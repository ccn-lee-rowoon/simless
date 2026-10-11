import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AndroidDriver,
  type AndroidDriverOptions,
  parseAvdslimProfiles,
} from "../src/server/drivers/android.ts";
import {
  mergeProfiles,
  parseDeviceDefinitions,
  profileId,
} from "../src/server/drivers/android-profiles.ts";
import { Config } from "../src/shared/config.ts";
import type { RunResult } from "../src/shared/exec.ts";
import type { Device } from "../src/shared/model.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function sdkWithImages() {
  const root = mkdtempSync(join(tmpdir(), "simless-android-"));
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
    // 진짜 Android Studio 를 읽지 않는다 — 대표 프로필만
    deviceDefinitions: async () => ({ user: [], studio: [] }),
    isPortFree: async () => true,
    pollMs: 1,
    ...extra,
  });
}

describe("AndroidDriver — 만들기·켜기·슬림 (R1·R4·R5·R7)", () => {
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

  test("만든 AVD 는 지우면 사라진다 — 다른 AVD 는 그대로", async () => {
    const { env } = sdkWithImages();
    sourceAvd(env.ANDROID_AVD_HOME, "Size_Small_360dp", small);
    const d = driver(env, { runner: fakeAdb().runner });
    const { spec } = await d.resolve({ model: "small-phone" });
    const { native } = await d.create({ id: "ab12", name: "simless Small", spec }, () => {});
    expect(native).toBe("simless_ab12");
    const dir = join(env.ANDROID_AVD_HOME, "simless_ab12.avd");
    expect(readFileSync(join(dir, "config.ini"), "utf8")).toContain("AvdId=simless_ab12");

    const device = { id: "ab12", native, name: "simless Small", spec } as Device;
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
        adb.running.set(`emulator-${port}`, { avd: "simless_ab12", booted: false });
        setTimeout(
          () => adb.running.set(`emulator-${port}`, { avd: "simless_ab12", booted: true }),
          10,
        );
        return { exited: new Promise(() => {}) };
      },
    });
    const device = { id: "ab12", native: "simless_ab12", name: "작은 폰" } as Device;
    const state = await d.boot(device, () => {});
    expect(state).toEqual({ booted: true, targetId: "emulator-5556" });
    expect(spawned[0]).toContain("-avd");
    expect(spawned[0]).toContain("simless_ab12");

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
      .boot({ id: "x", native: "simless_x", name: "x" } as Device, () => {})
      .catch((e) => e);
    expect(String(error)).toContain("exited while booting");
  });

  test("slim — avdslim 이 없으면 TOOL_MISSING", async () => {
    const { env } = sdkWithImages();
    const error = await driver(env)
      .slim({ id: "x", native: "simless_x", name: "x" } as Device, () => {})
      .catch((e) => e);
    expect(error).toMatchObject({ code: "TOOL_MISSING" });
  });
});

