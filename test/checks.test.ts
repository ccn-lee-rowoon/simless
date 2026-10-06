import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Probe, runChecks } from "../src/install/checks.ts";
import type { CheckId, CheckView } from "../src/shared/api.ts";
import { Config } from "../src/shared/config.ts";
import type { RunResult } from "../src/shared/exec.ts";
import { VERSION } from "../src/shared/version.ts";
import { session, tempEnv, testServers } from "./helpers.ts";

const start = testServers();

// simless doctor·첫 실행 설정 창의 점검 — 이 Mac 대신 가짜 명령·임시 HOME 으로 본다

const ok = (stdout = ""): RunResult => ({ code: 0, stdout, stderr: "" });
const fail: RunResult = { code: 1, stdout: "", stderr: "not found" };

/** 아무것도 없는 Mac */
function emptyMac(home: string): Partial<Probe> {
  return { run: async () => fail, which: () => undefined, env: { HOME: home, PATH: "" } };
}

/** 다 갖춘 Mac — Android SDK·도구·Xcode·argent 하나 */
function readyMac(home: string, sdk: string): Partial<Probe> {
  for (const file of ["platform-tools/adb", "emulator/emulator"]) {
    mkdirSync(join(sdk, file, ".."), { recursive: true });
    writeFileSync(join(sdk, file), "");
  }
  mkdirSync(join(sdk, "system-images", "android-36"), { recursive: true });
  const bin = join(home, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "argent"), "");
  return {
    env: { HOME: home, PATH: bin },
    which: (name) =>
      ["avdslim", "simslim", "brew"].includes(name) ? `/opt/bin/${name}` : undefined,
    run: async (command) => {
      if (command[1] === "outdated") return ok(JSON.stringify({ formulae: [] }));
      if (command.includes("simctl")) return ok("usage");
      if (command[0] === "xcodebuild") return ok("Xcode 26.1");
      return ok("1.0.0");
    },
  };
}

const byId = (checks: CheckView[]) => new Map(checks.map((c) => [c.id, c]));

describe("설치 안내·연결 확인 (S1·S2)", () => {
  test("빠진 도구는 실패로, 무엇을 설치할지와 창에서 누를 동작을 알려 준다 (S1)", async () => {
    const env = tempEnv();
    const config = Config.parse({ android: { sdkPath: join(env.env.HOME, "no-sdk") } });
    const checks = byId(
      await runChecks(
        { paths: env.paths, config, session: session("doctor") },
        { serverVersion: VERSION, probe: emptyMac(env.env.HOME) },
      ),
    );
    for (const id of ["androidSdk", "images", "avdslim", "xcode", "simslim"] as CheckId[]) {
      expect(checks.get(id)?.status).toBe("fail");
      expect(checks.get(id)?.fix).toBeTruthy();
    }
    expect(checks.get("avdslim")?.fix).toContain("brew");
    expect(checks.get("avdslim")?.action).toEqual({ fix: "avdslim.install", kind: "install" });
    expect(checks.get("simslim")?.action).toEqual({ fix: "simslim.install", kind: "install" });
    expect(checks.get("xcode")?.action?.fix).toBe("xcode.open");
    expect(checks.get("argent")).toMatchObject({
      status: "warn",
      action: { fix: "argent.install" },
    });
    // 서버 등록·스킬·앱이 없으면 simless install 로
    expect(checks.get("launchd")).toMatchObject({ status: "warn", fix: "simless install" });
    expect(checks.get("skill")?.status).toBe("warn");
    expect(checks.get("app")).toMatchObject({ status: "warn", fix: "simless install" });
    env.cleanup();
  });

  test("다 갖췄으면 통과, brew 에 새 버전이 있으면 업데이트를 알려 준다 (S1)", async () => {
    const env = tempEnv();
    const sdk = join(env.env.HOME, "sdk");
    const config = Config.parse({ android: { sdkPath: sdk } });
    const probe = readyMac(env.env.HOME, sdk);
    const checks = byId(
      await runChecks(
        { paths: env.paths, config, session: session("doctor") },
        { serverVersion: VERSION, probe },
      ),
    );
    for (const id of ["androidSdk", "images", "avdslim", "xcode", "simslim", "argent"] as CheckId[])
      expect(checks.get(id)?.status).toBe("ok");
    expect(checks.get("images")?.detail).toBe("android-36");

    const run = probe.run as NonNullable<Probe["run"]>;
    const newer = byId(
      await runChecks(
        { paths: env.paths, config, session: session("doctor") },
        {
          serverVersion: VERSION,
          probe: {
            ...probe,
            run: async (command, options) =>
              command[1] === "outdated"
                ? ok(
                    JSON.stringify({
                      formulae: [{ name: "x/y/simslim", current_version: "9.9.9" }],
                    }),
                  )
                : run(command, options),
          },
        },
      ),
    );
    expect(newer.get("simslim")).toMatchObject({
      status: "warn",
      fix: "brew upgrade simslim",
      action: { fix: "simslim.upgrade", kind: "update" },
    });
    env.cleanup();
  });

  test("서버가 꺼져 있으면 실패와 켜는 방법, 버전이 다르면 다시 켜라고 (S2)", async () => {
    const env = tempEnv();
    const ctx = { paths: env.paths, config: Config.parse({}), session: session("doctor") };
    const down = byId(await runChecks(ctx, { probe: emptyMac(env.env.HOME) }));
    expect(down.get("server")).toMatchObject({ status: "fail", fix: "simless install" });

    const old = byId(
      await runChecks(ctx, { serverVersion: "0.0.1", probe: emptyMac(env.env.HOME) }),
    );
    expect(old.get("server")?.status).toBe("warn");
    expect(old.get("server")?.fix).toBeTruthy();
    env.cleanup();
  });

  test("서버가 떠 있으면 소켓으로 물어 같은 버전이면 통과 (S2)", async () => {
    const { env } = await start();
    const checks = byId(
      await runChecks(
        { paths: env.paths, config: Config.parse({}), session: session("doctor") },
        { probe: emptyMac(env.env.HOME) },
      ),
    );
    expect(checks.get("server")).toMatchObject({ status: "ok", detail: `simless ${VERSION}` });
  });
});
