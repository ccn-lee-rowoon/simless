import { describe, expect, test } from "bun:test";
import { IosDriver, parseSimslimProfiles } from "../src/server/drivers/ios.ts";
import { Config } from "../src/shared/config.ts";
import type { RunResult } from "../src/shared/exec.ts";
import type { Device } from "../src/shared/model.ts";

const deviceTypes = [
  {
    identifier: "dt.iphone-17",
    name: "iPhone 17",
    productFamily: "iPhone",
    bundlePath: "/DT/iPhone 17.simdevicetype",
  },
  {
    identifier: "dt.watch",
    name: "Apple Watch",
    productFamily: "Apple Watch",
    bundlePath: "/DT/w",
  },
  {
    identifier: "dt.old",
    name: "iPhone 8",
    productFamily: "iPhone",
    bundlePath: "/DT/iPhone 8.simdevicetype",
  },
];
const runtimes = [
  {
    identifier: "rt.26-0",
    name: "iOS 26.0",
    version: "26.0",
    platform: "iOS",
    isAvailable: true,
    supportedDeviceTypes: [{ identifier: "dt.iphone-17", name: "iPhone 17" }],
  },
  {
    identifier: "rt.26-5",
    name: "iOS 26.5",
    version: "26.5",
    platform: "iOS",
    isAvailable: true,
    supportedDeviceTypes: [{ identifier: "dt.iphone-17", name: "iPhone 17" }],
  },
];

/** 명령 문자열 → 결과. 호출 기록을 남긴다 */
function fakeRunner(overrides: Record<string, Partial<RunResult>> = {}) {
  const calls: string[] = [];
  const runner = async (command: string[]): Promise<RunResult> => {
    const line = command.join(" ");
    calls.push(line);
    const override = Object.entries(overrides).find(([prefix]) => line.startsWith(prefix))?.[1];
    if (override) return { code: 0, stdout: "", stderr: "", ...override };
    if (line === "xcrun simctl list -j devicetypes") return ok({ devicetypes: deviceTypes });
    if (line === "xcrun simctl list -j runtimes") return ok({ runtimes });
    if (line.startsWith("plutil"))
      return ok({ mainScreenWidth: 1206, mainScreenHeight: 2622, mainScreenScale: 3 });
    return { code: 0, stdout: "", stderr: "" };
  };
  return { runner, calls };
}
function ok(json: unknown): RunResult {
  return { code: 0, stdout: JSON.stringify(json), stderr: "" };
}

const config = Config.parse({});
const device: Device = {
  id: "abcd",
  name: "iPhone 17 402pt",
  native: "UDID-1",
  spec: {
    platform: "ios",
    deviceTypeId: "dt.iphone-17",
    deviceTypeName: "iPhone 17",
    runtimeId: "rt.26-5",
    runtimeName: "iOS 26.5",
    widthPt: 402,
    heightPt: 874,
    scale: 3,
  },
  platform: "ios",
  createdByCorgi: true,
  listed: true,
  slim: "none",
  createdAt: "2026-10-02T00:00:00.000Z",
};

