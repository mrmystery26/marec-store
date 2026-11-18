"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { app, BrowserWindow, ipcMain, safeStorage, dialog } = require("electron");
const { MarecApi, cleanGamesQuery } = require("../core/api");
const { LauncherService } = require("../core/service");
const { startGame } = require("../core/launch");
const { JsonFile, SecureStore, loadOrCreateDeviceId } = require("../core/store");
const config = require("../../launcher.config.json");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let mainWindow = null;
let runtime = null;

if (!app.requestSingleInstanceLock()) app.quit();
app.setAppUserModelId("com.marecstudios.store.launcher");

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
  runtime = { settings, api, service };
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

  // Publisher area: list and create studios, list their games. Nothing else is exposed.
  handle("developer:studios", () => runtime.api.studios());
  handle("developer:createStudio", (name) => runtime.api.createStudio(requireText(name, "studio name", 60).trim()));
  handle("developer:games", (studioId) => runtime.api.studioGames(requireGameId(studioId)));
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
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("second-instance", () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});
app.on("window-all-closed", () => app.quit());
