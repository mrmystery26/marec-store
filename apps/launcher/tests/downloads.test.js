"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createDownloads } = require("../src/renderer/js/downloads");

const flush = () => new Promise((resolve) => setImmediate(resolve));

function setup(limit = 1) {
  const started = [];
  const finish = new Map();
  const cancelled = [];
  const done = [];
  let clock = 0;
  const api = {
    install: (id) => new Promise((resolve) => {
      started.push(id);
      finish.set(id, (result) => resolve(result));
    }),
    cancel: (id) => {
      cancelled.push(id);
      finish.get(id)({ ok: false, error: { code: "CANCELLED", message: "Cancelled." } });
    },
  };
  const manager = createDownloads({ api, limit, now: () => clock, onDone: (e) => done.push([e.item.game_id, e.status]) });
  return { manager, started, finish, cancelled, done, tick: (ms) => (clock += ms) };
}

test("only one game downloads at a time and the next one starts when it finishes", async () => {
  const { manager, started, finish, done } = setup(1);
  manager.enqueue({ game_id: "a" });
  manager.enqueue({ game_id: "b" });
  assert.deepEqual(started, ["a"]);
  assert.equal(manager.statusOf("b"), "queued");
  assert.equal(manager.enqueue({ game_id: "a" }), false); // already busy

  finish.get("a")({ ok: true, data: { version: "1.0.0" } });
  await flush();
  assert.deepEqual(started, ["a", "b"]);
  assert.deepEqual(done, [["a", "completed"]]);
});

test("pause keeps the entry so resume can continue; cancel forgets it", async () => {
  const { manager, started, finish, done } = setup(1);
  manager.enqueue({ game_id: "a" });
  manager.handleProgress({ gameId: "a", done: 40, total: 100 });
  manager.pause("a");
  await flush();
  assert.equal(manager.statusOf("a"), "paused");
  assert.equal(manager.progress("a").percent, 40);

  manager.resume("a");
  assert.equal(manager.statusOf("a"), "downloading");
  assert.deepEqual(started, ["a", "a"]);

  manager.cancel("a");
  await flush();
  assert.equal(manager.statusOf("a"), null);
  assert.deepEqual(done.map((d) => d[1]), ["paused", "cancelled"]);
  assert.equal(finish.size, 1);
});

test("speed and time left come from real progress events", () => {
  const { manager, tick } = setup(1);
  manager.enqueue({ game_id: "a" });
  tick(1000);
  manager.handleProgress({ gameId: "a", done: 1000, total: 5000 });
  const p = manager.progress("a");
  assert.equal(p.speed, 1000);
  assert.equal(p.eta, 4);
  assert.equal(manager.handleProgress({ gameId: "unknown", done: 1, total: 2 }), false);
});

test("a failed download is reported and does not block the queue", async () => {
  const { manager, finish, done, started } = setup(1);
  manager.enqueue({ game_id: "a" });
  manager.enqueue({ game_id: "b" });
  finish.get("a")({ ok: false, error: { code: "NOT_OWNED", message: "no" } });
  await flush();
  assert.deepEqual(done, [["a", "failed"]]);
  assert.deepEqual(started, ["a", "b"]);
});
