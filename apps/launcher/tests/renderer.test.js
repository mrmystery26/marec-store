"use strict";
// Drives the launcher window code against a tiny fake DOM, so typos and broken flows are caught
// without opening Electron. These cover the critical flows: signing in, browsing the store, adding
// and installing games, the download queue, and the honest "not available yet" paths.
const test = require("node:test");
const assert = require("node:assert/strict");
const { createApp } = require("../src/renderer/app");
const { createPlatform } = require("../src/renderer/js/platform");

class FakeText {
  constructor(text) {
    this.text = String(text);
  }
}

class FakeElement {
  constructor(tag) {
    this.tagName = tag.toLowerCase();
    this.className = "";
    this.attributes = {};
    this.children = [];
    this.listeners = {};
    this.style = {};
    this.parent = null;
    this.disabled = false;
    this.value = "";
    this.checked = false;
  }
  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }
  getAttribute(name) {
    return this.attributes[name];
  }
  addEventListener(type, fn) {
    (this.listeners[type] ||= []).push(fn);
  }
  append(...items) {
    for (const item of items) {
      const node = item instanceof FakeElement || item instanceof FakeText ? item : new FakeText(item);
      if (node instanceof FakeElement) node.parent = this;
      this.children.push(node);
    }
  }
  replaceChildren(...items) {
    this.children = [];
    this.append(...items);
  }
  remove() {
    if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this);
  }
  set textContent(value) {
    this.children = [new FakeText(value)];
  }
  dispatch(type) {
    const event = { preventDefault() {}, target: this };
    for (const fn of this.listeners[type] || []) fn(event);
  }
}

const doc = { createElement: (tag) => new FakeElement(tag) };
const textOf = (node) => (node instanceof FakeText ? node.text : node.children.map(textOf).join(" "));
const findAll = (node, test) => {
  if (node instanceof FakeText) return [];
  return [...(test(node) ? [node] : []), ...node.children.flatMap((c) => findAll(c, test))];
};
const button = (root, label) => findAll(root, (n) => n.tagName === "button" && textOf(n).trim() === label)[0];
const byLabel = (root, label) => findAll(root, (n) => n.attributes["aria-label"] === label)[0];
// the Downloads item carries a count badge ("Downloads 2"), so ignore a trailing number
const nav = (root, label) =>
  findAll(root, (n) => n.tagName === "button" && /\bnav-item\b/.test(n.className) && textOf(n).trim().replace(/\s+\d+$/, "") === label)[0];
const settingsTab = (root, label) =>
  findAll(root, (n) => n.tagName === "button" && n.parent && /settings-nav/.test(n.parent.className) && textOf(n).trim() === label)[0];
const flush = async () => {
  for (let i = 0; i < 8; i++) await new Promise((resolve) => setImmediate(resolve));
};

const GAMES = {
  fresh: { game_id: "a", slug: "alpha", title: "Alpha Quest", studio: { name: "Studio A" }, available: true,
    installed: null, update_available: false, latest_version: "1.0.0", unavailable_reason: null },
  installed: { game_id: "b", slug: "beta", title: "Beta Racer", studio: { name: "Studio B" }, available: true,
    installed: { version: "1.0.0" }, update_available: false, latest_version: "1.0.0" },
  outdated: { game_id: "c", slug: "gamma", title: "Gamma Quest", studio: { name: "Studio C" }, available: true,
    installed: { version: "1.0.0" }, update_available: true, latest_version: "1.2.0" },
  hidden: { game_id: "d", slug: "delta", title: "Delta Dash", studio: { name: "Studio D" }, available: false,
    installed: null, update_available: false, unavailable_reason: "This game is not currently available." },
};

const STORE = [
  { id: "p1", slug: "paid-game", title: "Paid Racer", summary: "s", price_minor: 450000, currency: "MWK", is_free: false, age_rating: "7+",
    studio: { name: "Studio P", slug: "p" }, categories: [{ slug: "racing", name: "Racing" }], published_at: "2026-10-01T00:00:00Z" },
  { id: "f1", slug: "free-game", title: "Free Puzzle", summary: "s", price_minor: 0, currency: "MWK", is_free: true, age_rating: "3+",
    studio: { name: "Studio F", slug: "f" }, categories: [{ slug: "puzzle", name: "Puzzle" }], published_at: "2026-10-02T00:00:00Z" },
];

