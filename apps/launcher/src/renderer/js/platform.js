"use strict";
// Which kind of device this window runs on, and which games it can run. The same renderer is used by
// the Windows launcher and the Android app; the Android app injects `window.MarecAndroid`.
(function (host) {
  const NAMES = { windows: "Windows PC", android: "Android" };

  /** Store build platforms ("windows-x64", "android-arm64") -> ids ("windows", "android"). */
  function normalizePlatforms(raw) {
    const ids = [];
    for (const entry of Array.isArray(raw) ? raw : []) {
      const text = String(entry).toLowerCase();
      const id = text.startsWith("windows") ? "windows" : text.startsWith("android") ? "android" : null;
      if (id && !ids.includes(id)) ids.push(id);
    }
    // The store only accepts Windows builds today, so a game with no platform list is a Windows game.
    return ids.length ? ids : ["windows"];
  }

  function createPlatform(h = host) {
    const kind = h.MarecAndroid ? "android" : "windows";
    return {
      kind,
      mobile: kind === "android",
      name: NAMES[kind],
      names: (ids) => (ids && ids.length ? ids : ["windows"]).map((id) => NAMES[id] || id),
      /** True when a game that ships for `ids` can be installed and played on this device. */
      canRun: (ids) => (ids && ids.length ? ids : ["windows"]).includes(kind),
    };
  }

  const api = { createPlatform, normalizePlatforms, NAMES };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else (host.MarecUI = host.MarecUI || {}).platform = api;
})(typeof window !== "undefined" ? window : globalThis);
