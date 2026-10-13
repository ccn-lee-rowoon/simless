import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SimlessServer } from "../src/server/app.ts";
import { listen } from "../src/server/socket.ts";
import { VERSION } from "../src/shared/version.ts";
import { androidDevice, fakeDriver, seedDevice, tempEnv } from "./helpers.ts";

const entry = new URL("../bin/simless.ts", import.meta.url).pathname;
const env = tempEnv();
let stop = () => {};

beforeAll(async () => {
  const driver = fakeDriver();
  const server = new SimlessServer({ ...env, drivers: [driver] });
  seedDevice(server, driver, "aaaa", "Small");
  stop = (await listen(env.paths.socket, VERSION, server.handle)).stop;
});
afterAll(() => {
  stop();
  env.cleanup();
});

async function simless(args: string[], extraEnv: Record<string, string> = {}) {
  const proc = Bun.spawn([process.execPath, entry, ...args], {
    env: { ...process.env, ...env.env, ...extraEnv },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

describe("CLI ↔ 서버 (R13·R14)", () => {
  test("status --json", async () => {
    const { stdout, exitCode } = await simless(["--json", "status"]);
    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout).devices[0]).toMatchObject({ id: "aaaa", label: "Android 360dp" });
  });

  test("점유 후 다른 세션은 종료 코드 3 과 누가 쓰는지", async () => {
    expect((await simless(["acquire", "Small"], { SIMLESS_SESSION_ID: "A" })).exitCode).toBe(0);
    const busy = await simless(["--json", "acquire", "aaaa"], { SIMLESS_SESSION_ID: "B" });
    expect(busy.exitCode).toBe(3);
    expect(JSON.parse(busy.stdout).error).toMatchObject({ code: "BUSY" });
    expect((await simless(["release"], { SIMLESS_SESSION_ID: "A" })).exitCode).toBe(0);
  });

  test("acquire --purpose — 다른 세션의 BUSY 안내와 history 에 작업이 보인다 (M13)", async () => {
    const env = { SIMLESS_SESSION_ID: "A" };
    expect(
      (await simless(["acquire", "aaaa", "--purpose", "로그인 화면 확인"], env)).exitCode,
    ).toBe(0);
    const busy = await simless(["acquire", "aaaa"], { SIMLESS_SESSION_ID: "B" });
    expect(busy.exitCode).toBe(3);
    expect(busy.stderr).toContain("로그인 화면 확인");
    const history = await simless(["--json", "history", "--session", "x:A"], env);
    expect(JSON.parse(history.stdout)[0]).toMatchObject({
      kind: "acquired",
      purpose: "로그인 화면 확인",
    });
    expect((await simless(["release"], env)).exitCode).toBe(0);
  });

  test("슬림 항목 — create --slim-keep, slim --keep·--full·--app, 방식은 UI·App·Custom (M15)", async () => {
    const created = await simless([
      "--json",
      "create",
      "small-360",
      "--slim-keep",
      "location, assistant-search",
      "--no-baseline",
    ]);
    expect(created.exitCode).toBe(0);
    const device = JSON.parse(created.stdout);
    expect(device.slimKeep).toEqual(["location", "assistant-search"]);
    expect(device.slimMode).toBe("custom");

    const kept = await simless(["--json", "slim", device.id, "--keep", "location", "--app"]);
    expect(kept.exitCode).toBe(0);
    expect(JSON.parse(kept.stdout).devices[0]).toMatchObject({
      slimKeep: ["location"],
      slimMode: "app",
    });
    const table = await simless(["list"]);
    expect(table.stdout).toContain("(App −1)");

    const full = await simless(["--json", "slim", device.id, "--full"]);
    expect(full.exitCode).toBe(0);
    expect(JSON.parse(full.stdout).devices[0].slimKeep).toBeUndefined();
    expect(JSON.parse(full.stdout).devices[0].slimMode).toBe("ui");
    expect((await simless(["list"])).stdout).toContain("(UI)");

    // App 으로 남긴 뒤 슬림을 풀면 none — 저장된 출처(app)가 남아도 보이는 방식은 상태를 따른다
    await simless(["--json", "slim", device.id, "--keep", "location", "--app"]);
    const off = await simless(["--json", "slim", device.id, "--off"]);
    expect(JSON.parse(off.stdout).devices[0]).toMatchObject({ slim: "none", slimMode: "none" });

    // 방식만 주면 무엇을 남길지 몰라 INVALID
    const modeOnly = await simless(["--json", "slim", device.id, "--app"]);
    expect(JSON.parse(modeOnly.stdout).error).toMatchObject({ code: "INVALID" });

    const bad = await simless(["--json", "slim", device.id, "--keep", "nope"]);
    expect(bad.exitCode).toBe(2);
    expect(JSON.parse(bad.stdout).error).toMatchObject({ code: "INVALID" });
  });

  test("서버가 없으면 종료 코드 4", async () => {
    const { exitCode, stderr } = await simless(["status"], {
      SIMLESS_SOCKET: "/tmp/simless-test-none.sock",
    });
    expect(exitCode).toBe(4);
    expect(stderr).toContain("simless serve");
  });
});

describe("표 출력 — 슬림 실패 이유 (M6)", () => {
  test("슬림이 실패한 디바이스는 이유를 표 아래에 적는다", async () => {
    const { devicesTable } = await import("../src/cli/format.ts");
    const device = {
      ...androidDevice("cccc"),
      slim: "failed" as const,
      slimMode: "ui" as const,
      slimError: "avdslim 이 없습니다 — simless doctor\n자세한 내용",
      label: "Android 360dp",
      layoutWidth: 360,
      layoutHeight: 760,
      booted: false,
      mine: false,
      default: false,
      groups: [],
    };
    expect(devicesTable([device])).toContain(
      "Slim failed cccc: avdslim 이 없습니다 — simless doctor",
    );
    expect(devicesTable([device])).not.toContain("자세한 내용");
  });

  test("Simless 가 하지 않은 슬림도 SLIM — 꺼져 있으면 마지막으로 본 값과 시각", async () => {
    const { devicesTable } = await import("../src/cli/format.ts");
    const device = {
      ...androidDevice("dddd"),
      createdBySimless: false,
      slim: "none" as const,
      slimMode: "none" as const,
      slimSeen: {
        disabled: 49,
        total: 52,
        unit: "packages" as const,
        seenAt: new Date().toISOString(),
      },
      label: "Android 360dp",
      layoutWidth: 360,
      layoutHeight: 760,
      booted: false,
      mine: false,
      default: false,
      groups: [],
    };
    expect(devicesTable([device])).toContain("SLIM 49/52 packages (checked just now)");
  });

  test("슬림 방식(UI·App·Custom)과 남긴 수를 붙인다 (M15)", async () => {
    const { devicesTable } = await import("../src/cli/format.ts");
    const device = {
      ...androidDevice("eeee"),
      slim: "applied" as const,
      slimKeep: ["location", "camera"],
      slimMode: "custom" as const,
      label: "Android 360dp",
      layoutWidth: 360,
      layoutHeight: 760,
      booted: false,
      mine: false,
      default: false,
      groups: [],
    };
    expect(devicesTable([device])).toContain("SLIM (Custom −2)");
    expect(devicesTable([{ ...device, slimMode: "app" as const }])).toContain("SLIM (App −2)");
    expect(devicesTable([{ ...device, slimKeep: undefined, slimMode: "ui" as const }])).toContain(
      "SLIM (UI)",
    );
  });
});
