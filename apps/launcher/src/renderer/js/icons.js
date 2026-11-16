"use strict";
// A small icon set drawn as SVG paths (24x24, stroke based). Each icon is a list of [tag, attributes].
(function (host) {
  const p = (d, extra) => ["path", { d, ...extra }];
  const circle = (cx, cy, r, extra) => ["circle", { cx, cy, r, ...extra }];
  const rect = (x, y, width, height, rx = 0, extra) => ["rect", { x, y, width, height, rx, ...extra }];
  const solid = { fill: "currentColor", stroke: "none" };

  const ICONS = {
    home: [p("M4 11 12 4l8 7"), p("M6 10v9h12v-9"), p("M10 19v-5h4v5")],
    store: [p("M5 8h14l-1 12H6L5 8z"), p("M9 8V6a3 3 0 0 1 6 0v2")],
    library: [rect(4, 4, 6, 6, 1.5), rect(14, 4, 6, 6, 1.5), rect(4, 14, 6, 6, 1.5), rect(14, 14, 6, 6, 1.5)],
    download: [p("M12 4v11"), p("M7 11l5 5 5-5"), p("M5 20h14")],
    upload: [p("M12 16V5"), p("M7 9l5-5 5 5"), p("M5 20h14")],
    heart: [p("M12 20s-7-4.5-7-10a4 4 0 0 1 7-2.5A4 4 0 0 1 19 10c0 5.5-7 10-7 10z")],
    "heart-fill": [p("M12 20s-7-4.5-7-10a4 4 0 0 1 7-2.5A4 4 0 0 1 19 10c0 5.5-7 10-7 10z", solid)],
    users: [circle(9, 8, 3), p("M3 19c0-3.3 2.7-5 6-5s6 1.7 6 5"), circle(17, 9, 2.5), p("M17 14c2.5 0 4 1.5 4 4")],
    user: [circle(12, 8, 4), p("M4 20c0-4 3.6-6 8-6s8 2 8 6")],
    search: [circle(11, 11, 6), p("M16 16l4 4")],
    bell: [p("M6 16v-5a6 6 0 0 1 12 0v5l1.5 2h-15L6 16z"), p("M10 20a2 2 0 0 0 4 0")],
    sliders: [p("M4 7h10M18 7h2M4 17h2M10 17h10"), circle(16, 7, 2), circle(8, 17, 2)],
    "chevron-left": [p("M15 6l-6 6 6 6")],
    "chevron-right": [p("M9 6l6 6-6 6")],
    "chevron-down": [p("M6 9l6 6 6-6")],
    sidebar: [rect(4, 5, 16, 14, 2), p("M9 5v14")],
    play: [p("M8 5v14l11-7z", solid)],
    pause: [rect(7, 5, 3.5, 14, 1, solid), rect(13.5, 5, 3.5, 14, 1, solid)],
    x: [p("M6 6l12 12M18 6L6 18")],
    check: [p("M5 12l5 5 9-10")],
    plus: [p("M12 5v14M5 12h14")],
    trash: [p("M5 7h14"), p("M9 7V5h6v2"), p("M7 7l1 13h8l1-13")],
    refresh: [p("M20 12a8 8 0 1 1-2.3-5.7"), p("M20 4v5h-5")],
    folder: [p("M3 7h6l2 2h10v10H3z")],
    info: [circle(12, 12, 9), p("M12 11v5"), p("M12 8v.01")],
    alert: [p("M12 4l9 16H3z"), p("M12 10v4"), p("M12 17v.01")],
    grid: [rect(4, 4, 6, 6, 1.5), rect(14, 4, 6, 6, 1.5), rect(4, 14, 6, 6, 1.5), rect(14, 14, 6, 6, 1.5)],
    list: [p("M8 7h12M8 12h12M8 17h12"), p("M4 7v.01M4 12v.01M4 17v.01")],
    tag: [p("M3 12V4h8l10 10-8 8z"), circle(7.5, 8.5, 1.2)],
    chart: [p("M5 20V10M12 20V4M19 20v-7")],
    logout: [p("M10 4H5v16h5"), p("M15 8l4 4-4 4"), p("M9 12h10")],
    box: [p("M12 3l8 4v10l-8 4-8-4V7z"), p("M4 7l8 4 8-4"), p("M12 11v10")],
    shield: [p("M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"), p("M9 12l2 2 4-4")],
    globe: [circle(12, 12, 9), p("M3 12h18"), p("M12 3c3 3 3 15 0 18"), p("M12 3c-3 3-3 15 0 18")],
    image: [rect(4, 5, 16, 14, 2), circle(9, 10, 1.5), p("M4 17l5-4 4 3 3-2 4 3")],
    film: [rect(4, 5, 16, 14, 2), p("M10 9l5 3-5 3z", solid)],
    compass: [circle(12, 12, 9), p("M15.5 8.5l-2 5-5 2 2-5z")],
    lock: [rect(5, 11, 14, 9, 2), p("M8 11V8a4 4 0 0 1 8 0v3")],
  };

  const SVG_NS = "http://www.w3.org/2000/svg";

  /** Builds an <svg> for `name`. `doc` is the document (a fake one in tests may lack createElementNS). */
  function createIcon(doc, name, size = 18) {
    const parts = ICONS[name] || ICONS.info;
    if (typeof doc.createElementNS !== "function") {
      const stub = doc.createElement("span");
      stub.className = `icon icon-${name}`;
      return stub;
    }
    const svg = doc.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("width", size);
    svg.setAttribute("height", size);
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "1.8");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("class", "icon");
    for (const [tag, attrs] of parts) {
      const node = doc.createElementNS(SVG_NS, tag);
      for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
      svg.append(node);
    }
    return svg;
  }

  const api = { createIcon, ICON_NAMES: Object.keys(ICONS) };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else (host.MarecUI = host.MarecUI || {}).icons = api;
})(typeof window !== "undefined" ? window : globalThis);
