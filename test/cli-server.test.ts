import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { CorgiServer } from "../src/server/app.ts";
import { listen } from "../src/server/socket.ts";
import { VERSION } from "../src/shared/version.ts";
import { androidDevice, fakeDriver, tempEnv } from "./helpers.ts";

const entry = new URL("../bin/corgi.ts", import.meta.url).pathname;
const env = tempEnv();
let stop = () => {};

beforeAll(async () => {
  const server = new CorgiServer({ ...env, drivers: [fakeDriver()] });
  server.registry.add(androidDevice("aaaa", "Small"));
  stop = (await listen(env.paths.socket, VERSION, server.handle)).stop;
});
afterAll(() => {
  stop();
  env.cleanup();
});

async function corgi(args: string[], extraEnv: Record<string, string> = {}) {
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

describe("CLI ↔ 서버", () => {
  test("status --json", async () => {
    const { stdout, exitCode } = await corgi(["--json", "status"]);
    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout).devices[0]).toMatchObject({ id: "aaaa", label: "Android 360dp" });
  });

  test("점유 후 다른 세션은 종료 코드 3 과 누가 쓰는지", async () => {
    expect((await corgi(["acquire", "Small"], { CORGI_SESSION_ID: "A" })).exitCode).toBe(0);
    const busy = await corgi(["--json", "acquire", "aaaa"], { CORGI_SESSION_ID: "B" });
    expect(busy.exitCode).toBe(3);
    expect(JSON.parse(busy.stdout).error).toMatchObject({ code: "BUSY" });
    expect((await corgi(["release"], { CORGI_SESSION_ID: "A" })).exitCode).toBe(0);
  });

  test("서버가 없으면 종료 코드 4", async () => {
    const { exitCode, stderr } = await corgi(["status"], {
      CORGI_SOCKET: "/tmp/corgi-test-none.sock",
    });
    expect(exitCode).toBe(4);
    expect(stderr).toContain("corgi serve");
  });
});

describe("표 출력", () => {
  test("슬림이 실패한 디바이스는 이유를 표 아래에 적는다", async () => {
    const { devicesTable } = await import("../src/cli/format.ts");
    const device = {
      ...androidDevice("cccc"),
      slim: "failed" as const,
      slimError: "avdslim 이 없습니다 — corgi doctor\n자세한 내용",
      label: "Android 360dp",
      layoutWidth: 360,
      layoutHeight: 760,
      booted: false,
      mine: false,
    };
    expect(devicesTable([device])).toContain("슬림 실패 cccc: avdslim 이 없습니다 — corgi doctor");
    expect(devicesTable([device])).not.toContain("자세한 내용");
  });
});
