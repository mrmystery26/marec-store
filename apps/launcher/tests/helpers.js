"use strict";
// Shared test helpers: signed manifests and a small HTTP server with Range support and faults.
const crypto = require("node:crypto");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { sha256Hex } = require("../src/core/manifest");

const CHUNK = 1024 * 1024; // the smallest chunk size the launcher accepts
const GAME_ID = "11111111-1111-4111-8111-111111111111";
const BUILD_ID = "22222222-2222-4222-8222-222222222222";

const randomBytes = (n) => crypto.randomBytes(n);

function chunkHashes(buffer, chunkSize = CHUNK) {
  const out = [];
  for (let at = 0; at < buffer.length; at += chunkSize) {
    out.push(sha256Hex(buffer.subarray(at, at + chunkSize)));
  }
  return out;
}

function manifestFor(files, overrides = {}) {
  return {
    format: 1,
    game_id: GAME_ID,
    build_id: BUILD_ID,
    version: "1.0.0",
    platform: "windows-x64",
    chunk_size: CHUNK,
    entry: "game.exe",
    created_at: new Date().toISOString(),
    files: Object.entries(files).map(([p, data]) => ({
      path: p,
      size: data.length,
      sha256: sha256Hex(data),
      chunks: chunkHashes(data),
    })),
    ...overrides,
  };
}

function newKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const raw = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  return { privateKey, publicKeyB64: raw.toString("base64") };
}

/** Signs a manifest object and returns everything an install plan would carry. */
function signed(manifest, keyPair = newKeyPair()) {
  const bytes = Buffer.from(JSON.stringify(manifest));
  return {
    input: {
      manifestB64: bytes.toString("base64"),
      signatureB64: crypto.sign(null, bytes, keyPair.privateKey).toString("base64"),
      manifestSha256: sha256Hex(bytes),
      publicKeyB64: keyPair.publicKeyB64,
    },
    keyPair,
    bytes,
  };
}

/** Serves `files` (url path to Buffer). hooks.onRequest(req, res, data, n) may take over. */
function startServer(files, hooks = {}) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const data = files.get(req.url.split("?")[0]);
    if (!data) {
      res.statusCode = 404;
      return res.end();
    }
    requests.push({ url: req.url, range: req.headers.range || null });
    if (hooks.onRequest && hooks.onRequest(req, res, data, requests.length)) return;
    let start = 0;
    let end = data.length - 1;
    let status = 200;
    const match = req.headers.range && /^bytes=(\d+)-(\d*)$/.exec(req.headers.range);
    if (match && !hooks.ignoreRange) {
      start = Number(match[1]);
      end = match[2] ? Math.min(Number(match[2]), data.length - 1) : data.length - 1;
      status = 206;
    }
    res.writeHead(status, { "Content-Length": end - start + 1 });
    res.end(data.subarray(start, end + 1));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        port,
        requests,
        url: (p) => `http://127.0.0.1:${port}${p}`,
        close: () => {
          server.closeAllConnections();
          return new Promise((done) => server.close(done));
        },
      });
    });
  });
}

function tempDir(name = "launcher-test") {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
}

module.exports = {
  CHUNK, GAME_ID, BUILD_ID, randomBytes, chunkHashes, manifestFor, newKeyPair, signed,
  startServer, tempDir,
};
