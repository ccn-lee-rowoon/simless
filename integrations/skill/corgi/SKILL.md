---
name: corgi
description: Use when testing or checking a **mobile app** (React Native, Expo, native iOS or Android) on an iOS simulator or Android emulator on this Mac — running the app, checking a screen, checking its layout across device sizes, or anything else that drives a simulator or emulator. Also use when the user explicitly asks for a simulator, emulator or Corgi, in any project. Corgi (the `corgi` CLI) brokers the devices between sessions — acquire a device group, the default device, or specific devices, then drive screens with argent. Triggers in a mobile app project — "시뮬레이터로 확인해 줘", "에뮬레이터에서 테스트", "기본 디바이스로 테스트", "DM 확인 그룹으로 봐 줘", "여러 해상도로 확인", "레이아웃 크기별로 봐 줘", "320·375·414 에서 확인", "작은 폰에서 깨지는지", "태블릿에서도 봐 줘"; anywhere — "코기로 확인해 줘", "시뮬레이터에서 봐 줘", "test on the simulator". Even for a single device, acquire it through Corgi first; argent skills (argent-device-interact etc.) then do the on-screen work. **Not for web projects**: checking a website's responsive layout at phone or tablet widths is done in a browser (resize, device emulation), not here — unless the user asks for a simulator or emulator by name (e.g. mobile Safari on an iOS simulator). Not for tasks that don't touch a device.
---

# Corgi — device broker

Corgi lets several agent sessions and people share this Mac's simulators and emulators without stepping on each other. Every device on this Mac is listed, and you **acquire** a device before touching it. Devices are bundled by purpose into **device groups** (e.g. «UI layout check», «DM check»), and each platform has one **default device** for general testing.

| Who | Does what |
| --- | --- |
| Corgi (`corgi`) | Lists devices and device groups; **acquires**/releases; boots/shuts down; creates and slims devices; gives each device's argent ID and size label |
| argent | Installs (`reinstall-app`) and launches (`launch-app`) apps, deep links (`open-url`), taps, screenshots |

**Rules**
- Touch a device with argent, adb or simctl **only after acquiring it**. Reads (screenshot, describe) count too.
- Boot and shut down with **`corgi use` / `corgi down`**, not argent `boot-device`.
- Never touch other sessions' devices or Metro. **Run your own Metro on a free port** (step 3) — never reuse, stop or kill a Metro you didn't start, and never assume 8081 is yours.
- Never run `corgi release --force` (people only).
- Create or edit device groups **only when the user asks**. Don't change groups someone else made.
- Decide on error **codes** (`--json` output), not on message text — messages follow the user's language setting.

## Steps

### 1. Check and pick what to use

First make sure this really is device work: the project is a mobile app (`package.json` with `react-native` or `expo`, an `ios/`·`android/` project, Xcode or Gradle files), or the user asked for a simulator, emulator or Corgi by name. A web project's «check it at phone widths» belongs in the browser — stop here and use browser tools instead.

```sh
corgi --json status          # server, devices, groups, defaults, who holds what
corgi --json group list      # device groups — read each description
```

