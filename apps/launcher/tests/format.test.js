"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const f = require("../src/renderer/js/format");

test("sizes, speeds and time left read naturally", () => {
  assert.equal(f.formatBytes(10), "10 B");
  assert.equal(f.formatBytes(1536), "1.5 KB");
  assert.equal(f.formatSpeed(2 * 1024 * 1024), "2.0 MB/s");
  assert.equal(f.formatEta(0), "");
  assert.equal(f.formatEta(30), "less than a minute left");
  assert.equal(f.formatEta(12 * 60), "12 min left");
  assert.equal(f.formatEta(65 * 60), "1 h 5 min left");
});

test("prices come from tambala and never guess a conversion", () => {
  const paid = { isFree: false, price: { minor: 450000, currency: "MWK", original_minor: null } };
  assert.equal(f.priceView(paid).label, "MWK 4,500");
  assert.equal(f.priceView({ isFree: true, price: {} }).label, "Free");
  assert.equal(f.priceView({ isFree: false, price: { minor: null } }).known, false);

  // USD is used only when the store sent a USD price for that game
  assert.equal(f.priceView(paid, "USD").label, "MWK 4,500");
  assert.equal(f.priceView({ ...paid, prices: { USD: { minor: 599 } } }, "USD").label, "USD 5.99");
});

test("discounts show the original price and a rounded percentage", () => {
  const sale = f.priceView({ isFree: false, price: { minor: 350000, original_minor: 500000, currency: "MWK" } });
  assert.deepEqual([sale.discount, sale.original, sale.label], [30, "MWK 5,000", "MWK 3,500"]);
  assert.equal(f.discountPercent(500000, 500000), 0);
  assert.equal(f.discountPercent(600000, 500000), 0);
});
