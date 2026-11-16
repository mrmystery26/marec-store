"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { MarecApi, ApiError } = require("../src/core/api");

function memoryTokens(initial = null) {
  let value = initial;
  return {
    load: () => value,
    save: (next) => {
      value = next;
    },
    clear: () => {
      value = null;
    },
    get value() {
      return value;
    },
  };
}

async function backend(t, handler) {
  const calls = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : null;
      calls.push({ method: req.method, url: req.url, auth: req.headers.authorization || null, body });
      const out = handler(req, body, calls);
      res.writeHead(out.status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(out.json === undefined ? {} : out.json));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    return new Promise((done) => server.close(done));
  });
  return { calls, base: `http://127.0.0.1:${server.address().port}/` };
}

const error = (status, code, message = "x") => ({
  status,
  json: { error: { code, message, request_id: "req-1" } },
});

test("login stores the tokens and later calls use them", async (t) => {
  const { calls, base } = await backend(t, (req) => {
    if (req.url === "/v1/auth/login") {
      return { status: 200, json: { access_token: "A1", refresh_token: "R1" } };
    }
    if (req.url === "/v1/me") return { status: 200, json: { email: "p@example.com" } };
    return { status: 200, json: { items: [], total: 0 } };
  });
  const tokens = memoryTokens();
  const api = new MarecApi({ baseUrl: base, tokenStore: tokens });

  const me = await api.login("p@example.com", "pw");
  assert.equal(me.email, "p@example.com");
  assert.deepEqual(tokens.value, { accessToken: "A1", refreshToken: "R1" });
  assert.equal(calls[0].auth, null); // login itself is not authenticated
  assert.deepEqual(calls[0].body, { email: "p@example.com", password: "pw" });

  await api.library(10, 5);
  const last = calls.at(-1);
  assert.equal(last.auth, "Bearer A1");
  assert.equal(last.url, "/v1/me/library?limit=10&offset=5");
  assert.equal(api.isLoggedIn(), true);
});

test("an expired access token is refreshed once, even for parallel requests", async (t) => {
  let refreshes = 0;
  const { base } = await backend(t, (req) => {
    if (req.url === "/v1/auth/refresh") {
      refreshes++;
      return { status: 200, json: { access_token: "A2", refresh_token: "R2" } };
    }
    return req.headers.authorization === "Bearer A2"
      ? { status: 200, json: { items: [] } }
      : error(401, "INVALID_TOKEN");
  });
  const tokens = memoryTokens({ accessToken: "A1", refreshToken: "R1" });
  const api = new MarecApi({ baseUrl: base, tokenStore: tokens });

  const [a, b] = await Promise.all([api.library(), api.library()]);
  assert.deepEqual(a, { items: [] });
  assert.deepEqual(b, { items: [] });
  assert.equal(refreshes, 1);
  assert.deepEqual(tokens.value, { accessToken: "A2", refreshToken: "R2" });
});

test("when the refresh token is rejected the session ends", async (t) => {
  const { base } = await backend(t, (req) =>
    req.url === "/v1/auth/refresh" ? error(401, "INVALID_REFRESH_TOKEN") : error(401, "INVALID_TOKEN")
  );
  const tokens = memoryTokens({ accessToken: "A1", refreshToken: "R1" });
  const api = new MarecApi({ baseUrl: base, tokenStore: tokens });
  await assert.rejects(api.library(), { code: "SESSION_EXPIRED" });
  assert.equal(tokens.value, null);
  assert.equal(api.isLoggedIn(), false);
});

test("server errors keep their code and request id", async (t) => {
  const { base } = await backend(t, () => error(403, "NOT_OWNED", "You do not own this game."));
  const api = new MarecApi({ baseUrl: base, tokenStore: memoryTokens({ accessToken: "A", refreshToken: "R" }) });
  await assert.rejects(api.installPlan("g1"), (e) => {
    assert.ok(e instanceof ApiError);
    assert.equal(e.status, 403);
    assert.equal(e.code, "NOT_OWNED");
    assert.equal(e.requestId, "req-1");
    return true;
  });
});

test("an unreachable store gives a clear network error", async () => {
  const api = new MarecApi({ baseUrl: "http://127.0.0.1:9", tokenStore: memoryTokens() });
  await assert.rejects(api.publicKeys(), { code: "NETWORK_ERROR" });
});

test("logout clears the local session even if the server cannot be reached", async () => {
  const tokens = memoryTokens({ accessToken: "A", refreshToken: "R" });
  const api = new MarecApi({ baseUrl: "http://127.0.0.1:9", tokenStore: tokens });
  await api.logout();
  assert.equal(tokens.value, null);
});

test("store pages are public, send only known filters, and escape the game slug", async (t) => {
  const { calls, base } = await backend(t, () => ({ status: 200, json: { items: [], total: 0, limit: 24, offset: 0 } }));
  const api = new MarecApi({ baseUrl: base, tokenStore: memoryTokens({ accessToken: "A", refreshToken: "R" }) });

  await api.games({ q: " racing ", free: true, sort: "price_asc", bogus: "x", limit: 500, min_price_minor: -5 });
  const url = new URL(calls[0].url, "http://x");
  assert.equal(url.pathname, "/v1/games");
  assert.equal(url.searchParams.get("q"), "racing");
  assert.equal(url.searchParams.get("free"), "true");
  assert.equal(url.searchParams.get("sort"), "price_asc");
  assert.equal(url.searchParams.get("limit"), "24"); // 500 is out of range, so the default is used
  assert.equal(url.searchParams.has("bogus"), false);
  assert.equal(url.searchParams.has("min_price_minor"), false);
  assert.equal(calls[0].auth, null); // browsing the store never sends the login

  await api.game("a/b c");
  assert.equal(calls[1].url, "/v1/games/a%2Fb%20c");
  await api.categories();
  assert.equal(calls[2].url, "/v1/categories");
});

test("register, add to library and the publisher calls use the documented endpoints", async (t) => {
  const { calls, base } = await backend(t, () => ({ status: 200, json: {} }));
  const api = new MarecApi({ baseUrl: base, tokenStore: memoryTokens({ accessToken: "A", refreshToken: "R" }) });

  await api.register("pat@example.com", "a-long-password", "Pat");
  assert.deepEqual(calls[0].body, { email: "pat@example.com", password: "a-long-password", display_name: "Pat" });
  assert.equal(calls[0].auth, null);

  await api.addToLibrary("11111111-1111-4111-8111-111111111111");
  assert.equal(calls[1].method, "POST");
  assert.equal(calls[1].url, "/v1/me/library/11111111-1111-4111-8111-111111111111");
  assert.equal(calls[1].auth, "Bearer A");

  await api.studios();
  await api.createStudio("Lakeshore Games");
  await api.studioGames("22222222-2222-4222-8222-222222222222");
  assert.equal(calls[2].url, "/v1/developer/studios");
  assert.deepEqual(calls[3].body, { name: "Lakeshore Games" });
  assert.match(calls[4].url, /^\/v1\/developer\/studios\/22222222-2222-4222-8222-222222222222\/games\?/);
});
