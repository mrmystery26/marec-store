"use strict";
// The data layer. Views never talk to the launcher bridge directly: they ask this module for games.
// Everything comes from the real store API through the launcher bridge (window.marec), shaped as the
// "Game" the views use (see fromApi below), so connecting more of the API later only means filling in
// more fields here, not changing any view.
(function (host) {
  const dep = (name) => (typeof require === "function" ? require(`./${name}`) : host.MarecUI[name]);
  const { normalizePlatforms } = dep("platform");

  const DAY = 86_400_000;
  const RELEASE_WINDOWS = { "30d": 30 * DAY, "180d": 180 * DAY, year: 365 * DAY };

  /** What the store can really do today. Views use this to say so instead of faking it. */
  const CAPABILITIES = { popularity: false, discounts: false, upcoming: false, usd: false, regions: false, media: false, artwork: false };

  // Every call to the launcher returns {ok, data} or {ok:false, error}; this turns errors into throws.
  async function unwrap(promise) {
    const result = await promise;
    if (result && result.ok) return result.data;
    const error = new Error((result && result.error && result.error.message) || "Something went wrong.");
    error.code = result && result.error ? result.error.code : "ERROR";
    throw error;
  }

  /** Store API game (card or detail) -> the Game shape the views use. */
  function fromApi(raw, now = Date.now()) {
    const released = raw.published_at || null;
    return {
      id: raw.id,
      slug: raw.slug,
      title: raw.title,
      summary: raw.summary || "",
      description: raw.description || raw.summary || "",
      studio: raw.studio || { name: "", slug: "" },
      publisher: null, // the store has one "studio" for now; shown as developer and publisher
      categories: raw.categories || [],
      isFree: Boolean(raw.is_free),
      isDemo: raw.release_kind === "demo",
      price: { minor: raw.price_minor, currency: raw.currency || "MWK", original_minor: null },
      prices: null,
      ageRating: raw.age_rating || null,
      releasedAt: released,
      upcoming: Boolean(released && Date.parse(released) > now),
      requirements: raw.requirements || [],
      offlineDays: raw.offline_days ?? null,
      platforms: normalizePlatforms(raw.platforms),
      // Optional: {url, sha256, size_bytes, version}. The store does not send Android builds yet.
      androidBuild: raw.android_build || null,
      sizeBytes: null,
      regions: null,
      popularity: null,
      featured: false,
      media: [],
      artwork: null,
    };
  }

  const isDiscounted = (g) =>
    !g.isFree && g.price.original_minor && g.price.minor !== null && g.price.original_minor > g.price.minor;

  const SORTERS = {
    newest: (a, b) => (Date.parse(b.releasedAt) || 0) - (Date.parse(a.releasedAt) || 0),
    popular: (a, b) => (b.popularity ?? -1) - (a.popularity ?? -1),
    price_asc: (a, b) => (a.price.minor ?? Infinity) - (b.price.minor ?? Infinity),
    price_desc: (a, b) => (b.price.minor ?? -1) - (a.price.minor ?? -1),
    title: (a, b) => a.title.localeCompare(b.title),
  };

  /** Filters that the backend cannot do yet (or that need the whole list). Applied here. */
  function clientFilter(games, params, now) {
    const tab = params.tab || "all";
    let out = games;
    if (tab === "upcoming") out = out.filter((g) => g.upcoming);
    else if (tab !== "all") out = out.filter((g) => !g.upcoming);
    if (tab === "free") out = out.filter((g) => g.isFree);
    if (tab === "discounted") out = out.filter(isDiscounted);
    if (params.release && params.release !== "any") {
      const span = RELEASE_WINDOWS[params.release];
      out = out.filter((g) => g.releasedAt && now - Date.parse(g.releasedAt) <= span);
    }
    if (params.category) out = out.filter((g) => g.categories.some((c) => c.slug === params.category));
    if (params.q) {
      const needle = params.q.toLowerCase();
      out = out.filter((g) => `${g.title} ${g.studio.name} ${g.summary}`.toLowerCase().includes(needle));
    }
    const priceOf = (g) => g.price.minor ?? Infinity;
    if (params.minPrice != null) out = out.filter((g) => priceOf(g) >= params.minPrice);
    if (params.maxPrice != null) out = out.filter((g) => priceOf(g) <= params.maxPrice);
    return out;
  }

  function createData({ api, now = Date.now }) {
    const needsClientFilter = (p) =>
      ["discounted", "upcoming"].includes(p.tab) || (p.release && p.release !== "any");

    async function pagedAll(query, cap = 200) {
      const items = [];
      let total = 0;
      for (let offset = 0; offset < cap; offset += 50) {
        const page = await unwrap(api.games({ ...query, limit: 50, offset }));
        total = page.total;
        items.push(...page.items.map((raw) => fromApi(raw, now())));
        if (items.length >= total) break;
      }
      return items;
    }

    return {
      capabilities: () => CAPABILITIES,

      async categories() {
        return unwrap(api.categories());
      },

      /**
       * params: {q, category, tab: all|free|discounted|upcoming, release, minPrice, maxPrice (minor units),
       *          sort, offset, limit}. Returns {items, total, offset, limit}.
       */
      async search(params = {}) {
        const limit = params.limit || 24;
        const offset = params.offset || 0;
        const sort = params.sort || "newest";
        const finish = (all) => {
          const sorted = [...all].sort(SORTERS[sort] || SORTERS.newest);
          return { items: sorted.slice(offset, offset + limit), total: sorted.length, offset, limit };
        };

        const query = {
          q: params.q, category: params.category, free: params.tab === "free" ? true : undefined,
          min_price_minor: params.minPrice ?? undefined, max_price_minor: params.maxPrice ?? undefined,
          sort: ["newest", "price_asc", "price_desc", "title"].includes(sort) ? sort : "newest",
        };
        if (!needsClientFilter(params)) {
          const page = await unwrap(api.games({ ...query, limit, offset }));
          const items = clientFilter(page.items.map((raw) => fromApi(raw, now())), { tab: params.tab === "free" ? "free" : "all" }, now());
          return { items, total: page.total, offset, limit };
        }
        return finish(clientFilter(await pagedAll(query), params, now()));
      },

      async game(slug) {
        return fromApi(await unwrap(api.game(slug)), now());
      },

      /** Everything the home page shows, in one go. Shelves with nothing in them are left out. */
      async home() {
        const [newest, free] = await Promise.all([
          unwrap(api.games({ sort: "newest", limit: 24, offset: 0 })),
          unwrap(api.games({ free: true, sort: "newest", limit: 12, offset: 0 })),
        ]);
        const recent = newest.items.map((raw) => fromApi(raw, now()));
        return {
          featured: recent.slice(0, 5),
          trending: [], // the store keeps no play counts yet
          recent: recent.slice(0, 12),
          offers: recent.filter(isDiscounted),
          free: free.items.map((raw) => fromApi(raw, now())),
          discover: null,
          total: newest.total,
        };
      },

      /** Everything the Friends page needs from the store, in one go. */
      async social() {
        const [list, requests, mine] = await Promise.all([
          unwrap(api.friends()),
          unwrap(api.friendRequests()),
          unwrap(api.friendCode()),
        ]);
        return { friends: list.items, incoming: requests.incoming, outgoing: requests.outgoing, code: mine.code };
      },
    };
  }

  const api = { createData, fromApi, unwrap, isDiscounted, clientFilter, CAPABILITIES };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else (host.MarecUI = host.MarecUI || {}).data = api;
})(typeof window !== "undefined" ? window : globalThis);
