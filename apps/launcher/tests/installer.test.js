"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { verifyManifest } = require("../src/core/manifest");
const I = require("../src/core/installer");
const H = require("./helpers");

const V1 = {
  "data/a.pck": H.randomBytes(100000),
  "data/empty.txt": Buffer.alloc(0),
  "game.exe": H.randomBytes(Math.floor(H.CHUNK * 2.2)),
};
const V2_BUILD = "33333333-3333-4333-8333-333333333333";

function prepare(files, overrides = {}) {
  const keyPair = H.newKeyPair();
  const sig = H.signed(H.manifestFor(files, overrides), keyPair);
  const { manifest, bytes } = verifyManifest(sig.input);
  return { manifest, bytes, sig };
}

async function serve(t, files, hooks) {
  const map = new Map(Object.entries(files).map(([p, d]) => [`/f/${p}`, d]));
  const server = await H.startServer(map, hooks);
  t.after(() => server.close());
  const links = new Map(Object.keys(files).map((p) => [p, server.url(`/f/${p}`)]));
  return { server, links };
}

function run(root, prepared, links, extra = {}) {
  return I.installBuild({
    gameDir: I.gameDirFor(root, prepared.manifest.game_id),
    manifest: prepared.manifest,
    manifestBytes: prepared.bytes,
    signatureB64: prepared.sig.input.signatureB64,
    kid: "kid-1",
    manifestSha256: prepared.sig.input.manifestSha256,
    links,
    retries: 1,
    backoffMs: 1,
    ...extra,
  });
}

const read = (root, rel) =>
  fs.readFileSync(path.join(I.gameDirFor(root, H.GAME_ID), "current", ...rel.split("/")));

test("installs every file, records the install and leaves no staging folder", async (t) => {
  const root = H.tempDir();
  const prepared = prepare(V1);
  const { server, links } = await serve(t, V1);
  const progress = [];
  const record = await run(root, prepared, links, { onProgress: (p) => progress.push(p) });

  for (const [rel, data] of Object.entries(V1)) assert.deepEqual(read(root, rel), data);
  const gameDir = I.gameDirFor(root, H.GAME_ID);
  assert.equal(fs.existsSync(path.join(gameDir, ".staging")), false);
  assert.deepEqual(fs.readFileSync(path.join(gameDir, "manifest.json")), prepared.bytes);
  assert.equal(record.version, "1.0.0");
  assert.equal(record.entry, "game.exe");
  assert.equal((await I.readInstalled(gameDir)).build_id, H.BUILD_ID);
  assert.equal((await I.listInstalled(root)).length, 1);
  assert.equal(progress.at(-1).done, progress.at(-1).total);
  assert.equal((await I.quickVerify(gameDir)).ok, true);
  assert.equal((await I.verifyInstall(gameDir)).ok, true);
  assert.equal(I.entryPath(gameDir, record), path.join(gameDir, "current", "game.exe"));
});

test("an interrupted install resumes without repeating finished files", async (t) => {
  const root = H.tempDir();
  const prepared = prepare(V1);
  let breakIt = true;
  const { server, links } = await serve(t, V1, {
    onRequest(req, res) {
      if (!(breakIt && req.url === "/f/game.exe" && req.headers.range.startsWith("bytes=1048576"))) {
        return false;
      }
      res.destroy();
      return true;
    },
  });

  await assert.rejects(run(root, prepared, links, { retries: 0 }), { code: "INTERRUPTED" });
  const gameDir = I.gameDirFor(root, H.GAME_ID);
  assert.equal(await I.readInstalled(gameDir), null); // nothing is half-installed
  assert.equal(fs.existsSync(path.join(gameDir, "current")), false);

  breakIt = false;
  const before = server.requests.length;
  await run(root, prepared, links);
  const second = server.requests.slice(before).map((r) => r.url);
  assert.equal(second.includes("/f/data/a.pck"), false); // already finished earlier
  assert.deepEqual(read(root, "game.exe"), V1["game.exe"]);
});

