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

  async request(method, pathname, { body, auth = true, query, text = false } = {}) {
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
    return this.parse(response, text);
  }

  /** `raw` answers with the body as plain text (for files such as the SDK config). */
  async parse(response, raw = false) {
    const text = await response.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    if (response.ok && raw) return text;
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

  // ---- Sign in with Google, and confirming an email address
  providers() {
    return this.request("GET", "/v1/auth/providers", { auth: false });
  }
  googleStart(codeChallenge) {
    return this.request("POST", "/v1/auth/google/start", { auth: false, body: { code_challenge: codeChallenge } });
  }
  /** Trades the one-time ticket (plus the app's secret verifier) for a session. */
  async googleExchange(ticket, codeVerifier) {
    const data = await this.request("POST", "/v1/auth/google/exchange", {
      auth: false,
      body: { ticket, code_verifier: codeVerifier },
    });
    this.tokenStore.save({ accessToken: data.access_token, refreshToken: data.refresh_token });
    return this.me();
  }
  sendEmailCode() {
    return this.request("POST", "/v1/auth/email/send-code");
  }
  verifyEmail(code) {
    return this.request("POST", "/v1/auth/email/verify", { body: { code } });
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

  // ---- Developer account, demos and builds
  developerAccount() {
    return this.request("GET", "/v1/developer/account");
  }
  registerDeveloper(studioName, termsVersion) {
    return this.request("POST", "/v1/developer/account", {
      body: { studio_name: studioName, accept_terms: true, terms_version: termsVersion },
    });
  }
  createGame(studioId, title) {
    return this.request("POST", `/v1/developer/studios/${studioId}/games`, { body: { title } });
  }
  developerGame(gameId) {
    return this.request("GET", `/v1/developer/games/${gameId}`);
  }
  updateGame(gameId, changes) {
    return this.request("PATCH", `/v1/developer/games/${gameId}`, { body: changes });
  }
  submitGame(gameId) {
    return this.request("POST", `/v1/developer/games/${gameId}/submit`);
  }
  builds(gameId) {
    return this.request("GET", `/v1/developer/games/${gameId}/builds`);
  }
  createBuild(gameId, body) {
    return this.request("POST", `/v1/developer/games/${gameId}/builds`, { body });
  }
  completeBuild(buildId) {
    return this.request("POST", `/v1/developer/builds/${buildId}/complete`);
  }
  sdkConfig(gameId) {
    return this.request("GET", `/v1/developer/games/${gameId}/sdk-config`, { text: true });
  }

  // ---- Staff review (the server checks the roles; these only work for staff)
  adminStudios(status) {
    return this.request("GET", "/v1/admin/studios", { query: { ...(status ? { status } : {}), limit: 50 } });
  }
  verifyStudio(studioId) {
    return this.request("POST", `/v1/admin/studios/${studioId}/verify`);
  }
  adminGames(status) {
    return this.request("GET", "/v1/admin/games", { query: { ...(status ? { status } : {}), limit: 50 } });
  }
  transitionGame(gameId, action, reason) {
    return this.request("POST", `/v1/admin/games/${gameId}/transition`, { body: { action, ...(reason ? { reason } : {}) } });
  }

  // ---- Friends (people are added with a friend code, never by email or name) ----
  friends() {
    return this.request("GET", "/v1/friends");
  }
  friendRequests() {
    return this.request("GET", "/v1/friends/requests");
  }
  friendCode() {
    return this.request("GET", "/v1/friends/code");
  }
  resetFriendCode() {
    return this.request("POST", "/v1/friends/code/reset");
  }
  sendFriendRequest(friendCode) {
    return this.request("POST", "/v1/friends/requests", { body: { friend_code: friendCode } });
  }
  acceptFriendRequest(requestId) {
    return this.request("POST", `/v1/friends/requests/${encodeURIComponent(requestId)}/accept`);
  }
  declineFriendRequest(requestId) {
    return this.request("POST", `/v1/friends/requests/${encodeURIComponent(requestId)}/decline`);
  }
  cancelFriendRequest(requestId) {
    return this.request("DELETE", `/v1/friends/requests/${encodeURIComponent(requestId)}`);
  }
  removeFriend(userId) {
    return this.request("DELETE", `/v1/friends/${encodeURIComponent(userId)}`);
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
