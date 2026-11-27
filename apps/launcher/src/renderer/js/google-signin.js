"use strict";
// Sign in with Google, for both the Windows launcher and the Android app.
//
// The app never shows Google's page itself (Google refuses embedded web views). It opens the system
// browser, and the store's API brings the person back with `marecstore://auth?ticket=...`. That
// ticket is worth nothing without the secret `code_verifier` this module keeps in memory, so a
// ticket that someone else triggers cannot sign this app in as them.
(function (host) {
  const REDIRECT = "marecstore://auth";
  const GOOGLE_ORIGIN = "https://accounts.google.com";
  const PENDING_MS = 10 * 60 * 1000; // the store's `state` lasts 10 minutes

  const MESSAGES = {
    GOOGLE_CANCELLED: "Sign-in was cancelled.",
    GOOGLE_NOT_CONFIGURED: "Sign in with Google is not set up on this store yet.",
    GOOGLE_EMAIL_UNVERIFIED: "Your Google email address is not verified, so it cannot be used here.",
    GOOGLE_REJECTED: "Google did not accept the sign-in. Please try again.",
    GOOGLE_BAD_TOKEN: "Google's answer could not be checked. Please try again.",
    GOOGLE_BAD_RESPONSE: "Google's answer was incomplete. Please try again.",
    GOOGLE_NO_EMAIL: "Google did not share an email address, which the store needs.",
    GOOGLE_UNREACHABLE: "The store could not reach Google. Please try again.",
    SIGNIN_EXPIRED: "That sign-in took too long. Please start again.",
    ACCOUNT_SUSPENDED: "This account is suspended.",
    ACCOUNT_UNAVAILABLE: "This account cannot sign in.",
    INVALID_TICKET: "That sign-in expired. Please start again.",
    TRY_AGAIN: "Something went wrong. Please try again.",
  };

  const failure = (code, message) => Object.assign(new Error(message || MESSAGES[code] || "Sign-in did not finish."), { code });

  const toBase64Url = (bytes) =>
    btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

  /** PKCE pair: a random verifier, and base64url(SHA-256(verifier)). `crypto` is injected. */
  async function makePkce(c) {
    const verifier = toBase64Url(c.randomBytes(48)); // 64 characters, within the 43..128 allowed
    const digest = await c.sha256(new TextEncoder().encode(verifier));
    return { verifier, challenge: toBase64Url(new Uint8Array(digest)) };
  }

  /** What the page's own `crypto` (browsers, WebView, Node 20+) offers. */
  function webCrypto(g = globalThis) {
    return {
      randomBytes: (n) => g.crypto.getRandomValues(new Uint8Array(n)),
      sha256: (bytes) => g.crypto.subtle.digest("SHA-256", bytes),
    };
  }

  /** True for the address the store sends the browser back to. */
  function isCallback(url) {
    return typeof url === "string" && url.toLowerCase().startsWith(REDIRECT);
  }

  function parseCallback(url) {
    if (!isCallback(url)) return null;
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return null;
    }
    if (parsed.protocol !== "marecstore:" || parsed.hostname.toLowerCase() !== "auth") return null;
    return { ticket: parsed.searchParams.get("ticket") || "", error: parsed.searchParams.get("error") || "" };
  }

  /**
   * api: { googleStart(challenge) -> {auth_url}, googleExchange(ticket, verifier) -> user }
   * crypto: { randomBytes(n), sha256(bytes) }
   */
  function createGoogleSignIn({ api, crypto = webCrypto(), now = Date.now }) {
    let pending = null;

    return {
      isPending: () => Boolean(pending) && now() - pending.at < PENDING_MS,

      /** Asks the store for Google's address. The caller opens the returned `authUrl`. */
      async begin() {
        const pkce = await makePkce(crypto);
        const { auth_url: authUrl } = await api.googleStart(pkce.challenge);
        let origin = "";
        try {
          origin = new URL(authUrl).origin;
        } catch {
          origin = "";
        }
        // Whatever the server says, only Google's own sign-in page is ever opened.
        if (origin !== GOOGLE_ORIGIN) throw failure("GOOGLE_BAD_RESPONSE", "The store sent an unexpected sign-in address, so it was not opened.");
        pending = { verifier: pkce.verifier, at: now() };
        return { authUrl };
      },

      /**
       * Handles `marecstore://auth?...`. Returns null for links this app did not ask for, or the
       * signed-in user. Throws an error with a `code` when the sign-in failed.
       */
      async complete(url) {
        const result = parseCallback(url);
        if (!result) return null;
        const mine = pending;
        if (!mine || now() - mine.at >= PENDING_MS) {
          pending = null;
          return null; // nobody here started a sign-in, so a ticket arriving now is ignored
        }
        pending = null;
        if (result.error) throw failure(result.error);
        if (!result.ticket) throw failure("GOOGLE_BAD_RESPONSE");
        return api.googleExchange(result.ticket, mine.verifier);
      },

      cancel() {
        pending = null;
      },
    };
  }

  const api = { createGoogleSignIn, makePkce, webCrypto, parseCallback, isCallback, MESSAGES, REDIRECT };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else (host.MarecUI = host.MarecUI || {})["google-signin"] = api;
})(typeof window !== "undefined" ? window : globalThis);
