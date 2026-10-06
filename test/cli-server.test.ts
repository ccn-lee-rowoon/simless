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
});
