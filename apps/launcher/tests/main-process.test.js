"use strict";
// Runs the real Electron main process file (src/main/main.js) against a stand-in for `electron` and a
// real local store, because the window itself cannot be opened in a test. It covers what only the main
// process does: the way back from Google (marecstore:// links), which pages may be opened, which
// callers are trusted, and the build upload and file save dialogs.
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const Module = require("node:module");
const os = require("node:os");
const path = require("node:path");

const GOOGLE_PAGE = "https://accounts.google.com/o/oauth2/v2/auth?client_id=x&state=y";
const USER = { email: "gina@gmail.com", display_name: "Gina", email_verified: true, status: "active", created_at: "2026-11-20T00:00:00Z", roles: [] };

async function fakeStore(t, { authUrl = GOOGLE_PAGE } = {}) {
  const log = { challenge: null, builds: [], stored: new Map(), completed: 0 };
  const srv = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks);
      const json = (status, body) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
      const body = req.headers["content-type"] === "application/json" && raw.length ? JSON.parse(raw.toString()) : null;
      if (req.url === "/v1/auth/google/start") { log.challenge = body.code_challenge; return json(200, { auth_url: authUrl }); }
      if (req.url === "/v1/auth/google/exchange") {
        const expected = crypto.createHash("sha256").update(body.code_verifier).digest("base64url");
        if (body.ticket !== "good-ticket" || expected !== log.challenge) return json(401, { error: { code: "INVALID_TICKET", message: "This sign-in expired. Please try again." } });
        return json(200, { access_token: "A1", refresh_token: "R1" });
      }
      if (req.url === "/v1/me") return json(200, USER);
      if (req.url === "/v1/developer/account") return json(200, { is_developer: true, email_verified: true, terms_version: "2026-11", limits: { demo_only: true, max_demo_build_mb: 1, max_games_per_studio: 5 }, studios: [] });
      if (req.url === "/v1/developer/games/11111111-1111-4111-8111-111111111111/builds" && req.method === "POST") {
        log.builds.push(body);
        const base = `http://127.0.0.1:${srv.address().port}`;
        return json(201, { id: "b1", uploads: body.files.map((f, i) => ({ path: f.path, size_bytes: f.size_bytes, upload_url: `${base}/storage/${i}` })) });
      }
      if (req.method === "PUT" && req.url.startsWith("/storage/")) { log.stored.set(req.url, raw); res.writeHead(204); return res.end(); }
      if (req.url === "/v1/developer/builds/b1/complete") { log.completed += 1; return json(200, { build: { id: "b1", version: "1.0.0" }, problems: [] }); }
      if (req.url === "/v1/developer/games/11111111-1111-4111-8111-111111111111/sdk-config") { res.writeHead(200, { "Content-Type": "text/plain" }); return res.end('const GAME_ID := "11111111-1111-4111-8111-111111111111"\n'); }
      return json(404, { error: { code: "NOT_FOUND", message: "no" } });
    });
  });
  await new Promise((resolve) => srv.listen(0, "127.0.0.1", resolve));
  t.after(() => { srv.closeAllConnections(); return new Promise((done) => srv.close(done)); });
  return { log, base: `http://127.0.0.1:${srv.address().port}` };
}

/** Loads main.js with `electron` replaced by a recording stand-in. */
async function boot(t, { base, argv = [], dialogs = {} }) {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "marec-main-"));
  t.after(() => fs.rmSync(userData, { recursive: true, force: true }));
  fs.writeFileSync(path.join(userData, "settings.json"), JSON.stringify({ apiBase: base, installRoot: path.join(userData, "games") }));

  const handlers = new Map();
  const appEvents = new Map();
  const sent = [];
  const opened = [];
  const protocol = [];
  const win = {
    destroyed: false, focused: 0, restored: 0,
    isDestroyed: () => false, isMinimized: () => true, restore() { this.restored += 1; }, focus() { this.focused += 1; },
    on() {}, loadFile() {},
    webContents: {
      send: (channel, payload) => sent.push([channel, payload]),
      once: (event, fn) => { win.loaded = fn; },
      setWindowOpenHandler() {}, on() {}, session: { setPermissionRequestHandler() {} },
    },
  };
  const electron = {
    app: {
      requestSingleInstanceLock: () => true, setAppUserModelId() {}, quit() {}, getVersion: () => "0.3.0",
      getPath: (name) => (name === "userData" ? userData : userData),
      setAsDefaultProtocolClient: (...args) => protocol.push(args),
      whenReady: () => Promise.resolve(),
      on: (event, fn) => appEvents.set(event, fn),
    },
    BrowserWindow: Object.assign(function () { return win; }, { getAllWindows: () => [win] }),
    ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) },
    safeStorage: { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from(s), decryptString: (b) => b.toString() },
    dialog: {
      showOpenDialog: async () => dialogs.open || { canceled: true, filePaths: [] },
      showSaveDialog: async () => dialogs.save || { canceled: true },
    },
    shell: { openExternal: async (url) => void opened.push(url) },
  };

  const realLoad = Module._load;
  Module._load = function (request, ...rest) {
    return request === "electron" ? electron : realLoad.call(this, request, ...rest);
  };
  const realArgv = process.argv;
  process.argv = [...realArgv.slice(0, 1), ...argv];
  const mainPath = require.resolve("../src/main/main.js");
  delete require.cache[mainPath];
  try {
    require(mainPath);
    await new Promise((resolve) => setImmediate(resolve)); // whenReady().then(...)
  } finally {
    Module._load = realLoad;
    process.argv = realArgv;
    delete require.cache[mainPath];
  }
  const caller = win.webContents;
  const invoke = (channel, ...args) => handlers.get(channel)({ sender: caller }, ...args);
  return { invoke, handlers, appEvents, sent, opened, protocol, win, userData, stranger: { sender: {} } };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 80));

