"use strict";
// Search: a full-screen search page (the Search tab on phones). Results update as you type.
(function (host) {
  function search(ctx) {
    const { h, c } = ctx;
    const s = ctx.state.searchUI;
    const results = h("div", { class: "search-results" });
    let timer = null;
    let token = 0;

    function paint() {
      if (s.status === "idle") {
        const cats = ctx.resource("categories", () => ctx.data.categories());
        results.replaceChildren(
          h("p", { class: "muted pad-sm" }, "Search by game title, studio or description."),
          cats.status === "ready" && cats.data.length
            ? h("div", { class: "chips" }, cats.data.map((cat) => h("button", { type: "button", class: "chip", onclick: () => ctx.browse({ category: cat.slug }) }, cat.name)))
            : null);
      } else if (s.status === "loading") {
        results.replaceChildren(h("div", { class: "card-grid", "aria-busy": "true" }, c.skeletonCards(4)));
      } else if (s.status === "error") {
        results.replaceChildren(c.errorState({
          title: "Search did not work", message: s.error.message,
          actions: [ctx.button({ label: "Try again", icon: "refresh", kind: "primary", onclick: () => run(s.q) })],
        }));
      } else if (!s.items.length) {
        results.replaceChildren(c.emptyState({ icon: "search", title: "No games found", body: `Nothing matches “${s.q.trim()}”. Try another word.` }));
      } else {
        results.replaceChildren(h("p", { class: "muted pad-sm" }, ctx.fmt.plural(s.total, "game")), h("div", { class: "card-grid" }, s.items.map(c.gameCard)));
      }
    }

    async function run(q) {
      const mine = ++token;
      s.q = q;
      if (!q.trim()) {
        s.status = "idle";
        return paint();
      }
      s.status = "loading";
      paint();
      try {
        const page = await ctx.data.search({ q: q.trim(), limit: 24 });
        if (mine !== token) return;
        Object.assign(s, { items: page.items, total: page.total, status: "ready" });
      } catch (error) {
        if (mine !== token) return;
        Object.assign(s, { status: "error", error });
      }
      paint();
    }

    const input = h("input", {
      type: "search", class: "search-input", placeholder: "Search games and studios", "aria-label": "Search games", value: s.q,
      oninput: (e) => {
        clearTimeout(timer);
        const q = e.target.value;
        timer = setTimeout(() => run(q), 300);
        if (timer && timer.unref) timer.unref();
      },
    });
    paint();
    if (typeof input.focus === "function") setTimeout(() => input.focus(), 0);
    return h("div", { class: "page search-page" },
      h("header", { class: "page-head" }, h("h1", {}, "Search")),
      h("div", { class: "search-box big" }, ctx.icon("search", 18), input),
      results);
  }

  const api = { search };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else (host.MarecUI = host.MarecUI || {})["views-search"] = api;
})(typeof window !== "undefined" ? window : globalThis);
