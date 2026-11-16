"use strict";
// Verifies a build manifest: the signature first, only then is anything inside it trusted.
const crypto = require("node:crypto");
const { validateRelativePath } = require("./paths");

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const MIN_CHUNK = 1024 * 1024;
const MAX_CHUNK = 64 * 1024 * 1024;
const MAX_FILES = 5000;
const MAX_FILE_BYTES = 5 * 1024 ** 3;
const HEX64 = /^[0-9a-f]{64}$/;

class ManifestError extends Error {}

function publicKeyFromBase64(b64) {
  const raw = Buffer.from(b64, "base64");
  if (raw.length !== 32) throw new ManifestError("The manifest public key is not 32 bytes.");
  return crypto.createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, raw]),
    format: "der",
    type: "spki",
  });
}

function sha256Hex(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

/**
 * @param {object} input manifestB64, signatureB64, manifestSha256, publicKeyB64
 * @param {object} expected optional gameId, buildId to compare with what the plan promised
 * @returns {{manifest: object, bytes: Buffer}}
 */
function verifyManifest(input, expected = {}) {
  const bytes = Buffer.from(input.manifestB64, "base64");
  if (sha256Hex(bytes) !== input.manifestSha256) {
    throw new ManifestError("The manifest does not match its checksum.");
  }
  const signature = Buffer.from(input.signatureB64, "base64");
  const key = publicKeyFromBase64(input.publicKeyB64);
  if (!crypto.verify(null, bytes, key, signature)) {
    throw new ManifestError("The manifest signature is not valid.");
  }

  let manifest;
  try {
    manifest = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new ManifestError("The manifest is not valid JSON.");
  }
  validateManifest(manifest, expected);
  return { manifest, bytes };
}

function validateManifest(m, expected) {
  const fail = (message) => {
    throw new ManifestError(message);
  };
  if (m === null || typeof m !== "object" || m.format !== 1) fail("Unsupported manifest format.");
  if (m.platform !== "windows-x64") fail("The manifest is not for Windows.");
  if (expected.gameId && m.game_id !== expected.gameId) fail("The manifest is for another game.");
  if (expected.buildId && m.build_id !== expected.buildId) fail("The manifest is for another build.");
  if (!Number.isInteger(m.chunk_size) || m.chunk_size < MIN_CHUNK || m.chunk_size > MAX_CHUNK) {
    fail("The manifest has an invalid chunk size.");
  }
  if (!Array.isArray(m.files) || m.files.length === 0 || m.files.length > MAX_FILES) {
    fail("The manifest has an invalid file list.");
  }
  const seen = new Set();
  for (const file of m.files) {
    const problem = validateRelativePath(file.path);
    if (problem) fail(`Unsafe file path in manifest: ${problem}`);
    const lowered = file.path.toLowerCase();
    if (seen.has(lowered)) fail("The manifest lists the same file twice.");
    seen.add(lowered);
    if (!Number.isInteger(file.size) || file.size < 0 || file.size > MAX_FILE_BYTES) {
      fail("A file in the manifest has an invalid size.");
    }
    if (!HEX64.test(file.sha256)) fail("A file in the manifest has an invalid checksum.");
    const expectedChunks = Math.ceil(file.size / m.chunk_size);
    if (!Array.isArray(file.chunks) || file.chunks.length !== expectedChunks) {
      fail("A file in the manifest has the wrong number of chunk checksums.");
    }
    if (!file.chunks.every((c) => HEX64.test(c))) fail("A chunk checksum is invalid.");
  }
  if (typeof m.entry !== "string" || !seen.has(m.entry.toLowerCase())) {
    fail("The manifest does not say which file starts the game.");
  }
  if (!m.entry.toLowerCase().endsWith(".exe")) fail("The start file is not an .exe.");
}

module.exports = { verifyManifest, ManifestError, sha256Hex };
