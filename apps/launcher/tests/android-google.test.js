"use strict";
// Sign in with Google, developer actions and staff review on the Android app, with the native layer
// faked and the store faked by a real local HTTP server (so the real API client and the real
// Google sign-in logic run).
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const http = require("node:http");
const { createAndroidBridge } = require("../src/renderer/js/platform-android");
const GoogleSignIn = require("../src/renderer/js/google-signin");
const { MarecApi } = require("../src/core/api");

const GOOGLE_PAGE = "https://accounts.google.com/o/oauth2/v2/auth?client_id=x&state=y";
const USER = { email: "gina@gmail.com", display_name: "Gina", email_verified: true, status: "active", created_at: "2026-11-20T00:00:00Z", roles: [] };

async function store(t, { authUrl = GOOGLE_PAGE } = {}) {
  const seen = { challenge: null, calls: [] };
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : null;
      seen.calls.push({ method: req.method, url: req.url, auth: req.headers.authorization || null, body });
      const reply = (status, json) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(json)); };
      if (req.url === "/v1/auth/providers") return reply(200, { google: true, email_codes: true });
      if (req.url === "/v1/auth/google/start") { seen.challenge = body.code_challenge; return reply(200, { auth_url: authUrl }); }
      if (req.url === "/v1/auth/google/exchange") {
        const expected = crypto.createHash("sha256").update(body.code_verifier).digest("base64url");
        if (body.ticket !== "good-ticket" || expected !== seen.challenge) return reply(401, { error: { code: "INVALID_TICKET", message: "This sign-in expired. Please try again." } });
        return reply(200, { access_token: "A1", refresh_token: "R1", token_type: "bearer", expires_in: 900 });
      }
      if (req.url === "/v1/me") return reply(200, USER);
      if (req.url === "/v1/developer/account") return reply(200, { is_developer: false, email_verified: true, terms_version: "2026-11", limits: { demo_only: true, max_demo_build_mb: 1024, max_games_per_studio: 5 }, studios: [] });
      if (req.url === "/v1/admin/studios?status=pending&limit=50") return reply(200, { items: [], total: 0 });
      if (req.url.startsWith("/v1/admin/games/") && req.url.endsWith("/transition")) return reply(200, { id: "g1", status: "approved" });
      return reply(404, { error: { code: "NOT_FOUND", message: "no" } });
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  return { seen, base: `http://127.0.0.1:${server.address().port}` };
}

function phone(base) {
  const hub = {};
  const opened = [];
  const secure = {};
  const native = {
    info: () => JSON.stringify({ versionName: "0.2.0", versionCode: 7, defaultApiBase: base, secureStorage: true, allowCleartext: true }),
    secureGet: (k) => (k in secure ? secure[k] : null),
    secureSet: (k, v) => void (secure[k] = v),
    secureRemove: (k) => void delete secure[k],
    settingGet: () => null,
    settingSet() {},
    openExternal: (url) => opened.push(url),
    httpRequest: (id, method, url, headersJson, body) => {
      fetch(url, { method, headers: JSON.parse(headersJson), body: body || undefined })
        .then(async (r) => hub.on("http", id, { status: r.status, body: await r.text() }))
        .catch((e) => hub.on("http", id, { status: 0, body: "", error: e.message }));
    },
  };
  const bridge = createAndroidBridge({ native, hub, MarecApi, GoogleSignIn });
  const events = [];
  bridge.onAuthEvent((event) => events.push(event));
  const arrive = (url) => hub.on("deeplink", "", { url });
  const settle = () => new Promise((resolve) => setTimeout(resolve, 60));
  return { bridge, opened, secure, events, arrive, settle };
}

