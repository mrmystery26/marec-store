"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { app, BrowserWindow, ipcMain, safeStorage, dialog, shell } = require("electron");
const nodeCrypto = require("node:crypto");
const { MarecApi, cleanGamesQuery } = require("../core/api");
const { LauncherService } = require("../core/service");
const { startGame } = require("../core/launch");
const { JsonFile, SecureStore, loadOrCreateDeviceId } = require("../core/store");
const { uploadBuild, scanFolder } = require("../core/uploader");
const google = require("../renderer/js/google-signin");
const config = require("../../launcher.config.json");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let mainWindow = null;
let runtime = null;
let pickedFolder = null; // the game folder the person chose, the only one an upload may use
let uploadAbort = null;
let queuedDeepLink = null; // a marecstore:// link that arrived before the window was ready

const PROTOCOL = "marecstore";

if (!app.requestSingleInstanceLock()) app.quit();
app.setAppUserModelId("com.marecstudios.store.launcher");

// Let Windows hand marecstore://auth links (the way back from Google) to this app.
if (process.defaultApp) {
  if (process.argv.length >= 2) app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [path.resolve(process.argv[1])]);
} else {
  app.setAsDefaultProtocolClient(PROTOCOL);
}

const deepLinkIn = (argv) => argv.find((arg) => typeof arg === "string" && google.isCallback(arg));

const nodeCryptoParts = {
  randomBytes: (n) => new Uint8Array(nodeCrypto.randomBytes(n)),
  sha256: async (bytes) => nodeCrypto.createHash("sha256").update(bytes).digest(),
};

function tell(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

async function handleDeepLink(url) {
  if (!url || !google.isCallback(url)) return;
  if (!runtime || !mainWindow) {
    queuedDeepLink = url;
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
  try {
    const user = await runtime.google.complete(url);
    if (user) tell("auth:event", { type: "signed-in", user });
  } catch (error) {
    tell("auth:event", { type: "failed", code: error.code || "ERROR", message: error.message });
  }
}

// Secrets (login session, this PC's id) are encrypted with the Windows account (DPAPI).
const osCrypto = {
  available: () => safeStorage.isEncryptionAvailable(),
  encrypt: (text) => safeStorage.encryptString(text),
  decrypt: (buffer) => safeStorage.decryptString(buffer),
};

function files() {
  const dir = app.getPath("userData");
  return {
    settings: new JsonFile(path.join(dir, "settings.json")),
    session: new SecureStore(path.join(dir, "session.bin"), osCrypto),
    device: new SecureStore(path.join(dir, "device.bin"), osCrypto),
  };
}

function loadSettings() {
  const saved = files().settings.read({});
  return {
    apiBase: saved.apiBase || config.defaultApiBase,
    installRoot: saved.installRoot || path.join(os.homedir(), "MAREC Games"),
  };
}

/** (Re)builds the backend client and launcher service from the current settings. */
function build() {
  const settings = loadSettings();
  const store = files();
  const api = new MarecApi({ baseUrl: settings.apiBase, tokenStore: store.session });
  const service = new LauncherService({
    api,
    installRoot: settings.installRoot,
    deviceId: loadOrCreateDeviceId(store.device),
    pinnedKeys: (config.pinnedManifestKeys || []).map((k) => ({ kid: k.kid, publicKey: k.publicKey })),
    startGameImpl: (args) => startGame({ ...args, timeoutMs: 15000 }),
  });
  runtime = { settings, api, service, google: google.createGoogleSignIn({ api, crypto: nodeCryptoParts }) };
}

function handle(channel, fn) {
  ipcMain.handle(channel, async (event, ...args) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) {
      return { ok: false, error: { code: "FORBIDDEN", message: "Unexpected caller." } };
    }
    try {
      return { ok: true, data: await fn(...args) };
    } catch (error) {
      return { ok: false, error: { code: error.code || "ERROR", message: error.message } };
    }
  });
}

function requireId(value, label) {
  if (typeof value !== "string" || !UUID.test(value)) throw new Error(`Invalid ${label}.`);
  return value.toLowerCase();
}

function requireGameId(value) {
  return requireId(value, "game");
}

const SLUG = /^[a-z0-9][a-z0-9-]{0,80}$/;

function requireSlug(value) {
  if (typeof value !== "string" || !SLUG.test(value)) throw new Error("Invalid game.");
  return value;
}

function requireText(value, label, max) {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error(`Invalid ${label}.`);
  return value;
}

const STATUS = /^[a-z_]{3,20}$/;

function optionalStatus(value) {
  if (value == null || value === "") return undefined;
  if (typeof value !== "string" || !STATUS.test(value)) throw new Error("Invalid status.");
  return value;
}

