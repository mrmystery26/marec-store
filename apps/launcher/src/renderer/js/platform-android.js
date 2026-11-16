"use strict";
// The Android app's version of `window.marec` (the same calls the Windows launcher offers).
//
// It reuses the launcher's own API client (login, silent token refresh, error mapping), and only swaps
// two things for native ones: HTTP requests (so the phone talks to the store without browser CORS
// limits) and token storage (Android Keystore through encrypted preferences).
//
// Windows games cannot run on a phone, so install/play/verify/uninstall of those are refused here.
// The only install path is an optional Android build (APK) on a game: it is downloaded, checked
// against its SHA-256, and handed to Android's own installer, which asks the player to confirm.
(function (host) {
  const failure = (code, message) => Object.assign(new Error(message), { code });

  /**
   * native: the object Android injects as window.MarecAndroid.
   * hub:    where the app receives answers from native code (hub.on(type, id, payload)).
   */
  function createAndroidBridge({ native, hub, MarecApi }) {
    const info = () => JSON.parse(native.info());

    // ---- native HTTP, used instead of fetch
    const waiting = new Map();
    let counter = 0;
    const nextId = (prefix) => `${prefix}${++counter}`;
    const progressListeners = new Set();
    const downloads = new Map(); // game id -> native download id

    hub.on = (type, id, payload) => {
      const entry = waiting.get(id);
      if (!entry) return;
      if (type === "http") {
        waiting.delete(id);
        if (payload.error) entry.reject(new Error(payload.error));
        else entry.resolve(payload);
      } else if (type === "apk") {
        if (payload.state === "progress") {
          for (const listener of progressListeners) listener({ gameId: entry.gameId, done: payload.done, total: payload.total });
          return;
        }
        waiting.delete(id);
        downloads.delete(entry.gameId);
        if (payload.state === "done") entry.resolve({ version: entry.version, pending: true });
        else entry.reject(failure(payload.code || "ERROR", payload.message || "The download failed."));
      }
    };

    const fetchImpl = (url, init = {}) =>
      new Promise((resolve, reject) => {
        const id = nextId("h");
        waiting.set(id, { resolve, reject });
        native.httpRequest(id, init.method || "GET", String(url), JSON.stringify(init.headers || {}), init.body == null ? "" : String(init.body));
      }).then((res) => ({ ok: res.status >= 200 && res.status < 300, status: res.status, text: () => Promise.resolve(res.body) }));

    // ---- login tokens live in Android's encrypted storage
    const tokenStore = {
      load() {
        try {
          return JSON.parse(native.secureGet("tokens") || "null");
        } catch {
          return null;
        }
      },
      save: (tokens) => native.secureSet("tokens", JSON.stringify(tokens)),
      clear: () => native.secureRemove("tokens"),
    };

    // ---- server address: chosen in Settings, or the one this build was made for
    const apiBase = () => native.settingGet("apiBase") || info().defaultApiBase || "";
    let cached = null;
    function api() {
      const base = apiBase();
      if (!base) throw failure("NO_SERVER", "Set the store server address in Settings first.");
      if (!cached || cached.base !== base) cached = { base, client: new MarecApi({ baseUrl: base, tokenStore, fetchImpl }) };
      return cached.client;
    }

    const wrap = (fn) => async (...args) => {
      try {
        return { ok: true, data: await fn(...args) };
      } catch (error) {
        return { ok: false, error: { code: error.code || "ERROR", message: error.message || "Something went wrong." } };
      }
    };
    const onlyOnWindows = () => {
      throw failure("UNSUPPORTED_PLATFORM", "Windows games can only be installed and played with the Windows launcher on a PC.");
    };

    // ---- library: whatever the player owns; nothing is installed through the Windows path
    let lastLibrary = new Map();
    async function listLibrary() {
      const items = [];
      for (let offset = 0; offset < 400; offset += 50) {
        const page = await api().library(50, offset);
        items.push(...page.items);
        if (items.length >= page.total) break;
      }
      // The store only holds Windows builds today, so owned games are Windows games.
      const out = items.map((item) => ({ ...item, installed: null, busy: false, update_available: false, platforms: ["windows"] }));
      lastLibrary = new Map(out.map((item) => [item.game_id, item]));
      return out;
    }

    async function installAndroid(gameId) {
      const item = lastLibrary.get(gameId);
      if (!item) throw failure("NOT_OWNED", "This game is not in your library.");
      const detail = await api().game(item.slug);
      const build = detail.android_build;
      if (!build) throw failure("NO_ANDROID_BUILD", "There is no Android version of this game yet.");
      if (typeof build.url !== "string" || !build.url.startsWith("https://") || !/^[0-9a-f]{64}$/i.test(String(build.sha256))) {
        throw failure("BAD_BUILD", "The store sent an Android build that cannot be checked, so it was not downloaded.");
      }
      return new Promise((resolve, reject) => {
        const id = nextId("a");
        waiting.set(id, { resolve, reject, gameId, version: build.version || "" });
        downloads.set(gameId, id);
        native.downloadApk(id, build.url, build.sha256.toLowerCase(), `${item.slug}.apk`);
      });
    }

    return {
      state: wrap(async () => {
        const details = info();
        const base = apiBase();
        let user = null;
        if (base && tokenStore.load()) {
          try {
            user = await api().me();
          } catch (error) {
            if (error.code !== "SESSION_EXPIRED" && error.status !== 401) throw error;
          }
        }
        return { apiBase: base, installRoot: "", secureStorage: Boolean(details.secureStorage), version: details.versionName, user };
      }),
      login: wrap((email, password) => api().login(email, password)),
      register: wrap((email, password, displayName) => api().register(email, password, displayName)),
      logout: wrap(() => api().logout()),

      categories: wrap(() => api().categories()),
      games: wrap((query) => api().games(query)),
      game: wrap((slug) => api().game(slug)),
      library: wrap(listLibrary),
      addToLibrary: wrap((gameId) => api().addToLibrary(gameId)),

      install: wrap(installAndroid),
      cancel: (gameId) => {
        const id = downloads.get(gameId);
        if (id) native.cancelDownload(id);
      },
      play: wrap(onlyOnWindows),
      verify: wrap(onlyOnWindows),
      uninstall: wrap(onlyOnWindows),

      studios: wrap(() => api().studios()),
      createStudio: wrap((name) => api().createStudio(name)),
      studioGames: wrap((studioId) => api().studioGames(studioId)),

      saveSettings: wrap(async (next) => {
        const url = new URL(String(next.apiBase));
        if (!["http:", "https:"].includes(url.protocol)) throw failure("BAD_SERVER", "The server address must start with https://");
        if (url.protocol === "http:" && !info().allowCleartext) throw failure("BAD_SERVER", "This build only connects over https. Use an address that starts with https://");
        const normalized = url.origin + url.pathname.replace(/\/+$/, "");
        // A login belongs to one server: never send it to a different one.
        if (normalized !== apiBase()) tokenStore.clear();
        native.settingSet("apiBase", normalized);
        return { apiBase: normalized, installRoot: "" };
      }),
      pickFolder: wrap(async () => null),

      onInstallProgress: (callback) => {
        progressListeners.add(callback);
        return () => progressListeners.delete(callback);
      },
    };
  }

  const api = { createAndroidBridge };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else if (host.MarecAndroid && !host.marec) {
    host.__marecNative = host.__marecNative || {};
    host.marec = createAndroidBridge({ native: host.MarecAndroid, hub: host.__marecNative, MarecApi: host.MarecUI.api.MarecApi });
  }
})(typeof window !== "undefined" ? window : globalThis);
