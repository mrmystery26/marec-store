# MAREC Store for Windows

The Windows app is the **launcher** in `apps/launcher`: an Electron app that shows the store, downloads and checks games,
installs them and starts them. It is built by GitHub, so you do not need to install anything.

## What you get

| File | What it is |
| --- | --- |
| `MarecStore-Setup.exe` | The installer. Use this one. It lets you choose the folder and adds a Start menu shortcut. |
| `MarecStore.exe` | One file that runs without installing (it unpacks itself each start, so it opens a little slower). |
| `MarecStore-Windows.zip` | The unpacked app with every supporting file (`resources/app.asar`, the Electron runtime and so on). |
| `SHA256SUMS.txt` | Checksums, so you can check a download is not damaged. |

Windows may show "Windows protected your PC" because the installer is not code-signed yet. Choose **More info**, then
**Run anyway**. Code signing needs a certificate that costs money, so it is not set up.

## Get it

See `GITHUB_ACTIONS.md`: push to `main`, open the finished **Build apps** run, download `MarecStore-Windows-...`.

## What the build checks

- the tests pass (they must for a version tag; on other pushes a failure is reported but does not stop the build)
- `MarecStore-Setup.exe` and `MarecStore.exe` exist, are real Windows programs and are not suspiciously small
- the zip really contains the app, its resources and the Electron runtime
- the app is started once and must still be running after 12 seconds (reported as a warning if it is not, because a build
  machine has no screen)

## What it does

Everything the launcher did before is unchanged: log in or create an account, browse the store, add free games, download
with resume and checking, install, verify, update, start a game. The store interface it shows is shared with the Android
app (`apps/launcher/src/renderer`).

## Choosing the server

The default server comes from the repository variable `MAREC_API_BASE_URL` when the app is built. Players can change it in
**Settings, Store server**. Without the variable the default is `http://localhost:8000`, which only works for development.

## Building on your own PC (optional)

You never have to. If you want to: install Node 22, then in `apps/launcher` run `npm install` and `npm run dist`. The files
appear in `apps/launcher/dist`.

## Troubleshooting

- **The app opens but shows "Can't reach the store".** The server address is wrong or the backend is off. Open Settings.
- **SmartScreen blocks it.** See above.
- **Games will not install.** The backend and its file storage must be running, and you must own the game.