describe("AndroidDriver 슬림 확인 (M6)", () => {
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

describe("AndroidDriver 커스텀 슬림 (M15)", () => {
  const profiles = `📦 Media & Apps:\n   • app.a\n   • app.z\n📦 Search:\n   • app.s\n🔒 GUARANTEED FUNCTIONAL (Never Disabled):\n   ✓ Core\n`;
  const device = {
    id: "x",
    native: "simless_x",
    name: "x",
    slim: "applied",
    slimKeep: ["media-apps", "location", "setup", "camera"],
  } as Device;

  function setup(installed: string[], disabled: string[]) {
    const calls: string[] = [];
    const runner = async (command: string[]): Promise<RunResult> => {
      const line = command.join(" ");
      calls.push(line);
      if (line === "/bin/avdslim profiles") return { code: 0, stdout: profiles, stderr: "" };
      const list = line.endsWith("packages -d")
        ? disabled
        : line.endsWith("packages")
          ? installed
          : [];
      return { code: 0, stdout: list.map((p) => `package:${p}\r`).join("\n"), stderr: "" };
    };
    const { env } = sdkWithImages();
    return { calls, d: driver(env, { runner, avdslimPath: () => "/bin/avdslim" }) };
  }

  test("고를 수 있는 항목 — 패키지 묶음 + 기기 설정 + 하드웨어", async () => {
    const { d } = setup([], []);
    const items = await d.slimItems();
    expect(items.map((i) => `${i.kind}:${i.id}`)).toEqual([
      "packages:media-apps",
      "packages:search",
      "settings:location",
      "settings:sync",
      "settings:bglimit",
      "settings:bluetooth",
      "settings:setup",
      "host:camera",
      "host:audio",
    ]);
  });

  test("기기 안 정리 — 남길 설정은 --skip 뒤 되돌리고, 남길 묶음의 설치된 패키지를 다시 켠다", async () => {
    const { d, calls } = setup(["app.a", "app.s"], []);
    await d.afterBoot?.(device, { booted: true, targetId: "emulator-5554" }, () => {});
    const avdslim = calls.filter((c) => c.startsWith("/bin/avdslim ") && !c.endsWith("profiles"));
    expect(avdslim).toEqual([
      "/bin/avdslim on emulator-5554 --skip=location,setup",
      "/bin/avdslim enable location emulator-5554", // setup 은 되돌리는 명령이 없다
      "/bin/avdslim enable app.a emulator-5554", // app.z 는 설치돼 있지 않다
    ]);
  });

  test("하드웨어 — tune-avd 뒤 남길 카메라를 다시 켜고, 소리를 남기면 -no-audio 없이 켠다", async () => {
    const calls: string[] = [];
    const spawned: string[][] = [];
    const adb = fakeAdb();
    const runner = async (command: string[]): Promise<RunResult> => {
      calls.push(command.join(" "));
      if (command[0] === "/bin/avdslim") return { code: 0, stdout: "", stderr: "" };
      return adb.runner(command);
    };
    const { env } = sdkWithImages();
    const d = driver(env, {
      runner,
      avdslimPath: () => "/bin/avdslim",
      spawnEmulator: (command) => {
        spawned.push(command);
        const port = command[command.indexOf("-port") + 1];
        adb.running.set(`emulator-${port}`, { avd: "simless_x", booted: true });
        return { exited: new Promise(() => {}) };
      },
    });
    const keepHw = { ...device, slimKeep: ["camera", "audio"] } as Device;
    await d.slim(keepHw, () => {});
    expect(calls.filter((c) => c.startsWith("/bin/avdslim enable"))).toEqual([
      "/bin/avdslim enable camera simless_x",
      "/bin/avdslim enable audio simless_x",
    ]);
    await d.boot(keepHw, () => {});
    expect(spawned[0]).not.toContain("-no-audio");
    await d.boot({ ...device, id: "y", native: "simless_y", slimKeep: [] } as Device, () => {});
    expect(spawned[1]).toContain("-no-audio");
  });

  test("slimOff — 묶음은 설치된 패키지 절반 이상 꺼짐, 설정은 기기 값, 읽을 수 없는 것은 남긴 항목으로 (M16)", async () => {
    const settings: Record<string, string> = {
      "secure location_mode": "0",
      "global bluetooth_on": "1",
      "global auto_sync": "0",
    };
    const runner = async (command: string[]): Promise<RunResult> => {
      const line = command.join(" ");
      if (line === "/bin/avdslim profiles") return { code: 0, stdout: profiles, stderr: "" };
      const setting = /settings get (\w+ \w+)$/.exec(line)?.[1];
      if (setting) return { code: 0, stdout: `${settings[setting] ?? "null"}\n`, stderr: "" };
      const list = line.endsWith("packages -d")
        ? ["app.s"]
        : line.endsWith("packages")
          ? ["app.a", "app.s"]
          : [];
      return { code: 0, stdout: list.map((p) => `package:${p}\r`).join("\n"), stderr: "" };
    };
    const { env } = sdkWithImages();
    const d = driver(env, { runner, avdslimPath: () => "/bin/avdslim" });
    // media-apps 는 설치된 app.a 가 켜져 있어 남음, search 는 꺼짐. 위치·동기화 꺼짐, 블루투스 켜짐.
    // 백그라운드 제한은 남기기로 했고 초기 설정은 슬림. 소리는 -no-audio 로 켜므로 꺼짐
    const keepBg = { ...device, slimKeep: ["bglimit"] } as Device;
    expect(await d.slimOff(keepBg, { booted: true, targetId: "emulator-5554" })).toEqual([
      "search",
      "location",
      "sync",
      "setup",
      "audio",
    ]);
    expect(await d.slimOff(keepBg, { booted: false })).toBeUndefined();
  });

  test("슬림 확인은 남긴 패키지를 세지 않는다", async () => {
    const { d } = setup(["app.a", "app.z", "app.s"], ["app.s"]);
    expect(await d.checkSlim(device, { booted: true, targetId: "emulator-5554" })).toBe("applied");
  });
});

describe("parseFootprint — 메모리 (M10)", () => {
  test("avdslim measure 의 Activity Monitor 메모리를 바이트로", async () => {
    const { parseFootprint } = await import("../src/server/drivers/android.ts");
    const text = "🖥️  HOST (macOS) Footprint:\n   Activity Monitor Memory (Footprint): 7583 MB\n";
    expect(parseFootprint(text)).toBe(7583 * 1024 * 1024);
    expect(parseFootprint("nothing")).toBeUndefined();
  });
});

describe("Android Studio 기기 정의 (M1)", () => {
  const studio = `<?xml version="1.0"?>
<d:devices xmlns:d="http://schemas.android.com/sdk/devices/7">
  <d:device>
    <d:name>Pixel 9</d:name>
    <d:hardware><d:screen><d:pixel-density>420dpi</d:pixel-density>
      <d:dimensions><d:x-dimension>1080</d:x-dimension><d:y-dimension>2424</d:y-dimension></d:dimensions>
    </d:screen></d:hardware>
    <d:id>pixel_9</d:id>
  </d:device>
  <d:device deprecated="true">
    <d:name>Nexus 9</d:name>
    <d:hardware><d:screen><d:pixel-density>xhdpi</d:pixel-density>
      <d:dimensions><d:x-dimension>2048</d:x-dimension><d:y-dimension>1536</d:y-dimension></d:dimensions>
    </d:screen></d:hardware>
    <d:id>Nexus 9</d:id>
  </d:device>
  <d:device>
    <d:name>Medium Phone</d:name>
    <d:hardware><d:screen><d:pixel-density>420dpi</d:pixel-density>
      <d:dimensions><d:x-dimension>1080</d:x-dimension><d:y-dimension>2400</d:y-dimension></d:dimensions>
    </d:screen></d:hardware>
    <d:id>medium_phone</d:id>
  </d:device>
  <d:device>
    <d:name>Wear OS Small Round</d:name>
    <d:hardware><d:screen><d:pixel-density>hdpi</d:pixel-density>
      <d:dimensions><d:x-dimension>384</d:x-dimension><d:y-dimension>384</d:y-dimension></d:dimensions>
    </d:screen></d:hardware>
    <d:id>wearos_small_round</d:id>
    <d:tag-id>android-wear</d:tag-id>
  </d:device>
</d:devices>`;

  test("폰·태블릿을 세로 기준으로 꺼내고, 밀도 이름은 dpi 로, 워치·TV 등은 뺀다", () => {
    expect(parseDeviceDefinitions(studio)).toEqual([
      { id: "pixel-9", name: "Pixel 9", widthPx: 1080, heightPx: 2424, density: 420 },
      { id: "nexus-9", name: "Nexus 9", widthPx: 1536, heightPx: 2048, density: 320 },
      { id: "medium-phone", name: "Medium Phone", widthPx: 1080, heightPx: 2400, density: 420 },
    ]);
    expect(profileId("pixel_9_pro_xl")).toBe("pixel-9-pro-xl");
  });

  test("사람이 만든 정의 → Android Studio → 대표 프로필 순으로, 같은 ID 는 앞의 것", () => {
    const user = [{ id: "pixel-9", name: "My Pixel 9", widthPx: 1, heightPx: 2, density: 3 }];
    const merged = mergeProfiles(user, parseDeviceDefinitions(studio), [
      { id: "small-320", name: "Small Phone 320dp", widthPx: 480, heightPx: 854, density: 240 },
    ]);
    expect(merged.map((p) => `${p.id}:${p.name}`)).toEqual([
      "pixel-9:My Pixel 9",
      "nexus-9:Nexus 9",
      "medium-phone:Medium Phone",
      "small-320:Small Phone 320dp",
    ]);
  });

  test("catalog·resolve 가 Android Studio 의 기종을 쓴다 — 없으면 대표 프로필만", async () => {
    const { env } = sdkWithImages();
    const d = driver(env, { deviceDefinitions: async () => ({ user: [], studio: [studio] }) });
    const catalog = await d.catalog();
    expect(catalog.models.find((m) => m.id === "pixel-9")).toMatchObject({
      name: "Pixel 9",
      layoutWidth: 411,
      form: "phone",
    });
    expect(catalog.models.find((m) => m.id === "nexus-9")?.form).toBe("tablet");
    expect(catalog.models.some((m) => m.id === "small-320")).toBe(true); // 대표 프로필도 남는다
    expect((await d.resolve({ model: "Pixel 9" })).spec).toMatchObject({
      widthPx: 1080,
      density: 420,
    });
    const plain = await driver(env).catalog();
    expect(plain.models.some((m) => m.id === "pixel-9")).toBe(false);
  });
});

describe("AndroidDriver 기종 목록·만들기 (R1·R2·M1)", () => {
  test("catalog — 대표 프로필(폭 dp), 시스템 이미지(4KB 페이지·API 높은 순이 기본), 직접 입력 가능", async () => {
    const { env } = sdkWithImages();
    const catalog = await driver(env).catalog();
    expect(catalog.custom).toBe(true);
    expect(catalog.models.find((m) => m.id === "medium-phone")).toMatchObject({
      layoutWidth: 411,
      form: "phone",
    });
    expect(catalog.models.find((m) => m.id === "medium-tablet")?.form).toBe("tablet");
    expect(catalog.os[0]).toMatchObject({
      recommended: true,
      id: expect.stringContaining("android-36/"),
    });
  });

  test("resolve — 직접 입력은 dp·밀도에서 px 를 계산하고, 이미지를 고를 수 있다", async () => {
    const { env } = sdkWithImages();
    const { spec, modelName } = await driver(env).resolve({
      custom: { widthDp: 375, heightDp: 812, density: 420 },
      os: "android-37.1",
    });
    expect(modelName).toBe("Android 375dp");
    expect(spec).toMatchObject({
      widthPx: 984,
      heightPx: 2132,
      density: 420,
      systemImage: expect.stringContaining("android-37.1"),
    });
  });

  test("resolve — 없는 프로필·이미지는 NOT_FOUND", async () => {
    const { env } = sdkWithImages();
    const d = driver(env);
    expect(await d.resolve({ model: "nope" }).catch((e) => e)).toMatchObject({ code: "NOT_FOUND" });
    expect(
      await d.resolve({ model: "small-phone", os: "android-99" }).catch((e) => e),
    ).toMatchObject({ code: "NOT_FOUND" });
  });

  test("프로필로 만들면 새 config.ini 를 쓴다", async () => {
    const { env } = sdkWithImages();
    const d = driver(env, { runner: fakeAdb().runner });
    const { spec } = await d.resolve({ model: "7 inch Tablet" });
    await d.create({ id: "tb01", name: "simless 7 inch Tablet", spec }, () => {});
    const config = readFileSync(
      join(env.ANDROID_AVD_HOME, "simless_tb01.avd", "config.ini"),
      "utf8",
    );
    expect(config).toContain("hw.lcd.width=1200");
    expect(config).toContain("hw.lcd.density=320");
    expect(config).toContain(
      "image.sysdir.1=system-images/android-36/google_apis_playstore/arm64-v8a/",
    );
    expect(readFileSync(join(env.ANDROID_AVD_HOME, "simless_tb01.ini"), "utf8")).toContain(
      "target=android-36",
    );
  });
});

describe("parseAvdslimProfiles (M4)", () => {
  test("꺼지는 묶음과 패키지 수, 끄지 않는 것 — 공격적 모드는 뺀다 (M4 ⓘ)", () => {
    const text = [
      "📋 AVD-SLIM Slimming Categories & Packages:",
      "",
      "📦 Assistant & Search (~250-400 MB RAM):",
      "   • com.google.android.googlequicksearchbox",
      "   • com.google.android.as",
      "",
      "📦 Printing & Background Spoolers (~30-60 MB RAM):",
      "   • com.android.printspooler",
      "",
      "🔥 Aggressive Mode Additional Packages (via `avdslim on --aggressive`):",
      "   • com.android.vending",
      "",
      "🔒 GUARANTEED FUNCTIONAL (Never Disabled):",
      "   ✓ Core Android OS & SystemUI",
      "   ✓ Flutter / React Native / Native APK execution",
    ].join("\n");
    const parsed = parseAvdslimProfiles(text);
    expect(parsed.off).toEqual([
      { id: "assistant-search", kind: "packages", name: "Assistant & Search", count: 2 },
      {
        id: "printing-background-spoolers",
        kind: "packages",
        name: "Printing & Background Spoolers",
        count: 1,
      },
    ]);
    expect(parsed.keeps).toEqual([
      "Core Android OS & SystemUI",
      "Flutter / React Native / Native APK execution",
    ]);
    // 남길 묶음의 패키지를 다시 켤 때 쓴다 (M15)
    expect(parsed.packages.get("assistant-search")).toEqual([
      "com.google.android.googlequicksearchbox",
      "com.google.android.as",
    ]);
  });
});