describe("IosDriver — 만들기·켜기·슬림 (R1·R4·R5·R7)", () => {
  test("list·sources — 이 Mac 의 iPhone·iPad 시뮬레이터, 폭은 기기 종류 프로필의 pt", async () => {
    const devices = {
      "rt.26-5": [
        {
          udid: "U-17",
          name: "iPhone 17",
          state: "Booted",
          isAvailable: true,
          deviceTypeIdentifier: "dt.iphone-17",
        },
        {
          udid: "U-W",
          name: "Watch",
          state: "Shutdown",
          isAvailable: true,
          deviceTypeIdentifier: "dt.watch",
        },
        {
          udid: "U-X",
          name: "Broken",
          state: "Shutdown",
          isAvailable: false,
          deviceTypeIdentifier: "dt.iphone-17",
        },
      ],
      "rt.gone": [
        {
          udid: "U-G",
          name: "Old",
          state: "Shutdown",
          isAvailable: true,
          deviceTypeIdentifier: "dt.iphone-17",
        },
      ],
    };
    const { runner } = fakeRunner({
      "xcrun simctl list -j devices": { stdout: JSON.stringify({ devices }) },
    });
    const driver = new IosDriver(config, runner, () => "/bin/simslim");
    // 워치·쓸 수 없는 것·없는 런타임은 빠진다
    expect(await driver.list()).toEqual([
      {
        native: "U-17",
        name: "iPhone 17",
        spec: expect.objectContaining({
          deviceTypeId: "dt.iphone-17",
          runtimeId: "rt.26-5",
          widthPt: 402,
          heightPt: 874,
          scale: 3,
        }),
      },
    ]);
  });

  test("catalog — 런타임이 지원하는 iPhone·iPad 기종, 최신 런타임이 기본", async () => {
    const { runner } = fakeRunner();
    const catalog = await new IosDriver(config, runner, () => undefined).catalog();
    // iPhone 8 은 지원하는 런타임이 없고, 워치는 iPhone·iPad 가 아니다
    expect(catalog.models).toEqual([
      expect.objectContaining({
        id: "dt.iphone-17",
        form: "phone",
        layoutWidth: 402,
        os: ["rt.26-5", "rt.26-0"],
      }),
    ]);
    expect(catalog.os.map((o) => [o.id, o.recommended])).toEqual([
      ["rt.26-5", true],
      ["rt.26-0", false],
    ]);
    expect(catalog.custom).toBe(false);
  });

  test("resolve — 이름·ID 로 기종을, 버전·이름으로 런타임을 고른다", async () => {
    const { runner } = fakeRunner();
    const driver = new IosDriver(config, runner);
    expect((await driver.resolve({ model: "iPhone 17" })).spec).toMatchObject({
      runtimeId: "rt.26-5",
    });
    expect((await driver.resolve({ model: "dt.iphone-17", os: "26.0" })).spec).toMatchObject({
      runtimeId: "rt.26-0",
    });
    expect(await driver.resolve({ model: "iPhone 8" }).catch((e) => e)).toMatchObject({
      code: "NOT_FOUND",
    });
  });

  test("create — 기기 종류·런타임으로 새로 만든다 (clone 아님), UDID 가 native", async () => {
    const { runner, calls } = fakeRunner({ "xcrun simctl create": { stdout: "NEW-UDID\n" } });
    const result = await new IosDriver(config, runner).create(
      { name: "corgi iPhone 17", spec: device.spec },
      () => {},
    );
    expect(result.native).toBe("NEW-UDID");
    expect(calls).toContain("xcrun simctl create corgi iPhone 17 dt.iphone-17 rt.26-5");
    expect(calls.some((c) => c.includes("clone"))).toBe(false);
  });

  test("boot — 여러 대를 요청해도 한 대씩 순서대로 켠다", async () => {
    const order: string[] = [];
    const runner = async (command: string[]): Promise<RunResult> => {
      const line = command.join(" ");
      if (line.includes(" boot ")) order.push(`start ${command.at(-1)}`);
      if (line.includes("bootstatus")) {
        await Bun.sleep(20);
        order.push(`done ${command.at(-1)}`);
      }
      return { code: 0, stdout: "", stderr: "" };
    };
    const driver = new IosDriver(config, runner);
    await Promise.all([
      driver.boot({ ...device, native: "U1" }, () => {}),
      driver.boot({ ...device, native: "U2" }, () => {}),
    ]);
    expect(order).toEqual(["start U1", "done U1", "start U2", "done U2"]);
  });

  test("이미 켜져 있으면 boot 오류를 무시한다", async () => {
    const { runner } = fakeRunner({
      "xcrun simctl boot UDID-1": {
        code: 149,
        stderr: "Unable to boot device in current state: Booted",
      },
    });
    expect(await new IosDriver(config, runner).boot(device, () => {})).toEqual({
      booted: true,
      targetId: "UDID-1",
    });
  });

  test("slim — simslim 이 없으면 TOOL_MISSING", async () => {
    const { runner } = fakeRunner();
    const error = await new IosDriver(config, runner, () => undefined)
      .slim(device, () => {})
      .catch((e) => e);
    expect(error).toMatchObject({ code: "TOOL_MISSING" });
  });

  test("slim — 꺼진 기기는 원래 상태로 돌려놓는 옵션으로 적용", async () => {
    const { runner, calls } = fakeRunner();
    await new IosDriver(config, runner, () => "/bin/simslim").slim(device, () => {});
    expect(calls).toContain("/bin/simslim on UDID-1 --preserve-boot-state");
  });

  test("checkSlim — 켜져 있을 때만 verify 결과로 판단", async () => {
    const { runner } = fakeRunner({ "/bin/simslim verify": { code: 1 } });
    const driver = new IosDriver(config, runner, () => "/bin/simslim");
    expect(await driver.checkSlim(device, { booted: false })).toBeUndefined();
    expect(await driver.checkSlim(device, { booted: true })).toBe("drifted");
  });
});

describe("parseSimslimProfiles", () => {
  test("묶음 이름과 «When disabled» 설명, 늘 켜 두는 것 (M4 ⓘ)", () => {
    const text = [
      "siri           Siri & Intelligence",
      "               29 daemons · ~265 MB idle footprint when enabled",
      "               When disabled: Siri, speech features, and Apple Intelligence services are unavailable.",
      "connectivity   Sharing & Device Connectivity",
      "               When disabled: AirDrop and Continuity will not work.",
      "               Always on: com.apple.sharingd — Required for system share sheets.",
      "",
      "170 daemons across 15 categories. Core workflow and deadlock-prone daemons are never disabled.",
    ].join("\n");
    expect(parseSimslimProfiles(text)).toEqual({
      off: [
        {
          name: "Siri & Intelligence",
          detail: "Siri, speech features, and Apple Intelligence services are unavailable.",
        },
        {
          name: "Sharing & Device Connectivity",
          detail: "AirDrop and Continuity will not work.",
        },
      ],
      keeps: ["Required for system share sheets."],
    });
  });
});