test("an update replaces the old version completely", async (t) => {
  const root = H.tempDir();
  const first = prepare(V1);
  let served = await serve(t, V1);
  await run(root, first, served.links);

  const V2 = { "data/a.pck": H.randomBytes(5000), "game.exe": H.randomBytes(3000) };
  const second = prepare(V2, { build_id: V2_BUILD, version: "1.1.0" });
  const updated = await serve(t, V2);
  const record = await run(root, second, updated.links);

  const gameDir = I.gameDirFor(root, H.GAME_ID);
  assert.equal(record.version, "1.1.0");
  assert.deepEqual(read(root, "game.exe"), V2["game.exe"]);
  assert.equal(fs.existsSync(path.join(gameDir, "current", "data", "empty.txt")), false);
  assert.deepEqual(fs.readdirSync(gameDir).filter((n) => n.includes(".old")), []);
});

test("expired links are refreshed in the middle of an install", async (t) => {
  const root = H.tempDir();
  const prepared = prepare(V1);
  let expired = true;
  const { server, links } = await serve(t, V1, {
    onRequest(req, res) {
      if (!(expired && req.url === "/f/game.exe")) return false;
      res.writeHead(403);
      res.end();
      return true;
    },
  });
  let refreshed = 0;
  await run(root, prepared, links, {
    refreshLinks: async () => {
      refreshed++;
      expired = false;
      return links;
    },
  });
  assert.equal(refreshed, 1);
  assert.deepEqual(read(root, "game.exe"), V1["game.exe"]);

  // Without a way to refresh, the expiry is reported.
  const other = H.tempDir();
  expired = true;
  await assert.rejects(run(other, prepared, links), { code: "LINK_EXPIRED" });
});

test("verification notices changed, resized and missing files", async (t) => {
  const root = H.tempDir();
  const prepared = prepare(V1);
  const { server, links } = await serve(t, V1);
  await run(root, prepared, links);
  const gameDir = I.gameDirFor(root, H.GAME_ID);
  const exe = path.join(gameDir, "current", "game.exe");

  const changed = Buffer.from(V1["game.exe"]);
  changed[0] ^= 1;
  fs.writeFileSync(exe, changed); // same size, different content
  assert.equal((await I.quickVerify(gameDir)).ok, true); // quick check only looks at sizes
  assert.equal((await I.verifyInstall(gameDir)).ok, false);

  fs.writeFileSync(exe, "short");
  assert.equal((await I.quickVerify(gameDir)).ok, false);
  fs.rmSync(exe);
  const missing = await I.quickVerify(gameDir);
  assert.match(missing.problems[0], /game.exe: missing/);
});

test("uninstall removes the game and refuses other folders", async (t) => {
  const root = H.tempDir();
  const prepared = prepare(V1);
  const { server, links } = await serve(t, V1);
  await run(root, prepared, links);
  const gameDir = I.gameDirFor(root, H.GAME_ID);

  await assert.rejects(I.uninstall(root), /Refusing/);
  await assert.rejects(I.uninstall(path.join(root, "games")), /Refusing/);
  await I.uninstall(gameDir);
  assert.equal(fs.existsSync(gameDir), false);
  assert.deepEqual(await I.listInstalled(root), []);
  assert.throws(() => I.gameDirFor(root, "../../etc"), /Invalid game id/);
});

test("a hand-made manifest with an escaping path writes nothing outside the install", async (t) => {
  const root = H.tempDir();
  const prepared = prepare(V1);
  const evil = structuredClone(prepared.manifest);
  evil.files[0].path = "../../escape.exe";
  const links = new Map([["../../escape.exe", "http://127.0.0.1:9/x"]]);
  await assert.rejects(run(root, { ...prepared, manifest: evil }, links), /Unsafe path/);
  assert.equal(fs.existsSync(path.join(root, "escape.exe")), false);
  assert.equal(fs.existsSync(path.join(path.dirname(root), "escape.exe")), false);
});
