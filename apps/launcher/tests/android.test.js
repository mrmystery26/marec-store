"use strict";
// The Android app's JavaScript side: the bridge that replaces window.marec, the platform rules that keep
// Windows games off phones, and the phone navigation. Native (Kotlin/Java) code is faked here; the bridge
// talks to a real local HTTP server so login, token refresh and errors go through the real API client.
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { createAndroidBridge } = require("../src/renderer/js/platform-android");
const { MarecApi } = require("../src/core/api");
const { createPlatform, normalizePlatforms } = require("../src/renderer/js/platform");

// ---------------------------------------------------------------- fake store server
async function store(t, handler) {
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      calls.push({ method: req.method, url: req.url, auth: req.headers.authorization || null, body: body ? JSON.parse(body) : null });
      const out = handler(req, calls.at(-1)) || { status: 404, json: { error: { code: "NOT_FOUND", message: "no" } } };
      res.writeHead(out.status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(out.json));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  return { calls, base: `http://127.0.0.1:${server.address().port}` };
}

// ---------------------------------------------------------------- fake native layer
function fakeNative({ defaultApiBase = "", allowCleartext = true, secure = {}, settings = {} } = {}) {
  const hub = {};
  const log = [];
  const native = {
    info: () => JSON.stringify({ versionName: "0.2.0", versionCode: 7, defaultApiBase, secureStorage: true, allowCleartext }),
    secureGet: (k) => (k in secure ? secure[k] : null),
    secureSet: (k, v) => void (secure[k] = v),
    secureRemove: (k) => void delete secure[k],
    settingGet: (k) => (k in settings ? settings[k] : null),
    settingSet: (k, v) => void (settings[k] = v),
    // what the Java side does: run the request, then answer through the hub
    httpRequest: (id, method, url, headersJson, body) => {
      log.push(["http", method, url]);
      fetch(url, { method, headers: JSON.parse(headersJson), body: body || undefined })
        .then(async (r) => hub.on("http", id, { status: r.status, body: await r.text() }))
        .catch((e) => hub.on("http", id, { status: 0, body: "", error: e.message }));
    },
    downloadApk: (id, url, sha, name) => log.push(["apk", id, url, sha, name]),
    cancelDownload: (id) => log.push(["cancel", id]),
  };
  return { native, hub, log, secure, settings };
}

const USER = { email: "pat@example.com", display_name: "Pat", status: "active", created_at: "2026-10-18T00:00:00Z" };
const OWNED = { game_id: "g1", slug: "alpha", title: "Alpha", studio: { name: "S" }, source: "free", granted_at: "2026-10-20T00:00:00Z", available: true, unavailable_reason: null, latest_version: "1.0.0" };

function loggedInServer(t, extra = () => null) {
  return store(t, (req) => {
    const custom = extra(req);
    if (custom) return custom;
    if (req.url === "/v1/auth/login") return { status: 200, json: { access_token: "A1", refresh_token: "R1" } };
    if (req.url === "/v1/me") return { status: 200, json: USER };
    if (req.url.startsWith("/v1/me/library")) return { status: 200, json: { items: [OWNED], total: 1, limit: 50, offset: 0 } };
    return null;
  });
}

// ---------------------------------------------------------------- bridge
test("with no server address the app asks for one instead of calling localhost", async () => {
  const { native, hub, log } = fakeNative();
  const bridge = createAndroidBridge({ native, hub, MarecApi });
  const state = await bridge.state();
  assert.equal(state.ok, true);
  assert.deepEqual([state.data.apiBase, state.data.user, state.data.installRoot], ["", null, ""]);
  const login = await bridge.login("a@b.co", "pw");
  assert.equal(login.error.code, "NO_SERVER");
  assert.equal(log.length, 0, "nothing was sent anywhere");
});

test("login goes through the real API client and keeps the tokens in secure storage", async (t) => {
  const server = await loggedInServer(t);
  const { native, hub, secure } = fakeNative({ defaultApiBase: server.base });
  const bridge = createAndroidBridge({ native, hub, MarecApi });

  const login = await bridge.login("pat@example.com", "secret");
  assert.equal(login.ok, true);
  assert.equal(login.data.display_name, "Pat");
  assert.deepEqual(JSON.parse(secure.tokens), { accessToken: "A1", refreshToken: "R1" });
  assert.equal(server.calls.at(-1).auth, "Bearer A1");

  const state = await bridge.state();
  assert.equal(state.data.user.email, "pat@example.com");
  assert.equal(state.data.version, "0.2.0");

  await bridge.logout();
  assert.equal("tokens" in secure, false, "logging out removes the tokens");
});

