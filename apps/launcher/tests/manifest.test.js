"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { verifyManifest, ManifestError } = require("../src/core/manifest");
const H = require("./helpers");

const FILES = { "game.exe": H.randomBytes(2000), "data/level.pck": H.randomBytes(1500) };

test("a correctly signed manifest is accepted", () => {
  const { input } = H.signed(H.manifestFor(FILES));
  const { manifest } = verifyManifest(input, { gameId: H.GAME_ID, buildId: H.BUILD_ID });
  assert.equal(manifest.entry, "game.exe");
  assert.equal(manifest.files.length, 2);
});

test("tampering is caught by the checksum and by the signature", () => {
  const { input, keyPair } = H.signed(H.manifestFor(FILES));
  const altered = Buffer.from(input.manifestB64, "base64");
  altered[10] ^= 1;
  assert.throws(
    () => verifyManifest({ ...input, manifestB64: altered.toString("base64") }),
    /checksum/
  );

  // A checksum that matches the altered bytes still fails the signature.
  const other = H.signed(H.manifestFor(FILES), H.newKeyPair());
  assert.throws(
    () => verifyManifest({ ...other.input, publicKeyB64: keyPair.publicKeyB64 }),
    /signature/
  );
});

test("a validly signed manifest with unsafe or inconsistent content is still refused", () => {
  const files = { "game.exe": H.randomBytes(100) };
  const cases = {
    "path traversal": H.manifestFor({ "../evil.exe": H.randomBytes(10), "game.exe": files["game.exe"] }),
    "blocked file type": H.manifestFor({ ...files, "run.bat": H.randomBytes(10) }),
    "entry not listed": H.manifestFor(files, { entry: "other.exe" }),
    "entry not exe": H.manifestFor({ ...files, "readme.txt": H.randomBytes(5) }, { entry: "readme.txt" }),
    "wrong platform": H.manifestFor(files, { platform: "linux" }),
    "tiny chunk size": H.manifestFor(files, { chunk_size: 10 }),
    "unknown format": H.manifestFor(files, { format: 2 }),
    "no files": H.manifestFor(files, { files: [] }),
  };
  for (const [name, manifest] of Object.entries(cases)) {
    assert.throws(() => verifyManifest(H.signed(manifest).input), ManifestError, name);
  }

  const duplicate = H.manifestFor(files);
  duplicate.files.push({ ...duplicate.files[0], path: "GAME.EXE" });
  assert.throws(() => verifyManifest(H.signed(duplicate).input), /twice/);

  const wrongChunks = H.manifestFor(files);
  wrongChunks.files[0].chunks = [];
  assert.throws(() => verifyManifest(H.signed(wrongChunks).input), /chunk/);

  const badHash = H.manifestFor(files);
  badHash.files[0].sha256 = "xyz";
  assert.throws(() => verifyManifest(H.signed(badHash).input), /checksum/);
});

test("a manifest for another game or build is refused", () => {
  const { input } = H.signed(H.manifestFor(FILES));
  assert.throws(() => verifyManifest(input, { gameId: "other" }), /another game/);
  assert.throws(() => verifyManifest(input, { buildId: "other" }), /another build/);
});
