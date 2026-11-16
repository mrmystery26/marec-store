"use strict";
// An independent check of the SDK's specification: a small reference verifier written in Node must
// give exactly the results recorded in vectors.json. The Godot SDK is held to the same file.
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const vectors = require("./fixtures/vectors.json");

const CLOCK_SKEW_ONLINE = 300;
const ROLLBACK_TOLERANCE = 300;
const decode = (part) => Buffer.from(part, "base64url");

function referenceVerify(token, pem, gameId, now, lastSeen) {
  const fail = (code) => ({ ok: false, code });
  const parts = String(token).split(".");
  if (parts.length !== 3) return fail("INVALID_TOKEN");
  let header;
  try {
    header = JSON.parse(decode(parts[0]).toString("utf8"));
  } catch {
    return fail("INVALID_TOKEN");
  }
  if (!header || header.alg !== "RS256") return fail("INVALID_TOKEN");

  const valid = crypto.verify(
    "sha256",
    Buffer.from(`${parts[0]}.${parts[1]}`),
    { key: pem, padding: crypto.constants.RSA_PKCS1_PADDING },
    decode(parts[2])
  );
  if (!valid) return fail("INVALID_SIGNATURE");

  let claims;
  try {
    claims = JSON.parse(decode(parts[1]).toString("utf8"));
  } catch {
    return fail("INVALID_TOKEN");
  }
  const text = ["iss", "aud", "sub", "jti", "kind"];
  if (!claims || text.some((k) => typeof claims[k] !== "string" || claims[k] === "")) {
    return fail("INVALID_TOKEN");
  }
  if (typeof claims.exp !== "number" || typeof claims.iat !== "number") return fail("INVALID_TOKEN");
  if (!["online", "dev", "lease"].includes(claims.kind)) return fail("INVALID_TOKEN");
  if (claims.iss !== "marec-store-api") return fail("WRONG_ISSUER");
  if (claims.aud !== gameId) return fail("WRONG_GAME");

  if (claims.kind === "lease") {
    if (now < claims.iat - ROLLBACK_TOLERANCE) return fail("CLOCK_ROLLBACK");
    if (lastSeen > 0 && now < lastSeen - ROLLBACK_TOLERANCE) return fail("CLOCK_ROLLBACK");
    if (now > claims.exp) return fail("LEASE_EXPIRED");
  } else if (now > claims.exp + CLOCK_SKEW_ONLINE) {
    return fail("TOKEN_EXPIRED");
  }
  return { ok: true, code: "ok" };
}

for (const c of vectors.cases) {
  test(`vector: ${c.name}`, () => {
    const result = referenceVerify(c.token, vectors.public_key_pem, c.game_id, c.now, c.last_seen);
    assert.equal(result.code, c.expect);
  });
}

test("the vectors cover every result the SDK can return", () => {
  const wanted = [
    "ok", "INVALID_TOKEN", "INVALID_SIGNATURE", "WRONG_ISSUER", "WRONG_GAME", "TOKEN_EXPIRED",
    "LEASE_EXPIRED", "CLOCK_ROLLBACK",
  ];
  const have = new Set(vectors.cases.map((c) => c.expect));
  for (const code of wanted) assert.ok(have.has(code), `no vector for ${code}`);
});
