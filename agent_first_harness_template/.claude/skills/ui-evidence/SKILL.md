---
name: ui-evidence
description: Use when a change or bug is visual or device-specific (mobile screens, web pages) and you need proof — capture screenshots, recordings or logs from Android emulators, iOS simulators or browsers.
---
# UI evidence (mobile and web)

Visual claims need pictures. Save evidence under `docs/evidence/<TASK-or-ISSUE>/` and reference the
paths in your report or submit summary. Don't commit huge videos; keep clips short.

## Android (emulator or device via adb)
```bash
adb devices                                        # pick a device
adb shell screencap -p /sdcard/s.png && adb pull /sdcard/s.png docs/evidence/T-012/android-home.png
adb shell screenrecord --time-limit 15 /sdcard/r.mp4 && adb pull /sdcard/r.mp4 docs/evidence/T-012/
adb logcat -d -t 300 > docs/evidence/T-012/logcat.txt   # recent logs (filter with | grep <tag>)
adb shell getprop ro.build.version.release          # OS version for the report
```

## iOS simulator (macOS)
```bash
xcrun simctl list devices booted
xcrun simctl io booted screenshot docs/evidence/T-012/ios-home.png
xcrun simctl io booted recordVideo docs/evidence/T-012/ios.mp4   # Ctrl+C to stop
xcrun simctl spawn booted log show --last 5m --predicate 'process == "Runner"' > docs/evidence/T-012/ios.log
```

## Flutter
```bash
flutter devices
flutter screenshot -d <device-id> -o docs/evidence/T-012/flutter.png
flutter test --update-goldens test/golden/   # only when a golden change is intended and reviewed
```

## Web
```bash
npx playwright screenshot --viewport-size=390,844 http://localhost:3000/settings docs/evidence/T-012/web-mobile.png
npx playwright screenshot --viewport-size=1440,900 http://localhost:3000/settings docs/evidence/T-012/web-desktop.png
```

## What to capture
Before and after for fixes; each state the spec names (empty, loading, error, success); small and large
screens; light and dark mode when relevant. Write the device/OS/build next to each file.
If no device or simulator is available here, say so and list exact manual steps for the human.
