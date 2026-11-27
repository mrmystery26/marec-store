"use strict";
// The API client's calls for Google sign-in, email codes, developer accounts and staff review:
// right address, right method, right body, and the answers handled the right way.
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { MarecApi } = require("../src/core/api");

async function server(t, handler) {
  const calls = [];
  const srv = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const call = { method: req.method, url: req.url, auth: req.headers.authorization || null, body: raw ? JSON.parse(raw) : null };
      calls.push(call);
      const out = handler(call) || { status: 200, json: {} };
      res.writeHead(out.status || 200, { "Content-Type": out.text ? "text/plain" : "application/json" });
      res.end(out.text !== undefined ? out.text : JSON.stringify(out.json));
    });
  });
  await new Promise((resolve) => srv.listen(0, "127.0.0.1", resolve));
  t.after(() => srv.close());
  const saved = [];
  const tokenStore = { load: () => ({ accessToken: "tok", refreshToken: "ref" }), save: (v) => saved.push(v), clear() {} };
  return { calls, saved, api: new MarecApi({ baseUrl: `http://127.0.0.1:${srv.address().port}`, tokenStore }) };
}

test("providers and the Google start call need no login", async (t) => {
  const { api, calls } = await server(t, () => ({ json: { google: true, email_codes: false, auth_url: "https://accounts.google.com/x" } }));
  await api.providers();
  await api.googleStart("c".repeat(43));
  assert.deepEqual(calls.map((c) => [c.method, c.url, c.auth]), [["GET", "/v1/auth/providers", null], ["POST", "/v1/auth/google/start", null]]);
  assert.deepEqual(calls[1].body, { code_challenge: "c".repeat(43) });
});

test("the Google ticket is traded for a session, which is saved, and the player is returned", async (t) => {
  const { api, calls, saved } = await server(t, (call) => (call.url === "/v1/me" ? { json: { email: "gina@gmail.com" } } : { json: { access_token: "A", refresh_token: "R" } }));
  const user = await api.googleExchange("ticket-123", "v".repeat(50));
  assert.deepEqual(calls[0].body, { ticket: "ticket-123", code_verifier: "v".repeat(50) });
  assert.equal(calls[0].auth, null, "no login exists yet");
  assert.deepEqual(saved, [{ accessToken: "A", refreshToken: "R" }]);
  assert.equal(user.email, "gina@gmail.com");
});

test("a bad ticket comes back as an error with the store's code", async (t) => {
  const { api, saved } = await server(t, () => ({ status: 401, json: { error: { code: "INVALID_TICKET", message: "This sign-in expired. Please try again." } } }));
  await assert.rejects(api.googleExchange("t".repeat(30), "v".repeat(50)), (e) => e.code === "INVALID_TICKET");
  assert.deepEqual(saved, []);
});

test("email codes: send and verify", async (t) => {
  const { api, calls } = await server(t, () => ({ json: {} }));
  await api.sendEmailCode();
  await api.verifyEmail("123456");
  assert.deepEqual(calls.map((c) => [c.method, c.url, c.body]), [["POST", "/v1/auth/email/send-code", null], ["POST", "/v1/auth/email/verify", { code: "123456" }]]);
  assert.ok(calls.every((c) => c.auth === "Bearer tok"));
});

test("developer calls use the right addresses and bodies", async (t) => {
  const { api, calls } = await server(t, () => ({ json: {} }));
  await api.developerAccount();
  await api.registerDeveloper("Zomba Games", "2026-11");
  await api.createGame("s1", "Maize Run");
  await api.developerGame("g1");
  await api.updateGame("g1", { summary: "x" });
  await api.submitGame("g1");
  await api.builds("g1");
  await api.completeBuild("b1");
  assert.deepEqual(calls.map((c) => [c.method, c.url]), [
    ["GET", "/v1/developer/account"], ["POST", "/v1/developer/account"], ["POST", "/v1/developer/studios/s1/games"],
    ["GET", "/v1/developer/games/g1"], ["PATCH", "/v1/developer/games/g1"], ["POST", "/v1/developer/games/g1/submit"],
    ["GET", "/v1/developer/games/g1/builds"], ["POST", "/v1/developer/builds/b1/complete"],
  ]);
  assert.deepEqual(calls[1].body, { studio_name: "Zomba Games", accept_terms: true, terms_version: "2026-11" });
  assert.deepEqual(calls[2].body, { title: "Maize Run" });
  assert.deepEqual(calls[4].body, { summary: "x" });
});

test("the SDK config is returned as plain text", async (t) => {
  const file = 'extends RefCounted\nconst GAME_ID := "g1"\n';
  const { api } = await server(t, () => ({ text: file }));
  assert.equal(await api.sdkConfig("g1"), file);
});

test("staff calls: lists are filtered by status, and a decision carries its reason", async (t) => {
  const { api, calls } = await server(t, () => ({ json: { items: [], total: 0 } }));
  await api.adminStudios("pending");
  await api.adminGames("submitted");
  await api.verifyStudio("s1");
  await api.transitionGame("g1", "request_changes", "Add more detail.");
  await api.transitionGame("g1", "approve");
  assert.deepEqual(calls.map((c) => [c.method, c.url]), [
    ["GET", "/v1/admin/studios?status=pending&limit=50"], ["GET", "/v1/admin/games?status=submitted&limit=50"],
    ["POST", "/v1/admin/studios/s1/verify"], ["POST", "/v1/admin/games/g1/transition"], ["POST", "/v1/admin/games/g1/transition"],
  ]);
  assert.deepEqual(calls[3].body, { action: "request_changes", reason: "Add more detail." });
  assert.deepEqual(calls[4].body, { action: "approve" });
});

test("a refused staff action is an error with the store's message, not a crash", async (t) => {
  const { api } = await server(t, () => ({ status: 403, json: { error: { code: "FORBIDDEN", message: "You do not have permission." } } }));
  await assert.rejects(api.transitionGame("g1", "approve"), (e) => e.code === "FORBIDDEN");
});
