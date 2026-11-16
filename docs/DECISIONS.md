# Decisions log

Short record of confirmed decisions. Add a line whenever a decision changes.

| Date | Decision |
|---|---|
| 2026-10-24 | Modular monolith: FastAPI + PostgreSQL. No microservices at prototype stage. |
| 2026-10-24 | Cloudflare R2 is the first object-storage candidate (S3-compatible). Confirmed by owner. |
| 2026-10-24 | PayChangu is the first payment-gateway candidate, behind a provider interface. Sandbox only until the pre-payment gate in the blueprint is cleared. Confirmed by owner. |
| 2026-10-24 | Games target Godot 4.7.2 for now. The MAREC Game SDK is NOT built first; it comes at milestone M6, after the launcher prototype. |
| 2026-10-24 | A Windows PC is available (at least occasionally) for launcher testing. |
| 2026-10-24 | Launcher framework: Tauri 2 with Electron as fallback, decided after a one-week spike (milestone M5). |
| 2026-10-24 | M0 backend skeleton passed CI on GitHub. Next: roles + audit log (M1), then game catalog. |
| 2026-10-24 | Roles are a fixed list in code; permissions live in code; assignments in `user_roles`. Staff are created only through the CLI, never the public API. |
| 2026-10-25 | Prices are stored in tambala (BIGINT); NULL means not set yet and blocks submission. Currency is MWK. |
| 2026-10-25 | Game states follow the blueprint. Rejecting a submission is `request_changes`; permanent takedown is `remove`. A reason is mandatory for request_changes, suspend, reinstate and remove. |
| 2026-10-25 | Public store lists use limit/offset paging (catalog is small, and sorting by price needs it). Audit log keeps cursor paging. |
| 2026-10-25 | Studios can be created by any user (max 3 owned) but only verified studios can submit games or appear in the store. |
| 2026-10-25 | Demo data comes from `python -m app.seed` (clearly labelled placeholders, never in production). The demo user cannot log in. |
| 2026-10-25 | Build files are verified by SHA-256 and 8 MB chunk hashes; the manifest is signed with Ed25519 (key from MANIFEST_SIGNING_KEY). Public keys are served at /v1/launch/public-keys. |
| 2026-10-25 | A game needs a ready build to be submitted. At most 3 non-revoked builds per game and platform. Max 5000 files, 5 GB per file, 10 GB per build. |
| 2026-10-25 | Storage is behind an interface: local disk for development and tests, S3-compatible (R2) for staging and production. Production refuses local storage. |
| 2026-10-25 | Malware scanning is deferred. Builds are labelled `not_scanned` until a scanner is connected. |
| 2026-10-26 | Ownership is one `game_entitlements` row per user and game, written only by the backend. Free games are added with one tap; paid games will be added by completed orders. |
| 2026-10-26 | Owners can install only while the game is published and its studio is verified. Suspended or removed games become unavailable to existing owners until reinstated. |
| 2026-10-26 | Install plan returns the exact signed manifest bytes (base64) plus 6-hour download links with Range support. Local development links are scoped to get or put and signed by the API. |
| 2026-10-26 | Launch tokens and offline leases are RS256 JWTs (RSA 2048+), not Ed25519, because Godot's built-in Crypto can verify RSA but not Ed25519. Manifests stay Ed25519 for the launcher. |
| 2026-10-26 | Online launch tokens last 120 seconds and are single use (redeemed once). Leases last the game's `offline_days` (0 to 30, default 7) and are bound to one PC and one build. |
| 2026-10-26 | A PC is identified by a random secret the launcher keeps; the backend stores only its SHA-256. Max 5 active PCs per account; removing a PC cancels its unused tokens and leases. |
| 2026-10-26 | Studio members can get `dev` tokens for their own ready builds without owning the game; these are audit-logged. There is no switch that skips verification. |
| 2026-10-27 | Launcher framework: Electron, not Tauri, for the prototype. This is the fallback the blueprint allowed. Reason: no Rust toolchain was available to compile or test, while the launcher's logic could be written in plain Node and tested for real (58 tests). Cost: an installer of about 100 MB instead of about 10 MB. Revisit before launch; the core logic and its tests can be ported. |
| 2026-10-27 | The launcher verifies each manifest's Ed25519 signature before trusting anything in it, checks every path again before writing, and installs through a staging folder swapped in only when all files verify. |
| 2026-10-27 | Release launchers must ship pinned manifest keys (`pinnedManifestKeys`). With none the launcher trusts the server's published key, which is for development only. Changing the server in Settings clears the saved login. |
| 2026-10-27 | Builds record an `entry_point` (the .exe to start), inferred when there is exactly one top-level .exe. |
| 2026-10-28 | Godot SDK is a GDScript addon (protection level 1) targeting Godot 4.7.2. Its settings are script constants (`marec_config.gd`) because scripts are always exported, unlike .cfg or .pem files. The decision logic is isolated in `marec_verifier.gd` and specified by shared test vectors checked in both Node and Godot. |
| 2026-10-28 | The launcher hands the token to the game over loopback TCP with a one-time secret (`MAREC_LAUNCH_ADDR`, `MAREC_LAUNCH_SECRET`), not a named pipe, because Godot cannot reliably open Windows pipes and does support TCP. A connection without the secret is dropped and does not use up the delivery. |
| 2026-10-28 | The SDK skips the check only when `OS.has_feature("editor")` is true (running from the Godot editor). There is no command-line or environment switch that disables it in an exported game. |
| 2026-11-15 | The store interface lives in the launcher window for now (there is no website yet). It stays plain JavaScript with no build step, because the window's security policy only allows scripts and styles from its own folder and there is no toolchain to bundle with. Files load as script tags in the app and as Node modules in tests. |
| 2026-11-15 | New bridge calls: public catalog (list, game, categories), register, add a free game to the library, and read or create studios and list their games. The window can only send whitelisted store filters; nothing else is exposed. |
| 2026-11-15 | Features the backend lacks are either kept on this PC (wishlist, notifications, download history, recently played) or shown from sample data behind one switch in Settings. Sample games are labelled everywhere and can never be bought, added or installed. Settings the launcher cannot honour yet (speed limit, start with Windows) are shown disabled with the reason. |
| 2026-11-15 | "Buy now" for a paid game opens a dialog saying payments are not open. It makes no request and changes nothing. Free games are added for real. |
| 2026-11-15 | Download queue lives in the window: one game at a time by default (kind to slow links), up to three. Pause stops the download and keeps the verified chunks; Resume continues from them. Cancel does the same stop and forgets the entry, since the core cannot discard partial data yet. |
| 2026-11-15 | Prices are shown in MWK from tambala. USD is shown only for games where the store sends a USD price; the window never converts currencies itself. |
| 2026-11-15 | Installers are built by `.github/workflows/build.yml` (job `windows`) on a Windows runner: every push to `main` gives a downloadable artifact, and a `vX.Y.Z` tag also attaches the files to a GitHub Release (the tag's version is stamped into the installer). The launcher stays Electron with electron-builder (no Tauri migration, no Rust). Output is `MarecStore-Setup.exe` (NSIS installer) and `MarecStore.exe` (portable single file), checked for size and Windows header before upload. The installer job moved out of `launcher.yml`, which now only runs tests. |
| 2026-11-15 | Without a lockfile the build uses `npm install` and warns. A manual "commit_lockfile" run creates `package-lock.json`; after that builds use `npm ci`. Releases require passing tests; ordinary pushes still build when tests fail, so a Windows-only test failure cannot block you. |
| 2026-11-16 | The Android app is a thin Java shell (WebView) hosting the same store interface as the Windows launcher, plus the launcher's own API client with native HTTP and encrypted token storage. This was chosen over a second app or a framework because the interface already talks to one `window.marec` bridge, so Android only needed a second implementation of that bridge. Gradle uses Groovy files and Java (no Kotlin plugin) to keep the tool versions to a minimum: AGP 8.5.2, Gradle 8.7, JDK 17, compile and target SDK 34, minimum Android 7.0. |
| 2026-11-16 | A game only offers Install and Play on a device that can run it. The store only has Windows builds, so a game with no platform list is a Windows game, and phones show it as one with no install button. The optional `android_build` field on a game (url, sha256, version) is how Android games will be delivered once the backend supports them; until then the Android install path exists but has nothing to install. |
| 2026-11-16 | One `VERSION` file decides the version for both apps (a version tag overrides it). The GitHub run number is the build number and the Android `versionCode`. Debug Android builds get the id suffix `.debug`. Release signing reads four GitHub secrets, builds release files only when they exist (always on tags and when asked for), and fails with the missing names otherwise. |
| 2026-11-16 | Wishlists, reviews, screenshots and payments are not synced or shown between apps because the backend has none of them. They stay local or placeholder until the backend does. |

