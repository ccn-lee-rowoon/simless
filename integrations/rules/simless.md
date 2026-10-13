# Simless — shared simulators and emulators

The iOS simulators and Android emulators in the simless list (`simless list`) are shared between agent sessions and people on this Mac. Simless only lends them out; driving the screen and testing are done with whatever tools the project uses.

- Before touching one with any tool — the project's UI and test tools, adb, or simctl; screenshots and accessibility trees included — acquire it: `simless use <device>`, `simless use --group "<group>"`, or `simless use --default ios|android`.
- Name the device on every call with its `targetId` from Simless. A tool given no device picks a booted one itself, which may be another session's.
- Boot and shut down with `simless use` / `simless down`, not a tool's own boot or shutdown command, `emulator -avd`, or `simctl boot`.
- When a device is busy, Simless says who holds it. Wait (`--wait`) or ask the user; never force-release it — only a person can, from the Simless app window.
- Metro: run your own on a free port and point only your devices at it (see the `simless` skill). Don't reuse a Metro already on 8081 — it is usually another session's — and give your port to any tool that connects to Metro.
- When your device work is done, recommend releasing: tell the user which devices you hold and run `simless release` once they agree or the task is clearly finished.
- A hook blocks calls on Simless devices this session doesn't hold. Follow the `simless` skill for the full flow.
