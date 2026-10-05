import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AndroidDriver, type AndroidDriverOptions } from "../src/server/drivers/android.ts";
import { Config } from "../src/shared/config.ts";
import type { RunResult } from "../src/shared/exec.ts";
import type { Device } from "../src/shared/model.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function sdkWithImages() {
  const root = mkdtempSync(join(tmpdir(), "corgi-android-"));
  dirs.push(root);
  const sdk = join(root, "sdk");
  for (const [target, tag, api] of [
    ["android-36", "google_apis_playstore", "36"],
    ["android-37.1", "google_apis_playstore_ps16k", "37"],
  ]) {
    const dir = join(sdk, "system-images", target ?? "", tag ?? "", "arm64-v8a");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "source.properties"),
      `AndroidVersion.ApiLevel=${api}\nSystemImage.TagId=${tag}\n`,
    );
  }
  for (const tool of ["platform-tools/adb", "emulator/emulator"]) {
    mkdirSync(join(sdk, tool, ".."), { recursive: true });
    writeFileSync(join(sdk, tool), "");
  }
  const env = { HOME: root, ANDROID_HOME: sdk, ANDROID_AVD_HOME: join(root, "avd") };
  mkdirSync(env.ANDROID_AVD_HOME, { recursive: true });
  return { root, sdk, env };
}

