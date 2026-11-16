"use strict";
// Installs a verified build into  <installRoot>/games/<gameId>/current  without ever leaving a
// half-installed game behind: files are downloaded into a staging folder, and only when every file
// has been verified is the staging folder swapped in.
const fsp = require("node:fs/promises");
const path = require("node:path");
const { downloadFile, hashFile } = require("./download");
const { safeJoin } = require("./paths");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function gameDirFor(installRoot, gameId) {
  if (!UUID.test(gameId)) throw new Error("Invalid game id.");
  return path.join(path.resolve(installRoot), "games", gameId.toLowerCase());
}

async function writeFileAtomic(file, data) {
  const temp = `${file}.tmp`;
  await fsp.writeFile(temp, data);
  await fsp.rename(temp, file);
}

// Windows can briefly refuse a rename while antivirus or the indexer touches the folder.
async function renameRetry(from, to) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fsp.rename(from, to);
    } catch (error) {
      const busy = ["EPERM", "EBUSY", "EACCES"].includes(error.code);
      if (!busy || attempt >= 5) throw error;
      await sleep(200);
    }
  }
}

async function swapIn(stagingDir, currentDir) {
  const old = `${currentDir}.old-${Date.now()}`;
  let hadOld = false;
  try {
    await renameRetry(currentDir, old);
    hadOld = true;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  try {
    await renameRetry(stagingDir, currentDir);
  } catch (error) {
    if (hadOld) await renameRetry(old, currentDir).catch(() => {});
    throw error;
  }
  if (hadOld) await fsp.rm(old, { recursive: true, force: true }).catch(() => {});
}

async function fileMatches(file, expected) {
  try {
    const stat = await fsp.stat(file);
    return stat.size === expected.size && (await hashFile(file)) === expected.sha256;
  } catch {
    return false;
  }
}

/**
 * @param {object} o gameDir, manifest (verified), manifestBytes, signatureB64, kid, manifestSha256,
 *   links (Map path to url), refreshLinks (async, returns a new Map), fetchImpl, signal,
 *   onProgress({done,total,file}), retries, backoffMs
 */
async function installBuild(o) {
  const { manifest } = o;
  if (!UUID.test(manifest.build_id) || !UUID.test(manifest.game_id)) {
    throw new Error("The manifest has an invalid id.");
  }
  const onProgress = o.onProgress || (() => {});
  const staging = path.join(o.gameDir, ".staging", manifest.build_id);
  await fsp.mkdir(staging, { recursive: true });
  for (const name of await fsp.readdir(o.gameDir)) {
    if (name.startsWith("current.old-")) {
      await fsp.rm(path.join(o.gameDir, name), { recursive: true, force: true }).catch(() => {});
    }
  }

  const total = manifest.files.reduce((sum, f) => sum + f.size, 0);
  let done = 0;
  let links = o.links;

  for (const file of manifest.files) {
    const dest = safeJoin(staging, file.path);
    if (await fileMatches(dest, file)) {
      done += file.size; // finished in an earlier attempt
      onProgress({ done, total, file: file.path });
      continue;
    }
    for (let refreshes = 0; ; refreshes++) {
      let counted = 0;
      try {
        const url = links.get(file.path);
        if (!url) throw new Error(`No download link for ${file.path}.`);
        await downloadFile({
          url,
          destPath: dest,
          size: file.size,
          sha256: file.sha256,
          chunks: file.chunks,
          chunkSize: manifest.chunk_size,
          fetchImpl: o.fetchImpl,
          signal: o.signal,
          retries: o.retries,
          backoffMs: o.backoffMs,
          onBytes: (n) => {
            counted += n;
            done += n;
            onProgress({ done, total, file: file.path });
          },
        });
        break;
      } catch (error) {
        done -= counted;
        if (error.code === "LINK_EXPIRED" && o.refreshLinks && refreshes < 3) {
          links = await o.refreshLinks();
          continue;
        }
        throw error;
      }
    }
  }

  const record = {
    game_id: manifest.game_id,
    build_id: manifest.build_id,
    version: manifest.version,
    entry: manifest.entry,
    manifest_sha256: o.manifestSha256,
    signature_b64: o.signatureB64,
    kid: o.kid,
    total_size: total,
    file_count: manifest.files.length,
    installed_at: new Date().toISOString(),
  };
  await writeFileAtomic(path.join(o.gameDir, "manifest.json"), o.manifestBytes);
  await swapIn(staging, path.join(o.gameDir, "current"));
  await writeFileAtomic(path.join(o.gameDir, "install.json"), JSON.stringify(record, null, 2));
  await fsp.rm(path.join(o.gameDir, ".staging"), { recursive: true, force: true }).catch(() => {});
  return record;
}

async function readInstalled(gameDir) {
  try {
    return JSON.parse(await fsp.readFile(path.join(gameDir, "install.json"), "utf8"));
  } catch {
    return null;
  }
}

async function listInstalled(installRoot) {
  const gamesDir = path.join(path.resolve(installRoot), "games");
  let names = [];
  try {
    names = await fsp.readdir(gamesDir);
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    if (!UUID.test(name)) continue;
    const gameDir = path.join(gamesDir, name);
    const record = await readInstalled(gameDir);
    if (record) out.push({ ...record, game_dir: gameDir });
  }
  return out;
}

async function loadManifest(gameDir) {
  return JSON.parse(await fsp.readFile(path.join(gameDir, "manifest.json"), "utf8"));
}

/** Cheap check before launching: every file exists with the right size. */
async function quickVerify(gameDir) {
  const problems = [];
  let manifest;
  try {
    manifest = await loadManifest(gameDir);
  } catch {
    return { ok: false, problems: ["The game is not installed correctly."] };
  }
  const current = path.join(gameDir, "current");
  for (const file of manifest.files) {
    try {
      const stat = await fsp.stat(safeJoin(current, file.path));
      if (stat.size !== file.size) problems.push(`${file.path}: wrong size.`);
    } catch {
      problems.push(`${file.path}: missing.`);
    }
  }
  return { ok: problems.length === 0, problems };
}

/** Full check of every file's SHA-256 ("Verify files"). */
async function verifyInstall(gameDir, onProgress = () => {}) {
  const problems = [];
  let manifest;
  try {
    manifest = await loadManifest(gameDir);
  } catch {
    return { ok: false, problems: ["The game is not installed correctly."] };
  }
  const current = path.join(gameDir, "current");
  let checked = 0;
  for (const file of manifest.files) {
    if (!(await fileMatches(safeJoin(current, file.path), file))) {
      problems.push(`${file.path}: missing or changed.`);
    }
    onProgress({ done: ++checked, total: manifest.files.length });
  }
  return { ok: problems.length === 0, problems };
}

function entryPath(gameDir, record) {
  return safeJoin(path.join(gameDir, "current"), record.entry);
}

async function uninstall(gameDir) {
  const resolved = path.resolve(gameDir);
  if (!UUID.test(path.basename(resolved)) || path.basename(path.dirname(resolved)) !== "games") {
    throw new Error("Refusing to delete a folder that is not a game install.");
  }
  await fsp.rm(resolved, { recursive: true, force: true });
}

module.exports = {
  gameDirFor, installBuild, readInstalled, listInstalled, quickVerify, verifyInstall, entryPath,
  uninstall,
};
