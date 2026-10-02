import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { CorgiServer } from "../src/server/app.ts";
import { listen } from "../src/server/socket.ts";
import type { DeviceOpResult, DeviceView } from "../src/shared/api.ts";
import { call } from "../src/shared/client.ts";
import { VERSION } from "../src/shared/version.ts";
import { fakeDriver, session, tempEnv } from "./helpers.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
});

async function start() {
  const env = tempEnv();
  const driver = fakeDriver();
  const server = new CorgiServer({ ...env, drivers: [driver] });
  const listener = await listen(env.paths.socket, VERSION, server.handle);
  cleanups.push(() => listener.stop(), env.cleanup);
  /** 결과 또는 오류(code·message)를 그대로 돌려준다 — 테스트에서 둘 다 본다 */
  const as =
    (key: string) =>
    // biome-ignore lint/suspicious/noExplicitAny: 테스트 편의 — 결과와 오류를 같은 값으로 받는다
    (method: string, params: unknown = {}): Promise<any> =>
      call(env.paths.socket, method, params, session(key))
        .then((r) => r.result)
        .catch((e: unknown) => e);
  return { server, driver, env, A: as("A"), B: as("B") };
}

const android360 = { request: { platform: "android", widthDp: 360 } };

describe("디바이스 명령", () => {
  test("만들면 기본 이름·슬림 적용, 같은 크기는 다시 못 만든다 (M3·M4·R5)", async () => {
    const { A } = await start();
    const device = (await A("device.create", android360)) as DeviceView;
    expect(device).toMatchObject({
      name: "Android 360dp",
      slim: "applied",
      label: "Android 360dp",
      enabled: true,
    });
    expect(await A("device.create", android360)).toMatchObject({ code: "INVALID" });
  });

  test("--no-slim 이면 슬림 미적용", async () => {
    const { A } = await start();
    expect(await A("device.create", { ...android360, slim: false })).toMatchObject({
      slim: "none",
    });
  });

  test("켜기는 점유가 있어야 한다 — 없으면 NOT_HELD, 점유하면 켜지고 argent ID 가 나온다", async () => {
    const { A } = await start();
    const device = (await A("device.create", android360)) as DeviceView;
    expect(await A("device.up", { devices: [device.id] })).toMatchObject({ code: "NOT_HELD" });

    await A("lease.acquire", { devices: [device.id] });
    const up: { results: DeviceOpResult[]; devices: DeviceView[] } = await A("device.up");
    expect(up.results).toEqual([{ id: device.id, name: device.name, ok: true }]);
    expect(up.devices[0]).toMatchObject({
      booted: true,
      mine: true,
      targetId: expect.stringMatching(/^emulator-/),
    });
  });

  test("다른 세션이 쓰는 중이면 이름 변경·삭제를 막는다 (M8·P1)", async () => {
    const { A, B } = await start();
    const device = (await A("device.create", android360)) as DeviceView;
    await A("lease.acquire", { devices: [device.id] });
    expect(await B("device.rename", { device: device.id, name: "x" })).toMatchObject({
      code: "BUSY",
    });
    expect(await B("device.delete", { device: device.id })).toMatchObject({ code: "BUSY" });
    expect(await A("device.rename", { device: device.id, name: "작은 폰" })).toMatchObject({
      name: "작은 폰",
    });
  });

  test("삭제하면 켜져 있던 것은 끄고 목록·점유에서 빠진다", async () => {
    const { A, server, driver } = await start();
    const device = (await A("device.create", android360)) as DeviceView;
    await A("lease.acquire", { devices: [device.id] });
    await A("device.up");
    expect(driver.booted.has(device.id)).toBe(true);
    await A("device.delete", { device: device.id });
    expect(driver.booted.has(device.id)).toBe(false);
    expect(server.registry.list()).toEqual([]);
    expect(server.leases.heldBy("A")).toEqual([]);
  });

  test("사용 안 함은 «전부» 점유에서 빠진다 (R6)", async () => {
    const { A } = await start();
    const a = (await A("device.create", android360)) as DeviceView;
    const b = (await A("device.create", {
      request: { platform: "android", widthDp: 412 },
    })) as DeviceView;
    await A("device.setEnabled", { device: b.id, enabled: false });
    expect(await A("lease.acquire", {})).toEqual({ status: "granted", deviceIds: [a.id] });
  });

  test("관리 디바이스 목록 파일을 남긴다 — 서버가 꺼졌을 때 훅이 읽는다 (P9)", async () => {
    const { A, env } = await start();
    const device = (await A("device.create", android360)) as DeviceView;
    await A("device.list");
    expect(existsSync(env.paths.managedIndex)).toBe(true);
    const index = JSON.parse(readFileSync(env.paths.managedIndex, "utf8"));
    expect(index.devices[0]).toMatchObject({ id: device.id, native: `corgi_${device.id}` });
  });
});
