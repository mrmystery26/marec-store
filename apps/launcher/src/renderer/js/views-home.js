"use strict";
// Home: the featured carousel and the shelves under it.
(function (host) {
  const HERO_SECONDS = 8;

  /** Shown when the store cannot be loaded: what happened and what to do about it. */
  function loadError(ctx, error, retryPrefix) {
    const { h, c, button } = ctx;
    const unreachable = error.code === "NETWORK_ERROR";
    return h("div", { class: "page" }, c.errorState({
      title: unreachable ? "Can't reach the store" : "The store did not load",
      message: error.message,
      actions: [
        button({ label: "Try again", icon: "refresh", kind: "primary", onclick: () => { ctx.invalidate(retryPrefix); ctx.rerender(); } }),
        button({ label: "Server settings", onclick: () => ctx.navigate("settings") }),
      ],
    }));
  }

  function hero(ctx, games) {
    const { h, c, icon, button } = ctx;
    let index = 0;
    const frame = h("div", { class: "hero-frame" });
    const rail = h("div", { class: "hero-rail", role: "tablist", "aria-label": "Choose a featured game" });
    const root = h("section", { class: "hero", "aria-label": "Featured games" }, frame, rail);

    function arm() {
      ctx.clearTimers();
      if (games.length > 1 && !ctx.reduceMotion()) ctx.setTimer(() => { paint(index + 1); arm(); }, HERO_SECONDS * 1000);
    }

    function paint(next) {
      index = (next + games.length) % games.length;
      const g = games[index];
      const owned = ctx.libraryItem(g.id);
      const actions = [button({ label: "View game", kind: "primary", onclick: () => ctx.openGame(g) })];
      if (!owned && g.isFree && !g.upcoming) {
        actions.push(button({ label: g.isDemo ? "Get the free demo" : "Get for free", onclick: () => ctx.actions.acquire(g) }));
      }
      frame.replaceChildren(
        c.artwork(g, { kind: "hero", caption: true }),
        h("div", { class: "hero-scrim" }),
        h("div", { class: "hero-copy" },
          h("div", { class: "hero-badges" }, c.stateBadges(g)),
          h("h1", { class: "hero-title" }, g.title),
          h("p", { class: "hero-summary" }, g.summary),
          h("div", { class: "hero-buy" }, c.price(g, "lg")),
          h("div", { class: "hero-actions" }, actions))
      );
      rail.replaceChildren(...games.map((x, n) =>
        h("button", { type: "button", role: "tab", class: n === index ? "on" : "", "aria-selected": String(n === index), onclick: () => { paint(n); arm(); } },
          h("span", { class: "rail-title" }, x.title),
          h("span", { class: "rail-meta" }, c.genreText(x) || x.studio.name))));
    }

    paint(0);
    arm();
    return root;
  }

  function discover(ctx, d) {
    const { h, c } = ctx;
    const tabs = [["recommended", "Recommended"], ["popular", "Popular"], ["upcoming", "Upcoming releases"]];
    const current = ctx.state.discoverTab;
    const items = d.discover[current] || [];
    return h("section", { class: "discover" },
      c.sectionHead("Discover games", "A wider look at what is in the store.",
        c.segmented({ ariaLabel: "Discover", value: current, options: tabs.map(([value, label]) => ({ value, label })),
          onchange: (value) => { ctx.state.discoverTab = value; ctx.rerender(); } })),
      items.length
        ? h("div", { class: "card-grid" }, items.map(c.gameCard))
        : c.emptyState({ icon: "tag", title: "Nothing here yet", body: "No games are listed in this group right now." }));
  }

  function home(ctx) {
    const { h, c, button } = ctx;
    const res = ctx.resource("home", () => ctx.data.home());
    if (res.status === "loading") {
      return h("div", { class: "page home", "aria-busy": "true" },
        h("div", { class: "hero skeleton" }), h("div", { class: "card-grid" }, c.skeletonCards(6)));
    }
    if (res.status === "error") return loadError(ctx, res.error, "home:");

    const d = res.data;
    if (!d.featured.length) {
      return h("div", { class: "page" }, c.emptyState({
        icon: "store", title: "The store has no games yet",
        body: "Games appear here once developers publish them. Are you making a game? Create a developer account and upload a free demo.",
        actions: [button({ label: "Publish a demo", kind: "primary", onclick: () => ctx.navigate("publisher") })],
      }));
    }

    const categories = ctx.resource("categories", () => ctx.data.categories());
    const page = h("div", { class: "page home" }, hero(ctx, d.featured));
    if (d.trending.length) page.append(c.shelf({ title: "Trending now", subtitle: "What players are opening most.", items: d.trending }));
    if (d.offers.length) page.append(c.shelf({ title: "Special offers", subtitle: "Discounted for a limited time.", items: d.offers }));
    page.append(c.shelf({ title: "Recently added", subtitle: "The newest games in the store.", items: d.recent }));
    if (d.free.length) page.append(c.shelf({ title: "Free to play", subtitle: "Add them to your library at no cost.", items: d.free }));

    if (categories.status === "ready" && categories.data.length) {
      page.append(h("section", { class: "genres" }, c.sectionHead("Browse by genre"),
        h("div", { class: "chips" }, categories.data.map((cat) =>
          h("button", { type: "button", class: "chip", onclick: () => ctx.browse({ category: cat.slug }) }, cat.name)))));
    }
    if (d.discover) page.append(discover(ctx, d));
    return page;
  }

  const api = { home, loadError };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else (host.MarecUI = host.MarecUI || {})["views-home"] = api;
})(typeof window !== "undefined" ? window : globalThis);
