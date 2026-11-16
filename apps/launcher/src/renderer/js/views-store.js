"use strict";
// Store: search, genres, filters, sorting and the results grid.
(function (host) {
    const PAGE = 24;
  const TABS = [["all", "All games"], ["free", "Free to play"], ["discounted", "Discounted"], ["upcoming", "Upcoming"]];
  // Prices are in tambala (MWK x 100), the unit the store API uses.
  const PRICE_RANGES = {
    any: { label: "Any price" },
    free: { label: "Free", min: 0, max: 0 },
    under5: { label: "Under MWK 5,000", max: 500000 },
    mid: { label: "MWK 5,000 to 10,000", min: 500000, max: 1000000 },
    over10: { label: "Over MWK 10,000", min: 1000000 },
  };
  const RELEASES = { any: "Any time", "30d": "Last 30 days", "180d": "Last 6 months", year: "Last 12 months" };
  const EMPTY_NOTES = {
    discounted: "No games are discounted right now. Discounts appear here once the store offers them.",
    upcoming: "No upcoming releases are listed right now.",
  };

  const defaultFilters = () => ({ q: "", category: "", tab: "all", price: "any", release: "any", sort: "newest" });

  function paramsOf(s) {
    const range = PRICE_RANGES[s.price] || PRICE_RANGES.any;
    return { q: s.q || undefined, category: s.category || undefined, tab: s.tab, minPrice: range.min, maxPrice: range.max, release: s.release, sort: s.sort };
  }

  function store(ctx) {
    const { h, c, button } = ctx;
    const s = ctx.state.store;
    const mode = ctx.data.mode();
    const caps = ctx.data.capabilities();
    const key = JSON.stringify([mode, paramsOf(s)]);

    function fetchPage(offset) {
      const result = s.result;
      ctx.data.search({ ...paramsOf(s), offset, limit: PAGE }).then(
        (page) => {
          if (s.result.key !== result.key) return;
          result.items = offset ? result.items.concat(page.items) : page.items;
          result.total = page.total;
          result.status = "ready";
          result.loadingMore = false;
          if (ctx.state.route.name === "store") ctx.rerender();
        },
        (error) => {
          if (s.result.key !== result.key) return;
          result.status = "error";
          result.error = error;
          result.loadingMore = false;
          if (ctx.state.route.name === "store") ctx.rerender();
        }
      );
    }

    if (s.result.key !== key) {
      s.result = { key, status: "loading", items: [], total: 0 };
      fetchPage(0);
    }
    const result = s.result;
    const categories = ctx.resource(`categories:${mode}`, () => ctx.data.categories());

    const set = (patch) => { Object.assign(s, patch); ctx.rerender(); };
    const filtered = s.category || s.price !== "any" || s.release !== "any" || s.q;
    const clear = () => set({ ...defaultFilters(), tab: s.tab, sort: s.sort });

    const sidebar = h("aside", { class: "filters", "aria-label": "Filters" },
      h("section", {}, h("h3", {}, "Genre"),
        h("div", { class: "filter-list" },
          [{ slug: "", name: "All genres" }, ...(categories.status === "ready" ? categories.data : [])].map((cat) =>
            h("button", { type: "button", class: `filter-item ${s.category === cat.slug ? "on" : ""}`.trim(), "aria-pressed": String(s.category === cat.slug), onclick: () => set({ category: cat.slug }) }, cat.name)))),
      h("section", {}, h("h3", {}, "Price"),
        c.select({ ariaLabel: "Price", value: s.price, options: Object.entries(PRICE_RANGES).map(([value, r]) => ({ value, label: r.label })), onchange: (value) => set({ price: value }) })),
      h("section", {}, h("h3", {}, "Release date"),
        c.select({ ariaLabel: "Release date", value: s.release, options: Object.entries(RELEASES).map(([value, label]) => ({ value, label })), onchange: (value) => set({ release: value }) })),
      filtered ? button({ label: "Clear filters", icon: "x", onclick: clear }) : null);

    const tabs = h("div", { class: "tabs", role: "tablist" }, TABS.map(([value, label]) =>
      h("button", { type: "button", role: "tab", class: s.tab === value ? "on" : "", "aria-selected": String(s.tab === value), onclick: () => set({ tab: value }) }, label)));

    const sortSelect = c.select({
      ariaLabel: "Sort by", value: s.sort, onchange: (value) => set({ sort: value }),
      options: [
        { value: "newest", label: "Newest" },
        { value: "popular", label: caps.popularity ? "Popularity" : "Popularity (not available yet)", disabled: !caps.popularity },
        { value: "price_asc", label: "Price: low to high" },
        { value: "price_desc", label: "Price: high to low" },
        { value: "title", label: "Title A to Z" },
      ],
    });

    let body;
    if (result.status === "loading") body = h("div", { class: "card-grid", "aria-busy": "true" }, c.skeletonCards(8));
    else if (result.status === "error") body = null; // drawn below
    else if (!result.items.length) {
      body = c.emptyState({
        icon: "search", title: filtered ? "No games match these filters" : "No games to show",
        body: filtered ? "Try a different genre or price, or clear the filters." : EMPTY_NOTES[s.tab] || "Games appear here once studios publish them.",
        actions: filtered ? [button({ label: "Clear filters", kind: "primary", onclick: clear })] : null,
      });
    } else {
      body = h("div", {},
        h("div", { class: "card-grid" }, result.items.map(c.gameCard)),
        result.items.length < result.total
          ? h("div", { class: "load-more" }, button({ label: result.loadingMore ? "Loading…" : "Load more games", disabled: result.loadingMore, onclick: () => { result.loadingMore = true; ctx.rerender(); fetchPage(result.items.length); } }))
          : null);
    }
    if (result.status === "error") {
      body = h("div", {}, c.errorState({
        title: "The store did not load", message: result.error.message,
        actions: [button({ label: "Try again", icon: "refresh", kind: "primary", onclick: () => { s.result = { key: "" }; ctx.rerender(); } }), button({ label: "Server settings", onclick: () => ctx.navigate("settings") })],
      }));
    }

    return h("div", { class: "page store" },
      h("header", { class: "page-head" }, h("h1", {}, "Store"),
        h("p", { class: "muted" }, "Find your next game. Prices are shown in kwacha (MWK).")),
      tabs,
      h("div", { class: "store-layout" }, sidebar,
        h("div", { class: "store-results" },
          h("div", { class: "results-bar" },
            h("div", { class: "results-info" },
              h("span", { class: "muted" }, result.status === "ready" ? ctx.fmt.plural(result.total, "game") : " "),
              s.q ? h("button", { type: "button", class: "chip on", onclick: () => { s.q = ""; ctx.clearSearch(); ctx.rerender(); } }, `“${s.q}”`, ctx.icon("x", 12)) : null),
            h("div", { class: "results-sort" }, h("span", { class: "muted" }, "Sort by"), sortSelect)),
          body)));
  }

  const api = { store, defaultFilters, PRICE_RANGES };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else (host.MarecUI = host.MarecUI || {})["views-store"] = api;
})(typeof window !== "undefined" ? window : globalThis);