test("backend errors and an unreachable backend become readable messages", async (t) => {
  const server = await store(t, () => ({ status: 401, json: { error: { code: "INVALID_CREDENTIALS", message: "Wrong email or password." } } }));
  const { native, hub, settings } = fakeNative({ defaultApiBase: server.base });
  const bridge = createAndroidBridge({ native, hub, MarecApi });
  assert.deepEqual((await bridge.login("a@b.co", "x")).error, { code: "INVALID_CREDENTIALS", message: "Wrong email or password." });

  settings.apiBase = "http://127.0.0.1:1"; // nothing listens here
  const down = await bridge.login("a@b.co", "x");
  assert.equal(down.error.code, "NETWORK_ERROR");
  assert.match(down.error.message, /Cannot reach the store/);
});

test("the library lists owned games as not installed Windows games", async (t) => {
  const server = await loggedInServer(t);
  const { native, hub } = fakeNative({ defaultApiBase: server.base, secure: { tokens: JSON.stringify({ accessToken: "A1", refreshToken: "R1" }) } });
  const bridge = createAndroidBridge({ native, hub, MarecApi });
  const { data } = await bridge.library();
  assert.equal(data.length, 1);
  assert.deepEqual([data[0].installed, data[0].update_available, data[0].platforms], [null, false, ["windows"]]);
});

test("changing the server clears the login and https is required in release builds", async (t) => {
  const { native, hub, secure, settings } = fakeNative({ allowCleartext: false, secure: { tokens: "{}" }, settings: { apiBase: "https://old.example.com" } });
  const bridge = createAndroidBridge({ native, hub, MarecApi });
  assert.equal((await bridge.saveSettings({ apiBase: "http://lan.example.com" })).error.code, "BAD_SERVER");
  assert.equal((await bridge.saveSettings({ apiBase: "ftp://x" })).error.code, "BAD_SERVER");
  assert.equal("tokens" in secure, true, "a refused address does not log you out");

  const saved = await bridge.saveSettings({ apiBase: "https://new.example.com/" });
  assert.equal(saved.data.apiBase, "https://new.example.com");
  assert.equal(settings.apiBase, "https://new.example.com");
  assert.equal("tokens" in secure, false);
});

test("Windows games are never installed, played or verified on a phone", async () => {
  const { native, hub, log } = fakeNative({ defaultApiBase: "https://x.example.com" });
  const bridge = createAndroidBridge({ native, hub, MarecApi });
  for (const call of ["play", "verify", "uninstall"]) {
    const result = await bridge[call]("g1");
    assert.equal(result.error.code, "UNSUPPORTED_PLATFORM", call);
  }
  assert.equal(log.length, 0);
});

test("a game with no Android build cannot be installed", async (t) => {
  const server = await loggedInServer(t, (req) => (req.url === "/v1/games/alpha" ? { status: 200, json: { slug: "alpha" } } : null));
  const { native, hub, log } = fakeNative({ defaultApiBase: server.base, secure: { tokens: JSON.stringify({ accessToken: "A1", refreshToken: "R1" }) } });
  const bridge = createAndroidBridge({ native, hub, MarecApi });
  await bridge.library();
  const result = await bridge.install("g1");
  assert.equal(result.error.code, "NO_ANDROID_BUILD");
  assert.equal(log.some((l) => l[0] === "apk"), false);
});

test("an Android build is checked, downloaded natively and handed to Android's installer", async (t) => {
  const sha = "AB".repeat(32);
  const server = await loggedInServer(t, (req) =>
    req.url === "/v1/games/alpha" ? { status: 200, json: { slug: "alpha", android_build: { url: "https://cdn.example.com/alpha.apk", sha256: sha, version: "1.0.0" } } } : null);
  const { native, hub, log } = fakeNative({ defaultApiBase: server.base, secure: { tokens: JSON.stringify({ accessToken: "A1", refreshToken: "R1" }) } });
  const bridge = createAndroidBridge({ native, hub, MarecApi });
  const seen = [];
  bridge.onInstallProgress((p) => seen.push(p));
  await bridge.library();

  const pending = bridge.install("g1");
  await new Promise((resolve) => setTimeout(resolve, 50));
  const [, id, url, hash, name] = log.find((l) => l[0] === "apk");
  assert.deepEqual([url, hash, name], ["https://cdn.example.com/alpha.apk", sha.toLowerCase(), "alpha.apk"]);

  hub.on("apk", id, { state: "progress", done: 50, total: 100 });
  assert.deepEqual(seen, [{ gameId: "g1", done: 50, total: 100 }]);
  hub.on("apk", id, { state: "done" });
  assert.deepEqual(await pending, { ok: true, data: { version: "1.0.0", pending: true } });
});

