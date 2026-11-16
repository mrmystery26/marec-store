"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JsonFile, SecureStore, loadOrCreateDeviceId } = require("../src/core/store");
const H = require("./helpers");

const provider = (available = true) => ({
  available: () => available,
  encrypt: (text) => Buffer.from(text).map((b) => b ^ 0x5a),
  decrypt: (buffer) => Buffer.from(buffer).map((b) => b ^ 0x5a).toString("utf8"),
});

test("settings round-trip and a damaged file falls back to the default", () => {
  const file = path.join(H.tempDir(), "settings.json");
  const store = new JsonFile(file);
  assert.deepEqual(store.read({ a: 1 }), { a: 1 });
  store.write({ apiBase: "http://x" });
  assert.deepEqual(store.read(), { apiBase: "http://x" });
  fs.writeFileSync(file, "{not json");
  assert.deepEqual(store.read({ ok: true }), { ok: true });
});

test("secrets are encrypted on disk and can be cleared", () => {
  const file = path.join(H.tempDir(), "tokens.bin");
  const store = new SecureStore(file, provider());
  store.save({ accessToken: "super-secret-access", refreshToken: "super-secret-refresh" });
  const onDisk = fs.readFileSync(file, "utf8");
  assert.equal(onDisk.includes("super-secret"), false);
  assert.equal(Buffer.from(onDisk, "base64").toString().includes("super-secret"), false);
  assert.deepEqual(store.load(), {
    accessToken: "super-secret-access",
    refreshToken: "super-secret-refresh",
  });
  store.clear();
  assert.equal(store.load(), null);
});

test("without OS encryption nothing is saved", () => {
  const file = path.join(H.tempDir(), "tokens.bin");
  const store = new SecureStore(file, provider(false));
  assert.throws(() => store.save({ accessToken: "x" }), /not available/);
  assert.equal(fs.existsSync(file), false);
  assert.equal(store.load(), null);
});

test("the device id is created once, stays the same, and fits the backend's rules", () => {
  const store = new SecureStore(path.join(H.tempDir(), "device.bin"), provider());
  const first = loadOrCreateDeviceId(store);
  assert.match(first, /^[A-Za-z0-9_-]{16,128}$/);
  assert.equal(loadOrCreateDeviceId(store), first);
  const other = new SecureStore(path.join(H.tempDir(), "device.bin"), provider());
  assert.notEqual(loadOrCreateDeviceId(other), first);
});
