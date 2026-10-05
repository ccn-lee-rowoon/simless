# Simless — shared simulators and emulators

The iOS simulators and Android emulators in the simless list (`simless list`) are shared between agent sessions and people on this Mac.

- Before touching one with argent, adb, or simctl — screenshots and `describe` included — acquire it: `simless use <device>`, `simless use --group "<group>"`, or `simless use --default ios|android`.
- Boot and shut down with `simless use` / `simless down`, not argent `boot-device`, `emulator -avd`, or `simctl boot`.
- When a device is busy, Simless says who holds it. Wait (`--wait`) or ask the user; never `simless release --force`.
- Release with `simless release` when the task is done.
- A hook blocks calls on Simless devices this session doesn't hold. Follow the `simless` skill for the full flow.
