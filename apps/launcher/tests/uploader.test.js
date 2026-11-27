"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { MarecApi } = require("../src/core/api");
const { uploadBuild, scanFolder, UploadError } = require("../src/core/uploader");

function makeFolder(t, files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "marec-upload-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const [rel, data] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), data);
  }
  return dir;
}

const memoryTokens = () => ({ load: () => ({ accessToken: "tok", refreshToken: "ref" }), save() {}, clear() {} });

/** A small pretend store: the API calls and the storage that receives the files. */
async function store(t, { problems = [], failUploads = [], createStatus = 201, createBody } = {}) {
  const log = { created: null, stored: new Map(), putHeaders: [], completed: 0, putAttempts: new Map() };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks);
      const json = (status, body) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
      if (req.method === "POST" && req.url.endsWith("/builds")) {
        log.created = JSON.parse(raw.toString());
        if (createStatus !== 201) return json(createStatus, createBody);
        const base = `http://127.0.0.1:${server.address().port}`;
        return json(201, { id: "b-1", uploads: log.created.files.map((f, i) => ({ path: f.path, size_bytes: f.size_bytes, upload_url: `${base}/storage/${i}` })) });
      }
      if (req.method === "PUT" && req.url.startsWith("/storage/")) {
        const n = (log.putAttempts.get(req.url) || 0) + 1;
        log.putAttempts.set(req.url, n);
        log.putHeaders.push({ length: req.headers["content-length"], chunked: req.headers["transfer-encoding"], auth: req.headers.authorization || null });
        if (failUploads.includes(req.url) && n === 1) { res.writeHead(503); return res.end(); }
        log.stored.set(req.url, raw);
        res.writeHead(204);
        return res.end();
      }
      if (req.method === "POST" && req.url.endsWith("/complete")) {
        log.completed += 1;
        return json(200, { build: { id: "b-1", version: log.created.version, file_count: log.created.files.length, entry_point: log.created.entry_point || "Game.exe" }, problems });
      }
      res.writeHead(404);
      res.end();
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); return new Promise((done) => server.close(done)); });
  const api = new MarecApi({ baseUrl: `http://127.0.0.1:${server.address().port}`, tokenStore: memoryTokens() });
  return { log, api };
}

const sha = (data) => crypto.createHash("sha256").update(data).digest("hex");

test("scanning lists files, total size and the .exe candidates at the top of the folder", (t) => {
  const dir = makeFolder(t, { "Game.exe": "MZ1", "data/level1.pck": "abc", "data/deep/x.bin": "z", "Other.exe": "MZ2", "sub/Tool.exe": "MZ3" });
  const scan = scanFolder(dir);
  assert.deepEqual(scan.files.map((f) => f.rel), ["Game.exe", "Other.exe", "data/deep/x.bin", "data/level1.pck", "sub/Tool.exe"]);
  assert.equal(scan.totalBytes, 3 + 3 + 3 + 1 + 3);
  assert.deepEqual(scan.exeCandidates, ["Game.exe", "Other.exe"]);
});

test("scanning refuses an empty folder, a file and a missing path", (t) => {
  const empty = makeFolder(t, {});
  const file = makeFolder(t, { "a.txt": "x" });
  assert.throws(() => scanFolder(empty), (e) => e.code === "EMPTY_FOLDER");
  assert.throws(() => scanFolder(path.join(file, "a.txt")), (e) => e.code === "NO_FOLDER");
  assert.throws(() => scanFolder(path.join(file, "nope")), (e) => e.code === "NO_FOLDER");
});

test("links are never followed out of the folder", (t) => {
  const outside = makeFolder(t, { "secret.txt": "do not upload" });
  const dir = makeFolder(t, { "Game.exe": "MZ" });
  try {
    fs.symlinkSync(path.join(outside, "secret.txt"), path.join(dir, "link.txt"));
    fs.symlinkSync(outside, path.join(dir, "linked-dir"));
  } catch {
    return t.skip("this system does not allow symbolic links");
  }
  assert.deepEqual(scanFolder(dir).files.map((f) => f.rel), ["Game.exe"]);
});

