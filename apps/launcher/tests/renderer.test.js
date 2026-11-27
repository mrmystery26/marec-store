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

const DEV_ACCOUNT = {
  is_developer: true, email_verified: true, terms_version: "2026-11",
  limits: { demo_only: true, max_demo_build_mb: 1024, max_games_per_studio: 5 },
  studios: [{ id: "s1", name: "Lakeshore Games", slug: "lakeshore", status: "pending", my_role: "owner" }],
};

function fakeApi(items, { user = null, ...overrides } = {}) {
  const calls = [];
  let progress = () => {};
  let authCallback = () => {};
  let uploadCallback = () => {};
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
    providers: () => ok({ google: false, email_codes: false }),
    googleSignIn: () => (calls.push(["googleSignIn"]), ok({ started: true })),
    googleCancel: () => (calls.push(["googleCancel"]), ok({ cancelled: true })),
    sendEmailCode: () => (calls.push(["sendEmailCode"]), ok({ expires_in_minutes: 15 })),
    verifyEmail: (code) => (calls.push(["verifyEmail", code]), ok({ email: "pat@example.com", display_name: "Pat", email_verified: true, created_at: "2026-10-18T00:00:00Z", roles: [] })),
    developerAccount: () => ok(DEV_ACCOUNT),
    registerDeveloper: (name, terms) => (calls.push(["registerDeveloper", name, terms]), ok({ id: "s9", name, slug: "x", status: "pending", my_role: "owner" })),
    studioGames: () => ok({ items: [], total: 0 }),
    createGame: (studioId, title) => (calls.push(["createGame", studioId, title]), ok({ id: "g9", title })),
    developerGame: (id) => ok({ id, slug: "my-demo", title: "My Demo", status: "draft", release_kind: "demo", summary: "", description: "", age_rating: null, categories: [], requirements: [], studio: { name: "Lakeshore Games", slug: "lakeshore" } }),
    updateGame: (id, changes) => (calls.push(["updateGame", id, changes]), ok({})),
    submitGame: (id) => (calls.push(["submitGame", id]), ok({})),
    builds: () => ok([]),
    pickBuildFolder: () => ok({ name: "export", fileCount: 3, totalBytes: 5_000_000, exeCandidates: ["Game.exe"] }),
    uploadBuild: (options) => (calls.push(["uploadBuild", options]), ok({ build: { id: "b1" } })),
    cancelUpload: () => (calls.push(["cancelUpload"]), ok({ cancelled: true })),
    downloadSdkConfig: (id) => (calls.push(["downloadSdkConfig", id]), ok({ path: "C:\\marec_config.gd" })),
    adminStudios: (status) => (calls.push(["adminStudios", status]), ok({ items: [], total: 0 })),
    verifyStudio: (id) => (calls.push(["verifyStudio", id]), ok({})),
    adminGames: (status) => (calls.push(["adminGames", status]), ok({ items: [], total: 0 })),
    transitionGame: (id, action, reason) => (calls.push(["transitionGame", id, action, reason]), ok({})),
    onAuthEvent: (cb) => ((authCallback = cb), () => {}),
    emitAuth: (event) => authCallback(event),
    onUploadProgress: (cb) => ((uploadCallback = cb), () => {}),
    emitUpload: (event) => uploadCallback(event),
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
  assert.ok(button(root, "Try again") && button(root, "Server settings"));
  assert.equal(button(root, "Preview with sample games"), undefined, "there is no sample store any more");
});

test("an empty store says so and points developers to the publisher portal", async () => {
  const { root } = await launch([], { ...LOGGED_IN, games: () => Promise.resolve({ ok: true, data: { items: [], total: 0, limit: 24, offset: 0 } }) });
  assert.match(textOf(root), /The store has no games yet/);
  assert.doesNotMatch(textOf(root), /sample/i);
  button(root, "Publish a demo").dispatch("click");
  await flush();
  assert.match(textOf(root), /Publisher portal/);
});

// ---------------------------------------------------------------- no placeholders

test("nothing in the launcher offers or shows made-up games", async () => {
  const { root } = await launch([], LOGGED_IN);
  byLabel(root, "Settings").dispatch("click");
  assert.doesNotMatch(textOf(root), /sample/i);
  assert.equal(findAll(root, (n) => n.tagName === "input" && n.attributes.role === "switch" && /sample/i.test(textOf(n.parent))).length, 0);
});

