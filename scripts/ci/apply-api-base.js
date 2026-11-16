#!/usr/bin/env node
"use strict";
// Points the Windows launcher at the real store. Reads MAREC_API_BASE_URL (a GitHub repository variable)
// and writes it as the default server in launcher.config.json. Players can still change it in Settings.
const fs = require("node:fs");
const path = require("node:path");

function applyApiBase(configPath, value) {
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const text = String(value || "").trim();
  if (!text) return { changed: false, apiBase: config.defaultApiBase };
  const url = new URL(text);
  if (!["https:", "http:"].includes(url.protocol)) throw new Error("MAREC_API_BASE_URL must start with https:// (or http:// for a test server).");
  config.defaultApiBase = url.origin + url.pathname.replace(/\/+$/, "");
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
  return { changed: true, apiBase: config.defaultApiBase };
}

if (require.main === module) {
  const target = process.argv[2] || path.resolve(__dirname, "../../apps/launcher/launcher.config.json");
  try {
    const result = applyApiBase(target, process.env.MAREC_API_BASE_URL);
    if (result.changed) console.log(`Default store server: ${result.apiBase}`);
    else console.log(`::warning::The repository variable MAREC_API_BASE_URL is not set, so the app defaults to ${result.apiBase}. Players can change it in Settings, but you probably want to set it (see docs/GITHUB_ACTIONS.md).`);
  } catch (error) {
    console.log(`::error::${error.message}`);
    process.exit(1);
  }
}
module.exports = { applyApiBase };
