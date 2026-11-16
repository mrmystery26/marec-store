"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { downloadFile, DownloadError, sha256 } = require("../src/core/download");
const H = require("./helpers");

const DATA = H.randomBytes(Math.floor(H.CHUNK * 2.5)); // three chunks, the last one partial

function job(server, dir, overrides = {}) {
  return {
    url: server.url("/file"),
    destPath: path.join(dir, "out", "file.bin"),
    size: DATA.length,
    sha256: sha256(DATA),
    chunks: H.chunkHashes(DATA),
    chunkSize: H.CHUNK,
    retries: 2,
    backoffMs: 1,
    ...overrides,
  };
}
const files = () => new Map([["/file", DATA]]);
const rangeStarts = (server) => server.requests.map((r) => Number(/bytes=(\d+)-/.exec(r.range)[1]));

test("downloads a multi-chunk file and verifies it", async () => {
  const dir = H.tempDir();
  const server = await H.startServer(files());
  const progress = [];
  await downloadFile(job(server, dir, { onBytes: (n) => progress.push(n) }));
  const dest = path.join(dir, "out", "file.bin");
  assert.deepEqual(fs.readFileSync(dest), DATA);
  assert.equal(fs.existsSync(`${dest}.part`), false);
  assert.equal(server.requests.length, 3);
  assert.equal(progress.reduce((a, b) => a + b, 0), DATA.length);
  await server.close();
});

test("a chunk that arrives corrupted is fetched again", async () => {
  const dir = H.tempDir();
  const server = await H.startServer(files(), {
    onRequest(req, res, data, n) {
      if (n !== 2) return false;
      const bad = Buffer.from(data.subarray(H.CHUNK, 2 * H.CHUNK));
      bad[5] ^= 0xff;
      res.writeHead(206, { "Content-Length": bad.length });
      res.end(bad);
      return true;
    },
  });
  await downloadFile(job(server, dir));
  assert.deepEqual(fs.readFileSync(path.join(dir, "out", "file.bin")), DATA);
  assert.equal(server.requests.length, 4);
  await server.close();
});

test("a chunk that is always corrupted fails with CHUNK_MISMATCH", async () => {
  const dir = H.tempDir();
  const server = await H.startServer(files(), {
    onRequest(req, res, data) {
      const bad = Buffer.from(data.subarray(0, H.CHUNK));
      bad[0] ^= 0xff;
      res.writeHead(206, { "Content-Length": bad.length });
      res.end(bad);
      return true;
    },
  });
  await assert.rejects(downloadFile(job(server, dir)), { code: "CHUNK_MISMATCH" });
  assert.equal(fs.existsSync(path.join(dir, "out", "file.bin")), false);
  await server.close();
});

test("an interrupted download resumes from the verified chunks", async () => {
  const dir = H.tempDir();
  let drop = true;
  const server = await H.startServer(files(), {
    onRequest(req, res, data, n) {
      if (!(drop && n === 2)) return false;
      res.writeHead(206, { "Content-Length": H.CHUNK });
      res.write(data.subarray(H.CHUNK, H.CHUNK + 1000));
      setTimeout(() => res.destroy(), 20); // connection dies mid-chunk
      return true;
    },
  });

  await assert.rejects(downloadFile(job(server, dir, { retries: 0 })), { code: "INTERRUPTED" });
  const before = server.requests.length;
  assert.equal(fs.statSync(path.join(dir, "out", "file.bin.part")).size >= H.CHUNK, true);

  drop = false;
  await downloadFile(job(server, dir));
  const resumed = rangeStarts({ requests: server.requests.slice(before) });
  assert.deepEqual(resumed, [H.CHUNK, 2 * H.CHUNK]); // chunk 0 was not downloaded again
  assert.deepEqual(fs.readFileSync(path.join(dir, "out", "file.bin")), DATA);
  await server.close();
});

