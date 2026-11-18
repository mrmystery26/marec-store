"use strict";
// The Windows launcher's window talks to its main process by named channels. Electron itself cannot run
// in these tests, so this checks the two files agree: a typo in a channel name would otherwise only
// show up as a button that does nothing.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const read = (file) => fs.readFileSync(path.join(__dirname, "../src/main", file), "utf8");
const used = [...read("preload.js").matchAll(/call\("([\w:]+)"/g)].map((m) => m[1]);
const handled = [...read("main.js").matchAll(/handle\("([\w:]+)"/g)].map((m) => m[1]);

test("every action the window can ask for has a handler in the main process", () => {
  assert.ok(used.length > 20);
  assert.deepEqual(used.filter((channel) => !handled.includes(channel)), []);
});

test("the main process answers nothing the window cannot ask for", () => {
  assert.deepEqual(handled.filter((channel) => !used.includes(channel)), []);
});

test("friends handlers check their input before calling the store", () => {
  const main = read("main.js");
  for (const channel of ["friends:accept", "friends:decline", "friends:cancel", "friends:remove"]) {
    const line = main.split("\n").find((l) => l.includes(`handle("${channel}"`));
    assert.match(line, /requireId\(/, `${channel} must check that the id is a UUID`);
  }
  const send = main.split("\n").find((l) => l.includes('handle("friends:send"'));
  assert.match(send, /requireText\(/);
});
