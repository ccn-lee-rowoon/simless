# Corgi — shared simulators and emulators

The iOS simulators and Android emulators in the Corgi list (`corgi list`) are shared between agent sessions and people on this Mac.

- Before touching one with argent, adb, or simctl — screenshots and `describe` included — acquire it: `corgi use <device>`, `corgi use --group "<group>"`, or `corgi use --default ios|android`.
- Boot and shut down with `corgi use` / `corgi down`, not argent `boot-device`, `emulator -avd`, or `simctl boot`.
- When a device is busy, Corgi says who holds it. Wait (`--wait`) or ask the user; never `corgi release --force`.
- Release with `corgi release` when the task is done.
- A hook blocks calls on Corgi devices this session doesn't hold. Follow the `corgi` skill for the full flow.
