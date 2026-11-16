"use strict";
// The build-pipeline helper scripts (versioning, Android assets, API address, APK checks).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const root = path.resolve(__dirname, "../../..");
const { computeBuildInfo, rendererFile } = require(path.join(root, "scripts/ci/build-info"));
const { applyApiBase } = require(path.join(root, "scripts/ci/apply-api-base"));
const { prepareAssets } = require(path.join(root, "scripts/android/prepare-assets"));
const { parseBadging, checkApk, checkBundle } = require(path.join(root, "scripts/ci/check-apk"));

const NOW = new Date("2026-11-16T10:00:00Z");
const base = { refType: "branch", refName: "main", runNumber: "42", sha: "abcdef1234567890", versionFile: "0.3.0\n", now: NOW };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "marec-"));

test("a push build uses the VERSION file and the run number", () => {
  const info = computeBuildInfo(base);
  assert.deepEqual([info.version, info.build, info.versionCode, info.commit, info.suffix, info.isTag, info.prerelease],
    ["0.3.0", 42, 42, "abcdef1", "0.3.0-build42", false, false]);
  assert.equal(info.date, "2026-11-16T10:00:00.000Z");
});

test("a version tag decides the version for both platforms", () => {
  const info = computeBuildInfo({ ...base, refType: "tag", refName: "v1.0.0-beta.1" });
  assert.deepEqual([info.version, info.suffix, info.prerelease, info.versionFileMismatch], ["1.0.0-beta.1", "1.0.0-beta.1", true, true]);
  assert.equal(computeBuildInfo({ ...base, refType: "tag", refName: "v0.3.0" }).versionFileMismatch, false);
});

test("bad tags and a bad VERSION file stop the build with a clear message", () => {
  for (const name of ["v1.0", "1.0.0", "vfoo", "v1.2.3.4"]) {
    assert.throws(() => computeBuildInfo({ ...base, refType: "tag", refName: name }), /not a version tag/);
  }
  assert.throws(() => computeBuildInfo({ ...base, versionFile: "latest" }), /VERSION file/);
});

test("the build info file is real JavaScript the app can load", () => {
  const file = path.join(tmp(), "build-info.js");
  fs.writeFileSync(file, rendererFile(computeBuildInfo(base)));
  assert.deepEqual(require(file), { version: "0.3.0", build: 42, commit: "abcdef1", date: "2026-11-16T10:00:00.000Z" });
});

test("the store address is written into the Windows launcher config", () => {
  const file = path.join(tmp(), "launcher.config.json");
  fs.writeFileSync(file, JSON.stringify({ defaultApiBase: "http://localhost:8000", other: 1 }));
  assert.equal(applyApiBase(file, "").changed, false);
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).defaultApiBase, "http://localhost:8000");
  assert.equal(applyApiBase(file, " https://api.marec.example/ ").apiBase, "https://api.marec.example");
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { defaultApiBase: "https://api.marec.example", other: 1 });
  assert.throws(() => applyApiBase(file, "ftp://x"), /https/);
});

test("the Android assets are the shared interface plus the browser-ready API client", () => {
  const out = path.join(tmp(), "assets");
  prepareAssets({ rendererDir: path.join(root, "apps/launcher/src/renderer"), apiClient: path.join(root, "apps/launcher/src/core/api.js"), outDir: out });
  const html = fs.readFileSync(path.join(out, "index.html"), "utf8");
  assert.ok(html.indexOf('js/marec-api.js') > 0 && html.indexOf("js/marec-api.js") < html.indexOf("js/platform-android.js"), "the API client loads before the Android bridge");
  assert.equal(html.includes("<!-- android-api -->"), false);
  for (const f of ["app.js", "js/platform-android.js", "css/mobile.css", "js/views-search.js"]) assert.ok(fs.existsSync(path.join(out, f)), f);

  // run the generated client the way a browser would
  const fakeWindow = {};
  new Function("window", fs.readFileSync(path.join(out, "js/marec-api.js"), "utf8"))(fakeWindow);
  const { MarecApi, ApiError, cleanGamesQuery } = fakeWindow.MarecUI.api;
  assert.equal(typeof MarecApi, "function");
  assert.equal(typeof ApiError, "function");
  assert.deepEqual(cleanGamesQuery({ q: " x " }), { q: "x", limit: 24, offset: 0 });
});

const BADGING = `package: name='com.marecstudios.store' versionCode='42' versionName='0.3.0' platformBuildVersionName='14'
sdkVersion:'24'
uses-permission: name='android.permission.INTERNET'
uses-permission: name='android.permission.REQUEST_INSTALL_PACKAGES'
uses-permission: name='com.marecstudios.store.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION'
targetSdkVersion:'34'
launchable-activity: name='com.marecstudios.store.MainActivity'  label='' icon=''
`;
const EXPECTED = { package: "com.marecstudios.store", version: "0.3.0", code: "42", minSdk: "24", release: true };
const GOOD_SIGNATURE = "Verifies\nSigner #1 certificate DN: CN=MAREC Studios, O=MAREC\n";

test("a correct APK passes every check", () => {
  const parsed = parseBadging(BADGING);
  assert.deepEqual([parsed.package, parsed.versionCode, parsed.versionName, parsed.minSdk, parsed.targetSdk, parsed.launchable], ["com.marecstudios.store", "42", "0.3.0", "24", "34", true]);
  assert.deepEqual(checkApk(parsed, EXPECTED, GOOD_SIGNATURE), []);
});

test("wrong id, version, minimum Android, permissions or signing are all reported", () => {
  const bad = BADGING.replace("com.marecstudios.store' versionCode='42'", "com.other.app' versionCode='1'").replace("sdkVersion:'24'", "sdkVersion:'21'")
    + "uses-permission: name='android.permission.READ_CONTACTS'\n";
  const problems = checkApk(parseBadging(bad), EXPECTED, "DOES NOT VERIFY\n");
  for (const part of ["package name", "version code", "minimum Android", "READ_CONTACTS", "signature did not verify"]) {
    assert.ok(problems.some((p) => p.includes(part)), part);
  }
  assert.ok(checkApk(parseBadging(BADGING), EXPECTED, "Verifies\nSigner #1 certificate DN: CN=Android Debug, O=Android\n").some((p) => /debug certificate/.test(p)));
  assert.ok(checkApk(parseBadging(BADGING.replace(/^launchable-activity.*$/m, "")), EXPECTED, GOOD_SIGNATURE).some((p) => /launcher activity/.test(p)));
});

test("a bundle must be a real, signed AAB", () => {
  const listing = "  base/manifest/AndroidManifest.xml\n  BundleConfig.pb\n  META-INF/MARECSTU.SF\n";
  assert.deepEqual(checkBundle(listing, true), []);
  assert.equal(checkBundle(listing, false).length, 1);
  assert.equal(checkBundle("nothing useful", true).length, 2);
});