test("Google sign-in on a phone: the system browser opens Google's page, the way back signs in", async (t) => {
  const { base, seen } = await store(t);
  const { bridge, opened, secure, events, arrive, settle } = phone(base);

  const started = await bridge.googleSignIn();
  assert.deepEqual(started, { ok: true, data: { started: true } });
  assert.deepEqual(opened, [GOOGLE_PAGE]);
  assert.match(seen.challenge, /^[A-Za-z0-9_-]{43}$/);

  arrive("marecstore://auth?ticket=good-ticket");
  await settle();
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "signed-in");
  assert.equal(events[0].user.email, "gina@gmail.com");
  assert.deepEqual(JSON.parse(secure.tokens), { accessToken: "A1", refreshToken: "R1" });
});

test("a link nobody asked for is ignored: no sign-in, no network", async (t) => {
  const { base, seen } = await store(t);
  const { arrive, settle, events } = phone(base);
  arrive("marecstore://auth?ticket=good-ticket");
  await settle();
  assert.deepEqual(events, []);
  assert.equal(seen.calls.length, 0);
});

test("a ticket from someone else's sign-in does not work here (PKCE)", async (t) => {
  const { base } = await store(t);
  const { bridge, arrive, settle, events, secure } = phone(base);
  await bridge.googleSignIn();
  arrive("marecstore://auth?ticket=attackers-ticket");
  await settle();
  assert.equal(events[0].type, "failed");
  assert.equal(events[0].code, "INVALID_TICKET");
  assert.equal(secure.tokens, undefined);
});

test("cancelled in the browser comes back as a plain message", async (t) => {
  const { base } = await store(t);
  const { bridge, arrive, settle, events } = phone(base);
  await bridge.googleSignIn();
  arrive("marecstore://auth?error=GOOGLE_CANCELLED");
  await settle();
  assert.deepEqual(events, [{ type: "failed", code: "GOOGLE_CANCELLED", message: "Sign-in was cancelled." }]);
});

test("the phone never opens a sign-in address that is not Google's", async (t) => {
  const { base } = await store(t, { authUrl: "https://evil.example.com/login" });
  const { bridge, opened } = phone(base);
  const result = await bridge.googleSignIn();
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "GOOGLE_BAD_RESPONSE");
  assert.deepEqual(opened, []);
});

test("cancelling forgets the sign-in, so a late link does nothing", async (t) => {
  const { base } = await store(t);
  const { bridge, arrive, settle, events } = phone(base);
  await bridge.googleSignIn();
  await bridge.googleCancel();
  arrive("marecstore://auth?ticket=good-ticket");
  await settle();
  assert.deepEqual(events, []);
});

test("the sign-in options are fetched from the store", async (t) => {
  const { base } = await store(t);
  const { bridge } = phone(base);
  assert.deepEqual(await bridge.providers(), { ok: true, data: { google: true, email_codes: true } });
});

test("uploading a build needs a PC: the phone says so, and nothing is sent", async (t) => {
  const { base, seen } = await store(t);
  const { bridge } = phone(base);
  for (const action of [() => bridge.pickBuildFolder(), () => bridge.uploadBuild({}), () => bridge.downloadSdkConfig("g")]) {
    const result = await action();
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "UNSUPPORTED_PLATFORM");
    assert.match(result.error.message, /PC/);
  }
  assert.equal(seen.calls.length, 0);
});

test("developer and staff actions reach the store with the player's login", async (t) => {
  const { base, seen } = await store(t);
  const { bridge, arrive, settle } = phone(base);
  await bridge.googleSignIn();
  arrive("marecstore://auth?ticket=good-ticket");
  await settle();

  const account = await bridge.developerAccount();
  assert.equal(account.ok, true);
  assert.equal(account.data.limits.demo_only, true);
  assert.equal((await bridge.adminStudios("pending")).ok, true);
  assert.equal((await bridge.transitionGame("g1", "approve")).ok, true);
  const transition = seen.calls.find((c) => c.url === "/v1/admin/games/g1/transition");
  assert.deepEqual(transition.body, { action: "approve" });
  assert.equal(transition.auth, "Bearer A1");
});
