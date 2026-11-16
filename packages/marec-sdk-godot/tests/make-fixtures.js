#!/usr/bin/env node
"use strict";
// Generates tests/fixtures/vectors.json: real RS256 tokens in exactly the shape the backend signs,
// plus forged and damaged ones, each with the result the SDK must give. Both the Node reference
// check (tests/vectors.test.js) and the Godot test (tests/run_tests.gd) read the same file, so the
// SDK is held to one written-down specification.
//   node tests/make-fixtures.js
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const NOW = 1800000000; // a fixed "current time" so the vectors never go stale
const GAME = "11111111-1111-4111-8111-111111111111";
const OTHER_GAME = "99999999-9999-4999-8999-999999999999";

const b64url = (input) => Buffer.from(input).toString("base64url");
const keys = () => crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const real = keys();
const stranger = keys();
const pem = real.publicKey.export({ type: "spki", format: "pem" });

function token(claims, { key = real.privateKey, header = { alg: "RS256", typ: "JWT", kid: "kid1" } } = {}) {
  const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  const signature = crypto.sign("sha256", Buffer.from(input), {
    key,
    padding: crypto.constants.RSA_PKCS1_PADDING,
  });
  return `${input}.${signature.toString("base64url")}`;
}

const base = {
  iss: "marec-store-api",
  aud: GAME,
  sub: "22222222-2222-4222-8222-222222222222",
  jti: "33333333-3333-4333-8333-333333333333",
  kind: "online",
  bid: "44444444-4444-4444-8444-444444444444",
  dh: "ab".repeat(32),
  lvl: 1,
  nonce: "nonce-0001",
  iat: NOW - 10,
  exp: NOW + 110,
};
const lease = (iat) => ({ ...base, kind: "lease", od: 7, iat, exp: iat + 7 * 86400 });

const valid = token(base);
const [head, body, sig] = valid.split(".");
const tamperedBody = b64url(JSON.stringify({ ...base, sub: "attacker" }));
const hs256Input = `${b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }))}.${b64url(JSON.stringify(base))}`;
const hs256 = `${hs256Input}.${crypto.createHmac("sha256", pem).update(hs256Input).digest("base64url")}`;
const { sub: _removed, ...withoutSub } = base;

const cases = [
  { name: "valid online token", token: valid, expect: "ok" },
  { name: "valid dev token", token: token({ ...base, kind: "dev", dev: true }), expect: "ok" },
  { name: "valid offline lease", token: token(lease(NOW - 100)), expect: "ok" },
  { name: "online token a little past expiry is within clock skew", token: token({ ...base, iat: NOW - 220, exp: NOW - 100 }), expect: "ok" },
  { name: "online token long expired", token: token({ ...base, iat: NOW - 1120, exp: NOW - 1000 }), expect: "TOKEN_EXPIRED" },
  { name: "lease expired", token: token(lease(NOW - 700000)), expect: "LEASE_EXPIRED" },
  { name: "lease with the PC clock set back", token: token(lease(NOW - 100)), last_seen: NOW + 86400, expect: "CLOCK_ROLLBACK" },
  { name: "lease issued in the future", token: token(lease(NOW + 100000)), expect: "CLOCK_ROLLBACK" },
  { name: "token for another game", token: valid, game_id: OTHER_GAME, expect: "WRONG_GAME" },
  { name: "payload changed after signing", token: `${head}.${tamperedBody}.${sig}`, expect: "INVALID_SIGNATURE" },
  { name: "signed by someone else's key", token: token(base, { key: stranger.privateKey }), expect: "INVALID_SIGNATURE" },
  { name: "algorithm none", token: `${b64url(JSON.stringify({ alg: "none", typ: "JWT" }))}.${body}.`, expect: "INVALID_TOKEN" },
  { name: "HS256 signed with the public key (algorithm confusion)", token: hs256, expect: "INVALID_TOKEN" },
  { name: "wrong issuer", token: token({ ...base, iss: "someone-else" }), expect: "WRONG_ISSUER" },
  { name: "missing subject", token: token(withoutSub), expect: "INVALID_TOKEN" },
  { name: "unknown kind", token: token({ ...base, kind: "admin" }), expect: "INVALID_TOKEN" },
  { name: "not a token", token: "not-a-token", expect: "INVALID_TOKEN" },
  { name: "two parts only", token: "a.b", expect: "INVALID_TOKEN" },
  { name: "empty", token: "", expect: "INVALID_TOKEN" },
  { name: "garbage in every part", token: "!!!.!!!.!!!", expect: "INVALID_TOKEN" },
];

const out = {
  now: NOW,
  game_id: GAME,
  public_key_pem: pem,
  cases: cases.map((c) => ({
    name: c.name,
    token: c.token,
    game_id: c.game_id || GAME,
    now: NOW,
    last_seen: c.last_seen || 0,
    expect: c.expect,
  })),
};
const file = path.join(__dirname, "fixtures", "vectors.json");
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, JSON.stringify(out, null, 2));
console.log(`Wrote ${out.cases.length} cases to ${file}`);
