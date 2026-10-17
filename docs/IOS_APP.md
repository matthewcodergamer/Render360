# Render360 native iOS app

Native SwiftUI + Metal app for the iPhone. The emulator core is the same C++
as the browser build (no WKWebView), compiled for arm64 by
`native/build-native.sh`. Status and measured numbers: `PROGRESS.md`.

## What it does today

- Boots titles through the same boot path as the web player
  (`native/src/native_title.cpp`, a port of `handoffDefaultXex`).
- CPU: **HIR interpreter only.** There is no arm64 JIT backend yet (Xenia only
  has x64). The app probes at startup whether the process may run JIT code
  (sideloaded build with StikDebug) and reports it; nothing uses it yet.
- Graphics: guest frames come from the core's software renderer (the VdSwap
  frontbuffer, as the browser's Canvas2D path) and are drawn with Metal,
  capped at 30 FPS. The Xenos GPU backend (WebGPU recorder) is not ported to
  Metal/wgpu yet, so ASTC/16F texture handling does not apply yet.
- Input: MFi / Xbox / PlayStation controllers (GameController.framework) and
  on-screen touch controls.
- Overlay and telemetry use the web overlay's definitions
  (`ios/Render360/PerfStats.swift` ports `render360-perf-overlay.mjs`).

## Build

Everything is quoted because the drive name has a space. Xcode tools are run
through a symlink (`~/r360`), because some Xcode steps break on the space.

```sh
ln -sfn "/Volumes/EXTERNAL HD/Render360" ~/r360
cd ~/r360
bash fetch-xenia.sh                                   # pinned Xenia, once
R360_NATIVE_TARGET=ios-arm64 bash native/build-native.sh   # core: build/native-ios-arm64/librender360core.a (~12 min)
bash native/build-native.sh                           # optional: macOS core + build/native-macos-x86_64/run-title
```

`R360_SKIP_OVERLAYS=1` reuses the overlay sources and only recompiles changed
units. Generate and build the app (XcodeGen 2.44.1 from its GitHub release):

```sh
cd ~/r360/ios
xcodegen generate
export TMPDIR=~/r360/build/xc/tmp; mkdir -p "$TMPDIR"     # the internal disk is nearly full
xcodebuild -project Render360.xcodeproj -scheme Render360 -configuration Release \
  -destination 'id=<iPhone UDID>' -derivedDataPath ~/r360/build/xc/dd \
  CLANG_MODULE_CACHE_PATH=~/r360/build/xc/mc \
  -allowProvisioningUpdates -allowProvisioningDeviceRegistration build
```

Find the UDID with `xcrun devicectl list devices --json-output /tmp/d.json`
(`hardwareProperties.udid`).

## Signing with a free Apple ID

1. Xcode > Settings > Accounts: add your Apple ID (a "Personal Team").
2. Create `ios/Signing.local.xcconfig` (git-ignored):
   ```
   DEVELOPMENT_TEAM = <your team ID>
   R360_BUNDLE_ID = com.render360.<something unique, e.g. your team ID lowercased>
   ```
3. Build as above; `-allowProvisioningUpdates` creates the profile.

Entitlements, checked on the signed app with `codesign -d --entitlements :-`:

| Entitlement | Free team |
| --- | --- |
| `com.apple.developer.kernel.increased-memory-limit` | **granted** (the phone reports ~2.1 GB available) |
| `com.apple.developer.kernel.extended-virtual-addressing` | not in free-team profiles (not requested; needs the paid program) |

## Install and the 7-day re-sign

```sh
xcrun devicectl device install app --device <UDID> ~/r360/build/xc/dd/Build/Products/Release-iphoneos/Render360.app
```

First launch: Settings > General > VPN & Device Management > trust the
developer; Developer Mode must be on. Free-team builds expire after 7 days.
The app reads `embedded.mobileprovision` and warns 2 days before. To renew,
rebuild and reinstall: installing over the app keeps its games and data.
**Never delete the app to reinstall** – that deletes the imported games.

## Importing games (never put game files in git)

Games live in the app's `Documents/Games/<id>/`, every file excluded from
iCloud backup. A multi-disc title (Watch Dogs) is one entry with several discs.

- **Files app:** Import game > Choose files… (select all discs together), or
  "Add a disc to an existing game".
- **AirDrop:** AirDrop the file and choose Render360.
- **From the Mac over Wi-Fi** (resumable):
  ```sh
  python3 tools/serve-games.py "/Volumes/EXTERNAL HD/Render360-games" --token <secret>
  ```
  In the app: Import game > From my Mac > the printed address and token.
  A game is a sub-folder (its files are its discs) or a single file. Downloads
  write `<disc>.part` and continue with HTTP Range after a drop.
- **Cable (developer):**
  ```sh
  xcrun devicectl device copy to --device <UDID> --domain-type appDataContainer \
    --domain-identifier <bundle id> --source <file> --destination Documents/Games/<id>/<file>
  ```
  plus a `game.json` (`{"id","title","discs":[file names]}`) in the same folder.

## Telemetry and diagnostics

```sh
python3 tools/telemetry-server.py          # port 8361; logs in logs/phone/ (git-ignored)
open http://localhost:8361/status
```

In the app: Settings > Telemetry to the Mac > `http://<mac-ip>:8361`. The phone
POSTs one line per second: game FPS, average, 1% low, stutters, emulation
speed %, MIPS, interpreted %, memory used/free/lowest, thermal state, battery,
JIT availability, signing days left. `/summary.json` gives per-session
averages. iOS asks once for Local Network permission.

Crash breadcrumbs: `Documents/Diagnostics/breadcrumbs.log` (fsynced lines;
`running.flag` detects a crash or jetsam kill). After such a run the app shows
the last lines and sends them to the Mac (`logs/phone/crash_*.txt`). Pull them:

```sh
xcrun devicectl device copy from --device <UDID> --domain-type appDataContainer \
  --domain-identifier <bundle id> --source Documents/Diagnostics/breadcrumbs.log --destination bc.log
```

Test hooks for unattended runs:
`xcrun devicectl device process launch --device <UDID> --terminate-existing -e '{"R360_AUTOPLAY":"<game id>","R360_TELEMETRY":"http://<mac-ip>:8361"}' <bundle id>`

## Known limits

- **Speed:** interpreter only, ~11 MIPS on the iPhone 11 (~9 on the 2018 MBP).
  Real time needs ~1000 MIPS, so games run about 100× too slow; Banjo-Tooie
  needs ~127B instructions to reach gameplay (hours at this speed).
- Stopping a game exits the app (guest threads of a stopped run cannot be
  unwound); the next launch starts clean.
- No audio (XMA decoding not implemented, as in the browser).
- Disc swap: the app can remount another disc (`r360_native_select_disc`), but
  nothing triggers it yet when a title asks for the next disc.
- No Xenos GPU backend on Metal yet; frames are the software renderer's.
