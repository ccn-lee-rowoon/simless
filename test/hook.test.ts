import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { offlineDecision } from "../src/hook/index.ts";
import { extractTargets } from "../src/hook/targets.ts";
import { SimlessServer } from "../src/server/app.ts";
import { listen } from "../src/server/socket.ts";
import { call } from "../src/shared/client.ts";
import { VERSION } from "../src/shared/version.ts";
import { type FakeDriver, fakeDriver, seedDevice, session, tempEnv } from "./helpers.ts";

describe("훅 대상 뽑기 (P4·P6)", () => {
  const bash = (command: string) => extractTargets("Bash", { command });

  test("디바이스 도구가 없는 명령·기기 인자 없는 argent 도구는 바로 통과", () => {
    expect(bash("ls -la && git status")).toBeUndefined();
    expect(bash("simless use bakw")).toBeUndefined();
    expect(extractTargets("mcp__argent__list-devices", {})).toBeUndefined();
    expect(extractTargets("Read", { file_path: "/x" })).toBeUndefined();
  });

  test("adb -s 시리얼·UDID 는 대상 후보, 기기 지정 없는 adb shell 은 켜진 Android 전부", () => {
    expect(bash("adb -s emulator-5554 shell input tap 1 2")).toMatchObject({
      ids: expect.arrayContaining(["emulator-5554"]),
      allAndroid: false,
    });
    expect(bash("adb shell getprop")?.allAndroid).toBe(true);
    expect(bash("ANDROID_SERIAL=emulator-5554 adb shell ls")?.allAndroid).toBe(false);
    expect(bash("adb devices")?.allAndroid).toBe(false);
    expect(bash("cd app && adb reverse tcp:8081 tcp:8081")?.allAndroid).toBe(true);
  });

  test("simctl booted 은 켜진 iOS 전부, simctl boot·emulator -avd 는 켜기", () => {
    expect(bash("xcrun simctl openurl booted myapp://home")?.allIos).toBe(true);
    expect(bash("xcrun simctl boot UDID-1")?.boots).toEqual(["UDID-1"]);
    expect(bash("$ANDROID_HOME/emulator/emulator -avd simless_ab12 -no-audio")?.boots).toEqual([
      "simless_ab12",
    ]);
    expect(bash("emulator @Pixel_6a")?.boots).toEqual(["Pixel_6a"]);
    expect(bash("xcrun simctl list devices")).toMatchObject({ allIos: false, boots: [] });
  });

  test("argent 도구는 udid·device_id·avdName, boot-device 는 켜기", () => {
    expect(extractTargets("mcp__argent__gesture-tap", { udid: "U1", x: 0.5, y: 0.5 })).toEqual({
      ids: ["U1"],
      boots: [],
      allAndroid: false,
      allIos: false,
    });
    expect(
      extractTargets("mcp__argent__debugger-component-tree", { device_id: "emulator-5554" })?.ids,
    ).toEqual(["emulator-5554"]);
    expect(extractTargets("mcp__argent__boot-device", { avdName: "simless_ab12" })?.boots).toEqual([
      "simless_ab12",
    ]);
  });
});

describe("서버가 꺼졌을 때 (P9)", () => {
  const index = {
    devices: [
      {
        id: "ab12",
        name: "Small",
        platform: "android" as const,
        native: "simless_ab12",
        targetId: "emulator-5554",
      },
      { id: "cd34", name: "SE", platform: "ios" as const, native: "UDID-1" },
    ],
  };
  const targets = { ids: [] as string[], boots: [] as string[], allAndroid: false, allIos: false };

  test("관리 디바이스(ID·마지막 시리얼)로 보이면 막는다", () => {
    expect(offlineDecision(index, { ...targets, ids: ["emulator-5554"] }).allow).toBe(false);
    expect(offlineDecision(index, { ...targets, ids: ["UDID-1"] }).allow).toBe(false);
    expect(offlineDecision(index, { ...targets, allAndroid: true }).allow).toBe(false);
  });

  test("관리 디바이스가 아니거나, 켜져 있던 iOS 가 없으면 통과", () => {
    expect(offlineDecision(index, { ...targets, ids: ["Pixel_6a"] }).allow).toBe(true);
    expect(offlineDecision(index, { ...targets, allIos: true }).allow).toBe(true);
    expect(offlineDecision(undefined, { ...targets, ids: ["UDID-1"] }).allow).toBe(true);
  });
});