test("existing partial data is re-checked, not trusted", async () => {
  const dir = H.tempDir();
  fs.mkdirSync(path.join(dir, "out"), { recursive: true });
  const part = path.join(dir, "out", "file.bin.part");

  // first chunk good, second chunk garbage of the right length
  fs.writeFileSync(part, Buffer.concat([DATA.subarray(0, H.CHUNK), H.randomBytes(H.CHUNK)]));
  let server = await H.startServer(files());
  await downloadFile(job(server, dir));
  assert.deepEqual(rangeStarts(server), [H.CHUNK, 2 * H.CHUNK]);
  assert.deepEqual(fs.readFileSync(path.join(dir, "out", "file.bin")), DATA);
  await server.close();

  // corrupted first chunk: everything is fetched again
  fs.rmSync(path.join(dir, "out"), { recursive: true });
  fs.mkdirSync(path.join(dir, "out"), { recursive: true });
  fs.writeFileSync(part, Buffer.concat([H.randomBytes(H.CHUNK), DATA.subarray(H.CHUNK)]));
  server = await H.startServer(files());
  await downloadFile(job(server, dir));
  assert.deepEqual(rangeStarts(server), [0, H.CHUNK, 2 * H.CHUNK]);
  await server.close();
});

test("an already complete partial file is only verified", async () => {
  const dir = H.tempDir();
  fs.mkdirSync(path.join(dir, "out"), { recursive: true });
  fs.writeFileSync(path.join(dir, "out", "file.bin.part"), DATA);
  const server = await H.startServer(files());
  await downloadFile(job(server, dir));
  assert.equal(server.requests.length, 0);
  assert.deepEqual(fs.readFileSync(path.join(dir, "out", "file.bin")), DATA);
  await server.close();
});

test("an expired link is reported without retrying", async () => {
  const dir = H.tempDir();
  const server = await H.startServer(files(), {
    onRequest(req, res) {
      res.writeHead(403);
      res.end();
      return true;
    },
  });
  await assert.rejects(downloadFile(job(server, dir)), { code: "LINK_EXPIRED" });
  assert.equal(server.requests.length, 1);
  await server.close();
});

test("cancelling stops the download", async () => {
  const dir = H.tempDir();
  const server = await H.startServer(files());
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(downloadFile(job(server, dir, { signal: controller.signal })), {
    code: "CANCELLED",
  });
  await server.close();
});

test("a server that ignores Range is refused for big files and accepted for small ones", async () => {
  const dir = H.tempDir();
  const big = await H.startServer(files(), { ignoreRange: true });
  await assert.rejects(downloadFile(job(big, dir)), { code: "HTTP_ERROR" });
  await big.close();

  const small = H.randomBytes(5000);
  const server = await H.startServer(new Map([["/file", small]]), { ignoreRange: true });
  await downloadFile(
    job(server, dir, {
      size: small.length,
      sha256: sha256(small),
      chunks: H.chunkHashes(small),
      destPath: path.join(dir, "small.bin"),
    })
  );
  assert.deepEqual(fs.readFileSync(path.join(dir, "small.bin")), small);
  await server.close();
});

test("empty files and whole-file mismatches", async () => {
  const dir = H.tempDir();
  const server = await H.startServer(files());
  const empty = path.join(dir, "empty.bin");
  await downloadFile(
    job(server, dir, { size: 0, sha256: sha256(Buffer.alloc(0)), chunks: [], destPath: empty })
  );
  assert.equal(fs.statSync(empty).size, 0);
  await assert.rejects(
    downloadFile(job(server, dir, { size: 0, sha256: "0".repeat(64), chunks: [], destPath: empty })),
    DownloadError
  );

  const wrong = path.join(dir, "wrong.bin");
  await assert.rejects(
    downloadFile(job(server, dir, { sha256: "0".repeat(64), destPath: wrong })),
    { code: "FILE_MISMATCH" }
  );
  assert.equal(fs.existsSync(wrong), false);
  assert.equal(fs.existsSync(`${wrong}.part`), false);
  await server.close();
});
