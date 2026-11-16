#!/usr/bin/env node
"use strict";
// Copies the shared store interface into the Android app, so Windows and Android use the same code.
//   apps/launcher/src/renderer/**         -> apps/android/app/src/main/assets/
//   apps/launcher/src/core/api.js (client) -> assets/js/marec-api.js  (wrapped for the browser)
// The output folder is generated on every build and is not committed.
const fs = require("node:fs");
const path = require("node:path");

const MARKER = "<!-- android-api -->";

function prepareAssets({ rendererDir, apiClient, outDir }) {
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.cpSync(rendererDir, outDir, { recursive: true });

  const source = fs.readFileSync(apiClient, "utf8");
  const wrapped = `"use strict";
// Generated from apps/launcher/src/core/api.js by scripts/android/prepare-assets.js. Do not edit.
(function (host) {
  const module = { exports: {} };
  ${source.replace(/^"use strict";\s*/, "")}
  (host.MarecUI = host.MarecUI || {}).api = module.exports;
})(window);
`;
  fs.writeFileSync(path.join(outDir, "js", "marec-api.js"), wrapped);

  const indexPath = path.join(outDir, "index.html");
  const html = fs.readFileSync(indexPath, "utf8");
  if (!html.includes(MARKER)) throw new Error(`index.html has no ${MARKER} marker, so the API client cannot be added.`);
  fs.writeFileSync(indexPath, html.replace(MARKER, '<script src="js/marec-api.js"></script>'));
  return { files: fs.readdirSync(outDir, { recursive: true }).length };
}

if (require.main === module) {
  const root = path.resolve(__dirname, "..", "..");
  const result = prepareAssets({
    rendererDir: path.join(root, "apps/launcher/src/renderer"),
    apiClient: path.join(root, "apps/launcher/src/core/api.js"),
    outDir: path.join(root, "apps/android/app/src/main/assets"),
  });
  console.log(`Android assets ready (${result.files} entries).`);
}
module.exports = { prepareAssets };