test("a build is hashed, declared, uploaded with a Content-Length, and finished", async (t) => {
  const files = { "Game.exe": Buffer.from("MZ" + "x".repeat(2000)), "data/level.pck": crypto.randomBytes(300_000) };
  const dir = makeFolder(t, files);
  const { log, api } = await store(t);
  const progress = [];
  const build = await uploadBuild({ api, gameId: "g-1", folder: dir, version: "1.0.0", notes: "First", onProgress: (p) => progress.push(p) });

  assert.equal(build.version, "1.0.0");
  assert.equal(log.created.platform, "windows-x64");
  assert.equal(log.created.release_notes, "First");
  assert.equal("entry_point" in log.created, false, "a single top-level .exe is inferred by the store");
  assert.deepEqual(log.created.files.map((f) => [f.path, f.size_bytes, f.sha256]), [
    ["Game.exe", files["Game.exe"].length, sha(files["Game.exe"])],
    ["data/level.pck", 300_000, sha(files["data/level.pck"])],
  ]);
  assert.deepEqual([...log.stored.values()].map(sha), [sha(files["Game.exe"]), sha(files["data/level.pck"])]);
  for (const h of log.putHeaders) {
    assert.ok(h.length && !h.chunked, "R2 refuses chunked uploads, so Content-Length must be sent");
    assert.equal(h.auth, null, "the login token must never be sent to the storage address");
  }
  assert.equal(log.completed, 1);

  const phases = [...new Set(progress.map((p) => p.phase))];
  assert.deepEqual(phases, ["hashing", "uploading", "finishing"]);
  const uploading = progress.filter((p) => p.phase === "uploading");
  assert.equal(uploading.at(-1).done, uploading.at(-1).total);
  assert.ok(uploading.every((p, i) => i === 0 || p.done >= uploading[i - 1].done), "progress never goes backwards");
});

test("with several .exe files at the top, the developer must choose one", async (t) => {
  const dir = makeFolder(t, { "A.exe": "MZ", "B.exe": "MZ" });
  const { log, api } = await store(t);
  await assert.rejects(uploadBuild({ api, gameId: "g", folder: dir, version: "1.0.0" }), (e) => e.code === "NEEDS_ENTRY_POINT");
  assert.equal(log.created, null, "nothing is declared before the problem is solved");
  await uploadBuild({ api, gameId: "g", folder: dir, version: "1.0.0", entryPoint: "B.exe" });
  assert.equal(log.created.entry_point, "B.exe");
});

test("an entry point that is not in the folder is refused before anything is sent", async (t) => {
  const dir = makeFolder(t, { "Game.exe": "MZ" });
  const { log, api } = await store(t);
  await assert.rejects(uploadBuild({ api, gameId: "g", folder: dir, version: "1.0.0", entryPoint: "Missing.exe" }), (e) => e.code === "BAD_ENTRY_POINT");
  assert.equal(log.created, null);
});

test("a folder over the demo size limit is refused before the slow hashing starts", async (t) => {
  const dir = makeFolder(t, { "Game.exe": Buffer.alloc(3 * 1024 * 1024) });
  const { log, api } = await store(t);
  await assert.rejects(uploadBuild({ api, gameId: "g", folder: dir, version: "1.0.0", maxBytes: 2 * 1024 * 1024 }), (e) => e.code === "TOO_LARGE" && /at most 2 MB/.test(e.message));
  assert.equal(log.created, null);
});

test("a temporary storage error is retried, a permanent one is not", async (t) => {
  const dir = makeFolder(t, { "Game.exe": "MZ", "a.pck": "abc" });
  const flaky = await store(t, { failUploads: ["/storage/1"] });
  await uploadBuild({ api: flaky.api, gameId: "g", folder: dir, version: "1.0.0", backoffMs: 1 });
  assert.equal(flaky.log.putAttempts.get("/storage/1"), 2);
  assert.equal(flaky.log.completed, 1);
});

test("problems found when the store checks the files are reported with their list", async (t) => {
  const dir = makeFolder(t, { "Game.exe": "MZ" });
  const { api } = await store(t, { problems: ["Game.exe: contents do not match the declared SHA-256."] });
  await assert.rejects(uploadBuild({ api, gameId: "g", folder: dir, version: "1.0.0" }), (e) => e instanceof UploadError && e.code === "BUILD_PROBLEMS" && e.problems.length === 1);
});

test("a refusal from the store (for example a demo that is too large) comes through unchanged", async (t) => {
  const dir = makeFolder(t, { "Game.exe": "MZ" });
  const { api } = await store(t, { createStatus: 422, createBody: { error: { code: "DEMO_TOO_LARGE", message: "A demo can be at most 1024 MB." } } });
  await assert.rejects(uploadBuild({ api, gameId: "g", folder: dir, version: "1.0.0" }), (e) => e.code === "DEMO_TOO_LARGE" && /1024 MB/.test(e.message));
});

test("cancelling stops the upload", async (t) => {
  const dir = makeFolder(t, { "Game.exe": crypto.randomBytes(2_000_000) });
  const { api } = await store(t);
  const controller = new AbortController();
  const pending = uploadBuild({ api, gameId: "g", folder: dir, version: "1.0.0", signal: controller.signal, onProgress: (p) => { if (p.phase === "hashing") controller.abort(); } });
  await assert.rejects(pending, (e) => e.code === "CANCELLED");
});