test("a demo is labelled as a demo, and its page says what that means", async () => {
  const demo = { ...STORE[0], release_kind: "demo", is_free: true, price_minor: 0 };
  const { root } = await launch([], { ...LOGGED_IN, games: () => Promise.resolve({ ok: true, data: { items: [demo], total: 1, limit: 24, offset: 0 } }), game: () => Promise.resolve({ ok: true, data: { ...demo, description: "About.", offline_days: 7, requirements: [] } }) });
  nav(root, "Store").dispatch("click");
  await flush();
  assert.ok(findAll(root, (n) => /\bbadge\b/.test(n.className) && /demo/.test(n.className)).length > 0);
  storeCard(root, demo.title).dispatch("click");
  await flush();
  assert.match(textOf(root), /This is a free demo/);
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

test("settings only offer things that work: no dead switches or disabled stubs", async () => {
  const { root } = await launch([], LOGGED_IN);
  byLabel(root, "Settings").dispatch("click");
  const switches = findAll(root, (n) => n.tagName === "input" && n.attributes.role === "switch");
  assert.ok(switches.every((n) => n.disabled !== true), "no switch is permanently disabled");
  assert.doesNotMatch(textOf(root), /Not available yet/);
  settingsTab(root, "Downloads").dispatch("click");
  assert.doesNotMatch(textOf(root), /speed limit/i);
});

test("settings are reachable before logging in", async () => {
  const { root } = await launch([]);
  button(root, "Server settings").dispatch("click");
  assert.match(textOf(root), /Store server/);
  button(root, "← Back to log in").dispatch("click");
  assert.match(textOf(root), /Log in/);
});

// ---------------------------------------------------------------- Google sign-in and email codes

const googleOn = { providers: () => Promise.resolve({ ok: true, data: { google: true, email_codes: true } }) };

test("the Continue with Google button appears only when the store has Google set up", async () => {
  const off = await launch([]);
  assert.equal(button(off.root, "Continue with Google"), undefined);
  const on = await launch([], googleOn);
  assert.ok(button(on.root, "Continue with Google"));
  assert.match(textOf(on.root), /Signed up with Google\? Use the Google button/);
});

test("Continue with Google starts the browser sign-in and waits, and can be cancelled", async () => {
  const { root, api } = await launch([], googleOn);
  button(root, "Continue with Google").dispatch("click");
  await flush();
  assert.deepEqual(api.calls.at(-1), ["googleSignIn"]);
  assert.match(textOf(root), /Finish signing in with Google in your browser/);
  assert.equal(button(root, "Continue with Google"), undefined, "no second sign-in while one is waiting");
  button(root, "Cancel").dispatch("click");
  await flush();
  assert.deepEqual(api.calls.at(-1), ["googleCancel"]);
  assert.ok(button(root, "Continue with Google"));
});

test("when Google sign-in finishes the player lands in the store signed in", async () => {
  const { root, api } = await launch([], googleOn);
  button(root, "Continue with Google").dispatch("click");
  await flush();
  api.emitAuth({ type: "signed-in", user: { email: "gina@gmail.com", display_name: "Gina", email_verified: true, created_at: "2026-11-20T00:00:00Z", roles: [] } });
  await flush();
  assert.ok(nav(root, "Library") && nav(root, "Store"), "the sidebar is shown");
  assert.doesNotMatch(textOf(root), /Finish signing in with Google/);
});

test("a cancelled or failed Google sign-in says why and lets the player try again", async () => {
  const { root, api } = await launch([], googleOn);
  button(root, "Continue with Google").dispatch("click");
  await flush();
  api.emitAuth({ type: "failed", code: "GOOGLE_CANCELLED", message: "Sign-in was cancelled." });
  await flush();
  assert.match(textOf(root), /Sign-in was cancelled\./);
  assert.ok(button(root, "Continue with Google"));
  assert.equal(findAll(root, (n) => n.tagName === "form").length, 1, "email sign-in is still there");
});

test("the Google button reports a failure to start (for example the store is not set up)", async () => {
  const { root } = await launch([], { ...googleOn, googleSignIn: () => Promise.resolve({ ok: false, error: { code: "GOOGLE_NOT_CONFIGURED", message: "Sign in with Google is not set up on this server." } }) });
  button(root, "Continue with Google").dispatch("click");
  await flush();
  assert.match(textOf(root), /not set up on this server/);
  assert.ok(button(root, "Continue with Google"));
});

const UNVERIFIED = { user: { email: "pat@example.com", display_name: "Pat", email_verified: false, created_at: "2026-10-18T00:00:00Z", roles: [] } };

test("an unconfirmed email is confirmed with a code from the email", async () => {
  const { root, api } = await launch([], UNVERIFIED);
  nav(root, "Library").dispatch("click"); // any page, then the profile
  byLabel(root, "Account menu").dispatch("click");
  button(root, "Profile").dispatch("click");
  await flush();
  assert.match(textOf(root), /Confirm your email/);
  button(root, "Email me a code").dispatch("click");
  await flush();
  assert.deepEqual(api.calls.at(-1), ["sendEmailCode"]);
  const code = byLabel(root, "6-digit code");
  code.value = "123456";
  button(root, "Confirm").dispatch("click");
  await flush();
  assert.deepEqual(api.calls.at(-1), ["verifyEmail", "123456"]);
  assert.doesNotMatch(textOf(root), /Confirm your email/);
});

test("a wrong code shows the store's message and keeps the box open", async () => {
  const { root } = await launch([], { ...UNVERIFIED, verifyEmail: () => Promise.resolve({ ok: false, error: { code: "WRONG_CODE", message: "That code is not right or has expired." } }) });
  byLabel(root, "Account menu").dispatch("click");
  button(root, "Profile").dispatch("click");
  await flush();
  button(root, "Email me a code").dispatch("click");
  await flush();
  byLabel(root, "6-digit code").value = "000000";
  button(root, "Confirm").dispatch("click");
  await flush();
  assert.match(textOf(root), /not right or has expired/);
  assert.ok(byLabel(root, "6-digit code"));
});

// ---------------------------------------------------------------- the publisher portal

const openPortal = async (root) => { nav(root, "Publisher portal").dispatch("click"); await flush(); };
const NOT_A_DEV = { ...DEV_ACCOUNT, is_developer: false, studios: [] };
const developerApi = (over = {}) => ({ ...LOGGED_IN, ...over });

test("a player who is not a developer yet sees the steps and the rules", async () => {
  const { root } = await launch([], developerApi({ developerAccount: () => Promise.resolve({ ok: true, data: NOT_A_DEV }) }));
  await openPortal(root);
  assert.match(textOf(root), /Become a developer/);
  assert.match(textOf(root), /only accepts free demos/);
  assert.ok(button(root, "Create developer account"));
});

test("creating a developer account needs the rules accepted and a studio name", async () => {
  const { root, api } = await launch([], developerApi({ developerAccount: () => Promise.resolve({ ok: true, data: NOT_A_DEV }) }));
  await openPortal(root);
  button(root, "Create developer account").dispatch("click");
  await flush();
  assert.match(textOf(root), /Use 2 to 60 characters for the studio name/);
  byLabel(root, "Studio name").value = "Zomba Games";
  byLabel(root, "Studio name").dispatch("input");
  button(root, "Create developer account").dispatch("click");
  await flush();
  assert.match(textOf(root), /Accept the developer rules/);
  assert.equal(api.calls.filter((c) => c[0] === "registerDeveloper").length, 0);

  const accept = findAll(root, (n) => n.tagName === "input" && n.attributes.role === "switch" && /rules/.test(textOf(n.parent)))[0];
  accept.checked = true;
  accept.dispatch("change");
  button(root, "Create developer account").dispatch("click");
  await flush();
  assert.deepEqual(api.calls.filter((c) => c[0] === "registerDeveloper")[0], ["registerDeveloper", "Zomba Games", "2026-11"]);
});

test("an unconfirmed email blocks developer registration and offers the code box", async () => {
  const { root } = await launch([], developerApi({ developerAccount: () => Promise.resolve({ ok: true, data: { ...NOT_A_DEV, email_verified: false } }) }));
  await openPortal(root);
  assert.match(textOf(root), /Confirm your email/);
  assert.equal(button(root, "Create developer account").disabled, true);
});

test("a pending studio is listed, can not create demos yet, and explains why", async () => {
  const { root } = await launch([], LOGGED_IN);
  await openPortal(root);
  assert.match(textOf(root), /Lakeshore Games/);
  assert.match(textOf(root), /MAREC has to verify this studio/);
  assert.equal(button(root, "Create demo"), undefined);
  assert.match(textOf(root), /Demos only for now/);
});

const VERIFIED = { ...DEV_ACCOUNT, studios: [{ ...DEV_ACCOUNT.studios[0], status: "verified" }] };
const verifiedStudio = (over = {}) => developerApi({ developerAccount: () => Promise.resolve({ ok: true, data: VERIFIED }), ...over });

test("a verified studio creates a demo and lands in its editor", async () => {
  const { root, api } = await launch([], verifiedStudio());
  await openPortal(root);
  byLabel(root, "Demo title").value = "Maize Run";
  byLabel(root, "Demo title").dispatch("input");
  button(root, "Create demo").dispatch("click");
  await flush();
  assert.deepEqual(api.calls.filter((c) => c[0] === "createGame")[0], ["createGame", "s1", "Maize Run"]);
  assert.match(textOf(root), /My Demo/);
  assert.ok(button(root, "Save details") && button(root, "Submit for review"));
});

test("the demo form checks every field before saving, then sends exactly what the store expects", async () => {
  const { root, api } = await launch([], verifiedStudio());
  await openPortal(root);
  byLabel(root, "Demo title").value = "Maize Run";
  byLabel(root, "Demo title").dispatch("input");
  button(root, "Create demo").dispatch("click");
  await flush();

  byLabel(root, "Summary").value = "";
  button(root, "Save details").dispatch("click");
  await flush();
  assert.match(textOf(root), /Write a one-line summary/);
  assert.match(textOf(root), /Describe your game/);
  assert.match(textOf(root), /Choose an age rating/);
  assert.match(textOf(root), /Pick at least one genre/);
  assert.match(textOf(root), /Say which processor is needed/);
  assert.equal(api.calls.filter((c) => c[0] === "updateGame").length, 0);

  byLabel(root, "Summary").value = "Dodge the goats.";
  byLabel(root, "Description").value = "A short demo.";
  byLabel(root, "Processor").value = "Intel Core i3";
  byLabel(root, "Age rating").value = "7+";
  byLabel(root, "Age rating").dispatch("change");
  findAll(root, (n) => n.tagName === "button" && /chip/.test(n.className) && textOf(n) === "Racing")[0].dispatch("click");
  button(root, "Save details").dispatch("click");
  await flush();
  const sent = api.calls.filter((c) => c[0] === "updateGame")[0];
  assert.equal(sent[1], "g9");
  assert.deepEqual(sent[2], {
    summary: "Dodge the goats.", description: "A short demo.", age_rating: "7+", category_slugs: ["racing"],
    requirements: [{ tier: "minimum", os: "Windows 10 64-bit", cpu: "Intel Core i3", ram_mb: 4096, gpu: "", storage_mb: 500 }],
  });
});

test("submitting for review sends the demo, and the store's list of what is missing is shown", async () => {
  const { root, api } = await launch([], verifiedStudio({
    submitGame: () => Promise.resolve({ ok: false, error: { code: "SUBMISSION_INCOMPLETE", message: "Missing: summary, a ready build" } }),
  }));
  await openPortal(root);
  byLabel(root, "Demo title").value = "Maize Run";
  byLabel(root, "Demo title").dispatch("input");
  button(root, "Create demo").dispatch("click");
  await flush();
  button(root, "Submit for review").dispatch("click");
  await flush();
  assert.match(textOf(root), /Missing: summary, a ready build/);
  assert.ok(api);
});

test("uploading a build: choose the folder, see its size, upload, and see progress", async () => {
  const { root, api } = await launch([], verifiedStudio());
  await openPortal(root);
  byLabel(root, "Demo title").value = "Maize Run";
  byLabel(root, "Demo title").dispatch("input");
  button(root, "Create demo").dispatch("click");
  await flush();

  assert.match(textOf(root), /at most 1024 MB/);
  button(root, "Choose game folder").dispatch("click");
  await flush();
  assert.match(textOf(root), /export: 3 files, 5 MB/);
  byLabel(root, "Version").value = "1.0.0";
  byLabel(root, "Version").dispatch("input");
  button(root, "Upload build").dispatch("click");
  await flush();
  const upload = api.calls.filter((c) => c[0] === "uploadBuild")[0][1];
  assert.equal(upload.version, "1.0.0");
  assert.equal(upload.entryPoint, "Game.exe");
  assert.ok(upload.gameId);
});

test("upload progress moves the bar and names the step", async () => {
  let release;
  const { root, api } = await launch([], verifiedStudio({ uploadBuild: () => new Promise((resolve) => { release = () => resolve({ ok: true, data: { build: {} } }); }) }));
  await openPortal(root);
  byLabel(root, "Demo title").value = "Maize Run";
  byLabel(root, "Demo title").dispatch("input");
  button(root, "Create demo").dispatch("click");
  await flush();
  button(root, "Choose game folder").dispatch("click");
  await flush();
  button(root, "Upload build").dispatch("click");
  await flush();
  const gameId = "g9";
  api.emitUpload({ gameId, phase: "uploading", done: 2_500_000, total: 5_000_000 });
  assert.match(textOf(root), /Uploading… 50%/);
  assert.ok(button(root, "Cancel upload"));
  button(root, "Cancel upload").dispatch("click");
  assert.deepEqual(api.calls.at(-1), ["cancelUpload"]);
  release();
  await flush();
});

test("a failed upload shows what went wrong and lets the developer try again", async () => {
  const { root } = await launch([], verifiedStudio({ uploadBuild: () => Promise.resolve({ ok: false, error: { code: "DEMO_TOO_LARGE", message: "A demo can be at most 1024 MB." } }) }));
  await openPortal(root);
  byLabel(root, "Demo title").value = "Maize Run";
  byLabel(root, "Demo title").dispatch("input");
  button(root, "Create demo").dispatch("click");
  await flush();
  button(root, "Choose game folder").dispatch("click");
  await flush();
  button(root, "Upload build").dispatch("click");
  await flush();
  assert.match(textOf(root), /A demo can be at most 1024 MB/);
  assert.ok(button(root, "Upload build"));
});

test("the SDK config is downloaded for the demo", async () => {
  const { root, api } = await launch([], verifiedStudio());
  await openPortal(root);
  byLabel(root, "Demo title").value = "Maize Run";
  byLabel(root, "Demo title").dispatch("input");
  button(root, "Create demo").dispatch("click");
  await flush();
  button(root, "Download SDK config").dispatch("click");
  await flush();
  assert.equal(api.calls.filter((c) => c[0] === "downloadSdkConfig").length, 1);
  assert.match(textOf(root), /addons\/marec_sdk/);
});

test("changes requested by MAREC are shown to the developer on the demo", async () => {
  const { root } = await launch([], verifiedStudio({
    studioGames: () => Promise.resolve({ ok: true, data: { items: [{ id: "g1", title: "Maize Run", status: "changes_requested", updated_at: "2026-11-20T00:00:00Z" }], total: 1 } }),
    developerGame: (id) => Promise.resolve({ ok: true, data: { id, title: "Maize Run", status: "changes_requested", status_reason: "Add a clearer description.", release_kind: "demo", summary: "s", description: "d", age_rating: "7+", categories: [{ slug: "racing", name: "Racing" }], requirements: [], studio: { name: "Lakeshore Games", slug: "lakeshore" } } }),
  }));
  await openPortal(root);
  button(root, "Open").dispatch("click");
  await flush();
  assert.match(textOf(root), /MAREC asked for changes: Add a clearer description\./);
  assert.ok(button(root, "Submit for review"), "it can be fixed and sent again");
});

test("a phone can manage demos but is told uploads need a PC", async () => {
  const { root } = await launch([], verifiedStudio({ platform: PHONE() }));
  await openPortal(root);
  assert.ok(root);
});

// ---------------------------------------------------------------- staff review

const STAFF = { user: { email: "boss@example.com", display_name: "Boss", email_verified: true, created_at: "2026-10-18T00:00:00Z", roles: ["super_admin"] } };
const REVIEW_GAME = { id: "g1", title: "Maize Run", status: "submitted", summary: "Dodge the goats.", description: "A demo.", release_kind: "demo", age_rating: "7+", studio: { name: "Zomba Games", slug: "zomba" }, categories: [{ slug: "racing", name: "Racing" }], requirements: [{ tier: "minimum", os: "Windows 10", ram_mb: 4096, storage_mb: 500 }] };

test("only staff see the Review screen", async () => {
  const player = await launch([], LOGGED_IN);
  assert.equal(nav(player.root, "Review"), undefined);
  const staff = await launch([], STAFF);
  assert.ok(nav(staff.root, "Review"));
});

test("staff verify a waiting studio", async () => {
  const { root, api } = await launch([], { ...STAFF, adminStudios: () => Promise.resolve({ ok: true, data: { items: [{ id: "s7", name: "Zomba Games", slug: "zomba-games", status: "pending", created_at: "2026-11-20T00:00:00Z", verified_at: null }], total: 1 } }) });
  nav(root, "Review").dispatch("click");
  await flush();
  assert.match(textOf(root), /Zomba Games/);
  button(root, "Verify").dispatch("click");
  await flush();
  assert.deepEqual(api.calls.filter((c) => c[0] === "verifyStudio")[0], ["verifyStudio", "s7"]);
});

test("staff move a submitted demo through review, and a reason is required to ask for changes", async () => {
  const { root, api } = await launch([], { ...STAFF, adminGames: (status) => Promise.resolve({ ok: true, data: { items: status === "under_review" ? [{ ...REVIEW_GAME, status: "under_review" }] : [], total: 0 } }) });
  nav(root, "Review").dispatch("click");
  await flush();
  findAll(root, (n) => n.tagName === "button" && n.attributes.role === "tab" && textOf(n) === "Demos to review")[0].dispatch("click");
  await flush();
  assert.match(textOf(root), /Maize Run/);
  assert.match(textOf(root), /Zomba Games/);

  button(root, "Request changes").dispatch("click");
  await flush();
  assert.match(textOf(root), /Write a reason first/);
  assert.equal(api.calls.filter((c) => c[0] === "transitionGame").length, 0);

  const reason = byLabel(root, "Reason for Maize Run");
  reason.value = "Add a clearer description.";
  reason.dispatch("input");
  button(root, "Request changes").dispatch("click");
  await flush();
  assert.deepEqual(api.calls.filter((c) => c[0] === "transitionGame")[0], ["transitionGame", "g1", "request_changes", "Add a clearer description."]);
});

test("approving and publishing need no reason", async () => {
  const { root, api } = await launch([], { ...STAFF, adminGames: (status) => Promise.resolve({ ok: true, data: { items: status === "approved" ? [{ ...REVIEW_GAME, status: "approved" }] : [], total: 0 } }) });
  nav(root, "Review").dispatch("click");
  await flush();
  findAll(root, (n) => n.tagName === "button" && n.attributes.role === "tab" && textOf(n) === "Demos to review")[0].dispatch("click");
  await flush();
  button(root, "Publish").dispatch("click");
  await flush();
  assert.deepEqual(api.calls.filter((c) => c[0] === "transitionGame")[0], ["transitionGame", "g1", "publish", undefined]);
});

test("live demos can be suspended, with a reason", async () => {
  const { root, api } = await launch([], { ...STAFF, adminGames: (status) => Promise.resolve({ ok: true, data: { items: status === "published" ? [{ ...REVIEW_GAME, status: "published" }] : [], total: 0 } }) });
  nav(root, "Review").dispatch("click");
  await flush();
  findAll(root, (n) => n.tagName === "button" && n.attributes.role === "tab" && textOf(n) === "Live demos")[0].dispatch("click");
  await flush();
  byLabel(root, "Reason for Maize Run").value = "Reported as unsafe.";
  button(root, "Suspend").dispatch("click");
  await flush();
  assert.deepEqual(api.calls.filter((c) => c[0] === "transitionGame")[0], ["transitionGame", "g1", "suspend", "Reported as unsafe."]);
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

// ---------------------------------------------------------------- friends

/** A small stateful stand-in for the store's friends service, so every click can be checked end to end. */
function friendsStore({ friends = [], incoming = [], outgoing = [], code = "K7QM-2XWD", sendError = null } = {}) {
  const state = { friends: [...friends], incoming: [...incoming], outgoing: [...outgoing], code };
  const log = [];
  const ok = (data) => Promise.resolve({ ok: true, data });
  const person = (r) => ({ user_id: r.user_id, display_name: r.display_name, since: "2026-11-17T00:00:00Z" });
  return {
    state,
    log,
    overrides: {
      friends: () => (log.push(["list"]), ok({ items: state.friends, total: state.friends.length })),
      friendRequests: () => ok({ incoming: state.incoming, outgoing: state.outgoing }),
      friendCode: () => ok({ code: state.code }),
      resetFriendCode: () => (log.push(["reset"]), (state.code = "NEW2-CODE"), ok({ code: state.code })),
      sendFriendRequest: (code) => {
        log.push(["send", code]);
        if (sendError) return Promise.resolve({ ok: false, error: sendError });
        return ok({ id: "r9", status: "pending", user_id: "u9", display_name: "Dee" });
      },
      acceptFriendRequest: (id) => {
        log.push(["accept", id]);
        const found = state.incoming.find((r) => r.id === id);
        state.incoming = state.incoming.filter((r) => r.id !== id);
        state.friends.push(person(found));
        return ok(person(found));
      },
      declineFriendRequest: (id) => (log.push(["decline", id]), (state.incoming = state.incoming.filter((r) => r.id !== id)), ok(null)),
      cancelFriendRequest: (id) => (log.push(["cancel", id]), (state.outgoing = state.outgoing.filter((r) => r.id !== id)), ok(null)),
      removeFriend: (userId) => (log.push(["remove", userId]), (state.friends = state.friends.filter((f) => f.user_id !== userId)), ok(null)),
    },
  };
}

const ANA = { user_id: "u1", display_name: "Ana", since: "2026-10-01T00:00:00Z" };
const BEA = { user_id: "u2", display_name: "Bea", since: "2026-10-05T00:00:00Z" };
const ASKED_ME = { id: "r1", user_id: "u3", display_name: "Cy", created_at: "2026-11-10T00:00:00Z" };
const I_ASKED = { id: "r2", user_id: "u4", display_name: "Dee", created_at: "2026-11-11T00:00:00Z" };

async function openFriends(options) {
  const fake = friendsStore(options);
  const { root, api } = await launch([], { ...LOGGED_IN, ...fake.overrides });
  nav(root, "Friends").dispatch("click");
  await flush();
  return { root, api, fake };
}
const friendsTabButton = (root, prefix) =>
  findAll(root, (n) => n.tagName === "button" && n.attributes.role === "tab" && textOf(n).trim().startsWith(prefix))[0];
const goToTab = async (root, prefix) => { friendsTabButton(root, prefix).dispatch("click"); await flush(); };
const typeCode = (root, value) => {
  const box = byLabel(root, "Friend code");
  box.value = value;
  box.dispatch("input");
};
const submitCode = async (root) => {
  findAll(root, (n) => n.tagName === "form" && /panel-form/.test(n.className))[0].dispatch("submit");
  await flush();
};

test("the friends page lists the player's real friends and counts waiting requests", async () => {
  const { root } = await openFriends({ friends: [ANA, BEA], incoming: [ASKED_ME] });
  const text = textOf(root);
  assert.match(text, /Ana/);
  assert.match(text, /Bea/);
  assert.match(text, /Friends since/);
  assert.ok(friendsTabButton(root, "Friends (2)"), "the friends tab shows how many friends");
  assert.ok(friendsTabButton(root, "Requests (1)"), "the requests tab shows how many are waiting");
  assert.doesNotMatch(text, /Sample Friend/);
  assert.match(text, /who is online and what your friends are playing is not built yet/);
});

test("with no friends the page explains how to add one, and shows the player's own code", async () => {
  const { root } = await openFriends();
  assert.match(textOf(root), /No friends yet/);
  button(root, "Add a friend").dispatch("click");
  await flush();
  assert.match(textOf(root), /Your friend code/);
  assert.match(textOf(root), /K7QM-2XWD/);
  assert.match(textOf(root), /not your email address/);
});

test("accepting a request makes a friend and refreshes both lists from the store", async () => {
  const { root, fake } = await openFriends({ friends: [ANA], incoming: [ASKED_ME] });
  await goToTab(root, "Requests");
  assert.match(textOf(root), /Requests for you/);
  assert.match(textOf(root), /Cy/);

  button(root, "Accept").dispatch("click");
  await flush();
  assert.deepEqual(fake.log.filter((c) => c[0] === "accept"), [["accept", "r1"]]);
  assert.match(textOf(root), /You and Cy are now friends/);
  assert.match(textOf(root), /No friend requests/);
  assert.ok(friendsTabButton(root, "Friends (2)"));
});

test("declining a request removes it and does not make a friend", async () => {
  const { root, fake } = await openFriends({ incoming: [ASKED_ME] });
  await goToTab(root, "Requests");
  button(root, "Decline").dispatch("click");
  await flush();
  assert.deepEqual(fake.log.filter((c) => c[0] === "decline"), [["decline", "r1"]]);
  assert.match(textOf(root), /No friend requests/);
  assert.equal(fake.state.friends.length, 0);
});

test("a request the player sent can be cancelled", async () => {
  const { root, fake } = await openFriends({ outgoing: [I_ASKED] });
  await goToTab(root, "Requests");
  assert.match(textOf(root), /Requests you sent/);
  assert.match(textOf(root), /Dee/);
  button(root, "Cancel request").dispatch("click");
  await flush();
  assert.deepEqual(fake.log.filter((c) => c[0] === "cancel"), [["cancel", "r2"]]);
  assert.match(textOf(root), /No friend requests/);
});

test("removing a friend needs a second click", async () => {
  const { root, fake } = await openFriends({ friends: [ANA, BEA] });
  button(root, "Remove").dispatch("click");
  await flush();
  assert.equal(fake.log.filter((c) => c[0] === "remove").length, 0, "the first click only asks");
  assert.ok(button(root, "Click again to remove"));

  button(root, "Click again to remove").dispatch("click");
  await flush();
  assert.deepEqual(fake.log.filter((c) => c[0] === "remove"), [["remove", "u1"]]);
  assert.match(textOf(root), /Ana was removed from your friends/);
  assert.doesNotMatch(textOf(root), /Friends since.*Friends since/s, "only Bea is left");
});

test("a friend code is checked on the device before anything is sent", async () => {
  const { root, fake } = await openFriends();
  await goToTab(root, "Add friend");

  await submitCode(root);
  assert.match(textOf(root), /Type your friend's code/);

  typeCode(root, "hello");
  await submitCode(root);
  assert.match(textOf(root), /does not look like a friend code/);
  typeCode(root, "ABCD-0O1I"); // letters that never appear in codes
  await submitCode(root);
  assert.match(textOf(root), /does not look like a friend code/);
  assert.equal(fake.log.filter((c) => c[0] === "send").length, 0);
});

test("a typed code is cleaned up, sent, and the box is cleared when it works", async () => {
  const { root, fake } = await openFriends();
  await goToTab(root, "Add friend");
  typeCode(root, "  abcd 2345 ");
  await submitCode(root);

  assert.deepEqual(fake.log.filter((c) => c[0] === "send"), [["send", "ABCD-2345"]]);
  assert.match(textOf(root), /Friend request sent to Dee/);
  assert.equal(byLabel(root, "Friend code").value, "", "the box is empty again");
});

test("the store's reason for refusing a request is shown under the code box", async () => {
  const sendError = { code: "FRIEND_CODE_NOT_FOUND", message: "No player has that friend code." };
  const { root } = await openFriends({ sendError });
  await goToTab(root, "Add friend");
  typeCode(root, "ABCD-2345");
  await submitCode(root);
  assert.match(textOf(root), /No player has that friend code/);
  assert.equal(byLabel(root, "Friend code").value, "ABCD-2345", "what was typed is kept so it can be fixed");
});

test("getting a new friend code asks twice, then shows the new code", async () => {
  const { root, fake } = await openFriends();
  await goToTab(root, "Add friend");
  button(root, "Get a new code").dispatch("click");
  await flush();
  assert.equal(fake.log.filter((c) => c[0] === "reset").length, 0, "the first click only asks");

  button(root, "Click again to get a new code").dispatch("click");
  await flush();
  assert.equal(fake.log.filter((c) => c[0] === "reset").length, 1);
  assert.match(textOf(root), /NEW2-CODE/);
  assert.doesNotMatch(textOf(root), /K7QM-2XWD/);
});

test("when friends cannot load the page says why and offers to try again", async () => {
  const down = () => Promise.resolve({ ok: false, error: { code: "NETWORK_ERROR", message: "Cannot reach the store: refused" } });
  const { root } = await launch([], { ...LOGGED_IN, ...friendsStore().overrides, friends: down });
  nav(root, "Friends").dispatch("click");
  await flush();
  assert.match(textOf(root), /Could not load your friends/);
  assert.match(textOf(root), /Cannot reach the store/);
  assert.ok(button(root, "Try again"));
});

