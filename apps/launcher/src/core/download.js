"use strict";
// Resumable, verified file download. A file is fetched in manifest-sized chunks with HTTP Range
// requests; every chunk is hashed before it is written, so a bad or truncated chunk is retried
// instead of silently corrupting the install. An interrupted download keeps its verified chunks.
const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");

const EMPTY_SHA256 = crypto.createHash("sha256").digest("hex");

class DownloadError extends Error {
  constructor(message, code, fatal = false) {
    super(message);
    this.code = code; // LINK_EXPIRED, CHUNK_MISMATCH, FILE_MISMATCH, INTERRUPTED, HTTP_ERROR, CANCELLED
    this.fatal = fatal; // fatal errors are not retried
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sha256 = (buffer) => crypto.createHash("sha256").update(buffer).digest("hex");

function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    fs.createReadStream(filePath)
      .on("data", (block) => hash.update(block))
      .on("error", reject)
      .on("end", () => resolve(hash.digest("hex")));
  });
}

/** How many leading chunks of an existing partial file are intact (re-hashed, not assumed). */
async function verifiedPrefix(partPath, size, chunkSize, chunks) {
  let length;
  try {
    length = (await fsp.stat(partPath)).size;
  } catch {
    return 0;
  }
  const candidates = length >= size ? chunks.length : Math.floor(length / chunkSize);
  const handle = await fsp.open(partPath, "r");
  try {
    for (let index = 0; index < candidates; index++) {
      const start = index * chunkSize;
      const want = Math.min(chunkSize, size - start);
      const buffer = Buffer.alloc(want);
      const { bytesRead } = await handle.read(buffer, 0, want, start);
      if (bytesRead !== want || sha256(buffer) !== chunks[index]) return index;
    }
    return candidates;
  } finally {
    await handle.close();
  }
}

async function fetchChunk(o, index) {
  const start = index * o.chunkSize;
  const end = Math.min(start + o.chunkSize, o.size) - 1;
  for (let attempt = 0; ; attempt++) {
    if (o.signal && o.signal.aborted) throw new DownloadError("Cancelled.", "CANCELLED", true);
    try {
      const response = await o.fetchImpl(o.url, {
        headers: { Range: `bytes=${start}-${end}` },
        signal: o.signal,
      });
      if (response.status === 401 || response.status === 403) {
        throw new DownloadError("The download link expired.", "LINK_EXPIRED", true);
      }
      if (response.status >= 400 && response.status < 500) {
        throw new DownloadError(`The server answered ${response.status}.`, "HTTP_ERROR", true);
      }
      if (response.status >= 500) {
        throw new DownloadError(`The server answered ${response.status}.`, "HTTP_ERROR");
      }
      if (response.status === 200 && o.size > o.chunkSize) {
        throw new DownloadError("The server does not support resuming.", "HTTP_ERROR", true);
      }
      const body = Buffer.from(await response.arrayBuffer());
      if (body.length !== end - start + 1) {
        throw new DownloadError("The connection ended early.", "INTERRUPTED");
      }
      if (sha256(body) !== o.chunks[index]) {
        throw new DownloadError("A downloaded chunk failed its checksum.", "CHUNK_MISMATCH");
      }
      return body;
    } catch (error) {
      if (o.signal && o.signal.aborted) throw new DownloadError("Cancelled.", "CANCELLED", true);
      const known = error instanceof DownloadError;
      if ((known && error.fatal) || attempt >= o.retries) {
        throw known ? error : new DownloadError(error.message, "INTERRUPTED");
      }
      await sleep(o.backoffMs * 2 ** attempt);
    }
  }
}

/**
 * Downloads one file to destPath, resuming from a verified partial file if there is one.
 * onBytes(n) is called with the number of bytes newly accounted for (including resumed bytes).
 */
async function downloadFile(options) {
  const defaults = { fetchImpl: fetch, retries: 3, backoffMs: 300, onBytes: () => {} };
  const given = Object.fromEntries(Object.entries(options).filter(([, v]) => v !== undefined));
  const o = { ...defaults, ...given };
  await fsp.mkdir(path.dirname(o.destPath), { recursive: true });

  if (o.size === 0) {
    if (o.sha256 !== EMPTY_SHA256) throw new DownloadError("Bad empty file.", "FILE_MISMATCH", true);
    await fsp.writeFile(o.destPath, "");
    return;
  }

  const part = `${o.destPath}.part`;
  const good = await verifiedPrefix(part, o.size, o.chunkSize, o.chunks);
  const handle = await fsp.open(part, good > 0 ? "r+" : "w+");
  try {
    await handle.truncate(Math.min(good * o.chunkSize, o.size));
    if (good > 0) o.onBytes(Math.min(good * o.chunkSize, o.size));
    for (let index = good; index < o.chunks.length; index++) {
      const data = await fetchChunk(o, index);
      await handle.write(data, 0, data.length, index * o.chunkSize);
      o.onBytes(data.length);
    }
    await handle.sync();
  } finally {
    await handle.close();
  }

  if ((await hashFile(part)) !== o.sha256) {
    await fsp.rm(part, { force: true });
    throw new DownloadError("The finished file failed its checksum.", "FILE_MISMATCH", true);
  }
  await fsp.rename(part, o.destPath);
}

module.exports = { downloadFile, DownloadError, hashFile, sha256, EMPTY_SHA256 };
