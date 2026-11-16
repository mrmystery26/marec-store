"use strict";
// Small file-backed stores: plain settings, and secrets encrypted with the operating system
// (Windows DPAPI through Electron's safeStorage). Secrets are never written in plain text.
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

class JsonFile {
  constructor(file) {
    this.file = file;
  }
  read(fallback = {}) {
    try {
      return JSON.parse(fs.readFileSync(this.file, "utf8"));
    } catch {
      return fallback;
    }
  }
  write(value) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(value, null, 2));
    fs.renameSync(temp, this.file);
  }
}

class SecureStore {
  /** provider needs available(), encrypt(string) -> Buffer, decrypt(Buffer) -> string. */
  constructor(file, provider) {
    this.file = file;
    this.provider = provider;
  }
  load() {
    try {
      const raw = Buffer.from(fs.readFileSync(this.file, "utf8"), "base64");
      return JSON.parse(this.provider.decrypt(raw));
    } catch {
      return null;
    }
  }
  save(value) {
    if (!this.provider.available()) {
      throw new Error("Secure storage is not available on this PC, so nothing was saved.");
    }
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const encrypted = this.provider.encrypt(JSON.stringify(value));
    fs.writeFileSync(this.file, encrypted.toString("base64"));
  }
  clear() {
    fs.rmSync(this.file, { force: true });
  }
}

/** The random per-PC secret that identifies this launcher to the backend (only its hash is sent on). */
function loadOrCreateDeviceId(store) {
  const existing = store.load();
  if (existing && typeof existing.deviceId === "string" && existing.deviceId.length >= 16) {
    return existing.deviceId;
  }
  const deviceId = crypto.randomBytes(24).toString("base64url");
  store.save({ deviceId });
  return deviceId;
}

module.exports = { JsonFile, SecureStore, loadOrCreateDeviceId };
