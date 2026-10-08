---
name: simless
description: Brokers this Mac's iOS simulators and Android emulators between agent sessions with the `simless` CLI — acquire a device group, the default device or specific devices, run the app on your own Metro, then drive screens with argent. Use when testing or checking a React Native (Expo) mobile app on a simulator or emulator — running the app, checking a screen, or its layout across device sizes — and whenever the user asks for a simulator, emulator or Simless in any project; acquire through Simless even for one device. Triggers — "시뮬레이터로 확인해 줘", "에뮬레이터에서 테스트", "기본 디바이스로 테스트", "그룹으로 확인해 줘", "여러 해상도로 확인", "작은 폰에서 깨지는지", "태블릿에서도 봐 줘", "심리스로 확인해 줘", "test on the simulator". Not for web projects — a website's responsive layout is checked in a browser unless the user names a simulator or emulator. Not for physical devices, or tasks that don't touch a device.
---

# Simless — device broker

> **What it's for: running the code in your working copy, through a Metro you start on this Mac, on this Mac's simulators and emulators.** Each session gets its own devices and its own Metro, and the app reaches it at `127.0.0.1:<port>` (step 3). Physical devices — over USB or the network — and a Metro on another machine or a shared one are not covered.
>
> **Supported apps: React Native with Expo (dev client).** The Metro, launch and build-cache steps below assume an Expo dev client. Leasing and protecting devices works for any app, but for native (Swift/Kotlin), Flutter or non-Expo React Native apps these steps don't apply — acquire the device here, then use that project's own way to build and run, and tell the user it's outside what this skill covers.

simless lets several agent sessions and people share this Mac's simulators and emulators without stepping on each other. The devices in the **simless list** (created by Simless, or added from this Mac) are shared, and you **acquire** a device before touching it. Devices are bundled by purpose into **device groups** (e.g. «UI layout check», «two accounts»), and each platform has one **default device** for general testing.

| Who | Does what |
| --- | --- |
| Simless (`simless`) | Lists devices and device groups; **acquires**/releases; boots/shuts down; creates and slims devices; gives each device's argent ID and size label; caches native builds (`simless app`) |
| argent | Installs (`reinstall-app`) and launches (`launch-app`) apps, deep links (`open-url`), taps, screenshots |

**Rules**
- Touch a device with argent, adb or simctl **only after acquiring it**. Reads (screenshot, describe) count too.
- Boot and shut down with **`simless use` / `simless down`**, not argent `boot-device`.
- Never touch other sessions' devices or Metro. **Run your own Metro on a free port** (step 3) — never reuse, stop or kill a Metro you didn't start, and never assume 8081 is yours.
- Never force-release another session's device — only a person can, from the Simless app window.
- Create or edit device groups **only when the user asks**. Don't change groups someone else made.
- Decide on error **codes** (`--json` output), not on message text — messages follow the user's language setting.
- If `simless` isn't found (`command -v simless`), tell the user to install it — don't drive devices without it. `simless --help` lists exit codes, error codes and examples.

## Steps

**Progress** — copy this list and tick it off as you go; the clean-up items are the ones most often missed:

```
- [ ] 1 Purpose picked (group / default / named devices); for a feature test, slimOff checked
- [ ] 2 Acquired with `simless use` on its own; targetId and label noted
- [ ] 3 Own Metro on a free port at 127.0.0.1 (`--android` only when yours is the only emulator running); Android adb reverse for <port> and 8081
- [ ] 4 Installed (build cache first), launched onto your Metro, attachment checked in the app
- [ ] 5 Reported per label
- [ ] 6 adb reverse removed, your Metro killed, devices released; asked about shutting down
```

### 1. Check and pick what to use

First make sure this really is device work: the project is a React Native app (`package.json` with `react-native` and `expo`), or the user asked for a simulator, emulator or Simless by name. A web project's «check it at phone widths» belongs in the browser — stop here and use browser tools instead.

```sh
simless --json status          # server, devices, groups, defaults, who holds what
simless --json group list      # device groups — read each description
```

