"use strict";
// The launcher's brain: ties the backend, verification, installing and starting games together.
// The Electron window only calls these methods; nothing here depends on Electron.
const crypto = require("node:crypto");
const os = require("node:os");
const { verifyManifest } = require("./manifest");
const installer = require("./installer");
const { startGame } = require("./launch");

class LauncherError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

class LauncherService {
  /**
   * @param {object} o api (MarecApi), installRoot, deviceId, pinnedKeys ([{kid, publicKey}]),
   *   fetchImpl, startGameImpl, deviceLabel
   * With no pinned keys the launcher trusts the key the server publishes. That is only
   * acceptable for development builds; release builds must ship pinned keys.
   */
  constructor(o) {
    this.api = o.api;
    this.installRoot = o.installRoot;
    this.deviceId = o.deviceId;
    this.pinnedKeys = o.pinnedKeys || [];
    this.fetchImpl = o.fetchImpl;
    this.startGameImpl = o.startGameImpl || startGame;
    this.deviceLabel = o.deviceLabel || os.hostname();
    this.retries = o.retries;
    this.backoffMs = o.backoffMs;
    this.jobs = new Map();
  }

  async manifestKey(kid) {
    const pinned = this.pinnedKeys.find((k) => k.kid === kid);
    if (pinned) return pinned.publicKey;
    if (this.pinnedKeys.length > 0) {
      throw new LauncherError("UNTRUSTED_KEY", "This build is signed with a key the launcher does not trust.");
    }
    const { keys } = await this.api.publicKeys();
    const found = keys.find((k) => k.use === "manifest" && k.kid === kid);
    if (!found) throw new LauncherError("UNTRUSTED_KEY", "The signing key for this build is unknown.");
    return found.public_key;
  }

  async library() {
    const page = await this.api.library(50, 0);
    const installed = new Map((await installer.listInstalled(this.installRoot)).map((r) => [r.game_id, r]));
    return page.items.map((item) => {
      const record = installed.get(item.game_id.toLowerCase());
      return {
        ...item,
        installed: record ? { version: record.version, installed_at: record.installed_at } : null,
        busy: this.jobs.has(item.game_id),
        update_available: Boolean(
          record && item.latest_version && item.latest_version !== record.version
        ),
      };
    });
  }

  linksFrom(plan) {
    return new Map(plan.downloads.map((d) => [d.path, d.url]));
  }

  /** Downloads, verifies and installs the newest build the player owns. */
  async install(gameId, onProgress = () => {}) {
    if (this.jobs.has(gameId)) throw new LauncherError("BUSY", "This game is already being installed.");
    const controller = new AbortController();
    this.jobs.set(gameId, controller);
    try {
      const plan = await this.api.installPlan(gameId);
      const publicKeyB64 = await this.manifestKey(plan.kid);
      const { manifest, bytes } = verifyManifest(
        {
          manifestB64: plan.manifest_b64,
          signatureB64: plan.manifest_signature,
          manifestSha256: plan.manifest_sha256,
          publicKeyB64,
        },
        { gameId: plan.game_id, buildId: plan.build_id }
      );
      return await installer.installBuild({
        gameDir: installer.gameDirFor(this.installRoot, manifest.game_id),
        manifest,
        manifestBytes: bytes,
        signatureB64: plan.manifest_signature,
        kid: plan.kid,
        manifestSha256: plan.manifest_sha256,
        links: this.linksFrom(plan),
        refreshLinks: async () => {
          const fresh = await this.api.installPlan(gameId);
          if (fresh.build_id !== plan.build_id) {
            throw new LauncherError("BUILD_CHANGED", "A new version was released. Please try again.");
          }
          return this.linksFrom(fresh);
        },
        fetchImpl: this.fetchImpl,
        signal: controller.signal,
        onProgress,
        retries: this.retries,
        backoffMs: this.backoffMs,
      });
    } finally {
      this.jobs.delete(gameId);
    }
  }

  cancel(gameId) {
    const job = this.jobs.get(gameId);
    if (job) job.abort();
  }

  /** Asks the backend for a launch token, then starts the game and hands it over. */
  async play(gameId) {
    const gameDir = installer.gameDirFor(this.installRoot, gameId);
    const record = await installer.readInstalled(gameDir);
    if (!record) throw new LauncherError("NOT_INSTALLED", "Install the game first.");
    const check = await installer.quickVerify(gameDir);
    if (!check.ok) {
      throw new LauncherError("DAMAGED", "Some game files are missing or changed. Use Verify files.");
    }
    const auth = await this.api.authorizeLaunch({
      game_id: record.game_id,
      build_id: record.build_id,
      device_id: this.deviceId,
      device_label: this.deviceLabel,
      nonce: crypto.randomBytes(12).toString("base64url"),
    });
    return this.startGameImpl({
      exePath: installer.entryPath(gameDir, record),
      token: auth.token,
      // Not a secret: lets the game notice a token that was issued for a different PC.
      env: { MAREC_DEVICE_HASH: crypto.createHash("sha256").update(this.deviceId).digest("hex") },
    });
  }

  verify(gameId, onProgress) {
    return installer.verifyInstall(installer.gameDirFor(this.installRoot, gameId), onProgress);
  }

  async uninstall(gameId) {
    if (this.jobs.has(gameId)) throw new LauncherError("BUSY", "Cancel the install first.");
    await installer.uninstall(installer.gameDirFor(this.installRoot, gameId));
  }
}

module.exports = { LauncherService, LauncherError };
