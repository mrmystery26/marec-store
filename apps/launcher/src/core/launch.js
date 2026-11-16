"use strict";
// Starts a game and hands it its launch token over a private loopback connection. The token is
// never put on the command line (other programs can read command lines) and is delivered once.
//
// The game learns where to connect (MAREC_LAUNCH_ADDR) and a one-time secret
// (MAREC_LAUNCH_SECRET) from its environment. A connection that does not present the secret is
// dropped without using up the delivery, so another program on this PC cannot snatch the token by
// connecting first.
const crypto = require("node:crypto");
const net = require("node:net");
const path = require("node:path");
const { spawn } = require("node:child_process");

function sameSecret(given, expected) {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * @returns {Promise<{child, delivered: boolean, exited: Promise<number|null>, port: number}>}
 *   `delivered` is false if the game never asked for its token within timeoutMs.
 */
async function startGame({
  exePath,
  args = [],
  token,
  env = {},
  timeoutMs = 60000,
  handshakeMs = 3000,
  onListening = () => {},
}) {
  const secret = crypto.randomBytes(16).toString("hex");
  let handedOver = false;
  let finish;
  const delivery = new Promise((resolve) => (finish = resolve));

  const server = net.createServer((socket) => {
    let received = "";
    socket.setEncoding("utf8");
    socket.on("error", () => {});
    const timer = setTimeout(() => socket.destroy(), handshakeMs);
    socket.on("close", () => clearTimeout(timer));
    socket.on("data", (chunk) => {
      if (handedOver) return;
      received += chunk;
      if (received.length > 256) return socket.destroy();
      const end = received.indexOf("\n");
      if (end === -1) return;
      clearTimeout(timer);
      if (!sameSecret(received.slice(0, end).trim(), secret)) return socket.destroy();
      handedOver = true;
      socket.write(`${token}\n`);
      // Keep the connection open briefly so the game can read it; it closes when the game does.
      socket.setTimeout(3000, () => socket.destroy());
      server.close();
      finish(true);
    });
  });
  server.on("error", () => finish(false));
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  onListening({ port });

  const child = spawn(exePath, args, {
    cwd: path.dirname(exePath),
    env: {
      ...process.env,
      ...env,
      MAREC_LAUNCH_ADDR: `127.0.0.1:${port}`,
      MAREC_LAUNCH_SECRET: secret,
    },
    stdio: "ignore",
  });
  const exited = new Promise((resolve) => {
    child.on("exit", (code) => resolve(code));
    child.on("error", () => resolve(null));
  });

  const timer = setTimeout(() => finish(false), timeoutMs);
  const delivered = await Promise.race([delivery, exited.then(() => handedOver)]);
  clearTimeout(timer);
  if (!handedOver) server.close();
  return { child, delivered, exited, port };
}

module.exports = { startGame };
