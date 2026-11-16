"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { startGame } = require("../src/core/launch");
const H = require("./helpers");

// Behaves like the SDK: connect, present the secret, read one line, write it to a file, leave.
function fakeGame(dir) {
  const file = path.join(dir, "fake-game.js");
  fs.writeFileSync(
    file,
    `const net = require("net"); const fs = require("fs");
     const [host, port] = process.env.MAREC_LAUNCH_ADDR.split(":");
     const socket = net.connect(Number(port), host, () => socket.write(process.env.MAREC_LAUNCH_SECRET + "\\n"));
     let text = "";
     socket.on("data", (d) => {
       text += d;
       if (text.includes("\\n")) { fs.writeFileSync(process.argv[2], text); socket.destroy(); process.exit(0); }
     });
     socket.on("error", () => process.exit(3));`
  );
  return file;
}

test("the game receives its token over loopback, exactly once", async () => {
  const dir = H.tempDir();
  const out = path.join(dir, "received.txt");
  const result = await startGame({
    exePath: process.execPath,
    args: [fakeGame(dir), out],
    token: "token-abc.def.ghi",
  });
  assert.equal(result.delivered, true);
  assert.equal(await result.exited, 0);
  assert.equal(fs.readFileSync(out, "utf8"), "token-abc.def.ghi\n");
});

test("the token never appears on the command line", async () => {
  const dir = H.tempDir();
  const result = await startGame({
    exePath: process.execPath,
    args: [fakeGame(dir), path.join(dir, "x.txt")],
    token: "secret-token-value",
  });
  assert.equal(result.child.spawnargs.join(" ").includes("secret-token-value"), false);
  await result.exited;
});

// Connects like an unrelated program would and reports whatever it gets back.
function probe(port, firstLine, waitMs = 300) {
  return new Promise((resolve) => {
    let received = "";
    const socket = net.connect(port, "127.0.0.1", () => {
      if (firstLine !== null) socket.write(`${firstLine}\n`);
    });
    socket.setEncoding("utf8");
    socket.on("data", (d) => (received += d));
    socket.on("error", () => resolve({ received, refused: true }));
    socket.on("close", () => resolve({ received, refused: false }));
    setTimeout(() => {
      socket.destroy();
      resolve({ received, refused: false });
    }, waitMs);
  });
}

test("programs without the secret get nothing and cannot use up the delivery", async () => {
  const dir = H.tempDir();
  const out = path.join(dir, "received.txt");
  const go = path.join(dir, "go");
  const gameFile = fakeGame(dir);
  // The real game only starts connecting once the file "go" exists, so the intruders arrive first.
  const gated = path.join(dir, "gated.js");
  fs.writeFileSync(
    gated,
    `const fs = require("fs");
     const timer = setInterval(() => {
       if (fs.existsSync(${JSON.stringify(go)})) { clearInterval(timer); require(${JSON.stringify(gameFile)}); }
     }, 20);`
  );

  let attacks;
  const result = await startGame({
    exePath: process.execPath,
    args: [gated, out],
    token: "real-token",
    timeoutMs: 10000,
    onListening: ({ port }) => {
      attacks = (async () => {
        const silent = await probe(port, null, 150);
        const guessing = await probe(port, "not-the-secret", 150);
        fs.writeFileSync(go, "");
        return { silent, guessing };
      })();
    },
  });

  const { silent, guessing } = await attacks;
  assert.equal(silent.received, "");
  assert.equal(guessing.received, "");
  assert.equal(result.delivered, true); // the genuine game still got its token
  await result.exited;
  assert.equal(fs.readFileSync(out, "utf8"), "real-token\n");
});

test("once the token is delivered the port is closed", async () => {
  const dir = H.tempDir();
  const result = await startGame({
    exePath: process.execPath,
    args: [fakeGame(dir), path.join(dir, "received.txt")],
    token: "only-once",
  });
  assert.equal(result.delivered, true);
  await result.exited;
  const late = await probe(result.port, "anything", 300);
  assert.equal(late.refused, true);
});

test("a game that never asks for its token is reported", async () => {
  const result = await startGame({
    exePath: process.execPath,
    args: ["-e", "setTimeout(() => {}, 400)"],
    token: "unused",
    timeoutMs: 100,
  });
  assert.equal(result.delivered, false);
  await result.exited;
});

test("a program that cannot start is reported without hanging", async () => {
  const result = await startGame({
    exePath: path.join(H.tempDir(), "missing.exe"),
    token: "unused",
    timeoutMs: 2000,
  });
  assert.equal(result.delivered, false);
  assert.equal(await result.exited, null);
});