- Exit code 4 (can't reach the server) or anything odd: run `corgi doctor` and follow it. If you can't fix it, tell the user.
- **Choose by purpose**:
  1. The user names a group (or the task clearly matches one by its description) → that group.
  2. Nothing specific → the **default device** (`--default ios`, `--default android`, or both).
  3. The user names devices → those devices.
- No device fits (e.g. a screen width is missing): show `corgi catalog`, **ask the user**, then create:
  ```sh
  corgi create "iPhone 17"                                # iOS device type (default: latest runtime)
  corgi create medium-phone                               # Android profile
  corgi create --width 375 --height 812 --density 420     # Android custom size
  corgi create "iPhone 17" --no-slim                      # a regular (non-slim) device
  ```
  Slim devices are named `corgi …` and boot lighter, but slimming turns some features off (push notifications, iCloud, Siri …; see `corgi catalog`). If the test needs them, create with `--no-slim`. iOS slimming takes 2–3 minutes. No apps are installed.

### 2. Acquire and boot

```sh
corgi --json use --group "DM check"       # every device in the group, all or nothing
corgi --json use --default ios            # the iOS default device
corgi --json use <ID|name>...             # specific devices
```

- The result lists each device with `state`: `held` · `queued` · `busy` · `free`, and who holds it.
- **Exit code 3 (`BUSY`) = another session is using a device.** Decide from the group description and the task:
  - The task can start with fewer devices (e.g. a layout check across widths): `--available` takes the free ones now; add `--wait` to have the server take the rest as they free up (`corgi status` shows them; run `corgi up` when they arrive).
  - Every device is required (e.g. «needs both devices»): show the holders to the user and **ask whether to wait**. If yes: `corgi --json use --group … --wait --timeout 9m`. If the Bash limit ends it as «still waiting», your place in line is kept — run it again.
  - `DEADLOCK`: waiting would make two sessions wait on each other. Continue with what you hold, or `corgi release` and ask again without holding anything.
- `NO_DEFAULT`: no default device yet — ask the user which device to use (or to create one).
- From `devices[]` remember each device's **`targetId`** (argent `udid`/`device_id` — iOS UDID, Android `emulator-<port>`) and **`label`** (e.g. `Android 360dp`, `iOS 402pt`). `corgi --json list` shows them again.

### 3. Start your own Metro (React Native · Expo apps)

Other sessions — often in other worktrees of the same repo — may run their own Metro at the same time. Use a port of your own so each session serves its own code to its own devices.

```sh
# first free port from 8081 up
for p in $(seq 8081 8099); do lsof -nP -iTCP:$p -sTCP:LISTEN >/dev/null || { echo $p; break; }; done
```

Start Metro from **your** working directory on that port, in the background, and remember its PID:

```sh
npx expo start --port <port>            # Expo
npx react-native start --port <port>    # bare React Native
```

If it fails because the port was just taken, pick the next free one. Point each device at your port:

- **Android** — map the device's 8081 to your port; the app needs no rebuild. Do this per acquired device:
  ```sh
  adb -s <targetId> reverse tcp:8081 tcp:<port>
  ```
- **iOS simulator** — it shares the Mac's localhost, so the app has to ask for your port:
  - Expo dev client: open `exp+<scheme>://expo-development-client/?url=http%3A%2F%2F127.0.0.1%3A<port>` with `open-url`.
  - Bare React Native: the port is set at build time — build with `npx react-native run-ios --port <port>` (or `RCT_METRO_PORT=<port>`).
- Android Expo dev client: after the `adb reverse`, open the same URL with `127.0.0.1%3A8081`.

### 4. Drive each device with argent

Pass `targetId` as argent's device argument, device by device, following the argent skills.

1. **Install** (when needed) — `reinstall-app`
2. **Launch** — `launch-app` (or the dev client URL above with `open-url`), after your Metro is up.
3. **Same screen everywhere** — `open-url <deep link>` if there is one, otherwise replay an argent flow (`flow-execute`) per device. Don't reuse tap coordinates across sizes.
4. **Screenshots** — `screenshot`, tagged with each device's `label`.

### 5. Report

Per `label`, say what broke (clipping, overlap, overflow, wrapping …) with screenshots. Mark sizes with no problems as fine.

### 6. Clean up

```sh
adb -s <targetId> reverse --remove tcp:8081   # each Android device you pointed at your Metro
kill <your Metro PID>                          # only the Metro you started
corgi release
```

- Release after reporting. You may keep the lease while waiting for the user or rebuilding — an idle lease (30 min) is released automatically only when someone is waiting.
- **Ask the user** whether to shut the devices down. If yes, `corgi down` before `release`.

## Device groups (only when the user asks)

```sh
corgi group create "DM check" --desc "Moderator + member — needs both devices" <device>...
corgi group edit "DM check" --add <device> --remove <device> --desc "…"
corgi default <device>                       # make it its platform's default device
```

## MCP tools

If the `corgi` MCP server is registered, the same steps are available as tools: `corgi_status`, `corgi_use` (devices, group, or default; `mode: "available"`; `wait` — call again while it answers `STILL_QUEUED`), `corgi_release`, `corgi_down`, `corgi_catalog`, `corgi_create`, `corgi_group_save`. Errors start with the code (`BUSY: …`). Use either the CLI or the tools — they share the same session.

## Command summary

| Command | What it does |
| --- | --- |
| `corgi --json status` | Server, devices, groups, defaults, leases |
| `corgi --json list [--platform] [--created]` | Devices in the Corgi list — `targetId`, `label`, state, slim, groups, holder |
| `corgi --json group list` / `group show <group>` | Device groups and their devices |
| `corgi --json use … [--group] [--default [platform]] [--available] [--wait --timeout 9m]` | Acquire + boot |
| `corgi acquire …` | Acquire without booting (same options) |
| `corgi who [<udid·serial>]` | Who is using a device |
| `corgi down` / `corgi release` | Shut down / release |
| `corgi catalog` / `corgi create …` | Models you can create / create one |
| `corgi doctor` | Check the installation and how to fix it |

Exit codes: `0` ok · `1` failed · `2` usage error · `3` in use by another session, still waiting, or `DEADLOCK` · `4` can't reach the server. With `--json`, errors go to stdout as `{"error": {code, message, data}}`. `--available` exits 0 when it took at least one device.
