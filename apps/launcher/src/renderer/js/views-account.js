"use strict";
// Sign in / create account, the player's profile, and settings.
(function (host) {
  const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

  /** Checks the create-account form with the same rules the store API enforces. */
  function validateRegistration({ name, email, password, confirm }) {
    const errors = {};
    const cleanName = String(name || "").split(/\s+/).filter(Boolean).join(" ");
    if (cleanName.length < 2 || cleanName.length > 40) errors.name = "Use 2 to 40 characters for your display name.";
    if (!EMAIL.test(String(email || "").trim())) errors.email = "Enter a valid email address.";
    if (String(password || "").length < 10) errors.password = "Use at least 10 characters.";
    else if (password.length > 128) errors.password = "Use 128 characters or fewer.";
    else if (password.toLowerCase() === String(email || "").trim().toLowerCase()) errors.password = "Your password must not be your email address.";
    if (!errors.password && password !== confirm) errors.confirm = "The passwords do not match.";
    return { errors, clean: { name: cleanName, email: String(email || "").trim(), password } };
  }

  // ------------------------------------------------------------------ sign in
  function login(ctx) {
    const { h, c, button } = ctx;
    const tab = ctx.state.authTab;
    const values = { name: "", email: "", password: "", confirm: "" };
    let errors = {};
    const form = h("form", { class: "auth-form", novalidate: "novalidate" });

    const refs = {};
    // Values are read from the fields themselves when the form is sent, so autofill works too.
    const sync = () => { for (const [name, el] of Object.entries(refs)) values[name] = el.value; };
    const input = (name, props) => {
      const el = h("input", { value: values[name], "aria-label": props.label, ...props.attrs, oninput: (e) => { values[name] = e.target.value; } });
      refs[name] = el;
      return el;
    };

    function paint() {
      if (tab === "login") {
        form.replaceChildren(
          c.field({ label: "Email", input: input("email", { label: "Email", attrs: { type: "email", autocomplete: "username" } }) }),
          c.field({ label: "Password", input: input("password", { label: "Password", attrs: { type: "password", autocomplete: "current-password" } }) }),
          button({ label: "Log in", kind: "primary wide", type: "submit" }));
      } else {
        form.replaceChildren(
          c.field({ label: "Display name", error: errors.name, input: input("name", { label: "Display name", attrs: { type: "text", autocomplete: "nickname", maxlength: "40" } }) }),
          c.field({ label: "Email", error: errors.email, input: input("email", { label: "Email", attrs: { type: "email", autocomplete: "email" } }) }),
          c.field({ label: "Password", hint: "At least 10 characters.", error: errors.password, input: input("password", { label: "Password", attrs: { type: "password", autocomplete: "new-password" } }) }),
          c.field({ label: "Confirm password", error: errors.confirm, input: input("confirm", { label: "Confirm password", attrs: { type: "password", autocomplete: "new-password" } }) }),
          button({ label: "Create account", kind: "primary wide", type: "submit" }));
      }
    }
    form.addEventListener("submit", (event) => {
      if (event && event.preventDefault) event.preventDefault();
      sync();
      if (tab === "login") return ctx.actions.login(values.email.trim(), values.password);
      const { errors: found, clean } = validateRegistration(values);
      errors = found;
      if (Object.keys(found).length) return paint();
      return ctx.actions.register(clean.email, clean.password, clean.name);
    });
    paint();

    const switchTab = (next) => { ctx.state.authTab = next; ctx.rerender(); };

    // "Continue with Google" appears only when this store has Google set up (the server says so).
    const providers = ctx.state.apiBase ? ctx.resource("providers", () => ctx.actions.providers()) : null;
    const google = ctx.state.google;
    let googleBlock = null;
    if (providers && providers.status === "ready" && providers.data.google) {
      googleBlock = h("div", { class: "auth-google" },
        google.pending
          ? h("div", { class: "auth-waiting", role: "status" },
              h("p", {}, "Finish signing in with Google in your browser, then come back here."),
              button({ label: "Cancel", kind: "ghost", onclick: () => ctx.actions.googleCancel() }))
          : button({ label: "Continue with Google", kind: "primary wide", onclick: () => ctx.actions.googleSignIn() }),
        google.error ? c.notice("warn", google.error) : null,
        h("div", { class: "auth-or" }, h("span", {}, "or use your email")));
    }
    return h("div", { class: "auth" },
      h("section", { class: "auth-brand" },
        h("div", { class: "wordmark" }, "MAREC", h("span", {}, "STORE")),
        h("p", { class: "tagline" }, "Play Local. Think Global."),
        h("p", { class: "muted" }, "Games from Malawi and across Africa, in kwacha, on your PC.")),
      h("section", { class: "auth-card" },
        h("div", { class: "tabs", role: "tablist" },
          h("button", { type: "button", role: "tab", class: tab === "login" ? "on" : "", "aria-selected": String(tab === "login"), onclick: () => switchTab("login") }, "Log in"),
          h("button", { type: "button", role: "tab", class: tab === "register" ? "on" : "", "aria-selected": String(tab === "register"), onclick: () => switchTab("register") }, "Create account")),
        ctx.state.apiBase ? null : c.notice("warn", "Set the store server address first. Tap Server settings below."),
        googleBlock,
        form,
        tab === "login" ? h("p", { class: "note" }, "Signed up with Google? Use the Google button above. Those accounts have no password.") : null,
        h("p", { class: "note" }, ctx.state.apiBase ? `Server: ${ctx.state.apiBase}` : "Server: not set"),
        button({ label: "Server settings", kind: "link", onclick: () => ctx.navigate("settings") })));
  }

  // ------------------------------------------------------------------ confirming an email address
  /** Shown while the address is not confirmed: ask for a code by email, then type it in. */
  function emailCard(ctx) {
    const { h, c, button } = ctx;
    const ui = ctx.state.emailCode;
    const input = h("input", {
      value: ui.value, inputmode: "numeric", maxlength: "6", autocomplete: "one-time-code", placeholder: "6-digit code", "aria-label": "6-digit code",
      oninput: (e) => { ui.value = e.target.value.replace(/\D/g, "").slice(0, 6); },
    });
    const confirm = () => ctx.actions.verifyEmail(String(input.value || ui.value).trim());
    return h("section", { class: "block narrow email-card" },
      c.sectionHead("Confirm your email", "Some things, such as creating a developer account, need a confirmed email address."),
      ui.error ? c.notice("warn", ui.error) : null,
      ui.sent
        ? h("div", {},
            c.field({ label: "Code from the email", hint: "It works for 15 minutes.", input }),
            h("div", { class: "row" },
              button({ label: "Confirm", kind: "primary", disabled: ui.busy, onclick: confirm }),
              button({ label: "Send a new code", kind: "ghost", disabled: ui.busy, onclick: () => ctx.actions.sendEmailCode() })))
        : button({ label: ui.busy ? "Sending…" : "Email me a code", kind: "primary", disabled: ui.busy, onclick: () => ctx.actions.sendEmailCode() }));
  }

  // ------------------------------------------------------------------ profile
  const SOURCES = { free: "Added free", purchase: "Purchase", gift: "Gift", grant: "Granted by MAREC" };

  function profile(ctx) {
    const { h, c } = ctx;
    const user = ctx.state.user;
    const library = ctx.state.library;
    const tab = ctx.state.profileTab;
    const installed = library.filter((i) => i.installed);
    const recent = ctx.local.recentlyPlayed(6).map((id) => library.find((i) => i.game_id === id)).filter(Boolean);
    const tabs = [["overview", "Overview"], ["games", "Owned games"], ["purchases", "Purchase history"]];

    const stat = (label, value) => h("div", { class: "stat" }, h("strong", {}, String(value)), h("span", { class: "muted" }, label));
    let body;
    if (tab === "overview") {
      body = h("div", {},
        h("div", { class: "profile-menu" }, [["wishlist", "Wishlist", "heart"], ["downloads", "Downloads", "download"], ["friends", "Friends", "users"], ["settings", "Settings", "sliders"], ["publisher", "Publisher portal", "upload"], ...(ctx.canReview() ? [["review", "Review", "check"]] : [])].map(([route, label, iconName]) =>
          h("button", { type: "button", class: "menu-item", onclick: () => ctx.navigate(route) }, ctx.icon(iconName, 18), h("span", {}, label), ctx.icon("chevron-right", 16)))),
        h("div", { class: "stats" }, stat("Games owned", library.length), stat("Installed", installed.length), stat("On wishlist", ctx.local.wishlist().length)),
        h("section", { class: "block" }, c.sectionHead("Recently played", "From this PC."),
          recent.length ? h("div", { class: "card-grid compact" }, recent.map((i) => ctx.libraryTile(i))) : h("p", { class: "muted" }, "Games you play from this launcher show up here.")),
        user.email_verified ? null : emailCard(ctx),
        h("section", { class: "block" }, c.sectionHead("Account"),
          h("dl", { class: "facts" },
            h("div", {}, h("dt", {}, "Email"), h("dd", {}, user.email)),
            h("div", {}, h("dt", {}, "Email verified"), h("dd", {}, user.email_verified ? "Yes" : "Not yet")),
            h("div", {}, h("dt", {}, "Account status"), h("dd", {}, user.status || "active")),
            h("div", {}, h("dt", {}, "Member since"), h("dd", {}, ctx.fmt.formatDate(user.created_at) || "Unknown"))),
          h("p", { class: "muted small" }, "Only you can see your email and account details. There is no public profile page.")));
    } else if (tab === "games") {
      body = library.length
        ? h("div", { class: "card-grid compact" }, library.map((i) => ctx.libraryTile(i)))
        : c.emptyState({ icon: "library", title: "No games yet", body: "Games you own are listed here." });
    } else {
      body = library.length
        ? h("div", {}, h("div", { class: "table-wrap" }, h("table", { class: "specs wide" },
            h("thead", {}, h("tr", {}, h("th", {}, "Game"), h("th", {}, "Date"), h("th", {}, "How you got it"), h("th", {}, "Amount"))),
            h("tbody", {}, [...library].sort((a, b) => (a.granted_at < b.granted_at ? 1 : -1)).map((i) =>
              h("tr", {}, h("td", {}, i.title), h("td", {}, ctx.fmt.formatDate(i.granted_at)), h("td", {}, SOURCES[i.source] || i.source),
                h("td", {}, i.source === "free" ? "Free" : "Not recorded")))))),
          h("p", { class: "muted small" }, "Paid purchases will be listed here with their prices once payments are open."))
        : c.emptyState({ icon: "tag", title: "No purchases yet", body: "Paid purchases and free additions will be listed here." });
    }

    return h("div", { class: "page profile" },
      h("header", { class: "profile-head" }, c.avatar(user.display_name || user.email, "xl"),
        h("div", {}, h("h1", {}, user.display_name || user.email), h("p", { class: "muted" }, `Member since ${ctx.fmt.formatDate(user.created_at) || "recently"}`))),
      h("div", { class: "tabs", role: "tablist" }, tabs.map(([value, label]) =>
        h("button", { type: "button", role: "tab", class: tab === value ? "on" : "", "aria-selected": String(tab === value), onclick: () => { ctx.state.profileTab = value; ctx.rerender(); } }, label))),
      body);
  }

  // ------------------------------------------------------------------ settings
  /** "MAREC Store 0.2.0 (build 15, abc1234, 16 Nov 2026)" */
  function aboutText(ctx) {
    const info = ctx.buildInfo || {};
    const version = ctx.state.version || info.version || "";
    const details = [info.build ? `build ${info.build}` : "", info.commit && info.commit !== "local" ? info.commit : "", info.date ? ctx.fmt.formatDate(info.date) : ""].filter(Boolean);
    return `MAREC Store ${version}${details.length ? ` (${details.join(", ")})` : ""}`.trim();
  }

  const SECTIONS = [["general", "General"], ["downloads", "Downloads"], ["interface", "Interface"], ["notifications", "Notifications"], ["account", "Account"]];

  function settings(ctx) {
    const { h, c, button } = ctx;
    const st = ctx.state;
    const prefs = ctx.local.prefs();
    const loggedIn = Boolean(st.user);
    const section = loggedIn ? st.settingsSection : "general";
    const draft = st.draft;
    const pref = (name) => (value) => { ctx.local.setPref(name, value); ctx.rerender(); };

    const serverInput = h("input", { value: draft.apiBase, spellcheck: "false", "aria-label": "Server address", oninput: (e) => { draft.apiBase = e.target.value; } });
    const folderInput = h("input", { value: draft.installRoot, spellcheck: "false", "aria-label": "Install folder", oninput: (e) => { draft.installRoot = e.target.value; } });
    const group = (title, ...children) => h("section", { class: "settings-group" }, h("h3", {}, title), children);

    const panes = {
      general: [
        group("Store connection",
          c.field({ label: "Store server", hint: "The address of the MAREC Store service.", input: serverInput }),
          h("p", { class: "note" }, "Changing the server logs you out. Games already installed stay in their old folder."),
          button({ label: "Save server", kind: "primary", onclick: () => ctx.actions.saveSettings({ apiBase: serverInput.value.trim(), installRoot: st.installRoot }) })),
        group("About", h("p", { class: "muted" }, aboutText(ctx)))],
      downloads: ctx.platform.mobile ? [
        group("Games on this phone",
          h("p", { class: "muted" }, "Android installs games with its own installer, and asks you to confirm each one. Windows PC games are installed with the Windows launcher on your PC."))] : [
        group("Installation directory",
          c.field({ label: "Install folder", hint: "Where games are installed.", input: folderInput }),
          h("div", { class: "row" },
            button({ label: "Browse…", onclick: async () => { const picked = await ctx.actions.pickFolder(); if (picked) { draft.installRoot = picked; folderInput.value = picked; } } }),
            button({ label: "Save folder", kind: "primary", onclick: () => ctx.actions.saveSettings({ apiBase: st.apiBase, installRoot: folderInput.value.trim() }) }))),
        group("Download behaviour",
          c.select({ label: "Games downloading at once", description: "Lower is kinder to slow connections. Extra games wait in the queue.", value: String(prefs.simultaneousDownloads),
            options: [{ value: "1", label: "1 game" }, { value: "2", label: "2 games" }, { value: "3", label: "3 games" }], onchange: (v) => { ctx.local.setPref("simultaneousDownloads", Number(v)); ctx.dl.setLimit(Number(v)); ctx.rerender(); } }))],
      interface: [
        group("Layout and motion",
          ctx.platform.mobile ? null : c.toggle({ label: "Collapse the sidebar", description: "Keep only icons in the left navigation.", checked: prefs.sidebarCollapsed, onchange: (v) => { ctx.local.setPref("sidebarCollapsed", v); ctx.state.sidebarCollapsed = v; ctx.rerenderShell(); } }),
          c.toggle({ label: "Reduce motion", description: "Stops the featured carousel from moving on its own.", checked: prefs.reduceMotion, onchange: (v) => { ctx.local.setPref("reduceMotion", v); ctx.rerender(); } }))],
      notifications: [
        group("In-app notifications",
          c.toggle({ label: "When a download finishes", checked: prefs.notifyDownloads, onchange: pref("notifyDownloads") }),
          c.toggle({ label: "When an update is available", checked: prefs.notifyUpdates, onchange: pref("notifyUpdates") }),
          h("p", { class: "note" }, "They appear under the bell at the top. Windows desktop notifications are not available yet."))],
      account: [
        group("Your account",
          h("dl", { class: "facts" },
            h("div", {}, h("dt", {}, "Display name"), h("dd", {}, st.user ? st.user.display_name : "")),
            h("div", {}, h("dt", {}, "Email"), h("dd", {}, st.user ? st.user.email : ""))),
          h("p", { class: "note" }, "Changing your name, email or password is not available in the launcher yet."),
          st.secureStorage ? null : c.notice("warn", "Secure storage is not available on this PC, so your login cannot be remembered."),
          button({ label: "Log out", icon: "logout", onclick: () => ctx.actions.logout() }))],
    };

    return h("div", { class: `page settings ${loggedIn ? "" : "solo"}`.trim() },
      h("header", { class: "page-head" }, h("h1", {}, "Settings"), h("p", { class: "muted" }, aboutText(ctx))),
      h("div", { class: "settings-layout" },
        loggedIn ? h("nav", { class: "settings-nav", "aria-label": "Settings sections" }, SECTIONS.map(([id, label]) =>
          h("button", { type: "button", class: section === id ? "on" : "", "aria-current": section === id ? "page" : null, onclick: () => { st.settingsSection = id; ctx.rerender(); } }, label))) : null,
        h("div", { class: "settings-pane" }, panes[section], loggedIn ? null : button({ label: "← Back to log in", kind: "link", onclick: () => ctx.navigate("home") }))));
  }

  const api = { login, profile, settings, validateRegistration, emailCard };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else (host.MarecUI = host.MarecUI || {})["views-account"] = api;
})(typeof window !== "undefined" ? window : globalThis);