test("the app registers marecstore:// so Windows hands the way back from Google to it", async (t) => {
  const { base } = await fakeStore(t);
  const { protocol } = await boot(t, { base });
  assert.ok(protocol.some((args) => args[0] === "marecstore"));
});

test("Continue with Google opens Google's page in the system browser, and the way back signs in", async (t) => {
  const { base, log } = await fakeStore(t);
  const m = await boot(t, { base });
  const started = await m.invoke("auth:googleStart");
  assert.deepEqual(started, { ok: true, data: { started: true } });
  assert.deepEqual(m.opened, [GOOGLE_PAGE]);
  assert.match(log.challenge, /^[A-Za-z0-9_-]{43}$/);

  // Windows starts a second copy of the app with the link as an argument; the first copy gets it here.
  m.appEvents.get("second-instance")({}, ["MarecStore.exe", "--flag", "marecstore://auth?ticket=good-ticket"]);
  await settle();
  const event = m.sent.find(([channel]) => channel === "auth:event");
  assert.equal(event[1].type, "signed-in");
  assert.equal(event[1].user.email, "gina@gmail.com");
  assert.ok(m.win.focused >= 1 && m.win.restored >= 1, "the window is brought to the front");

  const state = await m.invoke("state:get");
  assert.equal(state.data.user.email, "gina@gmail.com", "the session was saved");
});

test("a link that arrives when no sign-in was started is ignored", async (t) => {
  const { base } = await fakeStore(t);
  const m = await boot(t, { base });
  m.appEvents.get("second-instance")({}, ["MarecStore.exe", "marecstore://auth?ticket=good-ticket"]);
  await settle();
  assert.deepEqual(m.sent.filter(([channel]) => channel === "auth:event"), []);
});

test("other links in the arguments are not treated as sign-ins", async (t) => {
  const { base } = await fakeStore(t);
  const m = await boot(t, { base });
  await m.invoke("auth:googleStart");
  m.appEvents.get("second-instance")({}, ["MarecStore.exe", "https://evil.example.com/?ticket=good-ticket", "marecstore://other?ticket=good-ticket"]);
  await settle();
  assert.deepEqual(m.sent.filter(([channel]) => channel === "auth:event"), []);
});

test("a failed or cancelled sign-in is reported to the window", async (t) => {
  const { base } = await fakeStore(t);
  const m = await boot(t, { base });
  await m.invoke("auth:googleStart");
  m.appEvents.get("second-instance")({}, ["MarecStore.exe", "marecstore://auth?error=GOOGLE_CANCELLED"]);
  await settle();
  const event = m.sent.find(([channel]) => channel === "auth:event");
  assert.deepEqual(event[1], { type: "failed", code: "GOOGLE_CANCELLED", message: "Sign-in was cancelled." });
});

test("a link that launched the app is handled once the window has loaded", async (t) => {
  const { base } = await fakeStore(t);
  const m = await boot(t, { base, argv: ["marecstore://auth?error=SIGNIN_EXPIRED"] });
  assert.deepEqual(m.sent, [], "nothing is sent before the page is ready");
  m.win.loaded();
  await settle();
  // No sign-in was started in this fresh copy of the app, so the old link is ignored safely.
  assert.deepEqual(m.sent.filter(([channel]) => channel === "auth:event"), []);
});

test("only Google's own page is opened, even if the store says otherwise", async (t) => {
  const { base } = await fakeStore(t, { authUrl: "https://evil.example.com/login" });
  const m = await boot(t, { base });
  const result = await m.invoke("auth:googleStart");
  assert.equal(result.ok, false);
  assert.deepEqual(m.opened, []);
});

