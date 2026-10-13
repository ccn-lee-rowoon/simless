# When things go wrong

- **Parsing `simless --json` output**: progress lines («… booting», «… booted») go to **stderr**, the JSON to stdout. Drop stderr when piping — `simless --json use … 2>/dev/null | jq …`. Merging it (`2>&1 | jq`) breaks the parse (`Invalid numeric literal`).
- **A screenshot is entirely black**: the app blocks capture on that screen (Android `FLAG_SECURE`) — not a tool error. Read that screen's state from the tool's accessibility tree (text and frames) and take screenshots on the next screen that allows capture.
- **The project's tool can't send gestures to an Android emulator** (its own device server fails, other commands still work): fall back to adb on your `targetId` — coordinates are **pixels**, so multiply a 0–1 frame by `wm size`:
  ```sh
  adb -s <targetId> shell wm size
  adb -s <targetId> shell input tap <x> <y>
  adb -s <targetId> shell input swipe <x1> <y1> <x2> <y2> 300
  adb -s <targetId> shell input keyevent 82          # dev menu (4 = Back)
  adb -s <targetId> exec-out screencap -p > shot.png
  ```
  On iOS: `xcrun simctl launch` / `openurl` / `io <targetId> screenshot`. If the tool runs one shared service for every session on this Mac, **ask the user before restarting it** — it stops other sessions' work too.
- **A tool refuses a device you hold** («in use», «claimed»): some tools keep their own device sessions or claims, per folder or per named session. A claim left behind by an earlier run (yours, or the session that held the device before you) blocks it. Close that tool's session from the folder that opened it, or use the tool's own command for stale claims — never force anything another live session holds; ask the user.
