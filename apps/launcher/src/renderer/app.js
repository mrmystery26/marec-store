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
  const { review } = dep("views-review");
  const { search: searchView } = dep("views-search");
  const { createPlatform } = dep("platform");
  const buildInfo = dep("build-info");

  const VIEWS = {
    home, store, search: searchView, game, library: lib.library, downloads: lib.downloads, wishlist: lib.wishlist,
    friends: lib.friends, profile: account.profile, settings: account.settings, publisher, review,
  };
  // People who may use the Review screen. The store checks the role again on every request.
  const REVIEW_ROLES = ["super_admin", "store_admin", "game_moderator"];
  const canReview = (user) => Boolean(user && Array.isArray(user.roles) && user.roles.some((role) => REVIEW_ROLES.includes(role)));
  const NAV = [
    ["home", "Home", "home"], ["store", "Store", "store"], ["library", "Library", "library"],
    ["downloads", "Downloads", "download"], ["wishlist", "Wishlist", "heart"], ["friends", "Friends", "users"],
  ];
  // Phone tab bar. Wishlist, Downloads and Settings are reached from the Profile tab.
  const TABS = [["home", "Home", "home"], ["store", "Discover", "compass"], ["search", "Search", "search"], ["library", "Library", "library"], ["profile", "Profile", "user"]];
  const TAB_OF = { home: "home", store: "store", game: "store", search: "search", library: "library", profile: "profile", settings: "profile", downloads: "profile", wishlist: "profile", friends: "profile", publisher: "profile", review: "profile" };
  const TOP_LEVEL = new Set(["home", "store", "library", "downloads", "wishlist", "friends", "profile", "settings", "publisher", "review"]);

  // Form and two-click-confirm state for the Friends page. A new object whenever the account changes.
  const freshFriendsUI = () => ({ code: "", error: "", sending: false, confirmRemove: null, confirmReset: false });

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
      friendsUI: freshFriendsUI(),
      confirming: null, // game id waiting for a second click on Uninstall
      authTab: "login", profileTab: "overview", settingsSection: "general", friendsTab: "all", discoverTab: "recommended",
      mediaIndex: 0,
      store: { ...defaultFilters(), result: { key: "" } },
      libraryUI: { q: "", filter: "all", selected: null },
      searchUI: { q: "", status: "idle", items: [], total: 0, error: null },
      publisher: { gameId: null, form: null, newTitle: "", studioName: "", accepted: false, error: "", busy: false, upload: null },
      review: { tab: "studios", reason: "", busy: false },
      google: { pending: false, error: "" },
      emailCode: { sent: false, value: "", error: "", busy: false },
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
      state.friendsUI = freshFriendsUI();
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

      /** Free games are added for real. Paid games are explained, never faked. */
      async acquire(g) {
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

      // ---- Friends: every change reloads the page's data from the store, so what you see is what the store has.
      async sendFriendRequest(code) {
        const ui = state.friendsUI;
        ui.sending = true;
        try {
          const result = await call(api.sendFriendRequest(code));
          ui.code = "";
          ui.error = "";
          invalidate("friends");
          toast(result.status === "accepted" ? `You and ${result.display_name} are now friends.` : `Friend request sent to ${result.display_name}.`, "info");
        } catch (error) {
          if (error.code === "SESSION_EXPIRED") return fail(error);
          ui.error = error.message; // shown under the code box
        } finally {
          ui.sending = false;
          if (state.user) renderView();
        }
      },
      async answerFriendRequest(request, accept) {
        try {
          await call(accept ? api.acceptFriendRequest(request.id) : api.declineFriendRequest(request.id));
          toast(accept ? `You and ${request.display_name} are now friends.` : "Request declined.", "info");
        } catch (error) {
          fail(error);
        }
        invalidate("friends");
        if (state.user) renderView();
      },
      async cancelFriendRequest(request) {
        try {
          await call(api.cancelFriendRequest(request.id));
          toast("Request cancelled.", "info");
        } catch (error) {
          fail(error);
        }
        invalidate("friends");
        if (state.user) renderView();
      },
      async removeFriend(friend) {
        const ui = state.friendsUI;
        if (ui.confirmRemove !== friend.user_id) {
          ui.confirmRemove = friend.user_id; // the first click only asks "are you sure?"
          return renderView();
        }
        ui.confirmRemove = null;
        try {
          await call(api.removeFriend(friend.user_id));
          toast(`${friend.display_name} was removed from your friends.`, "info");
        } catch (error) {
          fail(error);
        }
        invalidate("friends");
        if (state.user) renderView();
      },
      async resetFriendCode() {
        const ui = state.friendsUI;
        if (!ui.confirmReset) {
          ui.confirmReset = true;
          return renderView();
        }
        ui.confirmReset = false;
        try {
          await call(api.resetFriendCode());
          toast("You have a new friend code. The old one no longer works.", "info");
        } catch (error) {
          fail(error);
        }
        invalidate("friends");
        if (state.user) renderView();
      },

      providers: () => call(api.providers()),

      // ---- Sign in with Google (the browser does the signing in; the answer arrives as an event)
      async googleSignIn() {
        state.google = { pending: true, error: "" };
        renderView();
        try {
          await call(api.googleSignIn());
        } catch (error) {
          state.google = { pending: false, error: error.message };
          renderView();
        }
      },
      async googleCancel() {
        try {
          await api.googleCancel();
        } finally {
          state.google = { pending: false, error: "" };
          renderView();
        }
      },

      // ---- Confirming an email address with the 6-digit code sent by email
      async sendEmailCode() {
        const ui = state.emailCode;
        ui.busy = true;
        ui.error = "";
        renderView();
        try {
          await call(api.sendEmailCode());
          ui.sent = true;
          toast("We emailed you a 6-digit code.", "info");
        } catch (error) {
          ui.error = error.message;
        } finally {
          ui.busy = false;
          renderView();
        }
      },
      async verifyEmail(code) {
        const ui = state.emailCode;
        ui.busy = true;
        ui.error = "";
        renderView();
        try {
          state.user = await call(api.verifyEmail(code));
          state.emailCode = { sent: false, value: "", error: "", busy: false };
          invalidate("developer");
          toast("Your email address is confirmed.", "info");
        } catch (error) {
          ui.error = error.message;
          ui.busy = false;
        }
        renderView();
      },

      // ---- Publisher portal and staff review. Views handle their own busy and error states.
      dev: {
        account: () => call(api.developerAccount()),
        register: (studioName, termsVersion) => call(api.registerDeveloper(studioName, termsVersion)),
        games: (studioId) => call(api.studioGames(studioId)),
        createGame: (studioId, title) => call(api.createGame(studioId, title)),
        game: (gameId) => call(api.developerGame(gameId)),
        updateGame: (gameId, changes) => call(api.updateGame(gameId, changes)),
        submitGame: (gameId) => call(api.submitGame(gameId)),
        builds: (gameId) => call(api.builds(gameId)),
        pickBuildFolder: () => call(api.pickBuildFolder()),
        uploadBuild: (options) => call(api.uploadBuild(options)),
        cancelUpload: () => call(api.cancelUpload()),
        downloadSdkConfig: (gameId) => call(api.downloadSdkConfig(gameId)),
        onUploadProgress: (callback) => api.onUploadProgress(callback),
      },
      admin: {
        studios: (status) => call(api.adminStudios(status)),
        verifyStudio: (id) => call(api.verifyStudio(id)),
        games: (status) => call(api.adminGames(status)),
        transition: (id, action, reason) => call(api.transitionGame(id, action, reason)),
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
      openLibraryPanel, clearTimers, setTimer, reduceMotion,
      emailCard: () => account.emailCard(ctx),
      canReview: () => canReview(state.user),
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
          canReview(state.user) ? (() => {
            const btn = h("button", { type: "button", class: "nav-item", title: "Review", onclick: () => navigate("review") }, icon("check", 20), h("span", { class: "nav-label" }, "Review"));
            navButtons.set("review", btn);
            return btn;
          })() : null,
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
      const main = h("div", { class: "main" }, topbar, content, bottomNav);
      const el = h("div", { class: "shell" }, sidebar, main);

      function applyCollapsed() {
        el.className = `shell ${state.sidebarCollapsed ? "collapsed" : ""}`.trim();
        collapse.setAttribute("aria-pressed", String(state.sidebarCollapsed));
      }
      return { el, content, navButtons, tabButtons, tabBadge, badge, bell, avatarBtn, backBtn, fwdBtn, applyCollapsed };
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
      // The way back from Google: the launcher tells us when the browser sign-in finished.
      api.onAuthEvent(async (event) => {
        if (event.type === "signed-in") {
          state.google = { pending: false, error: "" };
          state.user = event.user;
          toast("You are signed in with Google.", "info");
          await afterSignIn();
        } else {
          state.google = { pending: false, error: event.message || "Sign-in did not finish." };
          if (state.user) toast(state.google.error);
          else renderView();
        }
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
