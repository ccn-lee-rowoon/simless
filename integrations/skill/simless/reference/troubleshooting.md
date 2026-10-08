# When things go wrong

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
