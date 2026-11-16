"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { run, walk } = require("./upload-build");

async function fakeBackend(t, { problems = [] } = {}) {
  const seen = { declared: null, uploads: new Map(), token: null };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks);
      const json = (status, value) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(value));
      };
      if (req.url === "/v1/auth/login") return json(200, { access_token: "tok" });
      seen.token = req.headers.authorization;
      if (req.url.endsWith("/builds")) {
        seen.declared = JSON.parse(raw);
        const port = server.address().port;
        return json(201, {
          id: "build-1",
          uploads: seen.declared.files.map((f, i) => ({
            path: f.path,
            upload_url: `http://127.0.0.1:${port}/put/${i}`,
          })),
        });
      }
      if (req.url.startsWith("/put/")) {
        seen.uploads.set(req.url, raw);
        res.writeHead(204);
        return res.end();
      }
      if (req.url.endsWith("/complete")) {
        return json(200, { problems, build: { file_count: 2, entry_point: "Game.exe" } });
      }
      json(404, { error: { code: "NOT_FOUND", message: "no" } });
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    return new Promise((done) => server.close(done));
  });
  return { seen, base: `http://127.0.0.1:${server.address().port}` };
}

function sampleFolder() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "upload-test-"));
  fs.mkdirSync(path.join(dir, "data"));
  fs.writeFileSync(path.join(dir, "Game.exe"), crypto.randomBytes(300));
  fs.writeFileSync(path.join(dir, "data", "level.pck"), crypto.randomBytes(200));
  return dir;
}

const argsFor = (base, dir) => [
  "--api", base, "--email", "dev@example.com", "--game", "g1", "--version", "1.0.0", "--dir", dir,
];

test("uploads every file with the right size, hash and relative path", async (t) => {
  const { seen, base } = await fakeBackend(t);
  const dir = sampleFolder();
  process.env.MAREC_PASSWORD = "pw";
  const logs = [];
  const build = await run(argsFor(base, dir), (line) => logs.push(line));

  assert.equal(build.entry_point, "Game.exe");
  assert.equal(seen.token, "Bearer tok");
  assert.deepEqual(seen.declared.files.map((f) => f.path), ["Game.exe", "data/level.pck"]);
  for (const declared of seen.declared.files) {
    const local = fs.readFileSync(path.join(dir, ...declared.path.split("/")));
    assert.equal(declared.size_bytes, local.length);
    assert.equal(declared.sha256, crypto.createHash("sha256").update(local).digest("hex"));
  }
  assert.equal(seen.uploads.size, 2);
  assert.match(logs.at(-1), /is ready/);
});

test("problems reported by the server make the command fail", async (t) => {
  const { base } = await fakeBackend(t, { problems: ["Game.exe: not uploaded yet."] });
  process.env.MAREC_PASSWORD = "pw";
  await assert.rejects(run(argsFor(base, sampleFolder()), () => {}), /not ready/);
});

test("missing arguments and a missing password are explained", async () => {
  delete process.env.MAREC_PASSWORD;
  await assert.rejects(run(["--api", "http://x"], () => {}), /Missing --email/);
  await assert.rejects(run(argsFor("http://x", sampleFolder()), () => {}), /MAREC_PASSWORD/);
});

test("walk lists files with forward slashes in a stable order", () => {
  const dir = sampleFolder();
  assert.deepEqual(walk(dir).map((f) => f.rel), ["Game.exe", "data/level.pck"]);
});