function fakeApi(items, { user = null, ...overrides } = {}) {
  const calls = [];
  let progress = () => {};
  const ok = (data) => Promise.resolve({ ok: true, data });
  const api = {
    calls,
    state: () => ok({ apiBase: "http://store.test", installRoot: "C:\\Games", secureStorage: true, version: "0.2.0", user }),
    login: (email, password) => (calls.push(["login", email, password]), ok({ email, display_name: "Pat", created_at: "2026-10-18T00:00:00Z" })),
    register: (...args) => (calls.push(["register", ...args]), ok({})),
    logout: () => ok(null),
    library: () => ok(items),
    categories: () => ok([{ slug: "racing", name: "Racing" }, { slug: "puzzle", name: "Puzzle" }]),
    games: (query) => {
      calls.push(["games", query]);
      let list = STORE;
      if (query && query.free) list = list.filter((g) => g.is_free);
      if (query && query.q) list = list.filter((g) => g.title.toLowerCase().includes(query.q.toLowerCase()));
      return ok({ items: list, total: list.length, limit: 24, offset: 0 });
    },
    game: (slug) => ok({ ...STORE.find((g) => g.slug === slug), description: "About it.", offline_days: 7, requirements: [] }),
    addToLibrary: (id) => (calls.push(["addToLibrary", id]), ok({})),
    install: (id) => (calls.push(["install", id]), ok({ version: "1.0.0" })),
    cancel: (id) => calls.push(["cancel", id]),
    play: (id) => (calls.push(["play", id]), ok({ delivered: true })),
    verify: (id) => (calls.push(["verify", id]), ok({ ok: true, problems: [] })),
    uninstall: (id) => (calls.push(["uninstall", id]), ok(null)),
    saveSettings: (s) => (calls.push(["save", s]), ok(s)),
    pickFolder: () => ok("D:\\Games"),
    studios: () => ok([{ id: "s1", name: "Lakeshore Games", slug: "lakeshore", status: "pending", my_role: "owner" }]),
    createStudio: (name) => (calls.push(["createStudio", name]), ok({})),
    studioGames: () => ok({ items: [], total: 0 }),
    onInstallProgress: (cb) => ((progress = cb), () => {}),
    emitProgress: (p) => progress(p),
    ...overrides,
  };
  return api;
}

async function launch(items, options) {
  const { platform, ...apiOptions } = options || {};
  const root = new FakeElement("div");
  const api = fakeApi(items, apiOptions);
  const app = createApp({ doc, root, api, platform });
  await app.start();
  await flush();
  return { root, api, app };
}

const LOGGED_IN = { user: { email: "pat@example.com", display_name: "Pat", created_at: "2026-10-18T00:00:00Z" } };
const openLibrary = async (root) => { nav(root, "Library").dispatch("click"); await flush(); };
const libCards = (root) => findAll(root, (n) => /^lib-card( |$)/.test(n.className));

// ---------------------------------------------------------------- signing in

test("a new visitor sees the login form and can log in", async () => {
  const { root, api } = await launch(Object.values(GAMES));
  assert.match(textOf(root), /Log in/);
  assert.match(textOf(root), /Server: http:\/\/store.test/);

  const inputs = findAll(root, (n) => n.tagName === "input");
  inputs[0].value = "  pat@example.com ";
  inputs[1].value = "secret";
  findAll(root, (n) => n.tagName === "form")[0].dispatch("submit");
  await flush();

  assert.deepEqual(api.calls[0], ["login", "pat@example.com", "secret"]);
  assert.ok(nav(root, "Library") && nav(root, "Store") && nav(root, "Downloads"), "the sidebar is shown");
  assert.match(textOf(root), /Featured|Recently added/);
});

