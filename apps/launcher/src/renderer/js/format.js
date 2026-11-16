"use strict";
// Pure formatting helpers (sizes, speeds, prices, dates). No DOM in here, so they are easy to test.
(function (host) {
  function formatBytes(n) {
    const units = ["B", "KB", "MB", "GB", "TB"];
    let value = Number(n) || 0;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
      value /= 1024;
      unit++;
    }
    return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`;
  }

  const formatSpeed = (bytesPerSecond) => `${formatBytes(bytesPerSecond)}/s`;

  /** "12 min left", "1 h 5 min left", or "" when there is nothing sensible to say. */
  function formatEta(seconds) {
    if (!Number.isFinite(seconds) || seconds <= 0) return "";
    if (seconds < 60) return "less than a minute left";
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `${minutes} min left`;
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return rest ? `${hours} h ${rest} min left` : `${hours} h left`;
  }

  // Prices are stored in the smallest unit (tambala for MWK, cents for USD): 100 minor = 1 major.
  function formatMoney(minor, currency) {
    if (minor === null || minor === undefined) return "";
    const major = minor / 100;
    const text = Number.isInteger(major)
      ? major.toLocaleString("en-US")
      : major.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return `${currency || "MWK"} ${text}`;
  }

  /**
   * What to show for a game's price. `currency` is the player's choice ("MWK" or "USD"); USD is used
   * only when the store sent a USD price for that game. Nothing is ever converted by guesswork.
   */
  function priceView(game, currency = "MWK") {
    const price = game.price || {};
    if (game.isFree) return { free: true, label: "Free", original: "", discount: 0, known: true, currency: "MWK" };
    const usd = game.prices && game.prices.USD;
    const useUsd = currency === "USD" && usd && usd.minor !== null && usd.minor !== undefined;
    const source = useUsd ? usd : { minor: price.minor, original_minor: price.original_minor };
    const code = useUsd ? "USD" : price.currency || "MWK";
    if (source.minor === null || source.minor === undefined) {
      return { free: false, label: "Price not available", original: "", discount: 0, known: false, currency: code };
    }
    const discount = discountPercent(source.minor, source.original_minor);
    return {
      free: false,
      label: formatMoney(source.minor, code),
      original: discount ? formatMoney(source.original_minor, code) : "",
      discount,
      known: true,
      currency: code,
    };
  }

  function discountPercent(minor, originalMinor) {
    if (!originalMinor || minor === null || minor === undefined || originalMinor <= minor) return 0;
    return Math.round((1 - minor / originalMinor) * 100);
  }

  function formatDate(iso) {
    if (!iso) return "";
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return "";
    return date.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
  }

  function timeAgo(iso, nowMs = Date.now()) {
    const then = new Date(iso).getTime();
    if (Number.isNaN(then)) return "";
    const seconds = Math.max(0, Math.round((nowMs - then) / 1000));
    if (seconds < 60) return "just now";
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `${minutes} min ago`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return `${hours} h ago`;
    const days = Math.round(hours / 24);
    if (days < 30) return `${days} day${days === 1 ? "" : "s"} ago`;
    return formatDate(iso);
  }

  const initials = (title) =>
    String(title || "?")
      .split(/\s+/)
      .filter(Boolean)
      .map((word) => word[0])
      .join("")
      .slice(0, 3)
      .toUpperCase();

  function hueOf(text) {
    let n = 0;
    for (const ch of String(text)) n = (n * 31 + ch.charCodeAt(0)) % 360;
    return n;
  }

  const plural = (n, one, many) => `${n} ${n === 1 ? one : many || `${one}s`}`;

  const api = {
    formatBytes, formatSpeed, formatEta, formatMoney, priceView, discountPercent,
    formatDate, timeAgo, initials, hueOf, plural,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else (host.MarecUI = host.MarecUI || {}).format = api;
})(typeof window !== "undefined" ? window : globalThis);
