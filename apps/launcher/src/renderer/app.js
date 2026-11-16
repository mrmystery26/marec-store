"use strict";
// The MAREC Store window. It owns the app state, routing, the persistent shell (sidebar and top bar)
// and the actions views can trigger. Everything shown comes from the launcher service through
// window.marec, and all text is inserted as text (never as HTML), so a game title cannot inject anything.
(function (host) {
  const dep = (name) => (typeof require === "function" ? require(`./js/${name}`) : host.MarecUI[name]);
  const fmt = dep("format");
  const { createDom } = dep("dom");
  const { createLocalStore } = dep("local-store");
  const { createData, unwrap } = dep("data");
  const { createDownloads } = dep("downloads");
  const { createComponents } = dep("components");
  const { home } = dep("views-home");
  const { store, defaultFilters } = dep("views-store");
  const { game } = dep("views-game");
  const lib = dep("views-library");
  const account = dep("views-account");
  const { publisher } = dep("views-publisher");
  const { search: searchView } = dep("views-search");
  const { createPlatform } = dep("platform");
  const buildInfo = dep("build-info");

  const VIEWS = {
    home, store, search: searchView, game, library: lib.library, downloads: lib.downloads, wishlist: lib.wishlist,
    friends: lib.friends, profile: account.profile, settings: account.settings, publisher,
  };
  const NAV = [
    ["home", "Home", "home"], ["store", "Store", "store"], ["library", "Library", "library"],
    ["downloads", "Downloads", "download"], ["wishlist", "Wishlist", "heart"], ["friends", "Friends", "users"],
  ];
  // Phone tab bar. Wishlist, Downloads and Settings are reached from the Profile tab.
  const TABS = [["home", "Home", "home"], ["store", "Discover", "compass"], ["search", "Search", "search"], ["library", "Library", "library"], ["profile", "Profile", "user"]];
  const TAB_OF = { home: "home", store: "store", game: "store", search: "search", library: "library", profile: "profile", settings: "profile", downloads: "profile", wishlist: "profile", friends: "profile", publisher: "profile" };
  const TOP_LEVEL = new Set(["home", "store", "library", "downloads", "wishlist", "friends", "profile", "settings", "publisher"]);

  function createApp({ doc, root, api, now = Date.now, storage = null, platform = createPlatform(host) }) {
    const { h, icon, button } = createDom(doc);
    const local = createLocalStore(storage, { now });
    const data = createData({ api, local, now });
    const initial = local.prefs();

    const state = {
      route: { name: "login", params: {} },
      past: [], future: [], // for the Back and Forward buttons
      user: null, apiBase: "", installRoot: "", secureStorage: true, version: "",
      library: [], loadingLibrary: false,
      confirming: null, // game id waiting for a second click on Uninstall
      authTab: "login", profileTab: "overview", settingsSection: "general", friendsTab: "all", discoverTab: "recommended",
      mediaIndex: 0,
      store: { ...defaultFilters(), result: { key: "" } },
      libraryUI: { q: "", filter: "all", selected: null },
      searchUI: { q: "", status: "idle", items: [], total: 0, error: null },
      publisher: { tab: "overview", newName: "", nameError: "", creating: false },
      draft: { apiBase: "", installRoot: "" },
      panel: null, // "notifications" | "account" | null: the dropdown under the top bar
      modal: null,
      sidebarCollapsed: Boolean(initial.sidebarCollapsed),
    };

    const bars = new Map(); // game id -> [{fill, label, meta}] currently on screen
    const cache = new Map(); // resource key -> {status, data, error}
    const timers = [];
    let toastTimer = null;
    let shell = null;
    let searchBox = null;

    // ------------------------------------------------------------------ small helpers
    const isToast = (el) => /\btoast\b/.test(el.className || "");
    const reduceMotion = () => {
      if (local.prefs().reduceMotion) return true;
      return Boolean(host.matchMedia && host.matchMedia("(prefers-reduced-motion: reduce)").matches);
    };

    function clearTimers() {
      while (timers.length) clearTimeout(timers.pop());
    }
    function setTimer(fn, ms) {
      const id = setTimeout(fn, ms);
      if (id && id.unref) id.unref();
      timers.push(id);
    }

    function toast(message, kind) {
      for (const old of Array.from(root.children).filter(isToast)) old.remove();
      const el = h("div", { class: `toast ${kind || ""}`.trim(), role: "alert" }, message);
      root.append(el);
      if (toastTimer) clearTimeout(toastTimer);
      toastTimer = setTimeout(() => el.remove(), 6000);
      if (toastTimer.unref) toastTimer.unref();
    }

    async function call(promise) {
      return unwrap(promise);
    }

    function fail(error) {
      if (error.code === "SESSION_EXPIRED") {
        resetSession();
        state.route = { name: "login", params: {} };
        render();
      }
      toast(error.message);
    }

    function resetSession() {
      state.user = null;
      state.library = [];
      state.past = [];
      state.future = [];
      cache.clear();
      state.panel = null;
      state.modal = null;
    }

    // ------------------------------------------------------------------ resources (cached loads)
    /** Loads once per key and redraws when the answer arrives. Returns {status, data, error}. */
    function resource(key, fetcher) {
      const existing = cache.get(key);
      if (existing) return existing;
      const entry = { status: "loading", data: null, error: null };
      cache.set(key, entry);
      const routeAtStart = state.route;
      Promise.resolve()
        .then(fetcher)
        .then((value) => { entry.status = "ready"; entry.data = value; })
        .catch((error) => { entry.status = "error"; entry.error = error; })
        .then(() => { if (cache.get(key) === entry && state.route === routeAtStart) renderView(); });
      return entry;
    }
    function invalidate(prefix) {
      for (const key of Array.from(cache.keys())) if (key.startsWith(prefix)) cache.delete(key);
    }

    // ------------------------------------------------------------------ progress bars
    function updateBars(gameId) {
      const p = downloads.progress(gameId);
      for (const bar of bars.get(gameId) || []) {
        bar.fill.style.width = `${p ? p.percent : 0}%`;
        bar.label.textContent = p ? (p.total ? `${p.percent}% · ${fmt.formatBytes(p.done)} of ${fmt.formatBytes(p.total)}` : "Preparing…") : "";
        if (bar.meta) {
          const status = downloads.statusOf(gameId);
          bar.meta.textContent = !p ? "" : status === "paused" ? "Paused" : [p.speed ? fmt.formatSpeed(p.speed) : "", fmt.formatEta(p.eta)].filter(Boolean).join(", ");
        }
      }
    }

    /** A progress bar for one game, updated in place as progress events arrive. */
    function progressBar(gameId, { detail = false } = {}) {
      const fill = h("div");
      const label = h("div", { class: "meta" });
      const meta = detail ? h("div", { class: "meta" }) : null;
      const list = bars.get(gameId) || [];
      list.push({ fill, label, meta });
      bars.set(gameId, list);
      setTimeout(() => updateBars(gameId), 0).unref?.();
      return [h("div", { class: "bar" }, fill), label, meta];
    }

    // ------------------------------------------------------------------ downloads and notifications
    const downloads = createDownloads({
      api,
      now,
      limit: initial.simultaneousDownloads,
      onChange: () => { updateNav(); renderView(); },
      onDone: async ({ item, update, status, version, pending, error, bytes }) => {
        if (status === "completed") {
          local.addHistory({ gameId: item.game_id, title: item.title, version, bytes, status });
          toast(pending ? `${item.title} is downloaded. Confirm the install in the Android dialog.` : `${item.title} ${version} is installed.`, "info");
          if (local.prefs().notifyDownloads) local.notify("download", `${item.title} ${update ? "updated" : "installed"}`, `Version ${version} is ready to play.`);
        } else if (status === "cancelled") {
          local.addHistory({ gameId: item.game_id, title: item.title, status });
          toast("Download cancelled. You can resume it later.", "info");
        } else if (status === "failed") {
          local.addHistory({ gameId: item.game_id, title: item.title, status });
          if (error.code === "SESSION_EXPIRED") return fail(error);
          toast(error.message);
        }
        await loadLibrary();
        updateNav();
        renderView();
      },
    });

    // ------------------------------------------------------------------ library
    async function loadLibrary() {
      state.loadingLibrary = true;
      try {
        state.library = await call(api.library());
        notifyUpdates();
      } catch (error) {
        fail(error);
      } finally {
        state.loadingLibrary = false;
      }
    }

    function notifyUpdates() {
      if (!local.prefs().notifyUpdates) return;
      for (const item of state.library) {
        if (!item.update_available) continue;
        const key = `${item.game_id}@${item.latest_version}`;
        if (local.hasSeen(key)) continue;
        local.markSeen(key);
        local.notify("update", `${item.title} has an update`, `Version ${item.latest_version} is available.`);
      }
    }

    const libraryItem = (gameId) => state.library.find((i) => i.game_id === gameId);

    /** A compact library tile used on the profile page. */
    function libraryTile(item) {
      const c = components;
      return h("div", { class: "lib-card compact" },
        h("button", { type: "button", class: "card-hit", onclick: () => { state.libraryUI.selected = item.game_id; navigate("library"); } },
          h("div", { class: "card-art" }, c.artwork({ title: item.title, artwork: null })),
          h("div", { class: "card-body" }, h("div", { class: "card-title" }, item.title), lib.statusOf(ctx, item))));
    }

    // ------------------------------------------------------------------ actions
    const actions = {
      async login(email, password) {
        try {
          state.user = await call(api.login(email, password));
          await afterSignIn();
        } catch (error) {
          fail(error);
        }
      },
      async register(email, password, displayName) {
        try {
          await call(api.register(email, password, displayName));
          state.user = await call(api.login(email, password));
          toast("Your account is ready.", "info");
          await afterSignIn();
        } catch (error) {
          fail(error);
        }
      },
      async logout() {
        await api.logout();
        resetSession();
        state.route = { name: "login", params: {} };
        render();
      },

      install(item, isUpdate = false) {
        if (!downloads.enqueue(item, { update: isUpdate })) return;
        if (downloads.statusOf(item.game_id) === "queued") toast(`${item.title} will start when the current download finishes.`, "info");
      },

      async play(item) {
        try {
          const result = await call(api.play(item.game_id));
          local.markPlayed(item.game_id);
          if (!result.delivered) toast("The game started but did not ask for its launch token (it may not use the MAREC SDK yet).", "info");
          renderView();
        } catch (error) {
          fail(error);
        }
      },

      async verify(item) {
        toast(`Checking ${item.title}…`, "info");
        try {
          const result = await call(api.verify(item.game_id));
          toast(result.ok ? "All files are intact." : `${result.problems.length} file(s) are damaged. Uninstall and install again to repair.`, result.ok ? "info" : "");
        } catch (error) {
          fail(error);
        }
      },

      async uninstall(item) {
        if (state.confirming !== item.game_id) {
          state.confirming = item.game_id;
          renderView();
          return;
        }
        state.confirming = null;
        try {
          await call(api.uninstall(item.game_id));
          await loadLibrary();
        } catch (error) {
          fail(error);
        }
        renderView();
      },

      toggleWish(g) {
        if (local.inWishlist(g.id)) {
          local.removeFromWishlist(g.id);
          toast(`${g.title} was removed from your wishlist.`, "info");
        } else {
          local.addToWishlist(g);
          toast(`${g.title} was added to your wishlist.`, "info");
        }
        renderView();
      },

      /** Free games are added for real. Paid games and sample games are explained, never faked. */
      async acquire(g) {
        if (g.sample) return openModal(sampleGameDialog(g));
        if (!g.isFree) return openModal(paymentsDialog(g));
        try {
          await call(api.addToLibrary(g.id));
          await loadLibrary();
          toast(`${g.title} was added to your library.`, "info");
          renderView();
        } catch (error) {
          fail(error);
        }
      },

      async saveSettings(next) {
        try {
          await call(api.saveSettings(next));
          await refreshState();
          cache.clear();
          state.store.result = { key: "" };
          toast("Settings saved.", "info");
          if (!state.user) state.route = { name: "settings", params: {} };
          else await loadLibrary();
          render();
        } catch (error) {
          fail(error);
        }
      },
      async pickFolder() {
        try {
          return await call(api.pickFolder());
        } catch (error) {
          fail(error);
          return null;
        }
      },

      studios: () => call(api.studios()),
      studioGames: (id) => call(api.studioGames(id)),
      async createStudio(name) {
        state.publisher.creating = true;
        try {
          await call(api.createStudio(name));
          state.publisher.newName = "";
          state.publisher.nameError = "";
          invalidate("studios");
          toast("Studio registered. It stays pending until MAREC verifies it.", "info");
        } catch (error) {
          state.publisher.nameError = error.message;
        } finally {
          state.publisher.creating = false;
          renderView();
        }
      },
    };

    // Dialogs for the things that cannot happen yet. They say why and offer a way forward.
    function paymentsDialog(g) {
      const view = fmt.priceView(g, local.prefs().currency);
      return {
        title: "Paid purchases are not open yet",
        body: [h("p", {}, `${g.title} costs ${view.label}. MAREC Store cannot take payments yet, so nothing has been charged and nothing was added to your library.`),
          h("p", { class: "muted" }, "Mobile money and bank payments are planned. You can save the game to your wishlist in the meantime.")],
        actions: [
          button({ label: "Close", onclick: closeModal }),
          button({ label: local.inWishlist(g.id) ? "Already on wishlist" : "Add to wishlist", kind: "primary", disabled: local.inWishlist(g.id), onclick: () => { closeModal(); actions.toggleWish(g); } }),
        ],
      };
    }
    function sampleGameDialog(g) {
      return {
        title: "This is a sample game",
        body: [h("p", {}, `${g.title} is a fictional game used to preview the store design. It has no files, so it cannot be bought, added or installed.`)],
        actions: [
          button({ label: "Close", onclick: closeModal }),
          button({ label: "Switch to the live store", kind: "primary", onclick: () => { closeModal(); setSample(false); } }),
        ],
      };
    }

    // ------------------------------------------------------------------ sample mode
    function setSample(on) {
      local.setPref("sampleStore", Boolean(on));
      cache.clear();
      state.store = { ...defaultFilters(), result: { key: "" } };
      if (shell) shell.refreshBanner();
      toast(on ? "Previewing the store with sample games." : "Showing the live store.", "info");
      if (state.route.name === "game") state.route = { name: "home", params: {} };
      render();
    }

    // ------------------------------------------------------------------ modal
    function openModal(spec) {
      state.modal = spec;
      renderOverlays();
    }
    function closeModal() {
      state.modal = null;
      renderOverlays();
    }

    // ------------------------------------------------------------------ routing
    function navigate(name, params = {}, { push = true } = {}) {
      if (push && state.route.name !== "login") {
        state.past.push(state.route);
        state.future = [];
      }
      state.route = { name, params };
      state.panel = null;
      state.confirming = null;
      if (name === "game") state.mediaIndex = 0;
      renderView({ resetScroll: true });
      updateNav();
      renderOverlays();
    }
    const openGame = (g) => navigate("game", { slug: g.slug });
    function history(direction) {
      const from = direction < 0 ? state.past : state.future;
      const to = direction < 0 ? state.future : state.past;
      if (!from.length) return;
      to.push(state.route);
      const target = from.pop();
      state.route = target;
      state.panel = null;
      renderView({ resetScroll: true });
      updateNav();
      renderOverlays();
    }

    /** Opens the store with some filters set (used by genre chips and the top search). */
    function browse(patch) {
      state.store = { ...state.store, ...patch, result: { key: "" } };
      navigate("store");
    }

    function openLibraryPanel(gameId) {
      state.libraryUI.selected = gameId;
      renderView();
    }

    // ------------------------------------------------------------------ context handed to views
    const components = createComponents({
      h, icon, button, fmt,
      env: {
        currency: () => local.prefs().currency,
        isOwned: (id) => Boolean(libraryItem(id)),
        isWished: (id) => local.inWishlist(id),
        toggleWish: (g) => actions.toggleWish(g),
        openGame,
      },
    });

    const ctx = {
      h, icon, button, fmt, c: components, state, local, data, dl: downloads, actions, now, platform, buildInfo,
      navigate, openGame, browse, resource, invalidate, toast, libraryItem, libraryTile, progressBar,
      openLibraryPanel, setSample, clearTimers, setTimer, reduceMotion,
      rerender: () => renderView(),
      rerenderShell: () => { if (shell) shell.applyCollapsed(); renderView(); },
      clearSearch: () => { if (searchBox) searchBox.value = ""; },
      openModal, closeModal,
    };

    // ------------------------------------------------------------------ shell
    function buildShell() {
      const content = h("main", { class: "content", id: "content" });
      const navButtons = new Map();
      const badge = h("span", { class: "nav-badge" });
      const sidebar = h("nav", { class: "sidebar", "aria-label": "Main" },
        h("div", { class: "brand" }, h("span", { class: "brand-mark" }, "M"), h("span", { class: "brand-text" }, "MAREC", h("b", {}, "STORE"))),
        h("div", { class: "nav" },
          NAV.map(([id, label, iconName]) => {
            const btn = h("button", { type: "button", class: "nav-item", title: label, onclick: () => navigate(id) },
              icon(iconName, 20), h("span", { class: "nav-label" }, label), id === "downloads" ? badge : null);
            navButtons.set(id, btn);
            return btn;
          })),
        h("div", { class: "nav bottom" },
          (() => {
            const btn = h("button", { type: "button", class: "nav-item publisher-link", title: "Publisher portal", onclick: () => navigate("publisher") }, icon("upload", 20), h("span", { class: "nav-label" }, "Publisher portal"));
            navButtons.set("publisher", btn);
            return btn;
          })()));

      searchBox = h("input", { type: "search", placeholder: "Search the store", "aria-label": "Search the store", class: "search-input" });
      const runSearch = (event) => {
        if (event && event.preventDefault) event.preventDefault();
        browse({ q: searchBox.value.trim(), category: "", tab: "all" });
      };
      const bell = h("button", { type: "button", class: "icon-btn", title: "Notifications", "aria-label": "Notifications", onclick: () => togglePanel("notifications") }, icon("bell", 18), h("span", { class: "dot" }));
      const avatarBtn = h("button", { type: "button", class: "avatar-btn", title: "Account", "aria-label": "Account menu", onclick: () => togglePanel("account") });
      const collapse = h("button", { type: "button", class: "icon-btn desktop-only", title: "Collapse sidebar", "aria-label": "Collapse sidebar", onclick: () => { state.sidebarCollapsed = !state.sidebarCollapsed; local.setPref("sidebarCollapsed", state.sidebarCollapsed); applyCollapsed(); } }, icon("sidebar", 18));
      const backBtn = h("button", { type: "button", class: "icon-btn desktop-only", title: "Back", "aria-label": "Back", onclick: () => history(-1) }, icon("chevron-left", 18));
      const fwdBtn = h("button", { type: "button", class: "icon-btn desktop-only", title: "Forward", "aria-label": "Forward", onclick: () => history(1) }, icon("chevron-right", 18));
      const banner = h("div", { class: "banner", role: "status" });
      const topbar = h("header", { class: "topbar" },
        collapse, backBtn, fwdBtn,
        h("div", { class: "top-brand" }, h("span", { class: "brand-mark" }, "M"), h("span", { class: "brand-text" }, "MAREC", h("b", {}, "STORE"))),
        h("form", { class: "search-box top desktop-only", role: "search", onsubmit: runSearch }, icon("search", 16), searchBox),
        h("div", { class: "top-actions" }, bell, h("button", { type: "button", class: "icon-btn", title: "Settings", "aria-label": "Settings", onclick: () => navigate("settings") }, icon("sliders", 18)), avatarBtn));
      const tabButtons = new Map();
      const tabBadge = h("span", { class: "nav-badge" });
      const bottomNav = h("nav", { class: "bottom-nav", "aria-label": "Main" }, TABS.map(([id, label, iconName]) => {
        const btn = h("button", { type: "button", class: "tab", onclick: () => navigate(id) }, icon(iconName, 22), h("span", {}, label), id === "profile" ? tabBadge : null);
        tabButtons.set(id, btn);
        return btn;
      }));
      const main = h("div", { class: "main" }, topbar, banner, content, bottomNav);
      const el = h("div", { class: "shell" }, sidebar, main);

      function applyCollapsed() {
        el.className = `shell ${state.sidebarCollapsed ? "collapsed" : ""}`.trim();
        collapse.setAttribute("aria-pressed", String(state.sidebarCollapsed));
      }
      function refreshBanner() {
        if (local.prefs().sampleStore) {
          banner.className = "banner on";
          banner.replaceChildren(icon("info", 16), h("span", {}, "You are previewing the store with sample games. They are fictional and cannot be bought or installed."),
            button({ label: "Switch to the live store", kind: "link", onclick: () => setSample(false) }));
        } else {
          banner.className = "banner";
          banner.replaceChildren();
        }
      }
      return { el, content, navButtons, tabButtons, tabBadge, badge, bell, avatarBtn, backBtn, fwdBtn, applyCollapsed, refreshBanner };
    }

    function updateNav() {
      if (!shell) return;
      for (const [id, btn] of shell.navButtons) {
        const active = state.route.name === id || (id === "store" && state.route.name === "game");
        btn.className = `nav-item ${id === "publisher" ? "publisher-link" : ""} ${active ? "active" : ""}`.replace(/\s+/g, " ").trim();
        if (active) btn.setAttribute("aria-current", "page");
        else btn.setAttribute("aria-current", "false");
      }
      for (const [id, btn] of shell.tabButtons) {
        const active = TAB_OF[state.route.name] === id;
        btn.className = `tab ${active ? "on" : ""}`.trim();
        btn.setAttribute("aria-current", active ? "page" : "false");
      }
      const count = downloads.count();
      shell.badge.textContent = count ? String(count) : "";
      shell.badge.className = `nav-badge ${count ? "on" : ""}`.trim();
      shell.tabBadge.textContent = count ? String(count) : "";
      shell.tabBadge.className = `nav-badge ${count ? "on" : ""}`.trim();
      const unread = local.unreadCount();
      shell.bell.className = `icon-btn ${unread ? "has-unread" : ""}`.trim();
      shell.bell.setAttribute("aria-label", unread ? `Notifications, ${unread} unread` : "Notifications");
      shell.avatarBtn.replaceChildren(components.avatar(state.user ? state.user.display_name || state.user.email : "?"));
      shell.backBtn.disabled = !state.past.length;
      shell.fwdBtn.disabled = !state.future.length;
    }

    function togglePanel(name) {
      state.panel = state.panel === name ? null : name;
      if (state.panel === "notifications") local.markNotificationsRead();
      updateNav();
      renderOverlays();
    }

    function notificationsPanel() {
      const items = local.notifications();
      return h("div", { class: "popover notifications", role: "dialog", "aria-label": "Notifications" },
        h("header", {}, h("strong", {}, "Notifications"), items.length ? button({ label: "Clear all", kind: "link", onclick: () => { local.clearNotifications(); updateNav(); renderOverlays(); } }) : null),
        items.length
          ? h("ul", {}, items.map((n) => h("li", {}, h("div", { class: "card-title" }, n.title), h("div", { class: "muted small" }, n.body), h("div", { class: "muted small" }, fmt.timeAgo(n.at, now())))))
          : h("p", { class: "muted pad" }, "Nothing new. Finished downloads and updates show up here."));
    }

    function accountPanel() {
      const user = state.user;
      return h("div", { class: "popover account-menu", role: "menu", "aria-label": "Account" },
        h("div", { class: "who" }, components.avatar(user.display_name || user.email, "lg"), h("div", {}, h("strong", {}, user.display_name || user.email), h("div", { class: "muted small" }, user.email))),
        h("button", { type: "button", role: "menuitem", onclick: () => navigate("profile") }, icon("user", 16), "Profile"),
        h("button", { type: "button", role: "menuitem", onclick: () => navigate("settings") }, icon("sliders", 16), "Settings"),
        h("button", { type: "button", role: "menuitem", onclick: () => actions.logout() }, icon("logout", 16), "Log out"));
    }

    // ------------------------------------------------------------------ rendering
    let overlayEls = [];
    function renderOverlays() {
      for (const el of overlayEls) el.remove();
      overlayEls = [];
      if (!shell || !state.user) return;
      const add = (el) => { overlayEls.push(el); root.append(el); };
      if (state.panel) {
        const veil = h("div", { class: "veil", onclick: () => { state.panel = null; renderOverlays(); } });
        add(veil);
        add(state.panel === "notifications" ? notificationsPanel() : accountPanel());
      }
      if (state.modal) {
        const spec = state.modal;
        add(components.modal({ title: spec.title, children: spec.body, actions: spec.actions, onClose: closeModal }));
      }
    }

    function renderView({ resetScroll = false } = {}) {
      bars.clear();
      clearTimers();
      if (!state.user) {
        const view = state.route.name === "settings" ? h("div", { class: "content solo" }, VIEWS.settings(ctx)) : account.login(ctx);
        root.replaceChildren(view, ...Array.from(root.children).filter(isToast));
        shell = null;
        return;
      }
      if (!shell) {
        shell = buildShell();
        shell.applyCollapsed();
        shell.refreshBanner();
        root.replaceChildren(shell.el, ...Array.from(root.children).filter(isToast));
      }
      const viewFn = VIEWS[state.route.name] || VIEWS.home;
      const scroll = shell.content.scrollTop || 0;
      shell.content.replaceChildren(viewFn(ctx));
      shell.content.scrollTop = resetScroll ? 0 : scroll;
      for (const id of bars.keys()) updateBars(id);
    }

    function render() {
      if (!state.user) shell = null; // the sign-in page replaces the shell
      renderView({ resetScroll: true });
      updateNav();
      renderOverlays();
    }

    // ------------------------------------------------------------------ startup
    async function refreshState() {
      Object.assign(state, await call(api.state()));
      state.draft = { apiBase: state.apiBase, installRoot: state.installRoot };
    }

    async function afterSignIn() {
      state.route = { name: "home", params: {} };
      state.past = [];
      state.future = [];
      cache.clear();
      shell = null;
      render();
      await loadLibrary();
      updateNav();
      renderView();
    }

    async function start() {
      if (platform.mobile) {
        // The Android app calls this when the system Back button is pressed; true means it was handled.
        host.MarecAndroidBack = () => {
          if (state.modal) { closeModal(); return true; }
          if (state.panel) { state.panel = null; renderOverlays(); return true; }
          if (state.user && state.past.length) { history(-1); return true; }
          return false;
        };
      }
      api.onInstallProgress((p) => {
        if (downloads.handleProgress(p)) updateBars(p.gameId);
      });
      if (doc.addEventListener) {
        doc.addEventListener("keydown", (event) => {
          if (event.key !== "Escape") return;
          if (state.modal) closeModal();
          else if (state.panel) togglePanel(state.panel);
        });
      }
      try {
        await refreshState();
        if (state.user) {
          state.route = { name: "home", params: {} };
          await loadLibrary();
        } else {
          state.route = { name: "login", params: {} };
        }
      } catch (error) {
        toast(error.message);
      }
      render();
    }

    return { start, render, state, ctx, navigate, local, downloads, install: (item) => actions.install(item), formatBytes: fmt.formatBytes };
  }

  if (typeof module !== "undefined" && module.exports) module.exports = { createApp };
  else if (host.marec) {
    createApp({ doc: host.document, root: host.document.getElementById("app"), api: host.marec, storage: host.localStorage }).start();
  }
})(typeof window !== "undefined" ? window : globalThis);