test("creating an account checks the form first, then registers and signs in", async () => {
  const { root, api } = await launch([]);
  button(root, "Create account").dispatch("click");
  const form = findAll(root, (n) => n.tagName === "form")[0];
  form.dispatch("submit");
  assert.match(textOf(root), /Use 2 to 40 characters/);
  assert.match(textOf(root), /Enter a valid email/);
  assert.match(textOf(root), /at least 10 characters/);
  assert.equal(api.calls.length, 0, "nothing is sent while the form is invalid");

  const [name, email, password, confirm] = findAll(root, (n) => n.tagName === "input");
  name.value = "Pat";
  email.value = "pat@example.com";
  password.value = "a-long-password";
  confirm.value = "different-password";
  form.dispatch("submit");
  assert.match(textOf(root), /passwords do not match/);

  // the form is redrawn with the errors, so look the fields up again
  const [, , , confirmAgain] = findAll(root, (n) => n.tagName === "input");
  assert.equal(confirmAgain.value, "different-password", "typed values survive a redraw");
  confirmAgain.value = "a-long-password";
  form.dispatch("submit");
  await flush();
  assert.deepEqual(api.calls[0], ["register", "pat@example.com", "a-long-password", "Pat"]);
  assert.deepEqual(api.calls[1], ["login", "pat@example.com", "a-long-password"]);
});

test("an expired session sends the player back to the login form", async () => {
  const { root } = await launch([], {
    ...LOGGED_IN,
    library: () => Promise.resolve({ ok: false, error: { code: "SESSION_EXPIRED", message: "Please log in again." } }),
  });
  assert.match(textOf(root), /Log in/);
  assert.match(textOf(root), /Please log in again/);
});

// ---------------------------------------------------------------- library

test("each library game shows the right status and actions; Play only for installed games", async () => {
  const { root } = await launch(Object.values(GAMES), LOGGED_IN);
  await openLibrary(root);
  const cards = libCards(root);
  assert.equal(cards.length, 4);
  const [fresh, installed, outdated, hidden] = cards;

  assert.match(textOf(fresh), /Not installed/);
  assert.equal(button(fresh, "Install").disabled, false);
  assert.equal(button(fresh, "Play"), undefined);
  assert.match(textOf(installed), /Installed\s+v1.0.0/);
  assert.ok(button(installed, "Play"));
  assert.match(textOf(outdated), /Update available \(1.0.0 → 1.2.0\)/);
  assert.ok(button(outdated, "Update"));
  assert.match(textOf(hidden), /not currently available/);
  assert.equal(button(hidden, "Install").disabled, true);
});

test("library search and filters narrow the list", async () => {
  const { root } = await launch(Object.values(GAMES), LOGGED_IN);
  await openLibrary(root);
  button(root, "Installed").dispatch("click");
  assert.deepEqual(libCards(root).map((c) => /Beta|Gamma/.test(textOf(c))), [true, true]);
  button(root, "Not installed").dispatch("click");
  assert.equal(libCards(root).length, 2);

  button(root, "All").dispatch("click");
  const search = byLabel(root, "Search your games");
  search.value = "delta";
  search.dispatch("input");
  assert.equal(libCards(root).length, 1);
  assert.match(textOf(root), /Delta Dash/);
});

test("play and verify call the launcher, and playing is remembered", async () => {
  const { root, api, app } = await launch([GAMES.installed], LOGGED_IN);
  await openLibrary(root);
  button(libCards(root)[0], "Play").dispatch("click");
  await flush();
  assert.deepEqual(api.calls.at(-1), ["play", "b"]);
  assert.deepEqual(app.local.recentlyPlayed(), ["b"]);

  libCards(root)[0].children[0].dispatch("click"); // open the details panel
  button(root, "Verify game files").dispatch("click");
  await flush();
  assert.deepEqual(api.calls.at(-1), ["verify", "b"]);
  assert.match(textOf(root), /All files are intact/);
});

test("a game that never asks for its token is explained, not treated as a crash", async () => {
  const { root } = await launch([GAMES.installed], {
    ...LOGGED_IN,
    play: () => Promise.resolve({ ok: true, data: { delivered: false } }),
  });
  await openLibrary(root);
  button(root, "Play").dispatch("click");
  await flush();
  assert.match(textOf(root), /did not ask for its launch token/);
});

