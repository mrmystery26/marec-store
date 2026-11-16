"use strict";
// Game details: header art, buy/install panel, media, about, requirements and facts.
(function (host) {
  const REGION_NAMES = { MW: "Malawi", ZM: "Zambia", MZ: "Mozambique", TZ: "Tanzania", ZW: "Zimbabwe", ZA: "South Africa", KE: "Kenya" };

  const gigabytes = (mb) => (mb >= 1024 ? `${(mb / 1024).toFixed(mb % 1024 ? 1 : 0)} GB` : `${mb} MB`);

  function requirementsTable(ctx, game) {
    const { h } = ctx;
    const tier = (name) => game.requirements.find((r) => r.tier === name);
    const min = tier("minimum");
    const rec = tier("recommended");
    if (!min && !rec) return h("p", { class: "muted" }, "The studio has not listed system requirements yet.");
    const rows = [
      ["Operating system", (r) => r.os], ["Processor", (r) => r.cpu], ["Memory", (r) => gigabytes(r.ram_mb)],
      ["Graphics", (r) => r.gpu || "Not specified"], ["Storage", (r) => gigabytes(r.storage_mb)],
    ];
    return h("div", { class: "table-wrap" }, h("table", { class: "specs" },
      h("thead", {}, h("tr", {}, h("th", {}, ""), h("th", {}, "Minimum"), h("th", {}, "Recommended"))),
      h("tbody", {}, rows.map(([label, pick]) =>
        h("tr", {}, h("th", { scope: "row" }, label), h("td", {}, min ? pick(min) : "Not listed"), h("td", {}, rec ? pick(rec) : "Not listed"))))));
  }

  function gallery(ctx, game) {
    const { h, c, icon } = ctx;
    const media = game.media.length ? game.media : [{ type: "image", label: "No screenshots yet" }];
    const i = Math.min(ctx.state.mediaIndex, media.length - 1);
    const item = media[i];
    const main = item.src
      ? h("img", { class: "media-main", src: item.src, alt: item.label })
      : h("div", { class: `media-main placeholder ${game.media.length ? "" : "none"}`.trim() }, icon(item.type === "video" ? "film" : "image", 32),
          h("span", {}, game.media.length ? `${item.label} (placeholder)` : item.label));
    return h("section", { class: "block" }, c.sectionHead("Screenshots and trailers"),
      main,
      media.length > 1
        ? h("div", { class: "media-thumbs" }, media.map((m, n) =>
            h("button", { type: "button", class: n === i ? "on" : "", "aria-label": m.label, "aria-pressed": String(n === i), onclick: () => { ctx.state.mediaIndex = n; ctx.rerender(); } },
              icon(m.type === "video" ? "film" : "image", 18))))
        : null);
  }

  /** Said when the player owns a game that this device cannot run (a Windows game on a phone, or the reverse). */
  function wrongDevice(ctx, game) {
    const { c } = ctx;
    const text = ctx.platform.kind === "android"
      ? "This is a Windows PC game. It is in your library. Install and play it with the Windows launcher on your PC."
      : "This is an Android game. Install it from the MAREC Store app on your phone.";
    return c.notice("info", text);
  }

  /** The panel on the right: price, ownership, and the one thing the player can do next. */
  function actionPanel(ctx, game) {
    const { h, c, icon, button } = ctx;
    const item = ctx.libraryItem(game.id);
    const dl = ctx.dl.statusOf(game.id);
    const region = ctx.local.prefs().region;
    const blocked = game.regions && !game.regions.includes(region);
    const parts = [];

    if (item) {
      parts.push(h("div", { class: "own-line" }, icon("check", 16), h("strong", {}, "In your library")));
    } else {
      parts.push(h("div", { class: "buy-price" }, c.price(game, "lg")));
    }

    if (item && dl) {
      parts.push(...ctx.progressBar(game.id, { detail: true }));
      if (dl === "paused") parts.push(h("div", { class: "row" }, button({ label: "Resume", icon: "play", kind: "primary", onclick: () => ctx.dl.resume(game.id) }), button({ label: "Cancel", onclick: () => ctx.dl.cancel(game.id) })));
      else if (dl === "queued") parts.push(h("p", { class: "muted" }, "Waiting for the current download to finish."), button({ label: "Remove from queue", onclick: () => ctx.dl.cancel(game.id) }));
      else parts.push(h("div", { class: "row" }, button({ label: "Pause", icon: "pause", onclick: () => ctx.dl.pause(game.id) }), button({ label: "Cancel", onclick: () => ctx.dl.cancel(game.id) })));
    } else if (item && !ctx.platform.canRun(game.platforms)) {
      parts.push(wrongDevice(ctx, game));
    } else if (item) {
      if (!item.available) parts.push(c.notice("warn", item.unavailable_reason || "This game is not available right now."));
      else if (!item.installed) parts.push(button({ label: "Install", icon: "download", kind: "primary wide", onclick: () => ctx.actions.install(item) }));
      else {
        if (item.update_available) parts.push(button({ label: `Update to ${item.latest_version}`, icon: "refresh", kind: "primary wide", onclick: () => ctx.actions.install(item, true) }));
        parts.push(button({ label: "Play", icon: "play", kind: `${item.update_available ? "" : "play"} wide`.trim(), onclick: () => ctx.actions.play(item) }));
        parts.push(h("p", { class: "muted small" }, `Installed version ${item.installed.version}`));
      }
    } else if (blocked) {
      parts.push(c.notice("warn", "Not available in your region."));
    } else if (game.upcoming) {
      parts.push(button({ label: "Coming soon", kind: "wide", disabled: true }), h("p", { class: "muted small" }, `Releases ${ctx.fmt.formatDate(game.releasedAt)}`));
    } else if (game.isFree) {
      parts.push(button({ label: "Add to library", icon: "plus", kind: "primary wide", onclick: () => ctx.actions.acquire(game) }));
    } else {
      parts.push(
        button({ label: "Buy now", icon: "store", kind: "primary wide", onclick: () => ctx.actions.acquire(game) }),
        h("p", { class: "muted small" }, "Paid purchases are not open yet. Free games can be added today."));
    }

    if (!item && !ctx.platform.canRun(game.platforms)) {
      parts.push(h("p", { class: "muted small" }, `This game is for ${ctx.platform.names(game.platforms).join(" and ")}. You can still add it to your library here.`));
    }
    if (game.sample) parts.push(c.notice("info", "Sample game. It cannot be bought or installed."));
    const wished = ctx.local.inWishlist(game.id);
    parts.push(button({ label: wished ? "On your wishlist" : "Add to wishlist", icon: wished ? "heart-fill" : "heart", kind: `wide ${wished ? "on" : ""}`.trim(), "aria-pressed": String(wished), onclick: () => ctx.actions.toggleWish(game) }));
    return h("aside", { class: "buy-panel" }, parts);
  }

  function facts(ctx, game) {
    const { h } = ctx;
    const rows = [
      ["Developer", game.studio.name],
      ["Publisher", game.publisher || game.studio.name],
      ["Release date", ctx.fmt.formatDate(game.releasedAt) || "Not announced"],
      ["Genres", game.categories.map((x) => x.name).join(", ") || "Not listed"],
      ["Age rating", game.ageRating || "Not rated"],
      ["Platforms", ctx.platform.names(game.platforms).join(", ")],
      game.offlineDays ? ["Offline play", `Up to ${ctx.fmt.plural(game.offlineDays, "day")} without internet`] : null,
      game.sizeBytes ? ["Download size", ctx.fmt.formatBytes(game.sizeBytes)] : null,
      game.regions ? ["Sold in", game.regions.map((r) => REGION_NAMES[r] || r).join(", ")] : null,
    ].filter(Boolean);
    return h("dl", { class: "facts" }, rows.map(([k, v]) => h("div", {}, h("dt", {}, k), h("dd", {}, v))));
  }

  function game(ctx) {
    const { h, c, icon, button } = ctx;
    const slug = ctx.state.route.params.slug;
    const mode = ctx.data.mode();
    const res = ctx.resource(`game:${mode}:${slug}`, () => ctx.data.game(slug));
    const back = button({ label: "Back to store", icon: "chevron-left", kind: "ghost", onclick: () => ctx.navigate("store") });
    if (res.status === "loading") return h("div", { class: "page game", "aria-busy": "true" }, h("div", { class: "game-head skeleton" }), h("div", { class: "bone wide" }));
    if (res.status === "error") {
      return h("div", { class: "page" }, c.errorState({
        title: res.error.code === "GAME_NOT_FOUND" || res.error.code === "NOT_FOUND" ? "This game was not found" : "The game did not load",
        message: res.error.message,
        actions: [back, res.error.code === "NETWORK_ERROR" ? button({ label: "Try again", icon: "refresh", kind: "primary", onclick: () => { ctx.invalidate("game:"); ctx.rerender(); } }) : null],
      }));
    }
    const g = res.data;
    return h("div", { class: "page game" },
      back,
      h("section", { class: "game-head" },
        c.artwork(g, { kind: "hero", caption: true }),
        h("div", { class: "hero-scrim" }),
        h("div", { class: "game-head-copy" },
          h("div", { class: "hero-badges" }, c.stateBadges(g)),
          h("h1", {}, g.title),
          h("p", { class: "game-by" }, `by ${g.studio.name}`),
          h("p", { class: "game-genres" }, [c.genreText(g), g.ageRating ? `Age ${g.ageRating}` : ""].filter(Boolean).join(", ")))),
      h("div", { class: "game-layout" },
        h("div", { class: "game-main" },
          gallery(ctx, g),
          h("section", { class: "block" }, c.sectionHead("About this game"), h("p", { class: "prose" }, g.description || g.summary || "No description yet.")),
          h("section", { class: "block" }, c.sectionHead("System requirements"), requirementsTable(ctx, g))),
        h("div", { class: "game-side" }, actionPanel(ctx, g), h("section", { class: "block flush" }, c.sectionHead("Details"), facts(ctx, g)))));
  }

  const api = { game };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else (host.MarecUI = host.MarecUI || {})["views-game"] = api;
})(typeof window !== "undefined" ? window : globalThis);
