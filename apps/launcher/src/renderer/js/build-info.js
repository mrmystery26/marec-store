"use strict";
// Version details of this build. The build pipeline overwrites this file (it is not committed with
// real values), so every installer and APK knows its version, build number, commit and date.
(function (host) {
  const info = { version: "dev", build: 0, commit: "local", date: "" };
  if (typeof module !== "undefined" && module.exports) module.exports = info;
  else (host.MarecUI = host.MarecUI || {})["build-info"] = info;
})(typeof window !== "undefined" ? window : globalThis);
