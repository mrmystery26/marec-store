"use strict";
// Library, Downloads, Wishlist and Friends.
(function (host) {
  // ------------------------------------------------------------------ shared helpers
  const platformsOf = (item) => item.platforms || ["windows"];

  function statusOf(ctx, item) {
    const { h } = ctx;
    if (!ctx.platform.canRun(platformsOf(item))) {
      return h("span", { class: "status off" }, `${ctx.platform.names(platformsOf(item)).join(" and ")} game`);
    }
    const dl = ctx.dl.statusOf(item.game_id);
    if (dl === "downloading") return h("span", { class: "status warn" }, "Downloading…");
    if (dl === "queued") return h("span", { class: "status warn" }, "Waiting in queue");
    if (dl === "paused") return h("span", { class: "status warn" }, "Paused");
    if (!item.installed) return h("span", { class: `status ${item.available ? "off" : "warn"}` }, item.available ? "Not installed" : item.unavailable_reason || "Unavailable");
    if (item.update_available) return h("span", { class: "status warn" }, `Update available (${item.installed.version} → ${item.latest_version})`);
    return h("span", { class: "status ok" }, "Installed", h("span", { class: "muted" }, ` v${item.installed.version}`));
  }

  /** The one button that fits the game's state. Play is only ever offered for installed games. */
  function quickAction(ctx, item) {
    const { button } = ctx;
    if (!ctx.platform.canRun(platformsOf(item))) return null; // never offer Install or Play for another platform's game
    if (ctx.dl.isBusy(item.game_id)) return null;
    if (!item.installed) return button({ label: "Install", icon: "download", kind: "primary", disabled: !item.available, onclick: () => ctx.actions.install(item) });
    if (item.update_available) return button({ label: "Update", icon: "refresh", kind: "primary", onclick: () => ctx.actions.install(item, true) });
    return button({ label: "Play", icon: "play", kind: "play", onclick: () => ctx.actions.play(item) });
  }

  const asGame = (item) => ({ id: item.game_id, title: item.title, artwork: null });

  // ------------------------------------------------------------------ library
  function libraryCard(ctx, item, selected) {
    const { h, c } = ctx;
    const dl = ctx.dl.statusOf(item.game_id);
    return h("div", { class: `lib-card ${selected ? "selected" : ""}`.trim() },
      h("button", { type: "button", class: "card-hit", "aria-label": `${item.title}, open details`, onclick: () => ctx.openLibraryPanel(item.game_id) },
        h("div", { class: "card-art" }, c.artwork(asGame(item))),
        h("div", { class: "card-body" },
          h("div", { class: "card-title" }, item.title),
          h("div", { class: "card-genre" }, item.studio ? item.studio.name : ""),
          statusOf(ctx, item),
          dl === "downloading" ? ctx.progressBar(item.game_id) : null)),
      h("div", { class: "lib-card-action" }, quickAction(ctx, item)));
  }

  function libraryRow(ctx, item, selected) {
    const { h, c } = ctx;
    return h("div", { class: `lib-row ${selected ? "selected" : ""}`.trim() },
      h("button", { type: "button", class: "row-hit", "aria-label": `${item.title}, open details`, onclick: () => ctx.openLibraryPanel(item.game_id) },
        h("div", { class: "row-thumb" }, c.artwork(asGame(item))),
        h("div", { class: "row-main" }, h("div", { class: "card-title" }, item.title), h("div", { class: "card-genre" }, item.studio ? item.studio.name : "")),
        h("div", { class: "row-status" }, statusOf(ctx, item), ctx.dl.statusOf(item.game_id) === "downloading" ? ctx.progressBar(item.game_id) : null)),
      h("div", { class: "row-action" }, quickAction(ctx, item)));
  }

  function libraryPanel(ctx, item) {
    const { h, c, icon, button } = ctx;
    const confirming = ctx.state.confirming === item.game_id;
    const dl = ctx.dl.statusOf(item.game_id);
    const sections = [];

    const main = [];
    if (dl) {
      main.push(...ctx.progressBar(item.game_id, { detail: true }));
      main.push(h("div", { class: "row" },
        dl === "paused" ? button({ label: "Resume", icon: "play", kind: "primary", onclick: () => ctx.dl.resume(item.game_id) })
          : dl === "downloading" ? button({ label: "Pause", icon: "pause", onclick: () => ctx.dl.pause(item.game_id) }) : null,
        button({ label: dl === "queued" ? "Remove from queue" : "Cancel", onclick: () => ctx.dl.cancel(item.game_id) })));
    } else {
      main.push(quickAction(ctx, item) || null);
    }
    if (!ctx.platform.canRun(platformsOf(item))) {
      main.push(c.notice("info", ctx.platform.kind === "android"
        ? "This is a Windows PC game. Install and play it with the Windows launcher on your PC. It stays in your library."
        : "This is an Android game. Install it from the MAREC Store app on your phone."));
    }
    if (!item.available && !item.installed) main.push(c.notice("warn", item.unavailable_reason || "This game is not available right now."));

    sections.push(h("div", { class: "panel-actions" }, main));
    if (item.installed) {
      sections.push(h("section", {}, h("h3", {}, "Manage installation"),
        h("dl", { class: "facts" },
          h("div", {}, h("dt", {}, "Installed version"), h("dd", {}, item.installed.version)),
          h("div", {}, h("dt", {}, "Installed on"), h("dd", {}, ctx.fmt.formatDate(item.installed.installed_at) || "Unknown")),
          h("div", {}, h("dt", {}, "Games folder"), h("dd", { class: "path" }, ctx.state.installRoot))),
        h("div", { class: "row wrap" },
          button({ label: "Verify game files", icon: "shield", onclick: () => ctx.actions.verify(item) }),
          button({ label: confirming ? "Click again to uninstall" : "Uninstall", icon: "trash", kind: confirming ? "danger" : "", disabled: Boolean(dl), onclick: () => ctx.actions.uninstall(item) }))));
      sections.push(h("section", {}, h("h3", {}, "Game updates"),
        item.update_available
          ? h("p", { class: "muted" }, `Version ${item.latest_version} is available. Updates download the whole game again for now.`)
          : h("p", { class: "muted" }, "You have the latest version.")));
    }
    sections.push(button({ label: "View store page", kind: "ghost", onclick: () => ctx.navigate("game", { slug: item.slug }) }));

    return h("aside", { class: "drawer", role: "complementary", "aria-label": `${item.title} details` },
      h("header", { class: "drawer-head" },
        h("div", { class: "drawer-art" }, c.artwork(asGame(item), { kind: "hero" })),
        button({ icon: "x", title: "Close details", kind: "icon drawer-close", onclick: () => ctx.openLibraryPanel(null) })),
      h("div", { class: "drawer-body" }, h("h2", {}, item.title), h("p", { class: "muted" }, item.studio ? item.studio.name : ""), statusOf(ctx, item), sections));
  }

  function library(ctx) {
    const { h, c, button } = ctx;
    const ui = ctx.state.libraryUI;
    const items = ctx.state.library;
    const view = ctx.local.prefs().libraryView;

    if (!items.length) {
      return h("div", { class: "page" },
        h("header", { class: "page-head" }, h("h1", {}, "Library")),
        ctx.state.loadingLibrary
          ? h("div", { class: "card-grid", "aria-busy": "true" }, c.skeletonCards(4))
          : c.emptyState({ icon: "library", title: "Your library is empty", body: "Games you own show up here. Free games can be added from their store page.",
              actions: [button({ label: "Browse the store", kind: "primary", onclick: () => ctx.navigate("store") })] }));
    }

    const results = h("div", { class: "lib-results" });
    const paint = () => {
      const needle = ui.q.trim().toLowerCase();
      const shown = items.filter((i) =>
        (!needle || i.title.toLowerCase().includes(needle)) &&
        (ui.filter === "all" || (ui.filter === "installed" ? Boolean(i.installed) : !i.installed)));
      const recent = ctx.local.recentlyPlayed(6).map((id) => items.find((i) => i.game_id === id)).filter((i) => i && i.installed);
      const parts = [];
      if (recent.length && !needle && ui.filter === "all") {
        parts.push(h("section", { class: "recent" }, c.sectionHead("Recently played"), h("div", { class: "shelf-row" }, recent.map((i) => libraryCard(ctx, i, ui.selected === i.game_id)))));
      }
      parts.push(h("section", {}, c.sectionHead("All games", ctx.fmt.plural(shown.length, "game")),
        shown.length
          ? (view === "grid" ? h("div", { class: "card-grid" }, shown.map((i) => libraryCard(ctx, i, ui.selected === i.game_id)))
              : h("div", { class: "lib-list" }, shown.map((i) => libraryRow(ctx, i, ui.selected === i.game_id))))
          : c.emptyState({ icon: "search", title: "No games match", body: "Try a different search or filter." })));
      results.replaceChildren(...parts);
    };
    paint();

    const search = h("input", { type: "search", class: "search-input", placeholder: "Search your games", "aria-label": "Search your games", value: ui.q,
      oninput: (e) => { ui.q = e.target.value; paint(); } });
    const selected = ui.selected && items.find((i) => i.game_id === ui.selected);

    return h("div", { class: `page library ${selected ? "with-drawer" : ""}`.trim() },
      h("div", { class: "library-main" },
        h("header", { class: "page-head" }, h("h1", {}, "Library"), h("p", { class: "muted" }, ctx.platform.mobile ? "Everything you own. Windows PC games are installed with the Windows launcher." : "Everything you own, ready to install and play.")),
        h("div", { class: "toolbar" },
          h("div", { class: "search-box" }, ctx.icon("search", 16), search),
          ctx.platform.mobile ? null : c.segmented({ ariaLabel: "Show", value: ui.filter, options: [{ value: "all", label: "All" }, { value: "installed", label: "Installed" }, { value: "uninstalled", label: "Not installed" }], onchange: (v) => { ui.filter = v; ctx.rerender(); } }),
          c.segmented({ ariaLabel: "View", value: view, options: [{ value: "grid", icon: "grid", title: "Grid view" }, { value: "list", icon: "list", title: "List view" }], onchange: (v) => { ctx.local.setPref("libraryView", v); ctx.rerender(); } })),
        results),
      selected ? libraryPanel(ctx, selected) : null);
  }

  // ------------------------------------------------------------------ downloads
  function downloadRow(ctx, entry, mode) {
    const { h, c, button } = ctx;
    const { item } = entry;
    const id = item.game_id;
    const controls = {
      active: [button({ label: "Pause", icon: "pause", onclick: () => ctx.dl.pause(id) }), button({ label: "Cancel", onclick: () => ctx.dl.cancel(id) })],
      queued: [button({ label: "Remove", onclick: () => ctx.dl.cancel(id) })],
      paused: [button({ label: "Resume", icon: "play", kind: "primary", onclick: () => ctx.dl.resume(id) }), button({ label: "Cancel", onclick: () => ctx.dl.cancel(id) })],
    }[mode];
    return h("div", { class: "dl-row" },
      h("div", { class: "row-thumb" }, c.artwork(asGame(item))),
      h("div", { class: "dl-main" },
        h("div", { class: "card-title" }, item.title, h("span", { class: "tag" }, entry.update ? "Update" : "Install")),
        mode === "queued" ? h("div", { class: "muted small" }, "Waiting for the current download to finish.") : ctx.progressBar(id, { detail: true })),
      h("div", { class: "row" }, controls));
  }

  function downloads(ctx) {
    const { h, c, button } = ctx;
    const lists = ctx.dl.list();
    const updates = ctx.state.library.filter((i) => i.installed && i.update_available && !ctx.dl.isBusy(i.game_id) && ctx.platform.canRun(platformsOf(i)));
    const history = ctx.local.history();
    const parts = [];

    const group = (title, subtitle, rows) => rows.length ? h("section", { class: "block" }, c.sectionHead(title, subtitle), h("div", { class: "dl-list" }, rows)) : null;
    parts.push(group("Now downloading", null, lists.active.map((e) => downloadRow(ctx, e, "active"))));
    parts.push(group("Up next", "Games start one after another to keep slow connections usable.", lists.queued.map((e) => downloadRow(ctx, e, "queued"))));
    parts.push(group("Paused", "Resume to continue from the last verified part.", lists.paused.map((e) => downloadRow(ctx, e, "paused"))));
    if (updates.length) {
      parts.push(h("section", { class: "block" },
        c.sectionHead("Updates available", null, updates.length > 1 ? button({ label: "Update all", icon: "refresh", onclick: () => updates.forEach((i) => ctx.actions.install(i, true)) }) : null),
        h("div", { class: "dl-list" }, updates.map((i) =>
          h("div", { class: "dl-row" },
            h("div", { class: "row-thumb" }, c.artwork(asGame(i))),
            h("div", { class: "dl-main" }, h("div", { class: "card-title" }, i.title), h("div", { class: "muted small" }, `${i.installed.version} → ${i.latest_version}`)),
            button({ label: "Update", icon: "refresh", kind: "primary", onclick: () => ctx.actions.install(i, true) }))))));
    }

    const empty = !lists.active.length && !lists.queued.length && !lists.paused.length && !updates.length;
    if (empty) parts.push(c.emptyState({ icon: "download", title: "No downloads running", body: "Installs and updates show up here with their progress.", actions: [button({ label: "Go to library", onclick: () => ctx.navigate("library") })] }));

    const LABELS = { completed: "Installed", cancelled: "Cancelled", failed: "Failed" };
    parts.push(h("section", { class: "block" },
      c.sectionHead("History", "Installs and updates on this PC.", history.length ? button({ label: "Clear history", onclick: () => { ctx.local.clearHistory(); ctx.rerender(); } }) : null),
      history.length
        ? h("div", { class: "history" }, history.map((e) =>
            h("div", { class: "history-row" },
              h("span", { class: `status ${e.status === "completed" ? "ok" : e.status === "failed" ? "bad" : "off"}` }, LABELS[e.status] || e.status),
              h("span", { class: "history-title" }, e.title, e.version ? h("span", { class: "muted" }, ` v${e.version}`) : null),
              h("span", { class: "muted" }, e.bytes ? ctx.fmt.formatBytes(e.bytes) : ""),
              h("span", { class: "muted" }, ctx.fmt.timeAgo(e.at, ctx.now())))))
        : h("p", { class: "muted" }, "Finished downloads are listed here.")));

    return h("div", { class: "page downloads" },
      h("header", { class: "page-head" }, h("h1", {}, "Downloads"),
        h("p", { class: "muted" }, "Pause any time. If your connection drops, the download continues from the last verified part.")),
      parts);
  }

  // ------------------------------------------------------------------ wishlist
  function wishlist(ctx) {
    const { h, c, button } = ctx;
    const items = ctx.local.wishlist();
    return h("div", { class: "page wishlist" },
      h("header", { class: "page-head" }, h("h1", {}, "Wishlist"), h("p", { class: "muted" }, "Games you want to come back to. Saved on this PC only.")),
      items.length
        ? h("div", { class: "wish-list" }, items.map((w) => {
            const owned = ctx.libraryItem(w.id);
            const game = { id: w.id, title: w.title, price: w.price, isFree: w.isFree, artwork: null };
            return h("div", { class: "wish-row" },
              h("div", { class: "row-thumb" }, c.artwork(game)),
              h("div", { class: "dl-main" },
                h("div", { class: "card-title" }, w.title, w.sample ? c.badge("sample", "Sample") : null, owned ? c.badge("owned", "In library") : null),
                h("div", { class: "card-genre" }, w.studio)),
              h("div", { class: "wish-price" }, w.price ? c.price(game) : null),
              h("div", { class: "row" },
                button({ label: "View game", kind: "primary", onclick: () => ctx.navigate("game", { slug: w.slug }) }),
                button({ icon: "trash", title: `Remove ${w.title} from wishlist`, kind: "icon", onclick: () => { ctx.local.removeFromWishlist(w.id); ctx.rerender(); } })));
          }))
        : c.emptyState({ icon: "heart", title: "Your wishlist is empty", body: "Tap the heart on any game to save it here.", actions: [button({ label: "Browse the store", kind: "primary", onclick: () => ctx.navigate("store") })] }));
  }

  // ------------------------------------------------------------------ friends
  function friends(ctx) {
    const { h, c } = ctx;
    const tab = ctx.state.friendsTab;
    const list = ctx.data.friends().filter((f) => tab === "all" || (tab === "online" && f.status === "Online"));
    const tabs = [["all", "All friends"], ["online", "Online"], ["requests", "Requests"]];
    return h("div", { class: "page friends" },
      h("header", { class: "page-head" }, h("h1", {}, "Friends"), h("p", { class: "muted" }, "Friends are not available yet. This is how the page will look.")),
      c.notice("info", "Adding friends, invites and activity need the store's friends service, which is not built yet. Nothing on this page is connected."),
      h("div", { class: "tabs", role: "tablist" }, tabs.map(([value, label]) =>
        h("button", { type: "button", role: "tab", class: tab === value ? "on" : "", "aria-selected": String(tab === value), onclick: () => { ctx.state.friendsTab = value; ctx.rerender(); } }, label))),
      list.length && tab !== "requests"
        ? h("div", { class: "friend-list" }, list.map((f) =>
            h("div", { class: "friend-row" }, c.avatar(f.name), h("div", { class: "dl-main" }, h("div", { class: "card-title" }, f.name), h("div", { class: "muted small" }, f.playing ? `Playing ${f.playing}` : f.status)),
              h("span", { class: `status ${f.status === "Online" ? "ok" : "off"}` }, f.status))))
        : c.emptyState({ icon: "users", title: tab === "requests" ? "No friend requests" : "No friends yet", body: "Your friends list will appear here when friends are available." }));
  }

  const api = { library, downloads, wishlist, friends, statusOf, quickAction };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else (host.MarecUI = host.MarecUI || {})["views-library"] = api;
})(typeof window !== "undefined" ? window : globalThis);
