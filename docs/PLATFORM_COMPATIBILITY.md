# Platform compatibility: Windows and Android

## The rule

A game shows which platforms it is for. A device only installs and starts games that are for it.

| Game is for | On Windows PC | On Android phone |
| --- | --- | --- |
| Windows | Install, play, update, verify | Browse, buy where supported, wishlist, in the library. **No Install, no Play.** Says "Windows PC game". |
| Android | In the library. No Install. Says "install it from the MAREC Store app on your phone". | Install through Android's installer |
| Both | Install on either | Install on either |

The Android app never downloads or tries to start a Windows program. This is enforced in three places: the screens do not
show the buttons, the shared download code is not used on Android, and the Android bridge refuses `play`, `verify` and
`uninstall` and only accepts an Android build for `install`.

## Where the platform comes from today

The store backend only accepts **Windows** builds (`windows-x64`). So every game is a Windows game, and a game with no
platform list is treated as one. When the backend adds Android builds, the app already understands `platforms` containing
`windows-x64` or `android-arm64`.

## How an Android game would be delivered

This is **ready in the app but not yet usable, because the backend has no Android builds**. The app expects the game
details to carry an optional field, which the backend does not send yet:

```json
"android_build": { "url": "https://.../game.apk", "sha256": "<64 lowercase hex>", "size_bytes": 12345678, "version": "1.0.0" }
```

When present, Install on a phone does this:

1. Check the address is `https` and the checksum is well formed.
2. If Android has not allowed MAREC Store to install apps, open Android's settings page for that first, before downloading.
3. Download the file, showing progress, and check its SHA-256. A mismatch deletes the file.
4. Hand the file to Android's package installer. **Android shows its own confirmation screen; the app cannot skip it.**

Needs from the backend to switch this on: a platform on each build (`android-arm64`), upload support for an APK, and the
`android_build` details above for owners of the game. Until then the Install button for an Android game reports
"There is no Android version of this game yet."

## What is shared between Windows and Android

| Thing | Shared? | How |
| --- | --- | --- |
| Accounts, login, tokens | Yes | Same API. Each device keeps its own login. |
| Profile | Yes | Same API. |
| Game library and free-game adds | Yes | Same API. |
| Store catalogue, prices, game details | Yes | Same API. |
| Purchase history | Partly | Shown from the library (free additions). Paid purchases are not built. |
| **Wishlist** | **No** | Saved on each device only. The backend has no wishlist endpoint. |
| **Reviews and ratings** | **No** | The backend has none. |
| **Screenshots and trailers** | **No** | The backend sends none; the app shows labelled placeholders. |
| Download history | No | Each device keeps its own. |

Synced wishlists, reviews, screenshots, payments and Android builds all need backend work first. The apps will not
pretend otherwise.

## Prices and regions

Prices are shown in kwacha (MWK) from the store's tambala amounts. Dollar prices appear only for a game when the store sends
one. Nothing is converted by guesswork.

## Google Play notes (for later)

- Play restricts `REQUEST_INSTALL_PACKAGES` to apps whose main purpose is installing apps. A game store qualifies, but you
  must declare it.
- New apps must target a recent Android version. The app targets 34 today; raise `targetSdk` and `compileSdk` in
  `apps/android/app/build.gradle` when Play asks.
