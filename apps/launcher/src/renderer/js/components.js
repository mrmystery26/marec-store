"use strict";
// Reusable pieces: artwork, game cards, shelves, badges, form controls, states and dialogs.
// They know nothing about routing or the launcher; the app passes in what they need (`env`).
(function (host) {
  function createComponents({ h, icon, button, fmt, env }) {
    // ------------------------------------------------------------------ artwork
    /**
     * Game artwork. The store does not send artwork yet, so a game without a cover image gets its
     * initials on a coloured tile. When a game has `artwork.cover` / `artwork.hero` it shows that image instead.
     * (The window's content security policy must allow the image host before real URLs will load.)
     */
    function artwork(game, { kind = "cover", caption = false } = {}) {
      const source = game.artwork && (game.artwork[kind] || game.artwork.cover);
      if (source) return h("img", { class: `art art-${kind}`, src: source, alt: "" });
      const el = h(
        "div",
        { class: `art art-${kind} placeholder`, role: "img", "aria-label": `${game.title} (no cover image)`, title: "No cover image yet" },
        h("span", { class: "art-mark" }, fmt.initials(game.title)),
        caption ? h("span", { class: "art-caption" }, "No cover image yet") : null
      );
      el.style.background = `hsl(${fmt.hueOf(game.title)}, 16%, 17%)`;
      return el;
    }

    // ------------------------------------------------------------------ small pieces
    const badge = (kind, text) => h("span", { class: `badge ${kind}` }, text);

    function price(game, size = "") {
      const view = fmt.priceView(game, env.currency());
      if (view.free) return h("span", { class: `price free ${size}`.trim() }, "Free");
      if (!view.known) return h("span", { class: `price unknown ${size}`.trim() }, view.label);
      return h(
        "span",
        { class: `price ${size}`.trim() },
        view.discount ? badge("discount", `-${view.discount}%`) : null,
        view.original ? h("s", { class: "price-old" }, view.original) : null,
        h("span", { class: "price-now" }, view.label)
      );
    }

    const genreText = (game) => game.categories.slice(0, 2).map((c) => c.name).join(", ");

    function stateBadges(game) {
      return [
        env.isOwned(game.id) ? badge("owned", "In library") : null,
        game.upcoming ? badge("soon", "Coming soon") : null,
        game.isDemo ? badge("demo", "Demo") : null,
      ];
    }

    // ------------------------------------------------------------------ cards and shelves
    function gameCard(game) {
      const wished = env.isWished(game.id);
      return h(
        "div",
        { class: "game-card" },
        h(
          "button",
          { type: "button", class: "card-hit", onclick: () => env.openGame(game) },
          h("div", { class: "card-art" }, artwork(game), h("div", { class: "card-badges" }, stateBadges(game))),
          h(
            "div",
            { class: "card-body" },
            h("div", { class: "card-title" }, game.title),
            h("div", { class: "card-genre" }, genreText(game) || game.studio.name),
            price(game)
          )
        ),
        h(
          "button",
          {
            type: "button",
            class: `wish ${wished ? "on" : ""}`.trim(),
            title: wished ? "Remove from wishlist" : "Add to wishlist",
            "aria-label": `${wished ? "Remove" : "Add"} ${game.title} ${wished ? "from" : "to"} wishlist`,
            "aria-pressed": String(wished),
            onclick: () => env.toggleWish(game),
          },
          icon(wished ? "heart-fill" : "heart", 16)
        )
      );
    }

    function skeletonCards(count = 6) {
      return Array.from({ length: count }, () =>
        h("div", { class: "game-card skeleton", "aria-hidden": "true" },
          h("div", { class: "card-art" }),
          h("div", { class: "card-body" }, h("div", { class: "bone wide" }), h("div", { class: "bone" })))
      );
    }

    function sectionHead(title, subtitle, actions) {
      return h("header", { class: "section-head" },
        h("div", {}, h("h2", {}, title), subtitle ? h("p", { class: "muted" }, subtitle) : null),
        actions || null);
    }

    function shelf({ title, subtitle, items }) {
      const row = h("div", { class: "shelf-row" }, items.map(gameCard));
      const scroll = (direction) => {
        if (typeof row.scrollBy === "function") row.scrollBy({ left: direction * row.clientWidth * 0.85, behavior: "smooth" });
      };
      const arrows = items.length > 5
        ? h("div", { class: "shelf-arrows" },
            button({ icon: "chevron-left", title: "Scroll left", kind: "icon", onclick: () => scroll(-1) }),
            button({ icon: "chevron-right", title: "Scroll right", kind: "icon", onclick: () => scroll(1) }))
        : null;
      return h("section", { class: "shelf" }, sectionHead(title, subtitle, arrows), row);
    }

    // ------------------------------------------------------------------ states
    function emptyState({ icon: iconName = "box", title, body, actions }) {
      return h("div", { class: "state empty" },
        h("div", { class: "state-icon" }, icon(iconName, 28)),
        h("h3", {}, title),
        body ? h("p", { class: "muted" }, body) : null,
        actions ? h("div", { class: "state-actions" }, actions) : null);
    }

    function errorState({ title = "Something went wrong", message, actions }) {
      return h("div", { class: "state error", role: "alert" },
        h("div", { class: "state-icon" }, icon("alert", 28)),
        h("h3", {}, title),
        message ? h("p", { class: "muted" }, message) : null,
        actions ? h("div", { class: "state-actions" }, actions) : null);
    }

    const notice = (kind, text, actions) =>
      h("div", { class: `notice ${kind}` }, icon(kind === "warn" ? "alert" : "info", 16), h("span", {}, text), actions || null);

    // ------------------------------------------------------------------ form controls
    function toggle({ label, description, checked, disabled, onchange }) {
      const input = h("input", { type: "checkbox", role: "switch", checked: Boolean(checked), disabled: Boolean(disabled), onchange: (e) => onchange && onchange(e.target.checked) });
      return h("label", { class: `setting toggle ${disabled ? "disabled" : ""}`.trim() },
        h("span", { class: "setting-text" }, h("span", { class: "setting-label" }, label), description ? h("span", { class: "setting-desc" }, description) : null),
        input, h("span", { class: "track" }));
    }

    function select({ label, description, value, options, disabled, onchange, ariaLabel }) {
      const control = h("select", { "aria-label": ariaLabel || label, disabled: Boolean(disabled), onchange: (e) => onchange && onchange(e.target.value) },
        options.map((o) => h("option", { value: o.value, selected: o.value === value, disabled: Boolean(o.disabled) }, o.label)));
      if (!label) return control;
      return h("div", { class: `setting ${disabled ? "disabled" : ""}`.trim() },
        h("span", { class: "setting-text" }, h("span", { class: "setting-label" }, label), description ? h("span", { class: "setting-desc" }, description) : null),
        control);
    }

    function segmented({ options, value, onchange, ariaLabel }) {
      return h("div", { class: "segmented", role: "group", "aria-label": ariaLabel },
        options.map((o) =>
          h("button", { type: "button", class: o.value === value ? "on" : "", "aria-pressed": String(o.value === value), title: o.title, onclick: () => onchange(o.value) },
            o.icon ? icon(o.icon, 16) : null, o.label ? h("span", {}, o.label) : null)));
    }

    /** Label + input + hint + inline error. */
    function field({ label, hint, error, input }) {
      return h("div", { class: `field ${error ? "invalid" : ""}`.trim() },
        h("label", {}, label), input,
        error ? h("p", { class: "field-error", role: "alert" }, error) : hint ? h("p", { class: "field-hint" }, hint) : null);
    }

    // ------------------------------------------------------------------ dialogs
    function modal({ title, children, actions, onClose, wide }) {
      const dialog = h("div", { class: `modal ${wide ? "wide" : ""}`.trim(), role: "dialog", "aria-modal": "true", "aria-label": title },
        h("h2", {}, title),
        h("div", { class: "modal-body" }, children),
        h("div", { class: "modal-actions" }, actions));
      const backdrop = h("div", { class: "modal-backdrop", onclick: (e) => { if (e.target === backdrop) onClose(); } }, dialog);
      return backdrop;
    }

    function avatar(name, size = "") {
      const el = h("span", { class: `avatar ${size}`.trim(), "aria-hidden": "true" }, fmt.initials(name).slice(0, 2));
      el.style.background = `hsl(${fmt.hueOf(name || "?")}, 30%, 30%)`;
      return el;
    }

    return {
      artwork, badge, price, genreText, stateBadges, gameCard, skeletonCards, sectionHead, shelf,
      emptyState, errorState, notice, toggle, select, segmented, field, modal, avatar,
    };
  }

  const api = { createComponents };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else (host.MarecUI = host.MarecUI || {}).components = api;
})(typeof window !== "undefined" ? window : globalThis);
