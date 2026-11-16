# MAREC Store for Android

The Android app lives in `apps/android`. It is a small native shell (Java) that hosts the **same store interface as the
Windows launcher** (`apps/launcher/src/renderer`) and the same API client, so accounts, library and store data are shared with
Windows. Nothing here needs Android Studio.

## What you can do in the app

Browse featured games, Discover (the catalogue with genre, price and release filters), Search, game pages with
requirements, create an account and log in, view your profile, keep a wishlist, add free games to your library and see
your library. Phones get a bottom tab bar (Home, Discover, Search, Library, Profile); tablets get the sidebar layout.

Windows PC games are shown clearly as Windows games and cannot be installed or started on a phone. See
`PLATFORM_COMPATIBILITY.md`.

## What you get from a build

| File | Use |
| --- | --- |
| `MarecStore-Android-debug.apk` | For testing. Its app id ends in `.debug`, so it installs next to a release app. Signed with a throwaway key that changes every build, so to update it you must uninstall the old debug app first. |
| `MarecStore-Android-release.apk` | The real app, signed with your key. Only built when the signing secrets exist. |
| `MarecStore-Android-release.aab` | The same, as an Android App Bundle for Google Play later. |

## Get it and try it on your phone

1. In **Actions**, open the latest **Build apps** run and download the artifact `MarecStore-Android-...` (use your phone
   browser). Unzip it (the Files app can).
2. Tap the `.apk`. Android asks to allow installs from that app (your browser or Files). Allow it, then tap **Install**.
3. Open **MAREC Store**. Debug and release builds both work. On first start:
   - If the build was made with `MAREC_API_BASE_URL`, you go straight to the login screen.
   - Otherwise tap **Server settings**, enter the store address (it must start with `https://` in release builds), and save.
4. Create an account or log in.

Android never installs anything silently. Every install is confirmed by you on Android's own screen.

## Which backend must be running

The app talks to the same server as Windows. For each feature:

| Feature | Needs |
| --- | --- |
| Browse, search, game pages | The API (`services/api`) and its database |
| Create account, log in, profile | The API and its database |
| Library, adding free games | The API and its database |
| Android game downloads | The API for the game record, and file hosting for the APK (Cloudflare R2 or similar) |

The API must be reachable from the internet over `https` (a Codespace forwarded port set to **Public** works for testing).
The build does not need a paid server: building never contacts your backend.

## How it is built

1. `scripts/android/prepare-assets.js` copies the shared interface and API client into the app.
2. Gradle (version 8.7, Android Gradle Plugin 8.5.2, Java 17, Android 14 SDK) builds the APK and AAB.
3. `scripts/ci/check-apk.js` checks every APK: package name, version, minimum Android (7.0, API 24), permissions
   (internet and install-packages only), launcher activity and signature.

The version comes from the `VERSION` file, the build number is the run number, and the commit and date are built in
(shown in **Settings**).

## Test an APK on a real phone

Use the steps above. Then check: it opens, the login screen shows, create account and login work against your server, the
store lists games, a free game can be added, the Library shows it as a Windows game with no Install button, and the Back
button goes back one screen before leaving the app.

## Optional emulator check

Run **Build apps** manually with **emulator_test** ticked. It starts the debug APK in an Android emulator and checks that
the app opens, loads its first page, does not crash and reports no JavaScript error. It does not test login or the store,
because the build has no backend to talk to. Its screenshot and log are uploaded.

## Building on your own computer (optional)

You do not need to. If you want to: install JDK 17, the Android SDK (platform 34, build-tools 34.0.0) and Gradle 8.7,
run `node scripts/android/prepare-assets.js`, then `gradle -p apps/android assembleDebug`.

## Troubleshooting

- **"App not installed".** An older debug build with a different signature is on the phone. Uninstall it first.
- **"Blocked address" or "Cleartext HTTP traffic not permitted".** Release builds only talk to `https://`. Use an https address.
- **Login says "Cannot reach the store".** The address is wrong, the backend is off, or the phone has no data.
- **The build fails at the Android step.** Open the failed step and read the first line starting with `error:` or `What went wrong`.
