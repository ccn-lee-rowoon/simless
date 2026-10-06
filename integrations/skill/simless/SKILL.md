---
name: simless
description: Use when testing or checking a **mobile app** (React Native, Expo, native iOS or Android) on an iOS simulator or Android emulator on this Mac — running the app, checking a screen, checking its layout across device sizes, or anything else that drives a simulator or emulator. Also use when the user explicitly asks for a simulator, emulator or Simless, in any project. Simless (the `simless` CLI) brokers the devices between sessions — acquire a device group, the default device, or specific devices, then drive screens with argent. Triggers in a mobile app project — "시뮬레이터로 확인해 줘", "에뮬레이터에서 테스트", "기본 디바이스로 테스트", "그룹으로 확인해 줘", "여러 해상도로 확인", "레이아웃 크기별로 봐 줘", "320·375·414 에서 확인", "작은 폰에서 깨지는지", "태블릿에서도 봐 줘"; anywhere — "심리스로 확인해 줘", "시뮬레이터에서 봐 줘", "test on the simulator". Even for a single device, acquire it through Simless first; argent skills (argent-device-interact etc.) then do the on-screen work. **Not for web projects**: checking a website's responsive layout at phone or tablet widths is done in a browser (resize, device emulation), not here — unless the user asks for a simulator or emulator by name (e.g. mobile Safari on an iOS simulator). Not for tasks that don't touch a device.
---

# Simless — device broker

simless lets several agent sessions and people share this Mac's simulators and emulators without stepping on each other. The devices in the **simless list** (created by Simless, or added from this Mac) are shared, and you **acquire** a device before touching it. Devices are bundled by purpose into **device groups** (e.g. «UI layout check», «two accounts»), and each platform has one **default device** for general testing.

| Who | Does what |
| --- | --- |
| Simless (`simless`) | Lists devices and device groups; **acquires**/releases; boots/shuts down; creates and slims devices; gives each device's argent ID and size label; caches native builds (`simless app`) |
| argent | Installs (`reinstall-app`) and launches (`launch-app`) apps, deep links (`open-url`), taps, screenshots |

**Rules**
- Touch a device with argent, adb or simctl **only after acquiring it**. Reads (screenshot, describe) count too.
- Boot and shut down with **`simless use` / `simless down`**, not argent `boot-device`.
- Never touch other sessions' devices or Metro. **Run your own Metro on a free port** (step 3) — never reuse, stop or kill a Metro you didn't start, and never assume 8081 is yours.
- Never run `simless release --force` (people only).
- Create or edit device groups **only when the user asks**. Don't change groups someone else made.
- Decide on error **codes** (`--json` output), not on message text — messages follow the user's language setting.
- If `simless` isn't found (`command -v simless`), tell the user to install it — don't drive devices without it. `simless --help` lists exit codes, error codes and examples.

## Steps

### 1. Check and pick what to use

First make sure this really is device work: the project is a mobile app (`package.json` with `react-native` or `expo`, an `ios/`·`android/` project, Xcode or Gradle files), or the user asked for a simulator, emulator or Simless by name. A web project's «check it at phone widths» belongs in the browser — stop here and use browser tools instead.

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
  ```
  A device that exists on this Mac but isn't in the list (e.g. one made in Xcode): `simless --json list --available` shows them; add one with `simless add <device>` **only when the user asks**.
  Slim devices are named `simless …` and boot lighter, but slimming turns some features off (push notifications, iCloud, Siri …; see `simless catalog`). If the test needs them, create with `--no-slim`. iOS slimming takes 2–3 minutes. No apps are installed.

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
- From `devices[]` remember each device's **`targetId`** (argent `udid`/`device_id` — iOS UDID, Android `emulator-<port>`) and **`label`** (e.g. `Android 360dp`, `iOS 402pt`). `simless --json list` shows them again.

### 3. Start your own Metro (React Native · Expo apps)

Other sessions — often in other worktrees of the same repo — run their own Metro at the same time, and a Metro on 8081 is usually **someone else's**. So each session runs its own Metro on its own port and points only its own devices at it.

**This overrides the argent React Native workflow's single-Metro advice** («reuse the Metro already on 8081», `adb reverse tcp:8081 tcp:8081`, «iOS needs no config»). Following it here attaches your app to another session's code, or to nothing.

1. **Pick a free port** (first free from 8081 up):
   ```sh
   for p in $(seq 8081 8099); do lsof -nP -iTCP:$p -sTCP:LISTEN >/dev/null || { echo $p; break; }; done
   ```
2. **Start Metro from your working directory** on that port, in the background, and remember its PID. Force IPv4 so it answers on `127.0.0.1` — otherwise macOS may bind it to `[::1]` only and the app can't reach it. If the port was just taken, pick the next free one.
   - **Expo with one Android device — let Metro launch it.** `--android` does what Metro's `a` key does: `adb reverse` for your port and opening the dev client at your Metro with the scheme the installed app registers. **Always pin the device with `ANDROID_SERIAL`** — without it, it runs on every connected emulator, other sessions' included:
     ```sh
     ANDROID_SERIAL=<targetId> NODE_OPTIONS=--dns-result-order=ipv4first npx expo start --dev-client --port <port> --android
     ```
     Success in the Metro log: `Opening exp+<scheme>://expo-development-client/?url=…%3A<port>` and then `Android Bundled`. Then skip to 4.2's «Check it attached».
   - **Otherwise** (iOS, several Android devices, bare React Native) start Metro alone and launch per device in 4.2:
     ```sh
     NODE_OPTIONS=--dns-result-order=ipv4first npx expo start --dev-client --port <port>   # Expo
     NODE_OPTIONS=--dns-result-order=ipv4first npx react-native start --port <port>        # bare React Native
     ```