test("calls from anything but the app's own window are refused", async (t) => {
  const { base } = await fakeStore(t);
  const m = await boot(t, { base });
  for (const channel of ["auth:googleStart", "developer:account", "admin:transition", "developer:uploadBuild"]) {
    const result = await m.handlers.get(channel)(m.stranger, "x");
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "FORBIDDEN");
  }
  assert.deepEqual(m.opened, []);
});

test("inputs are checked before they reach the store", async (t) => {
  const { base } = await fakeStore(t);
  const m = await boot(t, { base });
  assert.equal((await m.invoke("auth:verifyEmail", "12345")).ok, false);
  assert.equal((await m.invoke("developer:game", "not-an-id")).ok, false);
  assert.equal((await m.invoke("developer:updateGame", "11111111-1111-4111-8111-111111111111", ["not", "an", "object"])).ok, false);
  assert.equal((await m.invoke("admin:games", "bad status!")).ok, false);
});

// ---------------------------------------------------------------- uploads and the SDK file

const GAME = "11111111-1111-4111-8111-111111111111";

function exportFolder(t, files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "marec-export-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const [name, data] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), data);
  }
  return dir;
}

test("a build is uploaded from the folder the person chose, with progress sent to the window", async (t) => {
  const { base, log } = await fakeStore(t);
  const dir = exportFolder(t, { "Game.exe": "MZ" + "x".repeat(1000), "data/level.pck": "abc" });
  const m = await boot(t, { base, dialogs: { open: { canceled: false, filePaths: [dir] } } });

  const picked = await m.invoke("developer:pickBuildFolder");
  assert.deepEqual(picked.data, { name: path.basename(dir), fileCount: 2, totalBytes: 1002 + 3, exeCandidates: ["Game.exe"] });

  const result = await m.invoke("developer:uploadBuild", { gameId: GAME, version: "1.0.0", notes: "First", entryPoint: "Game.exe" });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(log.builds[0].version, "1.0.0");
  assert.equal(log.builds[0].entry_point, "Game.exe");
  assert.equal(log.stored.size, 2);
  assert.equal(log.completed, 1);
  const phases = new Set(m.sent.filter(([channel]) => channel === "upload:progress").map(([, p]) => p.phase));
  assert.deepEqual([...phases], ["hashing", "uploading", "finishing"]);
});

test("an upload needs a folder chosen first, and cannot be pointed at any other path", async (t) => {
  const { base, log } = await fakeStore(t);
  const m = await boot(t, { base });
  const result = await m.invoke("developer:uploadBuild", { gameId: GAME, version: "1.0.0", entryPoint: "Game.exe", folder: "C:\\Windows" });
  assert.equal(result.ok, false);
  assert.match(result.error.message, /Choose the game folder first/);
  assert.equal(log.builds.length, 0);
});

test("a demo over the store's size limit is refused before anything is hashed or sent", async (t) => {
  const { base, log } = await fakeStore(t);
  const dir = exportFolder(t, { "Game.exe": Buffer.alloc(2 * 1024 * 1024) }); // the fake store's limit is 1 MB
  const m = await boot(t, { base, dialogs: { open: { canceled: false, filePaths: [dir] } } });
  await m.invoke("developer:pickBuildFolder");
  const result = await m.invoke("developer:uploadBuild", { gameId: GAME, version: "1.0.0", entryPoint: "Game.exe" });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "TOO_LARGE");
  assert.equal(log.builds.length, 0);
});

test("cancelling the folder dialog changes nothing", async (t) => {
  const { base } = await fakeStore(t);
  const m = await boot(t, { base });
  assert.deepEqual(await m.invoke("developer:pickBuildFolder"), { ok: true, data: null });
});

test("the SDK config is saved where the person chooses", async (t) => {
  const { base } = await fakeStore(t);
  const target = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "marec-sdk-")), "marec_config.gd");
  t.after(() => fs.rmSync(path.dirname(target), { recursive: true, force: true }));
  const m = await boot(t, { base, dialogs: { save: { canceled: false, filePath: target } } });
  const result = await m.invoke("developer:downloadSdkConfig", GAME);
  assert.deepEqual(result, { ok: true, data: { path: target } });
  assert.match(fs.readFileSync(target, "utf8"), /const GAME_ID := "11111111/);
});

test("cancelling the save dialog writes nothing", async (t) => {
  const { base } = await fakeStore(t);
  const m = await boot(t, { base });
  assert.deepEqual(await m.invoke("developer:downloadSdkConfig", GAME), { ok: true, data: null });
});
