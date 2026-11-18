"use strict";
// The data layer. Views never talk to the launcher bridge or to sample data directly: they ask
// this module for games, and it decides where they come from.
//
//   live    -> the real store API through the launcher bridge (window.marec)
//   sample  -> fictional games from sample-data.js, only when the player turns the preview on
//
// Both return the same "Game" shape (see fromApi below), so connecting more of the real API later
// only means filling in more fields here, not changing any view.
(function (host) {
  const dep = (name) => (typeof require === "function" ? require(`./${name}`) : host.MarecUI[name]);
  const sample = dep("sample-data");
  const { normalizePlatforms } = dep("platform");

  const DAY = 86_400_000;
  const RELEASE_WINDOWS = { "30d": 30 * DAY, "180d": 180 * DAY, year: 365 * DAY };

  /** What each source can really do today. Views use this to say so instead of faking it. */
  const CAPABILITIES = {
    live: { popularity: false, discounts: false, upcoming: false, usd: false, regions: false, media: false, artwork: false },
    sample: { popularity: true, discounts: true, upcoming: true, usd: true, regions: true, media: true, artwork: false },
  };

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
      sample: false,
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

  function createData({ api, local, now = Date.now }) {
    const useSample = () => Boolean(local.prefs().sampleStore);
    let sampleGames = null;
    const samples = () => (sampleGames ||= sample.buildSampleGames(now()));
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
      mode: () => (useSample() ? "sample" : "live"),
      capabilities: () => CAPABILITIES[useSample() ? "sample" : "live"],

      async categories() {
        if (useSample()) return sample.CATEGORIES;
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

        if (useSample()) return finish(clientFilter(samples(), params, now()));

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
        if (useSample()) {
          const found = samples().find((g) => g.slug === slug);
          if (!found) {
            const error = new Error("This game is not in the sample store.");
            error.code = "GAME_NOT_FOUND";
            throw error;
          }
          return found;
        }
        return fromApi(await unwrap(api.game(slug)), now());
      },

      /** Everything the home page shows, in one go. Shelves with nothing in them are left out. */
      async home() {
        if (useSample()) {
          const all = samples();
          const released = all.filter((g) => !g.upcoming);
          const byNewest = [...released].sort(SORTERS.newest);
          const byPopular = [...released].sort(SORTERS.popular);
          return {
            mode: "sample",
            featured: all.filter((g) => g.featured),
            trending: byPopular.slice(0, 8),
            recent: byNewest.slice(0, 8),
            offers: released.filter(isDiscounted),
            free: released.filter((g) => g.isFree),
            discover: {
              recommended: [...released].sort((a, b) => a.order - b.order).slice(0, 6),
              popular: byPopular.slice(0, 6),
              upcoming: all.filter((g) => g.upcoming),
            },
          };
        }
        const [newest, free] = await Promise.all([
          unwrap(api.games({ sort: "newest", limit: 24, offset: 0 })),
          unwrap(api.games({ free: true, sort: "newest", limit: 12, offset: 0 })),
        ]);
        const recent = newest.items.map((raw) => fromApi(raw, now()));
        return {
          mode: "live",
          featured: recent.slice(0, 5),
          trending: [], // the store keeps no play counts yet
          recent: recent.slice(0, 12),
          offers: recent.filter(isDiscounted),
          free: free.items.map((raw) => fromApi(raw, now())),
          discover: null,
          total: newest.total,
        };
      },

      /** The made-up people shown while the sample-store preview is on. */
      sampleFriends: () => sample.SAMPLE_FRIENDS,

      /** Everything the Friends page needs from the store, in one go (live store only). */
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
