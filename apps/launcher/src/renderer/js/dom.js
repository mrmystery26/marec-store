"use strict";
// The tiny element builder every view uses. All text goes in as text (never as HTML), so a game
// title or studio name can never inject markup.
(function (host) {
  const dep = (name) => (typeof require === "function" ? require(`./${name}`) : host.MarecUI[name]);
  const { createIcon } = dep("icons");

  function createDom(doc) {
    const PROPERTY_KEYS = new Set(["disabled", "value", "checked", "selected"]);

    function h(tag, props, ...kids) {
      const el = doc.createElement(tag);
      for (const [key, value] of Object.entries(props || {})) {
        if (key === "class") el.className = value;
        else if (key.startsWith("on")) el.addEventListener(key.slice(2), value);
        else if (PROPERTY_KEYS.has(key)) el[key] = value;
        else if (value !== false && value != null) el.setAttribute(key, value);
      }
      for (const kid of kids.flat(Infinity)) {
        if (kid != null && kid !== false) el.append(kid);
      }
      return el;
    }

    const icon = (name, size) => createIcon(doc, name, size);

    /** A button with an optional icon and label. `class` gets "btn" added. */
    function button({ label, icon: iconName, kind = "", onclick, disabled, title, type = "button", ...rest }) {
      return h(
        "button",
        {
          type,
          class: `btn ${kind}`.trim(),
          onclick,
          disabled: Boolean(disabled),
          title,
          ...(label ? {} : { "aria-label": title || rest["aria-label"] }),
          ...rest,
        },
        iconName ? icon(iconName, 16) : null,
        label ? h("span", {}, label) : null
      );
    }

    return { h, icon, button };
  }

  const api = { createDom };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else (host.MarecUI = host.MarecUI || {}).dom = api;
})(typeof window !== "undefined" ? window : globalThis);
