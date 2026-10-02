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
    (key: string, human = false) =>
    // biome-ignore lint/suspicious/noExplicitAny: 테스트 편의 — 결과와 오류를 같은 값으로 받는다
    (method: string, params: unknown = {}): Promise<any> =>
      call(env.paths.socket, method, params, session(key, { human }))
        .then((r) => r.result)
        .catch((e: unknown) => e);
  return { server, driver, env, A: as("A"), B: as("B"), H: as("web", true) };
}

const android360 = { source: "Small_360" };

describe("디바이스 명령", () => {
  test("만들면 기본 이름·슬림 적용, 같은 크기는 다시 못 만든다 (M3·M4·R5)", async () => {
    const { A } = await start();
    const device = (await A("device.create", android360)) as DeviceView;
    expect(device).toMatchObject({
      name: "corgi Small 360",
      slim: "applied",
      label: "Android 360dp",
      enabled: true,
      source: { name: "Small 360", native: "Small_360" },
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
    const b = (await A("device.create", { source: "Large 412" })) as DeviceView;
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

describe("슬림 재적용", () => {
  test("켤 때 풀린 것을 찾으면 다시 적용하고, 결과에는 바뀐 상태가 나온다 (M6)", async () => {
    const { A, server, driver } = await start();
    const device = (await A("device.create", android360)) as DeviceView;
    server.registry.update(device.id, { slim: "drifted" });
    let checks = 0;
    driver.checkSlim = async () => (checks++ === 0 ? "drifted" : "applied");
    await A("lease.acquire", { devices: [device.id] });
    const up: { devices: DeviceView[] } = await A("device.up");
    expect(up.devices[0]?.slim).toBe("applied");
  });
});

describe("원본 목록과 복제", () => {
  test("전체 목록 — 폭 순, 같은 크기로 만든 원본은 «생성됨», Corgi 가 만든 것은 managed (M3·M9)", async () => {
    const { A, driver } = await start();
    const made = (await A("device.create", { source: "Small_360" })) as DeviceView;
    driver.list.push({
      ...driver.list[0],
      native: made.native,
      name: made.name,
    } as (typeof driver.list)[0]);
    const { items } = await A("source.list");
    expect(
      items.map((i: { native: string; created?: string; managed?: string }) => [
        i.native,
        i.created,
        i.managed,
      ]),
    ).toEqual([
      [made.native, undefined, made.id], // 같은 폭이면 이름 순 — "corgi Small 360" 이 먼저
      ["Small_360", made.id, undefined],
      ["Large_412", undefined, undefined],
    ]);
  });

  test("Corgi 가 만든 디바이스는 원본으로 쓸 수 없다 (L4 는 나중에)", async () => {
    const { A, driver } = await start();
    const made = (await A("device.create", { source: "Small_360" })) as DeviceView;
    driver.list.push({
      ...driver.list[1],
      native: made.native,
      name: "corgi copy",
    } as (typeof driver.list)[0]);
    expect(await A("device.create", { source: made.native })).toMatchObject({ code: "INVALID" });
  });

  test("이름이 같은 원본이 여럿이면 원본 ID 로 고르게 한다", async () => {
    const { A, driver } = await start();
    driver.list.push({
      ...driver.list[1],
      native: "Large_412_b",
      name: "Small 360",
    } as (typeof driver.list)[0]);
    const error = await A("device.create", { source: "small 360" });
    expect(error).toMatchObject({ code: "INVALID" });
    expect(error.message).toContain("Large_412_b");
    expect(await A("device.create", { source: "Large_412_b" })).toMatchObject({
      name: "corgi Small 360",
    });
  });

  test("없는 원본은 NOT_FOUND", async () => {
    const { A } = await start();
    expect(await A("device.create", { source: "nope" })).toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("사람(웹 UI)의 켜기·끄기", () => {
  test("점유 없이 켜고 끈다 — 점유 기록이 남지 않는다", async () => {
    const { H, server, driver } = await start();
    const device = (await H("device.create", android360)) as DeviceView;
    const up: { devices: DeviceView[] } = await H("device.up", { devices: [device.id] });
    expect(up.devices[0]).toMatchObject({ booted: true, mine: false });
    expect(up.devices[0]?.holder).toBeUndefined();
    expect(server.leases.heldBy("web")).toEqual([]);
    await H("device.down", { devices: [device.id] });
    expect(driver.booted.has(device.id)).toBe(false);
  });

  test("에이전트가 쓰는 중인 디바이스는 사람도 켜고 끌 수 없다", async () => {
    const { A, H } = await start();
    const device = (await A("device.create", android360)) as DeviceView;
    await A("lease.acquire", { devices: [device.id] });
    expect(await H("device.up", { devices: [device.id] })).toMatchObject({ code: "BUSY" });
  });
});

describe("슬림 수치", () => {
  test("켜진 디바이스에는 뒤에서 읽어 둔 슬림 수치가 붙는다", async () => {
    const { H } = await start();
    const device = (await H("device.create", android360)) as DeviceView;
    await H("device.up", { devices: [device.id] });
    await H("device.list"); // 첫 목록이 뒤에서 읽기를 시작한다
    await Bun.sleep(20);
    const [view] = (await H("device.list")) as DeviceView[];
    expect(view?.slimStats).toMatchObject({ disabled: 49, total: 52, unit: "패키지" });
  });
});
