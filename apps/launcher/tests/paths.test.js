"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { validateRelativePath, safeJoin } = require("../src/core/paths");

test("safe paths are accepted", () => {
  for (const p of ["game.exe", "data/level1.pck", "Data/Textures/hero_01.png", "a b/c.txt"]) {
    assert.equal(validateRelativePath(p), null, p);
  }
});

test("unsafe paths are rejected", () => {
  const bad = [
    "", "../evil.dll", "data/../../evil.dll", "/etc/passwd", "C:/Windows/x.dll", "a\\b.dll",
    "a//b.txt", "a/./b.txt", "CON", "data/nul.txt", "com1.dat", "ends.with.dot.", "dir /file.txt",
    "setup.bat", "tools/run.PS1", "installer.msi", "what?.png", "stream.txt:hidden", "tab\there",
    "a".repeat(300), null, 42,
  ];
  for (const p of bad) assert.notEqual(validateRelativePath(p), null, String(p));
});

test("safeJoin stays inside the root", () => {
  const root = path.resolve("/tmp/marec-root");
  assert.equal(safeJoin(root, "data/a.pck"), path.join(root, "data", "a.pck"));
  for (const p of ["../x.exe", "/abs.exe", "a/../../x.exe", "C:/x.exe"]) {
    assert.throws(() => safeJoin(root, p), /Unsafe path/);
  }
});
