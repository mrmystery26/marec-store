# MAREC Store launcher (Windows)

The desktop app players use to install and start games from MAREC STORE.

**Status: prototype.** The launcher's core (verifying, downloading, resuming, installing, starting
a game) is covered by automated tests that run on every push. The window (the store interface) was
tested against a fake page and in headless Chromium with a stand-in for the launcher bridge; it has
**not been opened in a real Electron yet**. The first real test is installing the build from GitHub
Actions on your Windows PC.

## What it does

- **Continue with Google**, or log in / create an account with email and password (the session is
  kept encrypted with your Windows account). Google opens in your normal browser, never inside
  the launcher, and the browser hands you back to the launcher through a `marecstore://` link.
  The installed launcher registers that link; the portable `MarecStore.exe` registers it the first
  time it runs. Confirm your email with a code when the store asks for it.
- Store: home with a featured carousel, browse and search games, filter by genre, price and
  release date, game pages with system requirements. Free games can be added to your library.
- Downloads: progress, speed and time left, a queue (one game at a time by default), pause and
  resume, and a history of installs on this PC.
- Wishlist, notifications and "recently played" are kept on this PC only.
- Publisher portal: create a developer account, then create **free demos**, fill in their
  details, **upload the exported Windows game from a folder** (hashed and sent as a stream, with
  progress and cancel), download the game's filled-in `marec_config.gd` for the Godot SDK, and send
  the demo for review. Studios must be verified by MAREC before uploading.
- Review (staff only): verify new studios, move submitted demos through review and publish them,
  and suspend or remove live ones. Shown only to accounts with a staff role.
- Library: shows the games you own, with Install, Update, Play, Verify files and Uninstall.
- Install: fetches a signed install plan, **verifies the manifest signature**, then downloads each
  file in 8 MB chunks, checking every chunk's SHA-256. If the connection drops or you cancel, the
  next try continues from the last good chunk. Nothing is switched on until every file has
  been verified, so a failed install never leaves a half-installed game.
- Play: asks the backend for a short-lived launch token, starts the game, and hands it the token
  over a private loopback connection with a one-time secret (never on the command line).

## What it does not do yet

- Offline play (leases), automatic updates of the launcher, incremental game updates (an update
  downloads the whole game again), speed limits, starting with Windows.
- Cover images, screenshots and trailers for games: a game without a cover shows its initials on a
  coloured tile.
- Paid purchases. "Buy now" explains that payments are not open and changes nothing.
- Things the store does not send yet, so the window shows nothing for them: artwork,
  screenshots and trailers, discounts, popularity, upcoming releases, USD prices, regional
  availability. Windows desktop notifications do not exist yet. Friends work with friend codes and requests, but there is no online status or "now playing".
