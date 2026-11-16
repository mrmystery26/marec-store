#!/usr/bin/env node
"use strict";
// One place that decides the version of a build, so Windows and Android always agree.
//   version      from the VERSION file, or from the tag (v1.2.3) on a release build
//   build number the GitHub run number (also the Android versionCode, so it only ever goes up)
//   commit, date of this build
// Usage:  node scripts/ci/build-info.js [--write-renderer]
// Prints the values and, on GitHub Actions, writes them to $GITHUB_OUTPUT.
const fs = require("node:fs");
const path = require("node:path");

const SEMVER = /^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$/;

function computeBuildInfo({ refType, refName, runNumber, sha, versionFile, now = new Date() }) {
  const fileVersion = String(versionFile || "").trim();
  if (!SEMVER.test(fileVersion)) throw new Error(`The VERSION file must contain a version like 0.2.0, but it contains "${fileVersion}".`);
  let version = fileVersion;
  const isTag = refType === "tag";
  if (isTag) {
    if (!/^v/.test(refName) || !SEMVER.test(refName.slice(1))) {
      throw new Error(`The tag "${refName}" is not a version tag. Use a name like v0.2.0 or v0.2.0-beta.1.`);
    }
    version = refName.slice(1);
  }
  const build = Math.max(1, Number.parseInt(runNumber, 10) || 1);
  return {
    version,
    build,
    versionCode: build,
    commit: String(sha || "unknown").slice(0, 7),
    date: now.toISOString(),
    isTag,
    prerelease: version.includes("-"),
    versionFileMismatch: isTag && version !== fileVersion,
    suffix: isTag ? version : `${version}-build${build}`,
  };
}

function rendererFile(info) {
  const data = { version: info.version, build: info.build, commit: info.commit, date: info.date };
  return `"use strict";
// Written by scripts/ci/build-info.js during a build. Do not edit.
(function (host) {
  const info = ${JSON.stringify(data)};
  if (typeof module !== "undefined" && module.exports) module.exports = info;
  else (host.MarecUI = host.MarecUI || {})["build-info"] = info;
})(typeof window !== "undefined" ? window : globalThis);
`;
}

function main() {
  const root = path.resolve(__dirname, "..", "..");
  const env = process.env;
  const info = computeBuildInfo({
    refType: env.GITHUB_REF_TYPE || "branch",
    refName: env.GITHUB_REF_NAME || "local",
    runNumber: env.GITHUB_RUN_NUMBER,
    sha: env.GITHUB_SHA,
    versionFile: fs.readFileSync(path.join(root, "VERSION"), "utf8"),
    // Later jobs reuse the first job's date, so every file in one build says the same thing.
    now: env.BUILD_DATE ? new Date(env.BUILD_DATE) : new Date(),
  });
  if (process.argv.includes("--write-renderer")) {
    fs.writeFileSync(path.join(root, "apps/launcher/src/renderer/js/build-info.js"), rendererFile(info));
  }
  if (info.versionFileMismatch) console.log(`::notice::The tag says ${info.version} but the VERSION file says something else. The tag wins for this build.`);
  console.log(JSON.stringify(info, null, 2));
  if (env.GITHUB_OUTPUT) {
    const lines = Object.entries(info).map(([k, v]) => `${k}=${v}`).join("\n");
    fs.appendFileSync(env.GITHUB_OUTPUT, `${lines}\n`);
  }
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.log(`::error::${error.message}`);
    process.exit(1);
  }
}
module.exports = { computeBuildInfo, rendererFile };