/** adb 흉내 — 켜진 에뮬레이터 표를 바꿔 가며 쓴다 */
function fakeAdb() {
  const running = new Map<string, { avd: string; booted: boolean }>();
  const calls: string[] = [];
  const runner = async (command: string[]): Promise<RunResult> => {
    const args = command.slice(1);
    calls.push(command.join(" "));
    if (args[0] === "devices") {
      const lines = [...running].map(
        ([serial, r]) => `${serial}\t${r.booted ? "device" : "offline"}`,
      );
      return { code: 0, stdout: `List of devices attached\n${lines.join("\n")}\n`, stderr: "" };
    }
    if (args[0] === "-s" && args[2] === "emu" && args[3] === "avd") {
      const r = running.get(args[1] ?? "");
      return r
        ? { code: 0, stdout: `${r.avd}\r\nOK\r\n`, stderr: "" }
        : { code: 1, stdout: "", stderr: "" };
    }
    if (args[0] === "-s" && args[2] === "shell") {
      return { code: 0, stdout: running.get(args[1] ?? "")?.booted ? "1\n" : "\n", stderr: "" };
    }
    if (args[0] === "-s" && args[2] === "emu" && args[3] === "kill") {
      running.delete(args[1] ?? "");
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  return { running, calls, runner };
}

function driver(
  env: NodeJS.ProcessEnv,
  extra: Partial<AndroidDriverOptions> = {},
  config = Config.parse({}),
) {
  return new AndroidDriver(config, {
    env,
    logDir: join(env.HOME ?? "", "logs"),
    avdslimPath: () => undefined,
    isPortFree: async () => true,
    pollMs: 1,
    ...extra,
  });
}

describe("AndroidDriver", () => {
  /** 이 Mac 에 있는 원본 AVD 처럼 — 크기·이미지 설정과 사용자 데이터가 있다 */
  function sourceAvd(avdHome: string, id: string, config: Record<string, string>) {
    const dir = join(avdHome, `${id}.avd`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "config.ini"),
      `${Object.entries(config)
        .map(([k, v]) => `${k}=${v}`)
        .join("\n")}\n`,
    );
    writeFileSync(join(dir, "userdata-qemu.img"), "앱·로그인 데이터");
    writeFileSync(join(avdHome, `${id}.ini`), `path=${dir}\ntarget=android-36\n`);
  }
  const small = {
    AvdId: "Size_Small_360dp",
    "avd.ini.displayname": "Small 360x760dp",
    "hw.lcd.width": "720",
    "hw.lcd.height": "1520",
    "hw.lcd.density": "320",
    "hw.keyboard": "yes",
    "image.sysdir.1": "system-images/android-36/google_apis_playstore/arm64-v8a/",
    "tag.id": "google_apis_playstore",
  };

  test("sources 는 비어 있다 — 이 Mac 의 AVD 가 있어도 원본으로 쓰지 않는다 (M1)", async () => {
    const { env } = sdkWithImages();
    sourceAvd(env.ANDROID_AVD_HOME, "Size_Small_360dp", small);
    expect(await driver(env, { runner: fakeAdb().runner }).sources()).toEqual([]);
  });

  test("list — 이 Mac 의 AVD 전부, 크기가 없으면 skin.name, 표시 이름이 없으면 ID 로 (R20)", async () => {
    const { env } = sdkWithImages();
    sourceAvd(env.ANDROID_AVD_HOME, "Size_Small_360dp", small);
    sourceAvd(env.ANDROID_AVD_HOME, "Pixel_6a", {
      AvdId: "Pixel_6a",
      "skin.name": "1080x2400",
      "hw.lcd.density": "420",
    });
    sourceAvd(env.ANDROID_AVD_HOME, "Broken", { AvdId: "Broken" });
    const list = await driver(env, { runner: fakeAdb().runner }).list();
    expect(list.sort((a, b) => a.native.localeCompare(b.native))).toEqual([
      {
        native: "Pixel_6a",
        name: "Pixel 6a",
        spec: { platform: "android", widthPx: 1080, heightPx: 2400, density: 420, systemImage: "" },
      },
      {
        native: "Size_Small_360dp",
        name: "Small 360x760dp",
        spec: {
          platform: "android",
          widthPx: 720,
          heightPx: 1520,
          density: 320,
          systemImage: "system-images/android-36/google_apis_playstore/arm64-v8a/",
        },
      },
    ]);
  });

  test("만든 AVD 는 이름을 바꿔도 ID 가 그대로이고, 지우면 사라진다 — 다른 AVD 는 그대로", async () => {
    const { env } = sdkWithImages();
    sourceAvd(env.ANDROID_AVD_HOME, "Size_Small_360dp", small);
    const d = driver(env, { runner: fakeAdb().runner });
    const source = (await d.presetSources()).find((p) => p.native === "profile:small-phone");
    if (!source) throw new Error("프로필 없음");
    const { native } = await d.create({ id: "ab12", name: "corgi Small", source }, () => {});
    expect(native).toBe("corgi_ab12");
    const dir = join(env.ANDROID_AVD_HOME, "corgi_ab12.avd");
    expect(readFileSync(join(dir, "config.ini"), "utf8")).toContain("AvdId=corgi_ab12");

    const device = { id: "ab12", native, name: "corgi Small", spec: source.spec } as Device;
    await d.rename(device, "작은 폰");
    const config = readFileSync(join(dir, "config.ini"), "utf8");
    expect(config).toContain("avd.ini.displayname=작은 폰");
    expect(config).toContain("AvdId=corgi_ab12");

    await d.remove(device);
    expect(existsSync(dir)).toBe(false);
    expect(
      existsSync(join(env.ANDROID_AVD_HOME, "Size_Small_360dp.avd", "userdata-qemu.img")),
    ).toBe(true);
  });

  test("boot — 빈 포트로 켜고 sys.boot_completed 까지 기다린다, 시리얼은 emulator-<포트>", async () => {
    const { env } = sdkWithImages();
    const adb = fakeAdb();
    adb.running.set("emulator-5554", { avd: "Pixel_6a", booted: true }); // 남의 에뮬레이터
    const spawned: string[][] = [];
    const d = driver(env, {
      runner: adb.runner,
      spawnEmulator: (command) => {
        spawned.push(command);
        const port = command[command.indexOf("-port") + 1];
        adb.running.set(`emulator-${port}`, { avd: "corgi_ab12", booted: false });
        setTimeout(
          () => adb.running.set(`emulator-${port}`, { avd: "corgi_ab12", booted: true }),
          10,
        );
        return { exited: new Promise(() => {}) };
      },
    });
    const device = { id: "ab12", native: "corgi_ab12", name: "작은 폰" } as Device;
    const state = await d.boot(device, () => {});
    expect(state).toEqual({ booted: true, targetId: "emulator-5556" });
    expect(spawned[0]).toContain("-avd");
    expect(spawned[0]).toContain("corgi_ab12");

    const states = await d.states([device]);
    expect(states.get("ab12")).toEqual({ booted: true, targetId: "emulator-5556" });

    await d.shutdown(device, state);
    expect(adb.running.has("emulator-5556")).toBe(false);
    expect(adb.running.has("emulator-5554")).toBe(true); // 남의 것은 그대로
  });

  test("boot — 에뮬레이터가 부팅 중에 끝나면 로그와 함께 실패", async () => {
    const { env } = sdkWithImages();
    const adb = fakeAdb();
    const d = driver(env, {
      runner: adb.runner,
      spawnEmulator: () => ({ exited: Promise.resolve(1) }),
    });
    const error = await d
      .boot({ id: "x", native: "corgi_x", name: "x" } as Device, () => {})
      .catch((e) => e);
    expect(String(error)).toContain("부팅 중에 끝났습니다");
  });

  test("slim — avdslim 이 없으면 TOOL_MISSING", async () => {
    const { env } = sdkWithImages();
    const error = await driver(env)
      .slim({ id: "x", native: "corgi_x", name: "x" } as Device, () => {})
      .catch((e) => e);
    expect(error).toMatchObject({ code: "TOOL_MISSING" });
  });
});

describe("AndroidDriver 슬림 확인", () => {
  const profiles = `📦 Media:\n   • app.a\n   • app.b\n   • app.c\n   • app.d\n🔒 GUARANTEED FUNCTIONAL (Never Disabled):\n   • core.x\n`;

  function runnerWith(installed: string[], disabled: string[]) {
    return async (command: string[]): Promise<RunResult> => {
      const line = command.join(" ");
      if (line === "/bin/avdslim profiles") return { code: 0, stdout: profiles, stderr: "" };
      const list = line.endsWith("packages -d")
        ? disabled
        : line.endsWith("packages")
          ? installed
          : [];
      return { code: 0, stdout: list.map((p) => `package:${p}\r`).join("\n"), stderr: "" };
    };
  }

  async function check(installed: string[], disabled: string[], booted = true) {
    const { env } = sdkWithImages();
    const d = driver(env, {
      runner: runnerWith(installed, disabled),
      avdslimPath: () => "/bin/avdslim",
    });
    return d.checkSlim(
      { id: "x" } as Device,
      booted ? { booted, targetId: "emulator-5554" } : { booted },
    );
  }

  test("설치된 프로필 패키지의 절반 이상이 꺼져 있으면 applied", async () => {
    expect(await check(["app.a", "app.b", "app.c", "core.x"], ["app.a", "app.b"])).toBe("applied");
  });

  test("절반 미만이면 drifted (풀림)", async () => {
    expect(await check(["app.a", "app.b", "app.c"], ["app.a"])).toBe("drifted");
  });

  test("핵심 목록(GUARANTEED 아래)은 세지 않고, 꺼져 있으면 알 수 없다", async () => {
    expect(await check(["core.x"], [])).toBeUndefined();
    expect(await check(["app.a"], ["app.a"], false)).toBeUndefined();
  });
});

describe("parseFootprint", () => {
  test("avdslim measure 의 Activity Monitor 메모리를 바이트로", async () => {
    const { parseFootprint } = await import("../src/server/drivers/android.ts");
    const text = "🖥️  HOST (macOS) Footprint:\n   Activity Monitor Memory (Footprint): 7583 MB\n";
    expect(parseFootprint(text)).toBe(7583 * 1024 * 1024);
    expect(parseFootprint("nothing")).toBeUndefined();
  });
});

describe("AndroidDriver 대표 프로필·직접 입력", () => {
  test("대표 프로필은 기본 이미지(4KB 페이지·API 높은 순)로, 폭별로 나온다", async () => {
    const { env } = sdkWithImages();
    const presets = await driver(env).presetSources();
    expect(presets.map((p) => p.native)).toContain("profile:medium-phone");
    expect(
      presets.every(
        (p) => p.spec.platform === "android" && p.spec.systemImage.includes("android-36/"),
      ),
    ).toBe(true);
    const small = presets.find((p) => p.native === "profile:small-phone");
    expect(small?.spec).toMatchObject({ widthPx: 720, heightPx: 1280, density: 320 });
  });

  test("직접 입력은 dp·밀도에서 px 를 계산하고, 이미지를 고를 수 있다", async () => {
    const { env } = sdkWithImages();
    const source = await driver(env).customSource({
      widthDp: 375,
      heightDp: 812,
      density: 420,
      systemImage: "android-37.1",
    });
    expect(source).toMatchObject({
      native: "custom:375x812@420",
      spec: {
        widthPx: 984,
        heightPx: 2132,
        density: 420,
        systemImage: expect.stringContaining("android-37.1"),
      },
    });
  });

  test("프로필로 만들면 원본 없이 새 config.ini 를 쓴다", async () => {
    const { env } = sdkWithImages();
    const d = driver(env, { runner: fakeAdb().runner });
    const source = (await d.presetSources()).find((p) => p.native === "profile:tablet-7");
    if (!source) throw new Error("프로필 없음");
    await d.create({ id: "tb01", name: "corgi 7 inch Tablet", source }, () => {});
    const config = readFileSync(join(env.ANDROID_AVD_HOME, "corgi_tb01.avd", "config.ini"), "utf8");
    expect(config).toContain("hw.lcd.width=1200");
    expect(config).toContain("hw.lcd.density=320");
    expect(config).toContain(
      "image.sysdir.1=system-images/android-36/google_apis_playstore/arm64-v8a/",
    );
    expect(readFileSync(join(env.ANDROID_AVD_HOME, "corgi_tb01.ini"), "utf8")).toContain(
      "target=android-36",
    );
  });
});
