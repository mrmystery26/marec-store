#!/usr/bin/env node
"use strict";
// Checks a built APK or AAB before it is uploaded.
//   APK: package name, version, minimum Android version, permissions, launcher activity, signature
//   AAB: it is a real bundle and it is signed
// Usage: node scripts/ci/check-apk.js --file X.apk --package com.x --version 1.2.3 --code 12 [--release]
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const ALLOWED_PERMISSIONS = new Set(["android.permission.INTERNET", "android.permission.REQUEST_INSTALL_PACKAGES"]);

function parseBadging(text) {
  const grab = (re) => (text.match(re) || [])[1] || null;
  return {
    package: grab(/^package: name='([^']+)'/m),
    versionCode: grab(/^package:.* versionCode='([^']+)'/m),
    versionName: grab(/^package:.* versionName='([^']*)'/m),
    // aapt2 prints minSdkVersion:'N'; the older aapt printed sdkVersion:'N'. Accept both.
    minSdk: grab(/^(?:minSdkVersion|sdkVersion):'(\d+)'/m),
    targetSdk: grab(/^targetSdkVersion:'(\d+)'/m),
    permissions: [...text.matchAll(/^uses-permission(?:-sdk-\d+)?: name='([^']+)'/gm)].map((m) => m[1]),
    launchable: /^launchable-activity: name='/m.test(text),
  };
}

function checkApk(badging, expected, signing) {
  const problems = [];
  const want = (label, got, wanted) => {
    if (String(got) !== String(wanted)) problems.push(`${label}: expected ${wanted}, found ${got}`);
  };
  want("package name", badging.package, expected.package);
  want("version name", badging.versionName, expected.version);
  want("version code", badging.versionCode, expected.code);
  want("minimum Android version (API)", badging.minSdk, expected.minSdk);
  if (!badging.launchable) problems.push("the app has no launcher activity, so it would not appear on the home screen");
  for (const permission of badging.permissions) {
    if (permission.startsWith(`${badging.package}.`)) continue; // permissions the app defines for itself
    if (!ALLOWED_PERMISSIONS.has(permission)) problems.push(`unexpected permission: ${permission}`);
  }
  if (signing) {
    if (!/^Verifies/m.test(signing)) problems.push("the signature did not verify");
    if (expected.release && /CN=Android Debug/i.test(signing)) problems.push("the release APK is signed with a debug certificate");
  }
  return problems;
}

function checkBundle(listing, signed) {
  const problems = [];
  if (!/base\/manifest\/AndroidManifest\.xml/.test(listing)) problems.push("the bundle has no base module manifest");
  if (!/BundleConfig\.pb/.test(listing)) problems.push("the bundle has no BundleConfig.pb");
  if (!signed) problems.push("the bundle is not signed");
  return problems;
}

function buildTool(name) {
  const home = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
  if (!home) throw new Error("ANDROID_HOME is not set.");
  const versions = fs.readdirSync(path.join(home, "build-tools")).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const dir = path.join(home, "build-tools", versions.at(-1));
  const file = [name, `${name}.bat`, `${name}.exe`].map((n) => path.join(dir, n)).find((p) => fs.existsSync(p));
  if (!file) throw new Error(`${name} was not found in ${dir}.`);
  return file;
}

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : null;
}

function main() {
  const file = arg("file");
  const release = process.argv.includes("--release");
  let problems;
  if (file.endsWith(".aab")) {
    const listing = execFileSync("unzip", ["-l", file], { encoding: "utf8" });
    const signed = /META-INF\/.*\.(SF|RSA|DSA|EC)/.test(listing);
    problems = checkBundle(listing, signed);
  } else {
    const badging = execFileSync(buildTool("aapt2"), ["dump", "badging", file], { encoding: "utf8", maxBuffer: 1 << 24 });
    let signing = "";
    try {
      signing = execFileSync(buildTool("apksigner"), ["verify", "--verbose", "--print-certs", file], { encoding: "utf8" });
    } catch (error) {
      signing = `${error.stdout || ""}${error.stderr || ""}`;
    }
    const parsed = parseBadging(badging);
    problems = checkApk(parsed, { package: arg("package"), version: arg("version"), code: arg("code"), minSdk: arg("min-sdk"), release }, signing);
    console.log(`${path.basename(file)}: ${parsed.package} ${parsed.versionName} (code ${parsed.versionCode}), minSdk ${parsed.minSdk}, targetSdk ${parsed.targetSdk}`);
    console.log(`permissions: ${parsed.permissions.join(", ") || "none"}`);
  }
  if (problems.length) {
    for (const p of problems) console.log(`::error::${path.basename(file)}: ${p}`);
    process.exit(1);
  }
  console.log(`${path.basename(file)}: all checks passed.`);
}

if (require.main === module) main();
module.exports = { parseBadging, checkApk, checkBundle };
