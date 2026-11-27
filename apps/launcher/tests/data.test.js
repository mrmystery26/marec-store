"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createData, fromApi } = require("../src/renderer/js/data");
const { createLocalStore } = require("../src/renderer/js/local-store");

const ok = (data) => Promise.resolve({ ok: true, data });
const card = (slug, over = {}) => ({
  id: `id-${slug}`, slug, title: slug, summary: "s", price_minor: 100000, currency: "MWK", is_free: false, age_rating: "3+",
  studio: { name: "Studio", slug: "studio" }, categories: [{ slug: "racing", name: "Racing" }], published_at: "2026-10-01T00:00:00Z", ...over,
});

function setup({ games = [] } = {}) {
  const calls = [];
  const local = createLocalStore(null);
  const api = {
    games: (q) => (calls.push(q), ok({ items: games, total: games.length, limit: q.limit, offset: q.offset })),
    game: (slug) => ok(card(slug, { description: "d", offline_days: 7, requirements: [] })),
    categories: () => ok([{ slug: "racing", name: "Racing" }]),
  };
  return { data: createData({ api, local, now: () => Date.parse("2026-11-15T00:00:00Z") }), calls, local };
}

test("store games from the API become the shape the views use", () => {
  const game = fromApi(card("a", { is_free: true, price_minor: 0 }), Date.parse("2026-11-15"));
  assert.equal(game.isFree, true);
  assert.equal(game.price.original_minor, null); // the store has no discounts yet
  assert.equal(game.isDemo, false);
  assert.equal(game.upcoming, false);
});

test("a game the store marks as a demo is a demo", () => {
  assert.equal(fromApi(card("d", { release_kind: "demo", is_free: true, price_minor: 0 })).isDemo, true);
  assert.equal(fromApi(card("f", { release_kind: "full" })).isDemo, false);
});

test("live search passes supported filters to the API and does the rest itself", async () => {
  const { data, calls } = setup({ games: [card("a"), card("b", { price_minor: 0, is_free: true })] });
  const page = await data.search({ q: "a", category: "racing", tab: "free", sort: "popular", offset: 0, limit: 24 });
  assert.equal(calls[0].free, true);
  assert.equal(calls[0].sort, "newest"); // popularity is not available from the store
  assert.deepEqual(page.items.map((g) => g.slug), ["b"]);
});

test("discounted and upcoming browsing load the catalogue and say so honestly when empty", async () => {
  const { data, calls } = setup({ games: [card("a")] });
  const sale = await data.search({ tab: "discounted" });
  assert.equal(sale.total, 0);
  assert.equal(calls[0].limit, 50);
  assert.equal(data.capabilities().discounts, false);
});

test("home leaves out shelves the store cannot fill", async () => {
  const { data } = setup({ games: [card("a"), card("b")] });
  const home = await data.home();
  assert.equal(home.trending.length, 0);
  assert.equal(home.offers.length, 0);
  assert.equal(home.discover, null);
  assert.equal(home.featured.length, 2);
});

test("there are no made-up games: an empty store is empty", async () => {
  const { data } = setup({ games: [] });
  assert.equal(data.mode, undefined, "there is no sample mode to switch to");
  const all = await data.search({ limit: 50 });
  assert.equal(all.total, 0);
  const home = await data.home();
  assert.equal(home.featured.length, 0);
  assert.equal(home.recent.length, 0);
});

test("errors from the launcher become thrown errors with their code", async () => {
  const local = createLocalStore(null);
  const api = { categories: () => Promise.resolve({ ok: false, error: { code: "NETWORK_ERROR", message: "down" } }) };
  await assert.rejects(createData({ api, local }).categories(), { code: "NETWORK_ERROR", message: "down" });
});
