# GitHub Actions: automatic builds

One workflow, `.github/workflows/build.yml` (shown as **Build apps** in the Actions tab), builds both apps. You never
compile anything yourself.

## When it runs

| You do this | What happens |
| --- | --- |
| Push to `main` | Windows and Android are built. Files are kept for 30 days. |
| Push a version tag like `v0.2.0` | Same build, then a **GitHub Release** is created with the Windows and Android release files. |
| Actions, **Build apps**, **Run workflow** | Build on demand. Choose Windows, Android or both. |

Other workflows: **CI** tests the backend. **Launcher** runs the launcher tests.

## The steps in order

1. **Plan the build.** Reads the `VERSION` file (or the tag), the run number, the commit and the date. Every file from
   one run carries the same version.
2. **Windows** (a Windows machine): installs Node 22, restores packages, runs tests, builds the installer, the
   standalone exe and a zip, checks them, starts the app once, uploads them.
3. **Android** (a Linux machine): installs Node, Java 17, the Android SDK and Gradle 8.7, runs the tests, copies the shared
   store interface into the app, builds the debug APK (and the release APK and AAB when signing is set up), checks every
   file, uploads them.
4. **Release** (tags only): attaches the files to a GitHub Release.

If any required step fails, the run is red, **nothing is uploaded from that platform**, and a `...-build-logs-...`
artifact keeps the log.

## Where to download

Open **Actions**, tap the latest **Build apps** run, scroll to **Artifacts** at the bottom:

| Artifact | Contains |
| --- | --- |
| `MarecStore-Windows-<version>-build<number>` | `MarecStore-Setup.exe`, `MarecStore.exe`, `MarecStore-Windows.zip`, `SHA256SUMS.txt` |
| `MarecStore-Android-<version>-build<number>` | `MarecStore-Android-debug.apk`, plus `MarecStore-Android-release.apk` and `.aab` when signed |

Artifacts are zip files. The GitHub phone app may not list them; open github.com in your phone's browser if you cannot
see them. A **Release** (version tags) gives direct downloads with no zip.

## Run a build by hand

Actions, **Build apps**, **Run workflow**, then pick:

- **platform**: `both`, `windows` or `android`.
- **android_release**: also build the signed release APK and AAB. Fails clearly if the signing secrets are missing.
- **emulator_test**: also open the app in an Android emulator and check that it starts (adds about 10 minutes).
- **commit_lockfile**: one time only, creates `apps/launcher/package-lock.json` (see below).

## Publish a versioned release

1. Optional: change the number in the `VERSION` file.
2. On GitHub, **Releases**, **Draft a new release**, type a new tag such as `v0.2.0`, publish.
3. The workflow builds everything from that tag and adds the files to the release. The tag decides the version
   (`v0.2.0-beta.1` makes a pre-release). Tags need the tests to pass and the Android signing secrets to exist.

## Settings you can add (all optional except for release builds)

In your repository: **Settings, Secrets and variables, Actions**.

**Variables** (not secret):

| Name | Meaning |
| --- | --- |
| `MAREC_API_BASE_URL` | The store server both apps use by default, for example `https://api.example.com`. If unset, the Windows app defaults to `http://localhost:8000` and the Android app asks for an address on first start. |
| `ANDROID_APPLICATION_ID` | The Android app id. Default `com.marecstudios.store`. Do not change it after you publish. |

**Secrets** (for signed Android release builds, see `ANDROID_SIGNING.md`):

`ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`.

No other secrets or settings are needed. The workflow uses the token GitHub provides for each run.

## Package versions (lockfile)

Until `apps/launcher/package-lock.json` exists, the Windows build installs the newest allowed packages each time
(and warns). Run the workflow once with **commit_lockfile** ticked: it creates and commits the file. From then on builds
use the exact same packages every time.

## Versions

The `VERSION` file holds the number (for example `0.1.0`). The build number is the GitHub run number, which only goes up,
and is also the Android `versionCode`. The About line in Settings shows version, build, commit and date.

## Cost

Public repositories build for free. On private repositories, Windows minutes count double.

## Troubleshooting

| You see | What to do |
| --- | --- |
| Red run, step **Install dependencies** | A package could not be downloaded. Run the workflow again. |
| Red run, **Run the tests** (tag only) | A test failed. Open the step to see which one. Tags need green tests. |
| `A signed release build was requested, but these GitHub secrets are missing` | Add the secrets listed in `ANDROID_SIGNING.md`, or run without `android_release`. |
| `The tag "..." is not a version tag` | Use names like `v0.2.0`. |
| Android step **Build the Android app** fails | Open the step, read the first `error:` line. Download the `...Android-build-logs...` artifact for the full log. |
| `Check the APKs` reports `unexpected permission` | A new library added a permission. Remove it, or add it to the allowed list in `scripts/ci/check-apk.js` if you really want it. |
| Windows warning `The app closed by itself` | Common on a build machine with no screen. Test the installer on a real PC. |
