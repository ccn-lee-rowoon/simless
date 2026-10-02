import { describe, expect, test } from "bun:test";
import { IosDriver } from "../src/server/drivers/ios.ts";
import type { RunResult } from "../src/server/exec.ts";
import { Config } from "../src/shared/config.ts";
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
  enabled: true,
  slim: "none",
  createdAt: "2026-10-02T00:00:00.000Z",
};

describe("IosDriver", () => {
  test("catalog — iPhone·iPad 만, 기기 종류마다 가장 새 런타임으로, 폭은 pt", async () => {
    const { runner } = fakeRunner();
    const items = await new IosDriver(config, runner, () => "/bin/simslim").catalog();
    expect(items).toHaveLength(1); // 워치·지원 런타임 없는 기기는 빠진다
    expect(items[0]).toMatchObject({
      suggestedName: "iPhone 17 402pt",
      preset: true,
      spec: { runtimeId: "rt.26-5", widthPt: 402, heightPt: 874, scale: 3 },
    });
  });

  test("resolveSpec — 이름으로 찾고, 런타임은 버전으로 고를 수 있다", async () => {
    const { runner } = fakeRunner();
    const driver = new IosDriver(config, runner, () => undefined);
    expect(
      await driver.resolveSpec({ platform: "ios", deviceType: "iphone 17", runtime: "26.0" }),
    ).toMatchObject({
      runtimeId: "rt.26-0",
    });
    const missing = await driver
      .resolveSpec({ platform: "ios", deviceType: "iPhone 99" })
      .catch((e) => e);
    expect(missing).toMatchObject({ code: "NOT_FOUND" });
  });

  test("create — simctl create 가 준 UDID 가 native", async () => {
    const { runner, calls } = fakeRunner({ "xcrun simctl create": { stdout: "NEW-UDID\n" } });
    const result = await new IosDriver(config, runner).create(
      { name: "작은 폰", spec: device.spec },
      () => {},
    );
    expect(result.native).toBe("NEW-UDID");
    expect(calls).toContain("xcrun simctl create 작은 폰 dt.iphone-17 rt.26-5");
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
