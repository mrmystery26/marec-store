# Android signing

Android only installs and updates apps that are signed, and an update must be signed with the **same key** as the version
already installed. So you create **one release key, once**, keep it safe, and give it to GitHub as secrets. The build never
makes a new key.

- **Debug builds** are signed automatically with a temporary key. You do not do anything.
- **Release builds** (`MarecStore-Android-release.apk` and `.aab`) use your release key.

## 1. Create the key (once)

You need `keytool`, which comes with Java. If you do not have a computer, open a **GitHub Codespace** (you already use one
for the backend) and use its terminal:

```bash
keytool -genkeypair -v -keystore marec-release.jks -alias marec \
  -keyalg RSA -keysize 4096 -validity 10000
```

It asks for a password and some details. Choose a long password and write it down somewhere safe. The file
`marec-release.jks` is your key. **Never commit it.** (`*.jks` and `*.keystore` are in `.gitignore`.)

Turn it into text for GitHub:

```bash
base64 -w0 marec-release.jks
```

Copy the long line of text it prints.

## 2. Add the four secrets

GitHub, your repository, **Settings, Secrets and variables, Actions, New repository secret**:

| Secret name | Value |
| --- | --- |
| `ANDROID_KEYSTORE_BASE64` | the long line from step 1 |
| `ANDROID_KEYSTORE_PASSWORD` | the password you chose |
| `ANDROID_KEY_ALIAS` | `marec` (the `-alias` you used) |
| `ANDROID_KEY_PASSWORD` | the key password (the same as the keystore password if you were not asked for two) |

## 3. Back it up

Download `marec-release.jks` from the Codespace to a safe place (a password manager or an encrypted drive), and keep the
password with it. **If you lose the key you cannot update the app for the people who installed it.** Then delete the key
from the Codespace.

## 4. Build a release

- Push a version tag (see `GITHUB_ACTIONS.md`), or
- Actions, **Build apps**, **Run workflow**, tick **android_release**.

On ordinary pushes to `main`, release files are built automatically **if the secrets exist**; if they do not, only the debug
APK is built and the run says so. If you ask for a release and a secret is missing, the run fails and names the missing secret.

## How it is kept safe

- The key is stored only as an encrypted GitHub secret. Only the build steps that need it can read it.
- It is written to a temporary file on the build machine and deleted at the end of the run.
- The build checks that a release APK is signed and is **not** signed with a debug certificate.
- Pull requests from forks never receive secrets (this workflow does not run on them).

## Application id

The app id is `com.marecstudios.store` (debug builds add `.debug`). Change it with the repository variable
`ANDROID_APPLICATION_ID` **before** you publish anywhere. After that, never change it.

## Google Play later

Upload `MarecStore-Android-release.aab`. Play will ask you to turn on **Play App Signing**: it keeps the real signing key,
and your key becomes the upload key. Play also has rules about the permission that lets an app install other apps
(`REQUEST_INSTALL_PACKAGES`) and about the Android version the app targets (now 34). See `PLATFORM_COMPATIBILITY.md`.
