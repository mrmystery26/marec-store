#!/usr/bin/env bash
# Starts the app on a running Android emulator and checks that it opens without crashing.
# Usage: emulator-smoke.sh path/to/app.apk com.package.name
# It cannot test login or the store, because the build pipeline has no backend to talk to.
set -uo pipefail
APK="$1"
PACKAGE="$2"
SHOT="${3:-emulator-screenshot.png}"

adb install -r "$APK" || { echo "::error::The APK did not install on the emulator."; exit 1; }
adb logcat -c
adb shell am start -n "$PACKAGE/com.marecstudios.store.MainActivity" > /dev/null

loaded=0
for _ in $(seq 1 30); do
  if adb logcat -d -s MarecStore:I | grep -q "page-loaded"; then loaded=1; break; fi
  sleep 2
done
sleep 3
adb exec-out screencap -p > "$SHOT" || true
adb logcat -d > emulator-logcat.txt || true

if [ "$loaded" -ne 1 ]; then echo "::error::The app never finished loading its first page."; exit 1; fi
if grep -q "FATAL EXCEPTION" emulator-logcat.txt; then echo "::error::The app crashed (see emulator-logcat.txt)."; exit 1; fi
if grep -q "Uncaught" emulator-logcat.txt; then echo "::error::The page reported a JavaScript error (see emulator-logcat.txt)."; exit 1; fi
if [ -z "$(adb shell pidof "$PACKAGE" | tr -d '\r')" ]; then echo "::error::The app is not running after start."; exit 1; fi
echo "The app opened, loaded its page and was still running."