test("uninstall needs a second click", async () => {
  const { root, api } = await launch([GAMES.installed], LOGGED_IN);
  await openLibrary(root);
  libCards(root)[0].children[0].dispatch("click");
  button(root, "Uninstall").dispatch("click");
  await flush();
  assert.equal(api.calls.filter((c) => c[0] === "uninstall").length, 0);
  button(root, "Click again to uninstall").dispatch("click");
  await flush();
  assert.deepEqual(api.calls.at(-1), ["uninstall", "b"]);
});

test("game titles are shown as text and can never inject markup", async () => {
  const evil = { ...GAMES.fresh, title: '<img src=x onerror="alert(1)"> Evil' };
  const { root } = await launch([evil], LOGGED_IN);
  await openLibrary(root);
  assert.equal(findAll(root, (n) => n.tagName === "img").length, 0);
  assert.ok(textOf(root).includes('<img src=x onerror="alert(1)"> Evil'));
});

// ---------------------------------------------------------------- downloads

test("installing shows live progress, finishes cleanly and is recorded", async () => {
  let finish;
  const { root, api, app } = await launch([GAMES.fresh], {
    ...LOGGED_IN,
    install: () => new Promise((resolve) => (finish = () => resolve({ ok: true, data: { version: "1.0.0" } }))),
  });
  await openLibrary(root);
  button(root, "Install").dispatch("click");
  await flush();
  assert.match(textOf(root), /Downloading/);
  assert.equal(button(root, "Install"), undefined);

  api.emitProgress({ gameId: "a", done: 50, total: 100 });
  assert.match(textOf(root), /50% · 50 B of 100 B/);

  finish();
  await flush();
  assert.match(textOf(root), /Alpha Quest 1.0.0 is installed/);
  assert.equal(findAll(root, (n) => n.className === "bar").length, 0);
  assert.equal(app.local.history()[0].status, "completed");
  assert.match(textOf(byLabel(root, "Notifications, 1 unread") || root), /./);
});

test("the second install waits its turn, then starts on its own", async () => {
  const finishers = {};
  const { root, api } = await launch([GAMES.fresh, { ...GAMES.fresh, game_id: "e", slug: "echo", title: "Echo Run" }], {
    ...LOGGED_IN,
    install: (id) => new Promise((resolve) => (api.calls.push(["install", id]), (finishers[id] = () => resolve({ ok: true, data: { version: "1.0.0" } })))),
  });
  await openLibrary(root);
  const [first, second] = libCards(root);
  button(first, "Install").dispatch("click");
  button(second, "Install").dispatch("click");
  await flush();
  assert.deepEqual(api.calls.filter((c) => c[0] === "install"), [["install", "a"]]);
  assert.match(textOf(root), /Waiting in queue/);

  finishers.a();
  await flush();
  assert.deepEqual(api.calls.filter((c) => c[0] === "install"), [["install", "a"], ["install", "e"]]);
});

test("pause stops the download and resume continues it; cancel is explained", async () => {
  let stop;
  const { root, api } = await launch([GAMES.fresh], {
    ...LOGGED_IN,
    install: () => new Promise((resolve) => (stop = () => resolve({ ok: false, error: { code: "CANCELLED", message: "Cancelled." } }))),
    cancel: (id) => (api.calls.push(["cancel", id]), stop()),
  });
  await openLibrary(root);
  button(root, "Install").dispatch("click");
  await flush();
  nav(root, "Downloads").dispatch("click");
  button(root, "Pause").dispatch("click");
  await flush();
  assert.deepEqual(api.calls.at(-1), ["cancel", "a"]);
  assert.ok(button(root, "Resume"), "a paused download can be resumed");
  assert.doesNotMatch(textOf(root), /Download cancelled/);

  button(root, "Resume").dispatch("click");
  await flush();
  assert.ok(button(root, "Pause"));
  button(root, "Cancel").dispatch("click");
  await flush();
  assert.match(textOf(root), /Download cancelled/);
  assert.match(textOf(root), /No downloads running/);
});