3. **Wait until it's ready**: argent `debugger-status` with `device_id: <targetId>` and `port: <port>` — `metro_not_running` means not yet (retry for up to ~30 s); `no_app_connected` or `connected` means Metro is up.
4. **Point each acquired Android device at it** — both your port (dev client URLs use it) and 8081 (what the app falls back to), so a stale mapping can't send it elsewhere. `--android` sets only `tcp:<port>`, so add 8081 there too:
   ```sh
   adb -s <targetId> reverse tcp:<port> tcp:<port>
   adb -s <targetId> reverse tcp:8081 tcp:<port>
   ```
   **These mappings disappear** when the emulator reboots, the app is reinstalled, or the adb server restarts. A red screen «Unable to load script … adb reverse tcp:8081» means exactly that — set them again, then Reload.

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
     npx expo run:ios --device <targetId>      # or run:android
     simless --json app save --platform ios    # finds the newest build (DerivedData / android/app/build)
     ```
     `TOOL_MISSING` means it isn't an Expo project with `@expo/fingerprint` — skip the cache. Computing the fingerprint takes about 30 seconds.
   - Otherwise `reinstall-app`. If you build and install from the project instead, **always name the device**: `npx expo run:ios --device <targetId>` / `npx expo run:android --device <targetId>`, `npx react-native run-android --deviceId <targetId>`, or `ANDROID_SERIAL=<targetId>` for Gradle `installDebug`. Without it, Android tools install onto **every** connected emulator — including other sessions' devices.
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
     - iOS: `iOS Bundled` in your Metro log right after the launch.
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
simless release
```

- argent `stop-all-simulator-servers`: only with `devices: [<this session's devices>]` — the tool-server is shared, and an unscoped call stops other sessions' devices.

- Release after reporting. You may keep the lease while waiting for the user or rebuilding — an idle lease (30 min) is released automatically only when someone is waiting.
- **Ask the user** whether to shut the devices down. If yes, `simless down` before `release`.

## When things go wrong

- **Parsing `simless --json` output**: progress lines («… booting», «… booted») go to **stderr**, the JSON to stdout. Drop stderr when piping — `simless --json use … 2>/dev/null | jq …`. Merging it (`2>&1 | jq`) breaks the parse (`Invalid numeric literal`).
- **A screenshot is entirely black**: the app blocks capture on that screen (Android `FLAG_SECURE`) — not a tool error. Read that screen's state from `describe` (accessibility tree: text and frames) and take screenshots on the next screen that allows capture.
- **argent gestures fail on an Android emulator** with `simulator-server exited … emulator "emulator-5554" not found … grpc.token`: they keep failing for the rest of the session. `describe`, `debugger-*` and `launch-app` still work. Fall back to adb — coordinates are **pixels**, so multiply `describe`'s 0–1 frame by `wm size`:
  ```sh
  adb -s <targetId> shell wm size
  adb -s <targetId> shell input tap <x> <y>
  adb -s <targetId> shell input swipe <x1> <y1> <x2> <y2> 300
  adb -s <targetId> shell input keyevent 82          # dev menu (4 = Back)
  adb -s <targetId> exec-out screencap -p > shot.png
  ```
- **argent on iOS reports a sandbox error** — `launch-app` → `init_failed`, `screenshot` → `Connection refused … CoreSimulatorService … sandbox profile`: the argent tool-server was started inside a sandbox. Restarting it from an unsandboxed shell fixes it (`argent server stop && argent server start --detach`), but **the tool-server is shared by every session on this Mac — ask the user before restarting it.** Meanwhile use `xcrun simctl launch` / `openurl` / `io <targetId> screenshot`.
- **`debugger-connect` refuses the device when iOS and Android share one Metro**: the error lists each device's `logicalDeviceId`. Pass that as `device_id` (with `port: <port>`) to `debugger-connect` and every later `debugger-*` call.

## Device groups (only when the user asks)

```sh
simless group create "two accounts" --desc "Account A + account B — needs both devices" <device>...
simless group edit "two accounts" --add <device> --remove <device> --desc "…"
simless default <device>                       # make it its platform's default device
```

## MCP tools

If the `simless` MCP server is registered, the same steps are available as tools: `simless_status`, `simless_use` (devices, group, or default; `mode: "available"`; `wait` — call again while it answers `STILL_QUEUED`), `simless_release`, `simless_down`, `simless_catalog`, `simless_create`, `simless_group_save`. Errors start with the code (`BUSY: …`). Use either the CLI or the tools — they share the same session.

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
| `simless catalog` / `simless create …` | Models you can create / create one |
| `simless --json app install` / `app save --platform <p>` | Install the cached native build on held devices / store the one you just built |
| `simless app list` / `app prune` | Cached builds / keep only the newest 5 per app and platform |
| `simless doctor` | Check the installation and how to fix it |

Exit codes: `0` ok · `1` failed · `2` usage error · `3` in use by another session, still waiting, or `DEADLOCK` · `4` can't reach the server. With `--json`, errors go to stdout as `{"error": {code, message, data}}`. `--available` exits 0 when it took at least one device.
