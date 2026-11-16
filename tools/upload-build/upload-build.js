#!/usr/bin/env node
"use strict";
// Uploads a folder as a build of a game. No dependencies: needs only Node 20 or newer.
//
//   node upload-build.js --api http://localhost:8000 --email you@example.com --game <game id> \
//        --version 1.0.0 --dir ./export [--entry Game.exe] [--notes "First release"]
//
// The password is read from the MAREC_PASSWORD environment variable, so it does not end up in your
// shell history or on the command line where other programs could see it.
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    if (!key.startsWith("--") || argv[i + 1] === undefined) throw new Error(`Bad argument: ${key}`);
    args[key.slice(2)] = argv[i + 1];
  }
  return args;
}

function walk(dir, base = dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, base));
    else if (entry.isFile()) out.push({ full, rel: path.relative(base, full).split(path.sep).join("/") });
  }
  return out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
}

const sha256 = (buffer) => crypto.createHash("sha256").update(buffer).digest("hex");

async function api(base, method, route, { token, body } = {}) {
  const response = await fetch(base + route, {
    method,
    headers: {
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const e = (data && data.error) || {};
    throw new Error(`${method} ${route} failed: ${e.message || response.status} (${e.code || response.status})`);
  }
  return data;
}

async function run(argv, log = console.log) {
  const args = parseArgs(argv);
  for (const need of ["api", "email", "game", "version", "dir"]) {
    if (!args[need]) throw new Error(`Missing --${need}`);
  }
  const password = process.env.MAREC_PASSWORD;
  if (!password) throw new Error("Set the MAREC_PASSWORD environment variable.");
  const base = args.api.replace(/\/+$/, "");

  const files = walk(path.resolve(args.dir)).map((f) => {
    const data = fs.readFileSync(f.full);
    return { ...f, data, size_bytes: data.length, sha256: sha256(data) };
  });
  if (files.length === 0) throw new Error("The folder has no files.");
  log(`Found ${files.length} files.`);

  const login = await api(base, "POST", "/v1/auth/login", {
    body: { email: args.email, password },
  });
  const token = login.access_token;

  const body = {
    version: args.version,
    platform: "windows-x64",
    files: files.map(({ rel, size_bytes, sha256: hash }) => ({ path: rel, size_bytes, sha256: hash })),
  };
  if (args.entry) body.entry_point = args.entry;
  if (args.notes) body.release_notes = args.notes;
  const build = await api(base, "POST", `/v1/developer/games/${args.game}/builds`, { token, body });

  const byPath = new Map(files.map((f) => [f.rel, f]));
  let sent = 0;
  for (const target of build.uploads) {
    const response = await fetch(target.upload_url, {
      method: "PUT",
      body: byPath.get(target.path).data,
    });
    if (!response.ok) throw new Error(`Uploading ${target.path} failed (${response.status}).`);
    log(`Uploaded ${++sent}/${build.uploads.length}: ${target.path}`);
  }

  const done = await api(base, "POST", `/v1/developer/builds/${build.id}/complete`, { token });
  if (done.problems.length) {
    done.problems.forEach((p) => log(`Problem: ${p}`));
    throw new Error("The build is not ready. Fix the problems above and run the command again.");
  }
  log(`Build ${args.version} is ready (${done.build.file_count} files, entry ${done.build.entry_point}).`);
  return done.build;
}

if (require.main === module) {
  run(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}

module.exports = { run, walk, parseArgs };