- The installer is **not code-signed**, so Windows SmartScreen will warn you ("More info", "Run
  anyway"). Signing needs a paid certificate.
- Release builds must ship **pinned signing keys** in `launcher.config.json`
  (`pinnedManifestKeys`). With none, the launcher trusts the key the server publishes, which is only
  acceptable for development.
- It is an Electron app, so the installer is around 100 MB (a Tauri launcher would be about 10 MB).
  This was chosen so the logic could be tested without a Rust toolchain; see `docs/DECISIONS.md`.

## Getting the installer

You never build anything yourself. GitHub builds it on a Windows machine (workflow
`.github/workflows/build.yml`, called **Build apps** in the Actions tab; see `docs/GITHUB_ACTIONS.md`).

- **Every push to `main`** builds the installer. Open the run in the **Actions** tab, scroll to
  **Artifacts** at the bottom and download `MarecStore-Windows-<version>-build<number>`.
  Unzip it: `MarecStore-Setup.exe` is the installer, `MarecStore.exe` is a single-file version that
  runs without installing, `MarecStore-Windows.zip` is the unpacked app with its supporting files,
  and `SHA256SUMS.txt` lets you check the downloads. Artifacts are kept for
  30 days.
- **A version tag** (`v0.2.0`, `v1.0.0`, or `v1.0.0-beta.1` for a pre-release) builds the same files
  and attaches them to a **GitHub Release** with that name. Create the tag by publishing a new
  release on GitHub (Releases, then Draft a new release, then type the tag name and publish). The
  installer carries the tag's version, so `package.json` does not need editing. Releases need the
  tests to pass; ordinary pushes still build when a test fails, and show a warning.
- **On demand:** Actions, Build apps, Run workflow.
- If the build fails, the run shows which step failed, and a `MarecStore-Windows-build-logs-<number>`
  artifact keeps the build log.

No secrets are needed for Windows. The version comes from the `VERSION` file at the repository root
(or the tag), and the default store address from the repository variable `MAREC_API_BASE_URL`.

**Lockfile.** Package versions are only pinned once `apps/launcher/package-lock.json` exists. It does
not yet. Run the workflow once with **commit_lockfile** ticked and it creates and commits the file;
from then on builds use `npm ci` and get exactly the same packages every time.

## Trying it end to end

You need the backend reachable from your Windows PC.

1. **Backend:** in your Codespace run the stack as usual, but first set
   `PUBLIC_API_BASE_URL` to the address of the forwarded port 8000 (for example
   `https://NAME-8000.app.github.dev`) and set that port's visibility to **Public** in the Ports tab.
   Create a store account at `/docs` (`POST /v1/auth/register`).
2. **A game to upload to:** in the launcher open the **Publisher portal**, create a developer
   account (your email must be verified), and wait for the studio to be verified (the store owner
   does this in the **Review** screen, or with `python -m app.cli verify-studio --slug ...`). Then
   create a demo there.
3. **Upload a build** in the Publisher portal under **Builds**: pick the folder with your game's
   Windows export (for Godot: the `.exe` and `.pck`), a version, and press Upload. (The command-line
   tool in `tools/upload-build` still works if you prefer it.)
4. **Publish it:** submit the demo from the Publisher portal, then approve and publish it from the
   **Review** screen.
5. **Add it to your library:** open its page in the launcher's Store and choose **Add to library**
   (free games only), or in `/docs` log in and `POST /v1/me/library/GAME_ID`.
6. **Launcher:** open it, go to **Settings**, set the store server to the same address, save, log
   in, then Install and Play. A game that does not use the MAREC SDK yet will start, and the
   launcher will say it never asked for its launch token. That is expected until the SDK exists.

## For developers

```
cd apps/launcher
npm test            # all tests (needs only Node 22, no install)
npm install         # then:
npm start           # run the launcher
npm run dist        # build the Windows installer into dist/
```

Layout: `src/core` has all the logic and no Electron code; `src/main` is the Electron shell
(window, secure storage, the bridge); `src/renderer` is the window page. The window cannot touch
files or the network: it can only call the few actions in `src/main/preload.js`.

### The window (`src/renderer`)

Plain JavaScript and CSS, no build step and no dependencies (the page's security policy only
allows scripts and styles from its own folder). Each file in `js/` works both as a script tag and
as a Node module, which is how the tests load them.

```
css/            tokens (colours, fonts), layout, components, views
js/format.js        sizes, speeds, kwacha prices
js/data.js          THE DATA LAYER: the only place views get games from
js/google-signin.js  Sign in with Google: PKCE, the marecstore:// callback, who may be opened
js/downloads.js     queue, pause/resume, speed and time left
js/local-store.js   wishlist, notifications, history, preferences (this PC only)
js/components.js    artwork, cards, shelves, form controls, dialogs
js/views-*.js       home, store, game page, library, downloads, account, settings, publisher, review
app.js              state, routing, sidebar and top bar, and the actions views can trigger
```

**Real or not.** Everything on screen comes from the real store API through the bridge, or is kept
on this PC (wishlist, notifications, history). Nothing is made up: an empty store is shown as
empty. To connect a feature later, fill in the matching field in `js/data.js` (`fromApi`); the
views already read it. `capabilities()` there is the list of
what the store can do today.

**Artwork.** Games without artwork show their initials on a coloured tile from `components.artwork`.
When the API starts sending `artwork.cover` / `artwork.hero`, add the image host to `img-src` in
`src/renderer/index.html`, otherwise the window's security policy will block it (the same goes for
`media-src` if trailers are added).

**Fonts.** Titles use Bahnschrift and text uses Segoe UI, both included with Windows 10 and 11,
so nothing is downloaded.

Commit the `package-lock.json` that `npm install` creates, so builds use the same versions.
