"use strict";
// Staff review: verify new developer studios, and move submitted demos through review to the store.
// The store checks the person's staff role on every request, so this screen only works for staff.
(function (host) {
  const TABS = [["studios", "New studios"], ["demos", "Demos to review"], ["live", "Live demos"]];
  const STATUS_TEXT = {
    submitted: "Waiting for review", under_review: "In review", approved: "Approved", published: "Live", suspended: "Suspended",
  };

  // What staff can do to a demo in each state: [action, label, needs a written reason]
  const ACTIONS = {
    submitted: [["start_review", "Start review", false]],
    under_review: [["approve", "Approve", false], ["request_changes", "Request changes", true]],
    approved: [["publish", "Publish", false]],
    published: [["suspend", "Suspend", true], ["remove", "Remove", true]],
    suspended: [["reinstate", "Reinstate", true], ["remove", "Remove", true]],
  };

  function studiosTab(ctx) {
    const { h, c, button } = ctx;
    const ui = ctx.state.review;
    const res = ctx.resource("review:studios", () => ctx.actions.admin.studios("pending"));
    if (res.status === "loading") return h("div", { class: "bone wide" });
    if (res.status === "error") return c.errorState({ title: "Could not load studios", message: res.error.message, actions: [button({ label: "Try again", onclick: () => { ctx.invalidate("review:"); ctx.rerender(); } })] });
    if (!res.data.items.length) return c.emptyState({ icon: "shield", title: "Nobody is waiting", body: "New developer studios appear here until you verify them." });
    return h("div", { class: "dl-list" }, res.data.items.map((s) =>
      h("div", { class: "dl-row" }, c.avatar(s.name),
        h("div", { class: "dl-main" }, h("div", { class: "card-title" }, s.name), h("div", { class: "muted small" }, `Registered ${ctx.fmt.formatDate(s.created_at)}`)),
        button({ label: "Verify", kind: "primary", disabled: ui.busy, onclick: async () => {
          ui.busy = true; ui.error = ""; ctx.rerender();
          try {
            await ctx.actions.admin.verifyStudio(s.id);
            ctx.invalidate("review:");
            ctx.toast(`${s.name} is verified. The developer was emailed.`, "info");
          } catch (error) {
            ui.error = error.message;
          }
          ui.busy = false;
          ctx.rerender();
        } }))));
  }

  const loadGames = (ctx, statuses) => Promise.all(statuses.map((status) => ctx.actions.admin.games(status)))
    .then((pages) => pages.flatMap((page) => page.items));

  function gameCard(ctx, g) {
    const { h, c, button } = ctx;
    const ui = ctx.state.review;
    const reasons = (ui.reasons ||= {});
    const actions = ACTIONS[g.status] || [];
    const needsReason = actions.some(([, , reason]) => reason);
    const requirement = (g.requirements || []).find((r) => r.tier === "minimum");
    const reasonBox = needsReason
      ? h("textarea", { rows: "2", value: reasons[g.id] || "", maxlength: "500", "aria-label": `Reason for ${g.title}`, oninput: (e) => { reasons[g.id] = e.target.value; } })
      : null;
    const act = async ([action, label, reasonNeeded]) => {
      if (reasonBox) reasons[g.id] = reasonBox.value;
      const reason = String(reasons[g.id] || "").trim();
      if (reasonNeeded && !reason) { ui.error = "Write a reason first. The developer will see it."; return ctx.rerender(); }
      ui.busy = true; ui.error = ""; ctx.rerender();
      try {
        await ctx.actions.admin.transition(g.id, action, reasonNeeded ? reason : undefined);
        delete reasons[g.id];
        ctx.invalidate("review:");
        ctx.toast(`${g.title}: ${label.toLowerCase()} done.`, "info");
      } catch (error) {
        ui.error = error.message;
      }
      ui.busy = false;
      ctx.rerender();
    };
    return h("section", { class: "block review-card" },
      c.sectionHead(g.title, `${g.studio.name} · ${g.release_kind === "demo" ? "Demo" : "Full game"}`, h("span", { class: "status warn" }, STATUS_TEXT[g.status] || g.status)),
      h("p", {}, g.summary || "No summary."),
      h("p", { class: "muted small" }, (g.description || "No description.").slice(0, 600)),
      h("p", { class: "muted small" }, [
        g.age_rating ? `Age ${g.age_rating}` : "No age rating",
        (g.categories || []).map((x) => x.name).join(", ") || "No genre",
        requirement ? `Needs ${requirement.os}, ${requirement.ram_mb} MB memory, ${requirement.storage_mb} MB disk` : "No requirements",
      ].join(" · ")),
      g.status_reason ? h("p", { class: "muted small" }, `Last reason: ${g.status_reason}`) : null,
      reasonBox ? c.field({ label: "Reason (shown to the developer)", input: reasonBox }) : null,
      h("div", { class: "row" }, actions.map((entry) =>
        button({ label: entry[1], kind: entry[0] === "remove" || entry[0] === "suspend" ? "danger" : "primary", disabled: ui.busy, onclick: () => act(entry) }))));
  }

  function gamesTab(ctx, key, statuses, emptyTitle, emptyBody) {
    const { h, c, button } = ctx;
    const res = ctx.resource(key, () => loadGames(ctx, statuses));
    if (res.status === "loading") return h("div", { class: "bone wide" });
    if (res.status === "error") return c.errorState({ title: "Could not load demos", message: res.error.message, actions: [button({ label: "Try again", onclick: () => { ctx.invalidate("review:"); ctx.rerender(); } })] });
    if (!res.data.length) return c.emptyState({ icon: "shield", title: emptyTitle, body: emptyBody });
    return h("div", {}, res.data.map((g) => gameCard(ctx, g)));
  }

  function review(ctx) {
    const { h, c } = ctx;
    if (!ctx.canReview()) {
      return h("div", { class: "page" }, c.errorState({ title: "Staff only", message: "Your account does not have access to the Review screen." }));
    }
    const ui = ctx.state.review;
    const tabs = h("div", { class: "tabs", role: "tablist" }, TABS.map(([value, label]) =>
      h("button", { type: "button", role: "tab", class: ui.tab === value ? "on" : "", "aria-selected": String(ui.tab === value), onclick: () => { ui.tab = value; ui.error = ""; ctx.rerender(); } }, label)));
    const body = ui.tab === "studios" ? studiosTab(ctx)
      : ui.tab === "demos" ? gamesTab(ctx, "review:demos", ["submitted", "under_review", "approved"], "Nothing to review", "Submitted demos appear here.")
      : gamesTab(ctx, "review:live", ["published", "suspended"], "No live demos", "Published demos appear here, in case one needs to be suspended or removed.");
    return h("div", { class: "page review" },
      h("header", { class: "page-head" }, h("h1", {}, "Review"), h("p", { class: "muted" }, "Verify developers and decide which demos go live.")),
      tabs,
      ui.error ? c.notice("warn", ui.error) : null,
      body);
  }

  const api = { review, ACTIONS };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else (host.MarecUI = host.MarecUI || {})["views-review"] = api;
})(typeof window !== "undefined" ? window : globalThis);
