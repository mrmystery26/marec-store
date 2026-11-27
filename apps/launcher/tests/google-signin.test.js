"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const nodeCrypto = require("node:crypto");
const { createGoogleSignIn, makePkce, parseCallback, webCrypto, MESSAGES } = require("../src/renderer/js/google-signin");

const nodeParts = {
  randomBytes: (n) => new Uint8Array(nodeCrypto.randomBytes(n)),
  sha256: async (bytes) => nodeCrypto.createHash("sha256").update(bytes).digest(),
};
const GOOGLE = "https://accounts.google.com/o/oauth2/v2/auth?client_id=x&state=y";

function fakeApi({ authUrl = GOOGLE, exchange } = {}) {
  const calls = { start: [], exchange: [] };
  return {
    calls,
    googleStart: async (challenge) => (calls.start.push(challenge), { auth_url: authUrl }),
    googleExchange: async (ticket, verifier) => {
      calls.exchange.push({ ticket, verifier });
      if (exchange) return exchange(ticket, verifier);
      return { email: "gina@gmail.com" };
    },
  };
}

test("the PKCE pair matches the store's rule: challenge = base64url(SHA-256(verifier))", async () => {
  const { verifier, challenge } = await makePkce(nodeParts);
  assert.match(verifier, /^[A-Za-z0-9_-]{43,128}$/);
  assert.match(challenge, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(challenge, nodeCrypto.createHash("sha256").update(verifier).digest("base64url"));
  assert.notEqual((await makePkce(nodeParts)).verifier, verifier);
});

test("the browser's own crypto works too (this is what the Android app uses)", async () => {
  const { verifier, challenge } = await makePkce(webCrypto());
  assert.equal(challenge, nodeCrypto.createHash("sha256").update(verifier).digest("base64url"));
});

test("a full sign-in: begin sends only the challenge, complete sends the ticket and the secret", async () => {
  const api = fakeApi();
  const signIn = createGoogleSignIn({ api, crypto: nodeParts });
  assert.equal(signIn.isPending(), false);
  const { authUrl } = await signIn.begin();
  assert.equal(authUrl, GOOGLE);
  assert.equal(signIn.isPending(), true);
  assert.equal(api.calls.start.length, 1);

  const user = await signIn.complete("marecstore://auth?ticket=abc123");
  assert.deepEqual(user, { email: "gina@gmail.com" });
  const { ticket, verifier } = api.calls.exchange[0];
  assert.equal(ticket, "abc123");
  // The verifier is the secret whose hash was sent at the start; it was never sent before this.
  assert.equal(nodeCrypto.createHash("sha256").update(verifier).digest("base64url"), api.calls.start[0]);
  assert.equal(signIn.isPending(), false);
});

test("a ticket nobody here asked for is ignored (login CSRF)", async () => {
  const api = fakeApi();
  const signIn = createGoogleSignIn({ api, crypto: nodeParts });
  assert.equal(await signIn.complete("marecstore://auth?ticket=attackers"), null);
  assert.equal(api.calls.exchange.length, 0);
});

test("a ticket is used at most once per sign-in", async () => {
  const api = fakeApi();
  const signIn = createGoogleSignIn({ api, crypto: nodeParts });
  await signIn.begin();
  await signIn.complete("marecstore://auth?ticket=one");
  assert.equal(await signIn.complete("marecstore://auth?ticket=two"), null);
  assert.equal(api.calls.exchange.length, 1);
});

test("a sign-in left waiting for ten minutes is forgotten", async () => {
  let clock = 1_000_000;
  const api = fakeApi();
  const signIn = createGoogleSignIn({ api, crypto: nodeParts, now: () => clock });
  await signIn.begin();
  clock += 10 * 60 * 1000;
  assert.equal(signIn.isPending(), false);
  assert.equal(await signIn.complete("marecstore://auth?ticket=late"), null);
});

test("cancelling forgets the sign-in", async () => {
  const api = fakeApi();
  const signIn = createGoogleSignIn({ api, crypto: nodeParts });
  await signIn.begin();
  signIn.cancel();
  assert.equal(await signIn.complete("marecstore://auth?ticket=x"), null);
});

test("errors from the store come back with a code and a plain message", async () => {
  for (const code of ["GOOGLE_CANCELLED", "ACCOUNT_SUSPENDED", "GOOGLE_EMAIL_UNVERIFIED", "SIGNIN_EXPIRED"]) {
    const signIn = createGoogleSignIn({ api: fakeApi(), crypto: nodeParts });
    await signIn.begin();
    await assert.rejects(signIn.complete(`marecstore://auth?error=${code}`), (e) => e.code === code && e.message === MESSAGES[code]);
    assert.equal(signIn.isPending(), false);
  }
  const signIn = createGoogleSignIn({ api: fakeApi(), crypto: nodeParts });
  await signIn.begin();
  await assert.rejects(signIn.complete("marecstore://auth?error=SOMETHING_NEW"), (e) => e.code === "SOMETHING_NEW" && e.message.length > 5);
});

test("a callback with neither ticket nor error is a bad answer", async () => {
  const signIn = createGoogleSignIn({ api: fakeApi(), crypto: nodeParts });
  await signIn.begin();
  await assert.rejects(signIn.complete("marecstore://auth"), (e) => e.code === "GOOGLE_BAD_RESPONSE");
});

test("only Google's own page is ever opened, whatever the server says", async () => {
  for (const bad of ["https://evil.example.com/login", "http://accounts.google.com/x", "file:///etc/passwd", "javascript:alert(1)", "not a url", "https://accounts.google.com.evil.com/x"]) {
    const signIn = createGoogleSignIn({ api: fakeApi({ authUrl: bad }), crypto: nodeParts });
    await assert.rejects(signIn.begin(), (e) => e.code === "GOOGLE_BAD_RESPONSE", bad);
    assert.equal(signIn.isPending(), false);
  }
});

test("the exchange failing leaves nothing pending and passes the error on", async () => {
  const api = fakeApi({ exchange: () => { throw Object.assign(new Error("expired"), { code: "INVALID_TICKET" }); } });
  const signIn = createGoogleSignIn({ api, crypto: nodeParts });
  await signIn.begin();
  await assert.rejects(signIn.complete("marecstore://auth?ticket=t"), (e) => e.code === "INVALID_TICKET");
  assert.equal(signIn.isPending(), false);
});

test("only the app's own address counts as a callback", () => {
  assert.deepEqual(parseCallback("marecstore://auth?ticket=abc"), { ticket: "abc", error: "" });
  assert.deepEqual(parseCallback("MARECSTORE://auth?error=GOOGLE_CANCELLED"), { ticket: "", error: "GOOGLE_CANCELLED" });
  for (const other of ["https://example.com/?ticket=abc", "marecstore://other?ticket=abc", "marecstore://authx?ticket=abc", "", null, undefined, "marecstore:/auth"]) {
    assert.equal(parseCallback(other), null, String(other));
  }
});