describe("hook.check — 점유했는지 (P1·P5·P8)", () => {
  const env = tempEnv();
  let driver: FakeDriver;
  let server: SimlessServer;
  let stop = () => {};
  const check = (key: string, params: unknown) =>
    call<{ allow: boolean; reason?: string }>(
      env.paths.socket,
      "hook.check",
      params,
      session(key),
    ).then((r) => r.result);

  beforeAll(async () => {
    driver = fakeDriver();
    server = new SimlessServer({ ...env, drivers: [driver] });
    seedDevice(server, driver, "ab12", "Small");
    seedDevice(server, driver, "pix6", "Pixel 6a", false, false); // simless 목록에 없음
    stop = (await listen(env.paths.socket, VERSION, server.handle)).stop;
  });
  afterAll(() => {
    stop();
    env.cleanup();
  });

  test("simless 목록에 없는 기기는 통과, 점유하지 않은 관리 디바이스는 막고 점유 방법을 알려 준다", async () => {
    expect(await check("A", { ids: ["Pixel_6a_pix6"] })).toMatchObject({ allow: true });
    const denied = await check("A", { ids: ["simless_ab12"] });
    expect(denied.allow).toBe(false);
    expect(denied.reason).toContain("simless use ab12");
  });

  test("점유한 세션은 통과, 다른 세션은 누가 쓰는지와 함께 막힌다", async () => {
    await call(env.paths.socket, "lease.acquire", { devices: ["ab12"] }, session("A"));
    expect(await check("A", { ids: ["simless_ab12"] })).toMatchObject({ allow: true });
    expect(await check("B", { ids: ["simless_ab12"] })).toMatchObject({
      allow: false,
      reason: expect.stringContaining("test-agent"),
    });
  });

  test("켜진 기기의 시리얼·기기 지정 없는 adb 도 대상, 켜기는 점유해도 simless 로", async () => {
    // 켜기는 상태를 바꾸는 요청이라 서버가 켜짐 상태 기억을 버린다
    await call(env.paths.socket, "device.up", { devices: ["ab12"] }, session("A"));
    const serial = (await server.runtimeStates(await server.devices())).get("ab12")?.targetId ?? "";
    expect(serial).toStartWith("emulator-");
    expect(await check("B", { ids: [serial] })).toMatchObject({ allow: false });
    expect(await check("B", { allAndroid: true })).toMatchObject({ allow: false });
    expect(await check("A", { boots: ["simless_ab12"] })).toMatchObject({
      allow: false,
      reason: expect.stringContaining("simless use"),
    });
  });
});

describe("simless hook claude pre-tool-use", () => {
  const entry = new URL("../bin/simless.ts", import.meta.url).pathname;

  async function hook(input: unknown, extraEnv: Record<string, string>) {
    const proc = Bun.spawn([process.execPath, entry, "hook", "claude", "pre-tool-use"], {
      env: { ...process.env, ...extraEnv },
      stdin: new Blob([JSON.stringify(input)]),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    return { stdout, exitCode };
  }

  test("디바이스와 상관없는 호출은 아무것도 출력하지 않고 통과", async () => {
    const env = tempEnv();
    const result = await hook({ tool_name: "Bash", tool_input: { command: "ls" } }, env.env);
    env.cleanup();
    expect(result).toEqual({ stdout: "", exitCode: 0 });
  });

  test("서버가 꺼져 있고 관리 디바이스로 보이면 deny JSON 을 낸다", async () => {
    const env = tempEnv();
    mkdirSync(env.env.SIMLESS_STATE_DIR, { recursive: true });
    writeFileSync(
      env.paths.managedIndex,
      JSON.stringify({
        devices: [{ id: "ab12", name: "Small", platform: "android", native: "simless_ab12" }],
      }),
    );
    const result = await hook(
      { tool_name: "mcp__argent__gesture-tap", tool_input: { udid: "simless_ab12" } },
      env.env,
    );
    env.cleanup();
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny" },
    });
  });
});
