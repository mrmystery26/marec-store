"use strict";
// Everything the launcher remembers on this PC: preferences, wishlist, notifications, download
// history and what was played. It is all local to this window: nothing here is sent to the store.
(function (host) {
  const DEFAULT_PREFS = {
    sidebarCollapsed: false,
    libraryView: "grid", // grid | list
    currency: "MWK", // MWK | USD (USD only when a game carries a USD price)
    simultaneousDownloads: 1,
    notifyDownloads: true,
    notifyUpdates: true,
    reduceMotion: false,
    region: "MW", // where the player is; used when games are limited to some countries
  };
  const KEYS = {
    prefs: "marec.prefs.v1",
    wishlist: "marec.wishlist.v1",
    notifications: "marec.notifications.v1",
    history: "marec.history.v1",
    played: "marec.played.v1",
    seen: "marec.seen.v1",
  };
  const LIMITS = { notifications: 30, history: 50, wishlist: 200 };

  function memoryStorage() {
    const map = new Map();
    return {
      getItem: (key) => (map.has(key) ? map.get(key) : null),
      setItem: (key, value) => void map.set(key, String(value)),
      removeItem: (key) => void map.delete(key),
    };
  }

  /** `storage` is window.localStorage in the app; a failing or missing one falls back to memory. */
  function createLocalStore(storage, { now = Date.now } = {}) {
    const fallback = memoryStorage();
    const read = (key, empty) => {
      try {
        const raw = (storage || fallback).getItem(key);
        return raw ? JSON.parse(raw) : empty;
      } catch {
        return empty;
      }
    };
    const write = (key, value) => {
      try {
        (storage || fallback).setItem(key, JSON.stringify(value));
      } catch {
        // Storage can be full or blocked. The launcher keeps working; the value is just not kept.
      }
    };

    let prefs = { ...DEFAULT_PREFS, ...read(KEYS.prefs, {}) };
    let wishlist = read(KEYS.wishlist, []);
    let notifications = read(KEYS.notifications, []);
    let history = read(KEYS.history, []);
    let played = read(KEYS.played, {});
    let seen = read(KEYS.seen, {});
    let counter = 0;
    const newId = () => `${now()}-${++counter}`;

    return {
      prefs: () => prefs,
      setPref(name, value) {
        if (!(name in DEFAULT_PREFS)) return;
        prefs = { ...prefs, [name]: value };
        write(KEYS.prefs, prefs);
      },

      wishlist: () => wishlist,
      inWishlist: (id) => wishlist.some((item) => item.id === id),
      /** Keeps a small snapshot so the wishlist can be shown even when the store is unreachable. */
      addToWishlist(game) {
        if (wishlist.some((item) => item.id === game.id)) return;
        const snapshot = {
          id: game.id, slug: game.slug, title: game.title,
          studio: game.studio ? game.studio.name : "",
          price: game.price || null, isFree: Boolean(game.isFree), addedAt: new Date(now()).toISOString(),
        };
        wishlist = [snapshot, ...wishlist].slice(0, LIMITS.wishlist);
        write(KEYS.wishlist, wishlist);
      },
      removeFromWishlist(id) {
        wishlist = wishlist.filter((item) => item.id !== id);
        write(KEYS.wishlist, wishlist);
      },

      notifications: () => notifications,
      unreadCount: () => notifications.filter((n) => !n.read).length,
      notify(kind, title, body) {
        notifications = [{ id: newId(), kind, title, body, at: new Date(now()).toISOString(), read: false }, ...notifications]
          .slice(0, LIMITS.notifications);
        write(KEYS.notifications, notifications);
      },
      markNotificationsRead() {
        notifications = notifications.map((n) => ({ ...n, read: true }));
        write(KEYS.notifications, notifications);
      },
      clearNotifications() {
        notifications = [];
        write(KEYS.notifications, notifications);
      },

      history: () => history,
      addHistory(entry) {
        history = [{ id: newId(), at: new Date(now()).toISOString(), ...entry }, ...history].slice(0, LIMITS.history);
        write(KEYS.history, history);
      },
      clearHistory() {
        history = [];
        write(KEYS.history, history);
      },

      played: () => played,
      markPlayed(gameId) {
        played = { ...played, [gameId]: new Date(now()).toISOString() };
        write(KEYS.played, played);
      },
      /** Remembers that something (like "this update") was already announced. */
      hasSeen: (key) => Boolean(seen[key]),
      markSeen(key) {
        seen = { ...seen, [key]: 1 };
        const keys = Object.keys(seen);
        if (keys.length > 200) delete seen[keys[0]];
        write(KEYS.seen, seen);
      },

      /** Game ids, most recently played first. */
      recentlyPlayed: (limit = 6) =>
        Object.entries(played).sort((a, b) => (a[1] < b[1] ? 1 : -1)).slice(0, limit).map(([id]) => id),
    };
  }

  const api = { createLocalStore, DEFAULT_PREFS };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else (host.MarecUI = host.MarecUI || {})["local-store"] = api;
})(typeof window !== "undefined" ? window : globalThis);
