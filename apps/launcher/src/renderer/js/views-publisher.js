"use strict";
// The publisher portal: kept apart from the storefront. It shows the studios and games the signed-in
// player already has in the store (read-only), and lets them register a studio. Uploading builds,
// pricing and sales are not in the launcher yet, and each page says so.
(function (host) {
  const TABS = [["overview", "Overview", "home"], ["games", "My games", "box"], ["builds", "Builds", "upload"], ["pricing", "Pricing", "tag"], ["sales", "Sales", "chart"]];
  const STATUS_TEXT = {
    pending: "Waiting for MAREC to verify this studio", verified: "Verified",
    draft: "Draft", submitted: "Submitted", under_review: "In review", changes_requested: "Changes requested",
    approved: "Approved", scheduled: "Scheduled", published: "Published", suspended: "Suspended", removed: "Removed",
  };
  const statusKind = (s) => (["verified", "published", "approved"].includes(s) ? "ok" : ["suspended", "removed", "changes_requested"].includes(s) ? "bad" : "warn");

  function validateStudioName(value) {
    const name = String(value || "").split(/\s+/).filter(Boolean).join(" ");
    if (name.length < 2 || name.length > 60) return { error: "Use 2 to 60 characters for the studio name." };
    return { name };
  }

  function registerForm(ctx) {
    const { h, c, button } = ctx;
    const p = ctx.state.publisher;
    const input = h("input", { value: p.newName, maxlength: "60", placeholder: "Studio name", "aria-label": "Studio name", oninput: (e) => { p.newName = e.target.value; } });
    const holder = h("div", {});
    const paint = () => holder.replaceChildren(c.field({ label: "Studio name", error: p.nameError, hint: "This is the name players see on your games.", input }));
    paint();
    return h("form", { class: "panel-form", novalidate: "novalidate", onsubmit: async (e) => {
      if (e && e.preventDefault) e.preventDefault();
      const result = validateStudioName(p.newName);
      p.nameError = result.error || "";
      if (result.error) return paint();
      await ctx.actions.createStudio(result.name);
    } }, holder, button({ label: "Register studio", kind: "primary", type: "submit", disabled: p.creating }));
  }

  function overview(ctx, studios) {
    const { h, c } = ctx;
    return h("div", {},
      c.sectionHead("Your studios", "Studios you own or belong to."),
      studios.length
        ? h("div", { class: "dl-list" }, studios.map((s) =>
            h("div", { class: "dl-row" }, c.avatar(s.name),
              h("div", { class: "dl-main" }, h("div", { class: "card-title" }, s.name), h("div", { class: "muted small" }, `Your role: ${s.my_role}`)),
              h("span", { class: `status ${statusKind(s.status)}` }, STATUS_TEXT[s.status] || s.status))))
        : c.emptyState({ icon: "box", title: "You are not a publisher yet", body: "Register a studio to start publishing games on MAREC Store." }),
      studios.length < 3 ? h("section", { class: "block narrow" }, c.sectionHead(studios.length ? "Register another studio" : "Register as a publisher", "New studios start as pending until MAREC verifies them."), registerForm(ctx)) : null);
  }

  function gamesTab(ctx, studios) {
    const { h, c, button } = ctx;
    if (!studios.length) return c.emptyState({ icon: "box", title: "No studio yet", body: "Register a studio first.", actions: [button({ label: "Go to overview", onclick: () => { ctx.state.publisher.tab = "overview"; ctx.rerender(); } })] });
    return h("div", {}, studios.map((s) => {
      const res = ctx.resource(`studio-games:${s.id}`, () => ctx.actions.studioGames(s.id));
      let body;
      if (res.status === "loading") body = h("div", { class: "bone wide" });
      else if (res.status === "error") body = c.errorState({ title: "Could not load games", message: res.error.message, actions: [button({ label: "Try again", onclick: () => { ctx.invalidate("studio-games:"); ctx.rerender(); } })] });
      else if (!res.data.items.length) body = c.emptyState({ icon: "box", title: "No games yet", body: "Games you create with the developer API appear here with their review status." });
      else {
        body = h("div", { class: "table-wrap" }, h("table", { class: "specs wide" },
          h("thead", {}, h("tr", {}, h("th", {}, "Game"), h("th", {}, "Status"), h("th", {}, "Price"), h("th", {}, "Updated"))),
          h("tbody", {}, res.data.items.map((g) =>
            h("tr", {}, h("td", {}, g.title), h("td", {}, h("span", { class: `status ${statusKind(g.status)}` }, STATUS_TEXT[g.status] || g.status)),
              h("td", {}, g.is_free ? "Free" : g.price_minor === null ? "Not set" : ctx.fmt.formatMoney(g.price_minor, g.currency)), h("td", {}, ctx.fmt.formatDate(g.updated_at)))))));
      }
      return h("section", { class: "block" }, c.sectionHead(s.name), body);
    }));
  }

  const SOON = {
    builds: { icon: "upload", title: "Upload builds", body: "Uploading and publishing updates from the launcher is not built yet. Builds are uploaded with the command-line tool in tools/upload-build for now." },
    pricing: { icon: "tag", title: "Manage pricing", body: "Prices are set on the game record through the developer API for now. A pricing screen with MWK and USD prices will live here." },
    sales: { icon: "chart", title: "Sales statistics", body: "Sales numbers need orders and payments, which are not built yet." },
  };

  function publisher(ctx) {
    const { h, c, icon, button } = ctx;
    const p = ctx.state.publisher;
    const studios = ctx.resource("studios", () => ctx.actions.studios());
    let content;
    if (SOON[p.tab]) content = c.emptyState({ ...SOON[p.tab], title: SOON[p.tab].title });
    else if (studios.status === "loading") content = h("div", { "aria-busy": "true" }, h("div", { class: "bone wide" }), h("div", { class: "bone" }));
    else if (studios.status === "error") content = c.errorState({ title: "Could not load your studios", message: studios.error.message, actions: [button({ label: "Try again", icon: "refresh", kind: "primary", onclick: () => { ctx.invalidate("studios"); ctx.rerender(); } })] });
    else content = p.tab === "games" ? gamesTab(ctx, studios.data) : overview(ctx, studios.data);

    return h("div", { class: "page publisher" },
      h("header", { class: "publisher-head" },
        h("div", {}, h("h1", {}, "Publisher portal"), h("p", { class: "muted" }, "For studios publishing games on MAREC Store. Players do not see this area.")),
        button({ label: "Back to store", icon: "chevron-left", kind: "ghost", onclick: () => ctx.navigate("home") })),
      h("div", { class: "settings-layout" },
        h("nav", { class: "settings-nav", "aria-label": "Publisher sections" }, TABS.map(([id, label, iconName]) =>
          h("button", { type: "button", class: p.tab === id ? "on" : "", "aria-current": p.tab === id ? "page" : null, onclick: () => { p.tab = id; ctx.rerender(); } }, icon(iconName, 16), h("span", {}, label)))),
        h("div", { class: "settings-pane wide" }, content)));
  }

  const api = { publisher, validateStudioName };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else (host.MarecUI = host.MarecUI || {})["views-publisher"] = api;
})(typeof window !== "undefined" ? window : globalThis);
