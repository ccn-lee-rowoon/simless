import { describe, expect, test } from "bun:test";
import { IosDriver } from "../src/server/drivers/ios.ts";
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
  slim: "none",
  createdAt: "2026-10-02T00:00:00.000Z",
};

describe("IosDriver", () => {
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
    expect(await driver.list()).toEqual([
      { native: "U-17", name: "iPhone 17", spec: expect.objectContaining({ widthPt: 402 }) },
    ]);
    const sources = await driver.sources();
    expect(sources).toHaveLength(1); // 워치·쓸 수 없는 것·없는 런타임은 빠진다
    expect(sources[0]).toMatchObject({
      native: "U-17",
      name: "iPhone 17",
      booted: true,
      spec: {
        deviceTypeId: "dt.iphone-17",
        runtimeId: "rt.26-5",
        widthPt: 402,
        heightPt: 874,
        scale: 3,
      },
    });
  });

  test("create — 원본과 같은 기기 종류·런타임으로 새로 만든다 (clone 아님), UDID 가 native", async () => {
    const { runner, calls } = fakeRunner({ "xcrun simctl create": { stdout: "NEW-UDID\n" } });
    const source = {
      platform: "ios" as const,
      native: "U-17",
      name: "iPhone 17",
      spec: device.spec,
      detail: "",
      booted: true,
    };
    const result = await new IosDriver(config, runner).create(
      { name: "corgi iPhone 17", source },
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