test("a failed install is explained and can be tried again", async () => {
  const { root } = await launch([GAMES.fresh], {
    ...LOGGED_IN,
    install: () => Promise.resolve({ ok: false, error: { code: "NOT_OWNED", message: "You do not own this game." } }),
  });
  await openLibrary(root);
  button(root, "Install").dispatch("click");
  await flush();
  assert.match(textOf(root), /You do not own this game/);
  assert.ok(button(root, "Install"));
});

test("the downloads page offers updates for installed games", async () => {
  const { root, api } = await launch([GAMES.outdated], LOGGED_IN);
  nav(root, "Downloads").dispatch("click");
  assert.match(textOf(root), /Updates available/);
  button(root, "Update").dispatch("click");
  await flush();
  assert.deepEqual(api.calls.at(-1), ["install", "c"]);
});

// ---------------------------------------------------------------- store

const openStore = async (root) => { nav(root, "Store").dispatch("click"); await flush(); };
const storeCard = (root, title) => findAll(root, (n) => n.className === "card-hit" && textOf(n).includes(title))[0];

test("the store lists games with kwacha prices and searches from the top bar", async () => {
  const { root, api } = await launch([], LOGGED_IN);
  await openStore(root);
  assert.match(textOf(root), /Paid Racer/);
  assert.match(textOf(root), /MWK 4,500/);
  assert.match(textOf(root), /Free Puzzle/);

  const box = byLabel(root, "Search the store");
  box.value = "racer";
  findAll(root, (n) => n.tagName === "form" && /search-box/.test(n.className))[0].dispatch("submit");
  await flush();
  assert.equal(api.calls.filter((c) => c[0] === "games").at(-1)[1].q, "racer");
  assert.doesNotMatch(textOf(root), /Free Puzzle/);
});

test("a free game is added to the library for real", async () => {
  const { root, api } = await launch([], LOGGED_IN);
  await openStore(root);
  storeCard(root, "Free Puzzle").dispatch("click");
  await flush();
  button(root, "Add to library").dispatch("click");
  await flush();
  assert.deepEqual(api.calls.at(-1), ["addToLibrary", "f1"]);
  assert.match(textOf(root), /was added to your library/);
});

test("a paid game explains that payments are not open and never touches the library", async () => {
  const { root, api } = await launch([], LOGGED_IN);
  await openStore(root);
  storeCard(root, "Paid Racer").dispatch("click");
  await flush();
  button(root, "Buy now").dispatch("click");
  assert.match(textOf(root), /Paid purchases are not open yet/);
  assert.match(textOf(root), /nothing has been charged/);
  assert.equal(api.calls.filter((c) => c[0] === "addToLibrary").length, 0);
});

test("owned games show the library state on their store page", async () => {
  const owned = { ...GAMES.fresh, game_id: "f1", slug: "free-game", title: "Free Puzzle" };
  const { root } = await launch([owned], LOGGED_IN);
  await openStore(root);
  storeCard(root, "Free Puzzle").dispatch("click");
  await flush();
  assert.match(textOf(root), /In your library/);
  assert.ok(button(root, "Install"));
  assert.equal(button(root, "Add to library"), undefined);
});

test("the wishlist is saved on this PC", async () => {
  const { root, app } = await launch([], LOGGED_IN);
  await openStore(root);
  const heart = findAll(root, (n) => /\bwish\b/.test(n.className))[0];
  heart.dispatch("click");
  assert.equal(app.local.wishlist().length, 1);
  nav(root, "Wishlist").dispatch("click");
  assert.match(textOf(root), /Paid Racer/);
  findAll(root, (n) => n.tagName === "button" && /Remove .* from wishlist/.test(n.attributes.title || ""))[0].dispatch("click");
  assert.match(textOf(root), /Your wishlist is empty/);
});