test("an Android build with a bad address or hash is refused before downloading", async (t) => {
  for (const build of [{ url: "http://cdn.example.com/a.apk", sha256: "a".repeat(64) }, { url: "https://cdn.example.com/a.apk", sha256: "zz" }]) {
    const server = await loggedInServer(t, (req) => (req.url === "/v1/games/alpha" ? { status: 200, json: { android_build: build } } : null));
    const { native, hub, log } = fakeNative({ defaultApiBase: server.base, secure: { tokens: JSON.stringify({ accessToken: "A1", refreshToken: "R1" }) } });
    const bridge = createAndroidBridge({ native, hub, MarecApi });
    await bridge.library();
    assert.equal((await bridge.install("g1")).error.code, "BAD_BUILD");
    assert.equal(log.some((l) => l[0] === "apk"), false);
  }
});

// ---------------------------------------------------------------- platform rules
test("platform names from the store become ids, and unlabelled games count as Windows games", () => {
  assert.deepEqual(normalizePlatforms(["windows-x64", "android-arm64", "windows-x64"]), ["windows", "android"]);
  assert.deepEqual(normalizePlatforms(undefined), ["windows"]);
  assert.deepEqual(normalizePlatforms(["linux"]), ["windows"]);
});

test("a phone can run Android games only, and a PC Windows games only", () => {
  const phone = createPlatform({ MarecAndroid: {} });
  const pc = createPlatform({});
  assert.deepEqual([phone.kind, phone.mobile, pc.kind, pc.mobile], ["android", true, "windows", false]);
  assert.equal(phone.canRun(["windows"]), false);
  assert.equal(phone.canRun(["windows", "android"]), true);
  assert.equal(pc.canRun(["android"]), false);
  assert.deepEqual(phone.names(["windows", "android"]), ["Windows PC", "Android"]);
});

// ---------------------------------------------------------------- friends
test("friends actions on a phone go through the real API client and keep the store's messages", async (t) => {
  const FRIEND = "44444444-4444-4444-8444-444444444444";
  const server = await loggedInServer(t, (req) => {
    if (req.url === "/v1/friends") return { status: 200, json: { items: [{ user_id: FRIEND, display_name: "Ana", since: "2026-11-01T00:00:00Z" }], total: 1 } };
    if (req.url === "/v1/friends/requests" && req.method === "GET") return { status: 200, json: { incoming: [], outgoing: [] } };
    if (req.url === "/v1/friends/requests" && req.method === "POST") return { status: 409, json: { error: { code: "REQUEST_DECLINED", message: "This player did not accept your earlier request." } } };
    if (req.url === "/v1/friends/code") return { status: 200, json: { code: "K7QM-2XWD" } };
    if (req.url.startsWith("/v1/friends/") && req.method === "DELETE") return { status: 204 };
    return null;
  });
  const { native, hub } = fakeNative({ defaultApiBase: server.base });
  const bridge = createAndroidBridge({ native, hub, MarecApi });
  await bridge.login("pat@example.com", "secret");

  assert.equal((await bridge.friends()).data.items[0].display_name, "Ana");
  assert.deepEqual((await bridge.friendRequests()).data, { incoming: [], outgoing: [] });
  assert.equal((await bridge.friendCode()).data.code, "K7QM-2XWD");

  const refused = await bridge.sendFriendRequest("ABCD-2345");
  assert.deepEqual(refused.error, { code: "REQUEST_DECLINED", message: "This player did not accept your earlier request." });
  assert.deepEqual(server.calls.findLast((c) => c.url === "/v1/friends/requests").body, { friend_code: "ABCD-2345" });

  assert.equal((await bridge.removeFriend(FRIEND)).ok, true);
  const removal = server.calls.at(-1);
  assert.deepEqual([removal.method, removal.url, removal.auth], ["DELETE", `/v1/friends/${FRIEND}`, "Bearer A1"]);
});

test("Windows and Android offer the screens exactly the same actions", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const preload = fs.readFileSync(path.join(__dirname, "../src/main/preload.js"), "utf8");
  const body = preload.slice(preload.indexOf('exposeInMainWorld("marec", {'));
  const windowsActions = [...body.matchAll(/^  (\w+): /gm)].map((m) => m[1]).sort();

  const { native, hub } = fakeNative({ defaultApiBase: "http://127.0.0.1:1" });
  const androidActions = Object.keys(createAndroidBridge({ native, hub, MarecApi })).sort();

  assert.ok(windowsActions.length > 20, "the preload list was read");
  assert.deepEqual(androidActions, windowsActions);
});
