"use strict";
// Uploads a folder as a build of a game: scan, hash, declare, upload each file, finish.
// Files are hashed and sent as streams, so a demo of a gigabyte or more never has to fit in memory.
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const MAX_FILES = 5000; // the store's limits (services/api/app/modules/builds/schemas.py)
const MAX_FILE_BYTES = 5 * 1024 ** 3;

class UploadError extends Error {
  constructor(code, message, problems = []) {
    super(message);
    this.code = code;
    this.problems = problems;
  }
}

/** Every regular file under `dir`, sorted, with sizes. Links are skipped, never followed. */
function walk(dir, base = dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, base, out);
    else if (entry.isFile()) out.push({ full, rel: path.relative(base, full).split(path.sep).join("/"), size: fs.statSync(full).size });
  }
  return out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
}

/** What is in the folder, without reading file contents. */
function scanFolder(folder) {
  const root = path.resolve(folder);
  let stats;
  try {
    stats = fs.statSync(root);
  } catch {
    throw new UploadError("NO_FOLDER", "That folder cannot be opened.");
  }
  if (!stats.isDirectory()) throw new UploadError("NO_FOLDER", "Choose a folder, not a file.");
  const files = walk(root);
  if (!files.length) throw new UploadError("EMPTY_FOLDER", "The folder has no files.");
  if (files.length > MAX_FILES) throw new UploadError("TOO_MANY_FILES", `The folder has ${files.length} files. A build can have at most ${MAX_FILES}.`);
  const big = files.find((f) => f.size > MAX_FILE_BYTES);
  if (big) throw new UploadError("FILE_TOO_BIG", `${big.rel} is larger than 5 GB.`);
  const totalBytes = files.reduce((sum, f) => sum + f.size, 0);
  // The launcher starts one .exe. If exactly one sits at the top of the folder it is chosen for you.
  const exeCandidates = files.filter((f) => !f.rel.includes("/") && f.rel.toLowerCase().endsWith(".exe")).map((f) => f.rel);
  return { root, files, fileCount: files.length, totalBytes, exeCandidates };
}

const cancelled = () => new UploadError("CANCELLED", "The upload was cancelled.");
const throwIfCancelled = (signal) => {
  if (signal && signal.aborted) throw cancelled();
};

function hashFile(file, signal) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(file);
    const abort = () => stream.destroy(cancelled());
    if (signal) signal.addEventListener("abort", abort, { once: true });
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

async function putFile({ fetchImpl, url, file, size, onBytes, signal }) {
  throwIfCancelled(signal);
  const stream = fs.createReadStream(file);
  // fetch reports stream errors itself. This only stops one that happens while nobody listens
  // (for example after a cancel) from crashing the whole app.
  stream.on("error", () => {});
  stream.on("data", (chunk) => onBytes(chunk.length));
  try {
    // Content-Length is set on purpose: S3-style storage (Cloudflare R2) refuses chunked uploads.
    const response = await fetchImpl(url, { method: "PUT", body: stream, duplex: "half", headers: { "Content-Length": String(size) }, signal });
    if (!response.ok) {
      const error = new UploadError("UPLOAD_FAILED", `Uploading failed (${response.status}).`);
      error.status = response.status;
      throw error;
    }
  } finally {
    stream.destroy();
  }
}

/**
 * api: a MarecApi. onProgress({phase: "hashing"|"uploading"|"finishing", done, total, file}).
 * Throws UploadError; `problems` lists what the store found wrong when it checked the files.
 */
async function uploadBuild({ api, fetchImpl = fetch, gameId, folder, version, notes, entryPoint, maxBytes, onProgress = () => {}, signal, retries = 2, backoffMs = 800 }) {
  const scan = scanFolder(folder);
  if (maxBytes && scan.totalBytes > maxBytes) {
    throw new UploadError("TOO_LARGE", `This folder is ${Math.ceil(scan.totalBytes / 1024 ** 2)} MB. A demo can be at most ${Math.floor(maxBytes / 1024 ** 2)} MB.`);
  }
  if (!entryPoint && scan.exeCandidates.length !== 1) {
    throw new UploadError("NEEDS_ENTRY_POINT", scan.exeCandidates.length ? "Choose which .exe starts the game." : "There is no .exe at the top of the folder. Choose the .exe that starts the game.");
  }
  if (entryPoint && !scan.files.some((f) => f.rel === entryPoint)) {
    throw new UploadError("BAD_ENTRY_POINT", "The chosen .exe is not in that folder.");
  }

  const total = scan.totalBytes;
  let hashed = 0;
  const declared = [];
  for (const file of scan.files) {
    throwIfCancelled(signal);
    declared.push({ path: file.rel, size_bytes: file.size, sha256: await hashFile(file.full, signal) });
    hashed += file.size;
    onProgress({ phase: "hashing", done: hashed, total, file: file.rel });
  }

  throwIfCancelled(signal);
  const body = { version, platform: "windows-x64", files: declared };
  if (entryPoint) body.entry_point = entryPoint;
  if (notes) body.release_notes = notes;
  const build = await api.createBuild(gameId, body);

  const byPath = new Map(scan.files.map((f) => [f.rel, f]));
  let sent = 0;
  for (const target of build.uploads) {
    const file = byPath.get(target.path);
    for (let attempt = 0; ; attempt += 1) {
      let counted = 0;
      try {
        await putFile({
          fetchImpl, url: target.upload_url, file: file.full, size: file.size, signal,
          onBytes: (n) => { counted += n; onProgress({ phase: "uploading", done: sent + counted, total, file: target.path }); },
        });
        break;
      } catch (error) {
        if (signal && signal.aborted) throw cancelled();
        const retryable = !error.status || error.status >= 500;
        if (!retryable || attempt >= retries) throw error.code === "UPLOAD_FAILED" ? error : new UploadError("UPLOAD_FAILED", `Uploading ${target.path} failed: ${error.message}`);
        await new Promise((resolve) => setTimeout(resolve, backoffMs * (attempt + 1)));
      }
    }
    sent += file.size;
  }

  onProgress({ phase: "finishing", done: total, total, file: "" });
  const done = await api.completeBuild(build.id);
  if (done.problems.length) throw new UploadError("BUILD_PROBLEMS", `The store found problems with the uploaded files: ${done.problems.slice(0, 5).join(" ")}`, done.problems);
  return done.build;
}

module.exports = { uploadBuild, scanFolder, UploadError, MAX_FILES };