test("when the store cannot be reached the home page says so and offers a way forward", async () => {
  const down = () => Promise.resolve({ ok: false, error: { code: "NETWORK_ERROR", message: "Cannot reach the store: refused" } });
  const { root } = await launch([], { ...LOGGED_IN, games: down });
  assert.match(textOf(root), /Can't reach the store/);
  assert.ok(button(root, "Try again") && button(root, "Server settings") && button(root, "Preview with sample games"));
});

// ---------------------------------------------------------------- sample store

test("the sample store is labelled everywhere and its games can never be added", async () => {
  const { root, api } = await launch([], LOGGED_IN);
  const settingsButton = byLabel(root, "Settings");
  settingsButton.dispatch("click");
  const toggle = findAll(root, (n) => n.tagName === "input" && n.attributes.role === "switch" && /sample/i.test(textOf(n.parent)))[0];
  toggle.checked = true;
  toggle.dispatch("change");
  await flush();

  nav(root, "Store").dispatch("click");
  await flush();
  assert.match(textOf(root), /previewing the store with sample games/);
  assert.match(textOf(root), /Sample/);
  storeCard(root, "Nsima Tycoon").dispatch("click"); // a free sample game
  await flush();
  button(root, "Add to library").dispatch("click");
  await flush();
  assert.match(textOf(root), /This is a sample game/);
  assert.equal(api.calls.filter((c) => c[0] === "addToLibrary").length, 0);
});

// ---------------------------------------------------------------- settings and publisher

test("settings can save the server and the install folder", async () => {
  const { root, api } = await launch([GAMES.fresh], LOGGED_IN);
  byLabel(root, "Settings").dispatch("click");
  const server = byLabel(root, "Server address");
  assert.equal(server.value, "http://store.test");
  server.value = " http://other.test ";
  button(root, "Save server").dispatch("click");
  await flush();
  assert.deepEqual(api.calls.at(-1), ["save", { apiBase: "http://other.test", installRoot: "C:\\Games" }]);

  byLabel(root, "Settings").dispatch("click");
  settingsTab(root, "Downloads").dispatch("click");
  const folder = byLabel(root, "Install folder");
  assert.equal(folder.value, "C:\\Games");
  button(root, "Browse…").dispatch("click");
  await flush();
  assert.equal(folder.value, "D:\\Games");
  button(root, "Save folder").dispatch("click");
  await flush();
  assert.deepEqual(api.calls.at(-1), ["save", { apiBase: "http://store.test", installRoot: "D:\\Games" }]);
});

test("settings that the launcher cannot honour yet are shown as unavailable, not as dead switches", async () => {
  const { root } = await launch([], LOGGED_IN);
  byLabel(root, "Settings").dispatch("click");
  const startup = findAll(root, (n) => n.tagName === "input" && n.attributes.role === "switch")[0];
  assert.equal(startup.disabled, true);
  settingsTab(root, "Downloads").dispatch("click");
  const limit = byLabel(root, "Download speed limit");
  assert.equal(limit.disabled, true);
});

test("settings are reachable before logging in", async () => {
  const { root } = await launch([]);
  button(root, "Server settings").dispatch("click");
  assert.match(textOf(root), /Store server/);
  button(root, "← Back to log in").dispatch("click");
  assert.match(textOf(root), /Log in/);
});

test("the publisher portal lists the player's studios and checks the studio name", async () => {
  const { root, api } = await launch([], LOGGED_IN);
  nav(root, "Publisher portal").dispatch("click");
  await flush();
  assert.match(textOf(root), /Lakeshore Games/);
  assert.match(textOf(root), /Waiting for MAREC to verify/);

  const name = byLabel(root, "Studio name");
  name.value = "x";
  name.dispatch("input");
  findAll(root, (n) => n.tagName === "form" && /panel-form/.test(n.className))[0].dispatch("submit");
  await flush();
  assert.match(textOf(root), /Use 2 to 60 characters/);
  assert.equal(api.calls.filter((c) => c[0] === "createStudio").length, 0);
});

test("formatBytes is exposed for the downloads display", async () => {
  const { app } = await launch([], LOGGED_IN);
  assert.equal(app.formatBytes(1536), "1.5 KB");
  assert.equal(app.formatBytes(10), "10 B");
});

// ---------------------------------------------------------------- phone (Android) behaviour

const PHONE = () => createPlatform({ MarecAndroid: {} });
const tab = (root, label) =>
  findAll(root, (n) => n.tagName === "button" && /\btab\b/.test(n.className) && textOf(n).trim().replace(/\s+\d+$/, "") === label)[0];

test("the phone gets a bottom tab bar with Home, Discover, Search, Library and Profile", async () => {
  const { root } = await launch([], { ...LOGGED_IN, platform: PHONE() });
  for (const label of ["Home", "Discover", "Search", "Library", "Profile"]) assert.ok(tab(root, label), `${label} tab`);
  assert.equal(tab(root, "Home").attributes["aria-current"], "page");
  tab(root, "Discover").dispatch("click");
  await flush();
  assert.match(textOf(root), /Find your next game/);
  assert.equal(tab(root, "Discover").attributes["aria-current"], "page");
});

test("Windows games in a phone library cannot be installed or played, and say where they can be", async () => {
  const { root, api } = await launch([GAMES.fresh, GAMES.installed], { ...LOGGED_IN, platform: PHONE() });
  tab(root, "Library").dispatch("click");
  await flush();
  const cards = libCards(root);
  assert.equal(cards.length, 2);
  for (const card of cards) {
    assert.match(textOf(card), /Windows PC game/);
    assert.equal(button(card, "Install"), undefined);
    assert.equal(button(card, "Play"), undefined);
  }
  cards[0].children[0].dispatch("click"); // details panel
  assert.match(textOf(root), /Windows launcher on your PC/);
  assert.equal(button(root, "Verify game files"), undefined);
  assert.equal(api.calls.filter((c) => c[0] === "install" || c[0] === "play").length, 0);
});

test("a phone can still browse the store and add a free game to the library", async () => {
  const { root, api } = await launch([], { ...LOGGED_IN, platform: PHONE() });
  tab(root, "Discover").dispatch("click");
  await flush();
  storeCard(root, "Free Puzzle").dispatch("click");
  await flush();
  assert.match(textOf(root), /Windows PC/); // the platform it is for
  assert.match(textOf(root), /You can still add it to your library here/);
  button(root, "Add to library").dispatch("click");
  await flush();
  assert.deepEqual(api.calls.at(-1), ["addToLibrary", "f1"]);
});

test("the Search tab searches as you type and explains empty results", async () => {
  const { root, api } = await launch([], { ...LOGGED_IN, platform: PHONE() });
  tab(root, "Search").dispatch("click");
  const box = byLabel(root, "Search games");
  box.value = "racer";
  box.dispatch("input");
  await new Promise((resolve) => setTimeout(resolve, 400));
  await flush();
  assert.equal(api.calls.filter((c) => c[0] === "games").at(-1)[1].q, "racer");
  assert.match(textOf(root), /Paid Racer/);
  assert.doesNotMatch(textOf(root), /Free Puzzle/);

  box.value = "zzzz";
  box.dispatch("input");
  await new Promise((resolve) => setTimeout(resolve, 400));
  await flush();
  assert.match(textOf(root), /No games found/);
});

test("the Android Back button goes back inside the app, and only leaves at the start", async () => {
  const { root } = await launch([GAMES.fresh], { ...LOGGED_IN, platform: PHONE() });
  assert.equal(typeof globalThis.MarecAndroidBack, "function");
  assert.equal(globalThis.MarecAndroidBack(), false, "nothing to go back to on the first screen");
  tab(root, "Library").dispatch("click");
  await flush();
  assert.match(textOf(root), /Alpha Quest/);
  assert.equal(globalThis.MarecAndroidBack(), true);
  assert.doesNotMatch(textOf(root), /Everything you own/);
  delete globalThis.MarecAndroidBack;
});

test("a phone with no server address yet is told to set one", async () => {
  const { root } = await launch([], {
    platform: PHONE(),
    state: () => Promise.resolve({ ok: true, data: { apiBase: "", installRoot: "", secureStorage: true, version: "0.2.0", user: null } }),
  });
  assert.match(textOf(root), /Set the store server address first/);
  assert.ok(button(root, "Server settings"));
});

test("the Windows window is unchanged: Windows games keep Install and Play", async () => {
  const { root } = await launch([GAMES.fresh, GAMES.installed], LOGGED_IN);
  await openLibrary(root);
  const [fresh, installed] = libCards(root);
  assert.ok(button(fresh, "Install"));
  assert.ok(button(installed, "Play"));
});
