"use strict";
// Path rules for files that come from a build manifest. These mirror the server's rules, and are
// enforced again here because the launcher is what actually writes onto the player's disk.
const path = require("node:path");

const BLOCKED_EXTENSIONS = new Set([
  ".bat", ".cmd", ".ps1", ".vbs", ".vbe", ".wsf", ".hta", ".scr", ".msi", ".lnk", ".com", ".pif",
  ".reg", ".jar",
]);
const RESERVED = new Set(["con", "prn", "aux", "nul"]);
for (let n = 1; n <= 9; n++) {
  RESERVED.add(`com${n}`);
  RESERVED.add(`lpt${n}`);
}
const FORBIDDEN_CHARS = /[\x00-\x1f\x7f\\:*?"<>|]/;

/** Returns an error message, or null if the relative path is safe to write on Windows. */
function validateRelativePath(p) {
  if (typeof p !== "string" || p.length === 0 || p.length > 240) {
    return "Path must be 1 to 240 characters.";
  }
  if (FORBIDDEN_CHARS.test(p)) return "Path contains a forbidden character.";
  if (p.startsWith("/")) return "Path must be relative.";
  for (const segment of p.split("/")) {
    if (segment === "" || segment === "." || segment === "..") {
      return "Path contains an empty, . or .. segment.";
    }
    if (segment.endsWith(".") || segment.endsWith(" ") || segment.startsWith(" ")) {
      return "Path segments cannot start with a space or end with a dot or space.";
    }
    if (RESERVED.has(segment.split(".")[0].toLowerCase())) return "Reserved Windows name.";
  }
  const dot = p.lastIndexOf(".");
  if (dot > p.lastIndexOf("/") && BLOCKED_EXTENSIONS.has(p.slice(dot).toLowerCase())) {
    return "This file type is not allowed in game builds.";
  }
  return null;
}

/** Joins a manifest path onto `root`, throwing if the result could land outside it. */
function safeJoin(root, rel) {
  const problem = validateRelativePath(rel);
  if (problem) throw new Error(`Unsafe path "${rel}": ${problem}`);
  const base = path.resolve(root);
  const full = path.resolve(base, ...rel.split("/"));
  const relative = path.relative(base, full);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Unsafe path "${rel}": escapes the install folder.`);
  }
  return full;
}

module.exports = { validateRelativePath, safeJoin };
