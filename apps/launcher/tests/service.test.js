"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { MarecApi } = require("../src/core/api");
const { LauncherService } = require("../src/core/service");
const I = require("../src/core/installer");
const H = require("./helpers");

const FILES = { "data/a.pck": H.randomBytes(50000), "game.exe": H.randomBytes(H.CHUNK + 5000) };

// A tiny stand-in for the real backend: library, install plan, launch authorization, keys.
async function fakeStore(t, { keyPair = H.newKeyPair(), kid = "kid-main" } = {}) {
  const signedManifest = H.signed(H.manifestFor(FILES), keyPair);
  const files = new Map(Object.entries(FILES).map(([p, d]) => [`/f/${p}`, d]));
  const downloads = await H.startServer(files);
  t.after(() => downloads.close());

  const state = { launches: [], plans: 0, latest: "1.0.0" };
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      const send = (status, json) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(json));
      };
      if (req.url.startsWith("/v1/me/library")) {
        return send(200, {
          items: [{ game_id: H.GAME_ID, slug: "g", title: "Game", latest_version: state.latest }],
        });
      }
      if (req.url === "/v1/launch/public-keys") {
        return send(200, {
          keys: [{ kid, alg: "EdDSA", use: "manifest", public_key: keyPair.publicKeyB64 }],
        });
      }
      if (req.url === `/v1/games/${H.GAME_ID}/install-plan`) {
        state.plans++;
        return send(200, {
          game_id: H.GAME_ID,
          build_id: H.BUILD_ID,
          kid,
          manifest_b64: signedManifest.input.manifestB64,
          manifest_signature: signedManifest.input.signatureB64,
          manifest_sha256: signedManifest.input.manifestSha256,
          downloads: Object.keys(FILES).map((p) => ({ path: p, url: downloads.url(`/f/${p}`) })),
        });
      }
      if (req.url === "/v1/launch/authorizations") {
        state.launches.push(JSON.parse(raw));
        return send(200, { token: "launch-token", kind: "online" });
      }
      send(404, { error: { code: "NOT_FOUND", message: "no" } });
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    return new Promise((done) => server.close(done));
  });
  return { base: `http://127.0.0.1:${server.address().port}`, state, signedManifest, keyPair, kid };
}

function serviceFor(base, extra = {}) {
  const tokens = { value: { accessToken: "a", refreshToken: "r" } };
  const api = new MarecApi({
    baseUrl: base,
    tokenStore: { load: () => tokens.value, save: () => {}, clear: () => {} },
  });
  return new LauncherService({
    api,
    installRoot: H.tempDir(),
    deviceId: "device-secret-abcdefghij",
    retries: 1,
    backoffMs: 1,
    ...extra,
  });
}

test("install verifies the signed manifest and installs the game", async (t) => {
  const store = await fakeStore(t);
  const service = serviceFor(store.base);

  const before = await service.library();
  assert.equal(before[0].installed, null);

  const progress = [];
  const record = await service.install(H.GAME_ID, (p) => progress.push(p));
  assert.equal(record.version, "1.0.0");
  assert.equal(progress.at(-1).done, progress.at(-1).total);

  const after = await service.library();
  assert.equal(after[0].installed.version, "1.0.0");
  assert.equal(after[0].update_available, false);
  const gameDir = I.gameDirFor(service.installRoot, H.GAME_ID);
  assert.deepEqual(fs.readFileSync(path.join(gameDir, "current", "game.exe")), FILES["game.exe"]);
  assert.equal((await service.verify(H.GAME_ID)).ok, true);

  store.state.latest = "1.1.0";
  assert.equal((await service.library())[0].update_available, true);
});

test("a manifest signed by an untrusted key is refused and nothing is installed", async (t) => {
  const store = await fakeStore(t);
  const service = serviceFor(store.base, {
    pinnedKeys: [{ kid: "kid-main", publicKey: H.newKeyPair().publicKeyB64 }], // a different key
  });
  await assert.rejects(service.install(H.GAME_ID), /signature/);
  assert.deepEqual(await I.listInstalled(service.installRoot), []);

  const unknown = serviceFor(store.base, { pinnedKeys: [{ kid: "other", publicKey: "AAAA" }] });
  await assert.rejects(unknown.install(H.GAME_ID), { code: "UNTRUSTED_KEY" });
});

test("pinned keys are used instead of whatever the server publishes", async (t) => {
  const store = await fakeStore(t);
  const service = serviceFor(store.base, {
    pinnedKeys: [{ kid: store.kid, publicKey: store.keyPair.publicKeyB64 }],
  });
  await service.install(H.GAME_ID);
  assert.equal((await I.listInstalled(service.installRoot)).length, 1);
});

test("play asks for a launch token for the installed build and hands it to the game", async (t) => {
  const store = await fakeStore(t);
  let started;
  const service = serviceFor(store.base, {
    startGameImpl: async (args) => {
      started = args;
      return { delivered: true };
    },
  });
  await assert.rejects(service.play(H.GAME_ID), { code: "NOT_INSTALLED" });
  await service.install(H.GAME_ID);
  const result = await service.play(H.GAME_ID);

  assert.equal(result.delivered, true);
  const request = store.state.launches[0];
  assert.equal(request.game_id, H.GAME_ID);
  assert.equal(request.build_id, H.BUILD_ID);
  assert.equal(request.device_id, "device-secret-abcdefghij");
  assert.match(request.nonce, /^[A-Za-z0-9_-]{8,64}$/);
  assert.equal(started.token, "launch-token");
  assert.equal(
    started.env.MAREC_DEVICE_HASH,
    require("node:crypto").createHash("sha256").update("device-secret-abcdefghij").digest("hex")
  );
  assert.equal(
    started.exePath,
    path.join(I.gameDirFor(service.installRoot, H.GAME_ID), "current", "game.exe")
  );
});

test("a damaged install is not launched", async (t) => {
  const store = await fakeStore(t);
  const service = serviceFor(store.base, { startGameImpl: async () => ({ delivered: true }) });
  await service.install(H.GAME_ID);
  const gameDir = I.gameDirFor(service.installRoot, H.GAME_ID);
  fs.rmSync(path.join(gameDir, "current", "game.exe"));
  await assert.rejects(service.play(H.GAME_ID), { code: "DAMAGED" });
  assert.equal(store.state.launches.length, 0); // no token is requested for a broken install
});

test("uninstall removes the game, and a second install of the same game is refused while busy", async (t) => {
  const store = await fakeStore(t);
  const service = serviceFor(store.base);
  await service.install(H.GAME_ID);
  await service.uninstall(H.GAME_ID);
  assert.deepEqual(await I.listInstalled(service.installRoot), []);

  service.jobs.set(H.GAME_ID, new AbortController());
  await assert.rejects(service.install(H.GAME_ID), { code: "BUSY" });
  await assert.rejects(service.uninstall(H.GAME_ID), { code: "BUSY" });
});
