"use strict";
// Client for the MAREC STORE backend. Handles login, silent token refresh and error mapping.

class ApiError extends Error {
  constructor(status, code, message, requestId) {
    super(message);
    this.status = status;
    this.code = code;
    this.requestId = requestId;
  }
}

class MarecApi {
  /** tokenStore needs load() -> {accessToken, refreshToken} | null, save(tokens), clear(). */
  constructor({ baseUrl, tokenStore, fetchImpl = fetch }) {
    this.baseUrl = String(baseUrl).replace(/\/+$/, "");
    this.tokenStore = tokenStore;
    this.fetchImpl = fetchImpl;
    this.refreshing = null;
  }

  async request(method, pathname, { body, auth = true, query } = {}) {
    const send = async () => {
      const url = new URL(this.baseUrl + pathname);
      for (const [key, value] of Object.entries(query || {})) url.searchParams.set(key, value);
      const headers = { Accept: "application/json" };
      if (body !== undefined) headers["Content-Type"] = "application/json";
      const tokens = auth ? this.tokenStore.load() : null;
      if (tokens) headers.Authorization = `Bearer ${tokens.accessToken}`;
      try {
        return await this.fetchImpl(url, {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
        });
      } catch (error) {
        throw new ApiError(0, "NETWORK_ERROR", `Cannot reach the store: ${error.message}`);
      }
    };

    let response = await send();
    const canRefresh = auth && this.tokenStore.load() && pathname !== "/v1/auth/refresh";
    if (response.status === 401 && canRefresh) {
      await this.refresh();
      response = await send();
    }
    return this.parse(response);
  }

  async parse(response) {
    const text = await response.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    if (!response.ok) {
      const e = (data && data.error) || {};
      throw new ApiError(
        response.status,
        e.code || `HTTP_${response.status}`,
        e.message || `The store answered ${response.status}.`,
        e.request_id
      );
    }
    return data;
  }

  /** One refresh at a time, even if several requests fail together. */
  refresh() {
    if (!this.refreshing) {
      this.refreshing = this.doRefresh().finally(() => (this.refreshing = null));
    }
    return this.refreshing;
  }

  async doRefresh() {
    const tokens = this.tokenStore.load();
    if (!tokens) throw new ApiError(401, "SESSION_EXPIRED", "Please log in again.");
    let data;
    try {
      data = await this.request("POST", "/v1/auth/refresh", {
        auth: false,
        body: { refresh_token: tokens.refreshToken },
      });
    } catch (error) {
      if (error.code === "NETWORK_ERROR") throw error;
      this.tokenStore.clear();
      throw new ApiError(401, "SESSION_EXPIRED", "Your session has ended. Please log in again.");
    }
    this.tokenStore.save({ accessToken: data.access_token, refreshToken: data.refresh_token });
  }

  async login(email, password) {
    const data = await this.request("POST", "/v1/auth/login", {
      auth: false,
      body: { email, password },
    });
    this.tokenStore.save({ accessToken: data.access_token, refreshToken: data.refresh_token });
    return this.me();
  }

  async logout() {
    try {
      if (this.tokenStore.load()) await this.request("POST", "/v1/auth/logout");
    } catch {
      // The local session is removed either way.
    }
    this.tokenStore.clear();
  }

  isLoggedIn() {
    return Boolean(this.tokenStore.load());
  }

  me() {
    return this.request("GET", "/v1/me");
  }
  library(limit = 50, offset = 0) {
    return this.request("GET", "/v1/me/library", { query: { limit, offset } });
  }
  installPlan(gameId) {
    return this.request("POST", `/v1/games/${gameId}/install-plan`);
  }
  publicKeys() {
    return this.request("GET", "/v1/launch/public-keys", { auth: false });
  }
  authorizeLaunch(body) {
    return this.request("POST", "/v1/launch/authorizations", { body });
  }

  // ---- Public store (no login needed) ----
  categories() {
    return this.request("GET", "/v1/categories", { auth: false });
  }
  games(query) {
    return this.request("GET", "/v1/games", { auth: false, query: cleanGamesQuery(query) });
  }
  game(slug) {
    return this.request("GET", `/v1/games/${encodeURIComponent(slug)}`, { auth: false });
  }

  // ---- Account and library ----
  register(email, password, displayName) {
    return this.request("POST", "/v1/auth/register", {
      auth: false,
      body: { email, password, display_name: displayName },
    });
  }
  /** Adds a FREE game to the library. Paid games answer 402 (purchases are not built yet). */
  addToLibrary(gameId) {
    return this.request("POST", `/v1/me/library/${gameId}`);
  }

  // ---- Publisher area (read and create studios only; everything else stays in the developer API) ----
  studios() {
    return this.request("GET", "/v1/developer/studios");
  }
  createStudio(name) {
    return this.request("POST", "/v1/developer/studios", { body: { name } });
  }
  studioGames(studioId, limit = 50, offset = 0) {
    return this.request("GET", `/v1/developer/studios/${studioId}/games`, { query: { limit, offset } });
  }
}

const SORTS = ["newest", "price_asc", "price_desc", "title"];

/**
 * Keeps only the store filters the backend understands and drops empty ones, so the window can
 * never send anything else (and "undefined" never ends up in a URL).
 */
function cleanGamesQuery(raw) {
  const out = {};
  const input = raw || {};
  const text = (value, max) => (typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null);
  const whole = (value, min, max) =>
    Number.isInteger(value) && value >= min && value <= max ? value : null;
  const q = text(input.q, 80);
  const category = text(input.category, 60);
  if (q) out.q = q;
  if (category) out.category = category;
  if (input.free === true) out.free = "true";
  const minPrice = whole(input.min_price_minor, 0, 100_000_000);
  const maxPrice = whole(input.max_price_minor, 0, 100_000_000);
  if (minPrice !== null) out.min_price_minor = minPrice;
  if (maxPrice !== null) out.max_price_minor = maxPrice;
  if (SORTS.includes(input.sort)) out.sort = input.sort;
  out.limit = whole(input.limit, 1, 50) ?? 24;
  out.offset = whole(input.offset, 0, 10000) ?? 0;
  return out;
}

module.exports = { MarecApi, ApiError, cleanGamesQuery };
