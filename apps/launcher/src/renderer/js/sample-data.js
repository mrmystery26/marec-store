"use strict";
// SAMPLE STORE: fictional games used only when "Preview with sample games" is switched on.
// None of these exist. They have no builds, so they can never be bought, installed or played.
// Every sample game carries `sample: true`, and the interface labels it as a sample everywhere.
(function (host) {
  const CATEGORIES = [
    ["action", "Action"], ["adventure", "Adventure"], ["fps", "FPS"], ["rpg", "RPG"],
    ["simulation", "Simulation"], ["strategy", "Strategy"], ["racing", "Racing"],
    ["horror", "Horror"], ["indie", "Indie"], ["sports", "Sports"],
  ].map(([slug, name]) => ({ id: `sample-cat-${slug}`, slug, name }));

  const REQUIREMENTS = {
    light: [
      { tier: "minimum", os: "Windows 10 64-bit", cpu: "Intel Core i3-6100 or equivalent", ram_mb: 4096, gpu: "Intel HD 530 or equivalent", storage_mb: 3000 },
      { tier: "recommended", os: "Windows 10 64-bit", cpu: "Intel Core i5-8400 or equivalent", ram_mb: 8192, gpu: "GTX 1050 or equivalent", storage_mb: 3000 },
    ],
    heavy: [
      { tier: "minimum", os: "Windows 10 64-bit", cpu: "Intel Core i5-7400 or equivalent", ram_mb: 8192, gpu: "GTX 960 or equivalent", storage_mb: 18000 },
      { tier: "recommended", os: "Windows 10/11 64-bit", cpu: "Intel Core i7-9700 or equivalent", ram_mb: 16384, gpu: "GTX 1660 or equivalent", storage_mb: 18000 },
    ],
  };

  const GB = 1024 ** 3;
  // [slug, title, studio, categories, summary, priceMWK, originalMWK, usdCents, daysFromNow, sizeGB, popularity, flags]
  const ROWS = [
    ["dust-meridian", "Dust Meridian", "Hollow Mile Games", ["fps", "action"], "Squad tactics across a dried-out salt basin where every sightline matters.", 12500, 0, 899, -20, 14.2, 98, { featured: true, req: "heavy", age: "16+" }],
    ["kalinde-rally", "Kalinde Rally", "Lakeshore Interactive", ["racing"], "Time-trial rally on gravel roads from the lakeshore to the highlands.", 8000, 12000, 599, -45, 5.4, 91, { featured: true, req: "light", age: "3+", regions: ["MW", "ZM", "MZ", "TZ"], platforms: ["windows", "android"] }],
    ["lake-of-embers", "Lake of Embers", "Tinderbox Studio", ["adventure", "rpg"], "Row between burning islands and decide who gets saved.", 6500, 0, 499, -9, 3.1, 84, { featured: true, req: "light", age: "12+" }],
    ["nsima-tycoon", "Nsima Tycoon", "Chikondi Games", ["simulation", "indie"], "Build a village kitchen into a market-day legend.", 0, 0, 0, -60, 0.9, 88, { req: "light", age: "3+" }],
    ["chitenje-wars", "Chitenje Wars", "Kwacha Forge", ["strategy"], "Turn-based territory control, fought with trade routes instead of tanks.", 9500, 0, 699, -100, 2.2, 63, { req: "light", age: "7+" }],
    ["moonlit-hollow", "Moonlit Hollow", "Grey Ember", ["horror", "indie"], "A night shift in a village clinic that should have closed years ago.", 5500, 7500, 399, -30, 4.8, 79, { featured: true, req: "light", age: "18+" }],
    ["mzuzu-striker", "Mzuzu Striker", "Northern Goal Labs", ["sports"], "Fast five-a-side football with street rules and local rivalries.", 4000, 0, 299, -75, 1.7, 71, { req: "light", age: "3+", platforms: ["android"] }],
    ["ashfall-chronicles", "Ashfall Chronicles", "Ninefold Works", ["rpg", "adventure"], "A long road, a broken guild and a volcano that keeps its own calendar.", 15000, 0, 1199, -12, 17.6, 86, { featured: true, req: "heavy", age: "12+" }],
    ["tin-roof-drift", "Tin Roof Drift", "Lakeshore Interactive", ["racing", "indie"], "Drift minibuses through market streets. Mind the goats.", 0, 0, 0, -150, 0.6, 58, { req: "light", age: "3+" }],
    ["blue-hour-station", "Blue Hour Station", "Quiet Signal", ["indie", "adventure"], "A short, tender puzzle game about the last train of the evening.", 3500, 5000, 249, -200, 0.7, 54, { req: "light", age: "3+" }],
    ["rift-marshal", "Rift Marshal", "Hollow Mile Games", ["action", "fps"], "Close the rifts before the town does. Co-op arena shooter.", 11000, 0, 799, 38, 9.8, 77, { req: "heavy", age: "16+" }],
    ["baobab-defenders", "Baobab Defenders", "Kwacha Forge", ["strategy", "indie"], "Tower defence where the tower grows, and so do its problems.", 2500, 0, 199, 62, 1.1, 49, { req: "light", age: "7+" }],
    ["night-market", "Night Market", "Chikondi Games", ["adventure", "indie"], "Haggle, trade and gossip through one long evening in Lilongwe.", 5000, 0, 399, 95, 2.4, 66, { req: "light", age: "12+" }],
    ["harbour-9", "Harbour 9", "Grey Ember", ["horror", "action"], "Dockside survival horror with a shipping container for every secret.", 9000, 13000, 649, -6, 7.3, 82, { req: "heavy", age: "18+" }],
  ];

  const DAY = 86_400_000;

  function buildSampleGames(now = Date.now()) {
    return ROWS.map(([slug, title, studio, cats, summary, mwk, originalMwk, usd, days, gb, popularity, flags], index) => {
      const releasedMs = now + days * DAY;
      const free = mwk === 0;
      return {
        id: `sample-${slug}`,
        slug,
        title,
        summary,
        description:
          `${summary} ${title} is a fictional game used to preview the Marec Store design. ` +
          "Its description, screenshots and trailer are placeholders that the real store will replace.",
        studio: { name: studio, slug: studio.toLowerCase().replace(/[^a-z0-9]+/g, "-") },
        publisher: studio,
        categories: cats.map((c) => CATEGORIES.find((x) => x.slug === c)),
        isFree: free,
        price: { minor: mwk * 100, currency: "MWK", original_minor: originalMwk ? originalMwk * 100 : null },
        prices: free ? null : { USD: { minor: usd, original_minor: originalMwk ? Math.round(usd * (originalMwk / mwk)) : null } },
        ageRating: flags.age,
        releasedAt: new Date(releasedMs).toISOString(),
        upcoming: days > 0,
        requirements: REQUIREMENTS[flags.req],
        offlineDays: 7,
        platforms: flags.platforms || ["windows"],
        sizeBytes: Math.round(gb * GB),
        regions: flags.regions || null,
        popularity,
        featured: Boolean(flags.featured),
        media: [
          { type: "video", label: "Trailer" },
          { type: "image", label: "Screenshot 1" }, { type: "image", label: "Screenshot 2" },
          { type: "image", label: "Screenshot 3" }, { type: "image", label: "Screenshot 4" },
        ],
        artwork: null,
        sample: true,
        order: index,
      };
    });
  }

  const SAMPLE_FRIENDS = [
    { name: "Sample Friend A", status: "Online", playing: "Dust Meridian" },
    { name: "Sample Friend B", status: "Online", playing: "" },
    { name: "Sample Friend C", status: "Offline", playing: "" },
  ];

  const api = { CATEGORIES, buildSampleGames, SAMPLE_FRIENDS };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else (host.MarecUI = host.MarecUI || {})["sample-data"] = api;
})(typeof window !== "undefined" ? window : globalThis);