function registerHandlers() {
  handle("state:get", async () => ({
    apiBase: runtime.settings.apiBase,
    installRoot: runtime.settings.installRoot,
    secureStorage: osCrypto.available(),
    version: app.getVersion(),
    user: runtime.api.isLoggedIn() ? await runtime.api.me().catch(() => null) : null,
  }));

  handle("auth:login", async (email, password) => {
    if (typeof email !== "string" || typeof password !== "string") throw new Error("Invalid login.");
    return runtime.api.login(email.trim(), password);
  });
  handle("auth:register", (email, password, displayName) => {
    requireText(email, "email", 254);
    requireText(password, "password", 128);
    requireText(displayName, "display name", 40);
    return runtime.api.register(email.trim(), password, displayName.trim());
  });
  handle("auth:logout", () => runtime.api.logout());

  // Public store pages. Only whitelisted filters get through (see cleanGamesQuery).
  handle("catalog:categories", () => runtime.api.categories());
  handle("catalog:games", (query) => runtime.api.games(cleanGamesQuery(query)));
  handle("catalog:game", (slug) => runtime.api.game(requireSlug(slug)));
  handle("library:add", (gameId) => runtime.api.addToLibrary(requireGameId(gameId)));

  // Sign in with Google: the system browser does the signing in, the store sends the person back
  // here with a one-time ticket (see handleDeepLink). Only Google's own page is ever opened.
  handle("auth:providers", () => runtime.api.providers());
  handle("auth:googleStart", async () => {
    const { authUrl } = await runtime.google.begin();
    await shell.openExternal(authUrl);
    return { started: true };
  });
  handle("auth:googleCancel", () => {
    runtime.google.cancel();
    return { cancelled: true };
  });
  handle("auth:sendEmailCode", () => runtime.api.sendEmailCode());
  handle("auth:verifyEmail", (code) => {
    if (typeof code !== "string" || !/^\d{6}$/.test(code.trim())) throw new Error("Enter the 6-digit code from the email.");
    return runtime.api.verifyEmail(code.trim());
  });

  // Publisher area: the developer account, demos, builds and the SDK file for a game.
  handle("developer:account", () => runtime.api.developerAccount());
  handle("developer:register", (studioName, termsVersion) =>
    runtime.api.registerDeveloper(requireText(studioName, "studio name", 60).trim(), requireText(termsVersion, "rules version", 16)));
  handle("developer:games", (studioId) => runtime.api.studioGames(requireGameId(studioId)));
  handle("developer:createGame", (studioId, title) => runtime.api.createGame(requireId(studioId, "studio"), requireText(title, "title", 80).trim()));
  handle("developer:game", (gameId) => runtime.api.developerGame(requireGameId(gameId)));
  handle("developer:updateGame", (gameId, changes) => {
    if (!changes || typeof changes !== "object" || Array.isArray(changes)) throw new Error("Invalid changes.");
    return runtime.api.updateGame(requireGameId(gameId), changes);
  });
  handle("developer:submitGame", (gameId) => runtime.api.submitGame(requireGameId(gameId)));
  handle("developer:builds", (gameId) => runtime.api.builds(requireGameId(gameId)));

  handle("developer:pickBuildFolder", async () => {
    const result = await dialog.showOpenDialog(mainWindow, { properties: ["openDirectory"] });
    if (result.canceled) return null;
    const scan = scanFolder(result.filePaths[0]);
    pickedFolder = scan.root;
    return { name: path.basename(scan.root), fileCount: scan.fileCount, totalBytes: scan.totalBytes, exeCandidates: scan.exeCandidates };
  });
  handle("developer:uploadBuild", async (options) => {
    const gameId = requireGameId(options && options.gameId);
    const version = requireText(options.version, "version", 32).trim();
    const notes = options.notes ? requireText(options.notes, "release notes", 2000).trim() : undefined;
    const entryPoint = options.entryPoint ? requireText(options.entryPoint, "start file", 260) : undefined;
    if (!pickedFolder) throw new Error("Choose the game folder first.");
    if (uploadAbort) throw new Error("An upload is already running.");
    uploadAbort = new AbortController();
    try {
      const { limits } = await runtime.api.developerAccount();
      const maxBytes = limits.demo_only ? limits.max_demo_build_mb * 1024 * 1024 : undefined;
      const build = await uploadBuild({
        api: runtime.api, gameId, folder: pickedFolder, version, notes, entryPoint, maxBytes, signal: uploadAbort.signal,
        onProgress: (progress) => tell("upload:progress", { gameId, ...progress }),
      });
      return { build };
    } finally {
      uploadAbort = null;
    }
  });
  handle("developer:cancelUpload", () => {
    if (uploadAbort) uploadAbort.abort();
    return { cancelled: true };
  });
  handle("developer:downloadSdkConfig", async (gameId) => {
    const text = await runtime.api.sdkConfig(requireGameId(gameId));
    const result = await dialog.showSaveDialog(mainWindow, {
      defaultPath: path.join(app.getPath("documents"), "marec_config.gd"),
      filters: [{ name: "GDScript", extensions: ["gd"] }],
    });
    if (result.canceled || !result.filePath) return null;
    fs.writeFileSync(result.filePath, text, "utf8");
    return { path: result.filePath };
  });

  // Staff review. The store checks the person's roles on every call; these are just the doors.
  handle("admin:studios", (status) => runtime.api.adminStudios(optionalStatus(status)));
  handle("admin:verifyStudio", (studioId) => runtime.api.verifyStudio(requireId(studioId, "studio")));
  handle("admin:games", (status) => runtime.api.adminGames(optionalStatus(status)));
  handle("admin:transition", (gameId, action, reason) => {
    requireText(action, "action", 40);
    return runtime.api.transitionGame(requireGameId(gameId), action, reason ? requireText(reason, "reason", 500) : undefined);
  });
  handle("library:list", () => runtime.service.library());

  // Friends. Requests and friends are named by id, people are added by friend code.
  handle("friends:list", () => runtime.api.friends());
  handle("friends:requests", () => runtime.api.friendRequests());
  handle("friends:code", () => runtime.api.friendCode());
  handle("friends:resetCode", () => runtime.api.resetFriendCode());
  handle("friends:send", (code) => runtime.api.sendFriendRequest(requireText(code, "friend code", 40).trim()));
  handle("friends:accept", (id) => runtime.api.acceptFriendRequest(requireId(id, "request")));
  handle("friends:decline", (id) => runtime.api.declineFriendRequest(requireId(id, "request")));
  handle("friends:cancel", (id) => runtime.api.cancelFriendRequest(requireId(id, "request")));
  handle("friends:remove", (userId) => runtime.api.removeFriend(requireId(userId, "friend")));

  handle("game:install", async (gameId) => {
    const id = requireGameId(gameId);
    const record = await runtime.service.install(id, (progress) => {
      if (mainWindow) mainWindow.webContents.send("install:progress", { gameId: id, ...progress });
    });
    return { version: record.version };
  });
  handle("game:cancel", (gameId) => runtime.service.cancel(requireGameId(gameId)));
  handle("game:play", async (gameId) => {
    const result = await runtime.service.play(requireGameId(gameId));
    return { delivered: result.delivered };
  });
  handle("game:verify", (gameId) => runtime.service.verify(requireGameId(gameId)));
  handle("game:uninstall", (gameId) => runtime.service.uninstall(requireGameId(gameId)));

  handle("settings:save", (next) => {
    const url = new URL(String(next.apiBase));
    if (!["http:", "https:"].includes(url.protocol)) throw new Error("The server address must be http or https.");
    const installRoot = String(next.installRoot || "");
    if (!path.isAbsolute(installRoot) || installRoot.length > 200) throw new Error("Choose a full folder path.");
    fs.mkdirSync(installRoot, { recursive: true });
    const apiBase = url.origin + url.pathname.replace(/\/+$/, "");
    // A login belongs to one server: never send it to a different one.
    if (apiBase !== runtime.settings.apiBase) files().session.clear();
    files().settings.write({ apiBase, installRoot });
    build();
    return { apiBase: runtime.settings.apiBase, installRoot: runtime.settings.installRoot };
  });

  handle("settings:pickFolder", async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ["openDirectory", "createDirectory"],
    });
    return result.canceled ? null : result.filePaths[0];
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: "#121316",
    title: "MAREC Store",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  // The window only ever shows our own page: no pop-ups, no navigating away, no permissions.
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.on("will-navigate", (event) => event.preventDefault());
  mainWindow.webContents.session.setPermissionRequestHandler((_wc, _permission, done) => done(false));
  mainWindow.loadFile(path.join(__dirname, "..", "renderer", "index.html"));
  mainWindow.on("closed", () => (mainWindow = null));
}

app.whenReady().then(() => {
  build();
  registerHandlers();
  createWindow();
  queuedDeepLink = queuedDeepLink || deepLinkIn(process.argv) || null;
  // The page needs a moment to load before it can hear the answer.
  mainWindow.webContents.once("did-finish-load", () => {
    const link = queuedDeepLink;
    queuedDeepLink = null;
    if (link) handleDeepLink(link);
  });
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("second-instance", (_event, argv) => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
  // On Windows the link from the browser arrives as an argument of the second copy of the app.
  handleDeepLink(deepLinkIn(argv));
});
app.on("open-url", (event, url) => {
  event.preventDefault();
  handleDeepLink(url);
});
app.on("window-all-closed", () => app.quit());