- Exit code 4 (can't reach the server) or anything odd: run `simless doctor` and follow it. If you can't fix it, tell the user.
- **Choose by purpose**:
  1. The user names a group (or the task clearly matches one by its description) → that group.
  2. Nothing specific → the **default device** (`--default ios`, `--default android`, or both).
  3. The user names devices → those devices.
- No device fits (e.g. a screen width is missing): show `simless catalog`, **ask the user**, then create:
  ```sh
  simless create "iPhone 17"                                # iOS device type (default: latest runtime)
  simless create medium-phone                               # Android profile
  simless create --width 375 --height 812 --density 420     # Android custom size
  simless create "iPhone 17" --no-slim                      # a regular (non-slim) device
  simless create "iPhone 17" --slim-keep store,web          # slim, but keep push and universal links
  ```
  A device that exists on this Mac but isn't in the list (e.g. one made in Xcode): `simless --json list --available` shows them; add one with `simless add <device>` **only when the user asks**.
  Slim devices are named `simless …` and boot lighter, but slimming turns some features off (push notifications, iCloud, Siri …; see `simless catalog`). iOS slimming takes 2–3 minutes. No apps are installed.

#### Creating a slim device

A slim device is one of three kinds — **full slim** (the default; UI and layout checks), **keep what the app needs** (testing a feature that relies on the device), or **custom** (the user names what to keep). How to choose, the `--slim-keep` IDs, and how to change an existing device: [reference/slim.md](reference/slim.md).

#### Does the test need device features?

Slimmed devices have some features off. `simless --json list` shows, per device, **`slimOff`** — the slim item IDs that are off (none if the device isn't slimmed). `slimOffObserved: true` means it was read from the device; `false` means it was worked out from Simless's slim settings and will be read once the device is on.

- **UI and layout checks** need nothing — any device that fits the purpose is fine, including a fully slimmed one.
- **Testing a feature that relies on the device** (push notifications, universal links, photo picker, contacts, location, camera …): find what the app needs («Finding what the app needs» below) and map it to slim item IDs. A device fits when **none of those IDs is in its `slimOff`**.
  1. The device the purpose points to (group, default, named) fits → use it.
  2. It doesn't fit → look for another device in the list that fits (same platform), tell the user which one and why, and request it by ID.
  3. A fitting device is busy → if no other fitting device is free, wait for it (`--wait`) and tell the user.
  4. No device fits → **ask the user**: change a Simless-made device's slim (`simless slim <device> --keep <id,…>`, only if nobody is using it) or create one with `--slim-keep`. Don't change or create a device without asking — other sessions use them.

### 2. Acquire and boot

```sh
simless --json use --group "two accounts"   # every device in the group, all or nothing
simless --json use --default ios            # the iOS default device
simless --json use <ID|name>...             # specific devices
```

- The result lists each device with `state`: `held` · `queued` · `busy` · `free`, and who holds it.
- **Exit code 3 (`BUSY`) = another session is using a device.** Decide from the group description and the task:
  - The task can start with fewer devices (e.g. a layout check across widths): `--available` takes the free ones now; add `--wait` to have the server take the rest as they free up (`simless status` shows them; run `simless up` when they arrive).
  - Every device is required (e.g. «needs both devices»): show the holders to the user and **ask whether to wait**. If yes: `simless --json use --group … --wait --timeout 9m`. If the Bash limit ends it as «still waiting», your place in line is kept — run it again.
  - `DEADLOCK`: waiting would make two sessions wait on each other. Continue with what you hold, or `simless release` and ask again without holding anything.
- `NO_DEFAULT`: no default device yet. `data.missing` tells, per platform, how many devices exist:
  - `devices: 0` — there is nothing to choose from: tell the user you're creating one (slim, a few minutes), then `simless --json use --default <platform> --create`.
  - more than 0 — ask the user which device to use (`simless default <device>` makes it the default).
- **Run `simless use` on its own** — not chained with device commands (`simless use … && adb …`): the hook checks the whole command before the lease exists and blocks all of it. Device commands go in the next call.
- A lease can be released while you wait for the user (session end, or idle with someone waiting). If a device command is blocked with «… only after acquiring», check `simless --json status` (`mine`) and run `use` again — and redo the Android `adb reverse` from step 3.
- From `devices[]` remember each device's **`targetId`** (argent `udid`/`device_id` — iOS UDID, Android `emulator-<port>`; not the short Simless ID like `a1b2`, which only `simless` commands take) and **`label`** (e.g. `Android 360dp`, `iOS 402pt`). `simless --json list` shows them again.

### 3. Start your own Metro (React Native · Expo apps)

Other sessions — often in other worktrees of the same repo — run their own Metro at the same time, and a Metro on 8081 is usually **someone else's**. So each session runs its own Metro on its own port and points only its own devices at it.

**The app always talks to `127.0.0.1:<your port>` — never the Mac's LAN IP.** Expo's default dev URL is `http://<Mac's LAN IP>:8081`, made for physical phones on the same network; on a simulator it reaches whatever Metro holds 8081 (often another session's), it breaks when the network changes, and the dev client lists other Macs' Metros found on the same network. `127.0.0.1` reaches only this Mac: an iOS simulator shares the Mac's network, and an Android emulator gets there through `adb reverse tcp:<port> tcp:<port>` (its own `127.0.0.1` is the emulator itself, so the mapping is required).

**This overrides the argent React Native workflow's single-Metro advice** («reuse the Metro already on 8081», `adb reverse tcp:8081 tcp:8081`, «iOS needs no config»). Following it here attaches your app to another session's code, or to nothing.

1. **Pick a free port** (first free from 8081 up):
   ```sh
   for p in $(seq 8081 8099); do lsof -nP -iTCP:$p -sTCP:LISTEN >/dev/null || { echo $p; break; }; done
   ```
2. **Start Metro from your working directory** on that port, in the background, and remember its PID. Force IPv4 so it answers on `127.0.0.1` — otherwise macOS may bind it to `[::1]` only and the app can't reach it. If the port was just taken, pick the next free one.
   - **Expo, Android, and yours is the only emulator running** (`adb devices` lists just it) — Metro can launch it: `--android` does what Metro's `a` key does — `adb reverse` for your port and opening the dev client at your Metro with the scheme the installed app registers:
     ```sh
     NODE_OPTIONS=--dns-result-order=ipv4first npx expo start --dev-client --port <port> --android > <metro.log> 2>&1 &
     ```
     Success in the Metro log: `Opening exp+<scheme>://expo-development-client/?url=…%3A<port>` and then `Android Bundled`. Then skip to 4.2's «Check it attached».
     **Not when another emulator is running:** Expo opens the app on the **first** device it finds and ignores `ANDROID_SERIAL` (it passes its own `adb -s`), and it sets `adb reverse` for your port on **every** connected emulator. Start Metro alone instead and launch with `adb -s` in 4.2.
   - **Otherwise** (iOS, more than one emulator running, bare React Native) start Metro alone and launch per device in 4.2. Send its output to a log file — step 4.2 waits on it:
     ```sh
     NODE_OPTIONS=--dns-result-order=ipv4first npx expo start --dev-client --port <port> > <metro.log> 2>&1 &   # Expo
     NODE_OPTIONS=--dns-result-order=ipv4first npx react-native start --port <port> > <metro.log> 2>&1 &        # bare React Native
     ```
3. **Wait until it's ready**: argent `debugger-status` with `device_id: <targetId>` and `port: <port>` — `metro_not_running` means not yet (retry for up to ~30 s); `no_app_connected` or `connected` means Metro is up.
4. **Point each acquired Android device at it** — both your port (dev client URLs use it) and 8081 (what the app falls back to), so a stale mapping can't send it elsewhere. `--android` sets only `tcp:<port>`, so add 8081 there too:
   ```sh
   adb -s <targetId> reverse tcp:<port> tcp:<port>
   adb -s <targetId> reverse tcp:8081 tcp:<port>
   ```
   **These mappings disappear** when the emulator reboots, the app is reinstalled, or the adb server restarts. A red screen «Unable to load script … adb reverse tcp:8081» means exactly that — set them again, then Reload.

5. **Warm the first bundle while you build or install (Expo).** Metro builds the JS bundle only when the app first asks — tens of seconds for a large app. Ask for it now, in the background, with the exact URL the app will request (from the manifest your Metro serves):
   ```sh
   url=$(curl -s -H 'expo-platform: ios' http://127.0.0.1:<port>/ | jq -r '.launchAsset.url')   # android for Android
   curl -s "$url" -o /dev/null &
   ```
   If `url` comes back empty, skip this — it's only a speed-up.

Launching the app onto this Metro is step 4.2.

### 4. Drive each device with argent

Pass `targetId` as argent's device argument, device by device, following the argent skills.

1. **Install** (when needed).
   - **Expo apps — try the build cache first.** Native builds take many minutes; Simless keeps finished simulator/emulator builds by their native fingerprint, so a worktree or session whose native side is unchanged (only JS differs) reuses one. From the app project, with the **same environment variables you would build with** (some apps' config depends on them):
     ```sh
     simless --json app install            # held, booted devices; add --platform ios|android to pick one
     ```
     Per platform, `hit: true` means it is installed — go on to launch. `hit: false` means nothing is cached for this fingerprint: build onto the device (below), then store the build so the next session skips it:
     ```sh
     REACT_NATIVE_PACKAGER_HOSTNAME=127.0.0.1 npx expo run:ios --device <targetId> --port <port>
     REACT_NATIVE_PACKAGER_HOSTNAME=127.0.0.1 npx expo run:android --device <AVD name> --port <port>
     simless --json app save --platform ios    # finds the newest build (DerivedData / android/app/build)
     ```
   - **Building with your Metro already running (Expo):** pass `--port <port>` — Expo sees your Metro (started from the same folder) on that port and reuses it instead of starting another. Also set `REACT_NATIVE_PACKAGER_HOSTNAME=127.0.0.1`: otherwise the app opens at your **LAN IP**, which changes with the network. When the build finishes the app opens on `127.0.0.1:<port>` — go to 4.2's «Check it attached».
     - **Android: `--device` takes the AVD name, not the serial** — `native` in `simless --json list` (e.g. `simless_ab12`). Given `emulator-5554` it fails with «Could not find device with name». Expo also sets `adb reverse` for your port on every connected emulator and removes it when it exits — harmless to other sessions, whose Metros use other ports.
     - **Don't use `--no-bundler`.** It can't be combined with `--port` («mutually exclusive»), and without a port the app opens on **LAN IP :8081 — another session's Metro**. If an install did open there, stop the app and reopen it on your port (4.2).
     - Run the build in the foreground or watch its output — a backgrounded build that fails on bad options only tells you minutes later.
     `TOOL_MISSING` means it isn't an Expo project with `@expo/fingerprint` — skip the cache. Computing the fingerprint takes about 30 seconds.
   - Otherwise `reinstall-app`. If you build and install from the project instead, **always name the device**: `npx expo run:ios --device <targetId>` / `npx expo run:android --device <AVD name>`, `npx react-native run-android --deviceId <targetId>`, or `ANDROID_SERIAL=<targetId>` for Gradle `installDebug`. Without it, Android tools install onto **every** connected emulator — including other sessions' devices.
2. **Launch onto your Metro** — not with `launch-app`: a plain launch reconnects to whatever server the app remembers. The bundle ID and Android package come from the project: `npx expo config --json` → `ios.bundleIdentifier`, `android.package`.
   - **Find the dev client scheme the app actually registers** — don't build it from the slug: many apps change the slug per environment, but the scheme was fixed when the native project was generated (e.g. slug `MyApp_Dev_A` while the app registers `exp+myapp`). A wrong scheme leaves the app on the dev client's home screen.
     ```sh
     grep -rho 'exp+[A-Za-z0-9.+-]*' android/app/src/main/AndroidManifest.xml ios/*/Info.plist | sort -u
     adb -s <targetId> shell dumpsys package <package> | grep -o 'exp+[A-Za-z0-9.+-]*' | sort -u   # what the installed Android app handles
     ```
   - Stop it first if it is running: `xcrun simctl terminate <targetId> <bundleId>` / `adb -s <targetId> shell am force-stop <package>`.
   - **Expo dev client**, the URL: `<scheme>://expo-development-client/?url=http%3A%2F%2F127.0.0.1%3A<port>`.
     - iOS: `open-url` with it.
     - Android: start it for the package, and read the output — `Error: Activity not started, unable to resolve Intent` means the scheme is wrong:
       ```sh
       adb -s <targetId> shell "am start -W -a android.intent.action.VIEW -d '<url>' <package>"
       ```
     - Still on the dev client's home screen: tap **Enter URL manually** (or «New development server») and type `http://127.0.0.1:<port>`. **Don't tap the listed servers** — `192.168.…:8081`/`8082` and «Recently opened» entries are usually other sessions' Metros.
   - **Bare React Native, iOS**: write the server, then launch — no rebuild needed:
     ```sh
     xcrun simctl spawn <targetId> defaults write <bundleId> RCT_jsLocation 127.0.0.1:<port>
     ```
     then `launch-app`. **Android**: `launch-app` (the 8081 mapping from step 3 reaches your Metro).
   - **Check it attached — in the app, not in the Metro log.** `debugger-status` (`device_id: <targetId>`, `port: <port>`) should say `connected`; then confirm where the app really is:
     - Android: open the dev menu (`adb -s <targetId> shell input keyevent 82`) and scroll down to **Connected to: http://…:<port>**.
     - iOS: `iOS Bundled` in your Metro log right after the launch. Wait on it instead of a fixed sleep, with a limit — if it times out, check `debugger-status`:
       ```sh
       for i in $(seq 120); do grep -q 'iOS Bundled' <metro.log> && break; sleep 1; done   # Android: 'Android Bundled'
       ```
     - Device console lines flowing into your Metro log don't prove it — after the app moves to another Metro the old socket keeps sending logs for a while.
     - Not your port → it's on another server; repeat this step.
   - **An Android deep link can restart the app** — `am start … -d <url>` may recreate the activity even when the app is up, and the dev client then falls back to its saved default server (usually 8081 or a LAN address). Check the dev menu again after any deep link (step 4.3 too); if it fell back, the quickest fix is restarting your Metro with `--android` (step 3).
   - Pass `port: <port>` to **every** argent `debugger-*` and `react-profiler-*` call — without it they use 8081, which is another session's Metro.
3. **Same screen everywhere** — `open-url <deep link>` if there is one, otherwise replay an argent flow (`flow-execute`) per device. Don't reuse tap coordinates across sizes.
4. **Screenshots** — `screenshot`, tagged with each device's `label`.

### 5. Report

Per `label`, say what broke (clipping, overlap, overflow, wrapping …) with screenshots. Mark sizes with no problems as fine.

### 6. Clean up

```sh
adb -s <targetId> reverse --remove tcp:<port>   # each Android device you pointed at your Metro
adb -s <targetId> reverse --remove tcp:8081
kill <your Metro PID>                            # only the Metro you started — same PID when started with --android
simless down                                     # only if the user said yes (below) — before release
simless release
```

- argent `stop-all-simulator-servers`: only with `devices: [<this session's devices>]` — the tool-server is shared, and an unscoped call stops other sessions' devices.

- Release after reporting. You may keep the lease while waiting for the user or rebuilding — an idle lease (30 min) is released automatically only when someone is waiting.
- **Ask the user** whether to shut the devices down. If yes, `simless down` before `release`.

## Finding what the app needs (for «keep what the app needs»)

Used when picking a device for a feature test (step 1) and when creating a slim device that keeps what the app needs. The result is a short list of app features, each with its evidence, mapped to Simless slim item IDs.

1. **Reuse** — if the app root has `.device-slim.json` and it is still current, use its `features` and skip to 4. How to check it: [reference/slim.md](reference/slim.md) «Reuse a previous result».
2. **Read the project — don't guess.** A feature can enter the app from several places, and dependency names alone miss most of them. Read these files next to this skill, in order, and note where each feature came from (file and line, or «built app»):
   1. [reference/app-expo.md](reference/app-expo.md) — app config, config plugins, Expo modules, and how to read the app as it is now. Skip it for bare React Native.
   2. [reference/app-react-native.md](reference/app-react-native.md) — JavaScript dependencies (and whether source files import them), local native modules, patches.
   3. The platform you're testing: [reference/app-ios.md](reference/app-ios.md) for an iOS simulator, [reference/app-android.md](reference/app-android.md) for an Android emulator — the native project, and a built app made from it as it is now.

   **Read the app as it is now — don't ask which environment or build profile.** The evidence is what building from this folder right now would produce: the native folders `ios/` / `android/` when they exist (they are what gets built — if an Expo app's folders are older than its app config, still use them and say a fresh `npx expo prebuild` would change the result); with no native folders, `npx expo config --type introspect --json` (what a prebuild would write now, with the current environment variables and `.env`); and a built app made from that state. Say which one you used.
3. **Check each feature's evidence** before listing it:
   ```
   - [ ] Not only a package.json / Podfile / Gradle line — a dependency is never proof on its own
   - [ ] A config plugin, entitlement, Info.plist key or manifest permission — and a source file that imports or calls it (or the built app)
   - [ ] Dependencies no source file imports are dropped, and you say so
   - [ ] The evidence is the app as it is now (native folders, or `expo config --type introspect`, plus a built app from them), and you say which
   ```
4. List the features with their evidence and **confirm with the user** — always, even when you then continue with a default; they may only need some of them for this test.
5. Map them to slim item IDs with the tables in [reference/slim.md](reference/slim.md) «Features → Simless slim items».

## When things go wrong

Read [reference/troubleshooting.md](reference/troubleshooting.md) when `simless --json` output won't parse, a screenshot is entirely black, argent gestures fail on an Android emulator, argent on iOS reports a sandbox error, or `debugger-connect` refuses a device when iOS and Android share one Metro.

## Device groups (only when the user asks)

```sh
simless group create "two accounts" --desc "Account A + account B — needs both devices" <device>...
simless group edit "two accounts" --add <device> --remove <device> --desc "…"
simless default <device>                       # make it its platform's default device
```

## MCP tools

If the `simless` MCP server is registered, the same steps are available as its tools (in Claude Code they appear as `mcp__simless__<tool>`): `simless_status` (devices with `slimOff`), `simless_use` (devices, group, or default; `mode: "available"`; `wait` — call again while it answers `STILL_QUEUED`), `simless_release`, `simless_down`, `simless_catalog`, `simless_create` (`slimKeep`), `simless_slim` (`keep`, `off`), `simless_group_save`. Errors start with the code (`BUSY: …`). Use either the CLI or the tools — they share the same session.

## Command summary

| Command | What it does |
| --- | --- |
| `simless --json status` | Server, devices, groups, defaults, leases |
| `simless --json list [--platform] [--created]` | Devices in the simless list — `targetId`, `label`, state, slim, groups, holder |
| `simless --json group list` / `group show <group>` | Device groups and their devices |
| `simless --json use … [--group] [--default [platform] [--create]] [--available] [--wait --timeout 9m]` | Acquire + boot |
| `simless acquire …` | Acquire without booting (same options) |
| `simless who [<udid·serial>]` | Who is using a device |
| `simless down` / `simless release` | Shut down / release |
| `simless catalog` / `simless create … [--slim-keep <id,…>]` | Models and slim items / create one |
| `simless slim <device> --keep <id,…>` / `--full` / `--off` | Change what a slim device keeps / full slim / remove slimming |
| `simless --json app install` / `app save --platform <p>` | Install the cached native build on held devices / store the one you just built |
| `simless app list` / `app prune` | Cached builds / keep only the newest 5 per app and platform |
| `simless doctor` | Check the installation and how to fix it |

Exit codes: `0` ok · `1` failed · `2` usage error · `3` in use by another session, still waiting, or `DEADLOCK` · `4` can't reach the server. With `--json`, errors go to stdout as `{"error": {code, message, data}}`. `--available` exits 0 when it took at least one device.
