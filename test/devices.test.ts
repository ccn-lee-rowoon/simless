import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { type DeviceOpResult, type DeviceView, observedSlim } from "../src/shared/api.ts";
import { seedDevice, testServers } from "./helpers.ts";

const start = testServers();

const android360 = { model: "Small 360" };

describe("디바이스 명령 (R1·P1)", () => {
  test("만들면 기본 이름·슬림 적용, 같은 크기도 다시 만들고 이름만 겹치지 않는다 (M3·M4·R5)", async () => {
    const { A } = await start();
    const device = (await A("device.create", android360)) as DeviceView;
    expect(device).toMatchObject({
      name: "simless Small 360",
      slim: "applied",
      label: "Android 360dp",
      createdBySimless: true,
    });
    expect(await A("device.create", android360)).toMatchObject({ name: "simless Small 360 2" });
    expect(await A("device.create", { ...android360, name: "simless Small 360" })).toMatchObject({
      code: "INVALID",
    });
  });

  test("만들 때 이름을 정하면 그 이름으로, 기기에도 그 이름이 붙는다 (R3)", async () => {
    const { A, driver } = await start();
    const device = (await A("device.create", { ...android360, name: "계정 A 폰" })) as DeviceView;
    expect(device.name).toBe("계정 A 폰");
    expect(driver.existing.find((e) => e.native === device.native)?.name).toBe("계정 A 폰");
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
    await A("device.create", { model: "Large 412" }); // 처음 만든 것은 기본 디바이스라 못 지운다
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
    await A("device.create", { model: "Large 412" }); // 처음 만든 것은 기본 디바이스라 못 지운다
    const device = (await A("device.create", android360)) as DeviceView;
    await A("lease.acquire", { devices: [device.id] });
    await A("device.up");
    expect(driver.booted.has(device.id)).toBe(true);
    await A("device.delete", { device: device.id });
    expect(driver.booted.has(device.id)).toBe(false);
    expect(server.registry.get(device.id)).toBeUndefined();
    expect(server.leases.heldBy("A")).toEqual([]);
  });

  test("이 Mac 의 디바이스는 목록에 없다가, 추가하면 목록에 들어와 점유할 수 있다 (R20)", async () => {
    const { A, server, driver } = await start();
    seedDevice(server, driver, "pix6", "Pixel 6a", false, false);
    expect(await A("device.list")).toEqual([]);
    expect(await A("lease.acquire", { devices: ["Pixel 6a"] })).toMatchObject({
      code: "NOT_FOUND",
      message: expect.stringContaining("simless add"),
    });
    const [available] = (await A("device.available")) as DeviceView[];
    expect(available).toMatchObject({ id: "pix6", listed: false, createdBySimless: false });
    expect(await A("device.add", { device: "Pixel 6a" })).toMatchObject({
      id: "pix6",
      listed: true,
    });
    expect(await A("device.available")).toEqual([]);
    expect(await A("lease.acquire", { devices: ["Pixel 6a"] })).toMatchObject({
      status: "granted",
      deviceIds: ["pix6"],
    });
    expect(await A("device.add", { device: "pix6" })).toMatchObject({ code: "INVALID" });
  });

  test("추가한 디바이스는 목록에서 빼면 점유·그룹·기본 지정도 풀리고 기기는 남는다", async () => {
    const { A, server, driver } = await start();
    seedDevice(server, driver, "pix6", "Pixel 6a", false);
    await A("group.create", { name: "두 계정", devices: ["pix6"] });
    await A("device.setDefault", { device: "pix6" });
    await A("lease.acquire", { devices: ["pix6"] });
    expect(await A("device.unlist", { device: "pix6" })).toEqual({ unlisted: "pix6" });
    expect(await A("device.list")).toEqual([]);
    expect(server.leases.heldBy("A")).toEqual([]);
    expect(server.registry.groups()[0]?.deviceIds).toEqual([]);
    expect(server.registry.defaults()).toEqual({});
    expect(driver.existing).toHaveLength(1);
  });

  test("목록 표시가 없던 이전 정보 — 기본 디바이스나 그룹에 든 기기는 목록에 둔다", async () => {
    const { A, server, driver } = await start();
    seedDevice(server, driver, "def1", "iPhone 17 Pro", false);
    seedDevice(server, driver, "grp1", "Pixel 6a", false);
    seedDevice(server, driver, "oth1", "iPad Air", false);
    // listed 가 없는 이전 형식처럼
    for (const id of ["def1", "grp1", "oth1"]) server.registry.update(id, { listed: undefined });
    server.registry.setDefault("android", "def1");
    server.registry.addGroup({
      name: "g",
      description: "",
      deviceIds: ["grp1"],
      updatedBy: "human",
      updatedAt: "2026-10-05T00:00:00.000Z",
    });
    server.invalidate();
    const ids = ((await A("device.list")) as DeviceView[]).map((d) => d.id).sort();
    expect(ids).toEqual(["def1", "grp1"]);
  });

  test("simless 가 만든 디바이스는 목록에서 뺄 수 없다 — 삭제한다", async () => {
    const { A } = await start();
    const device = (await A("device.create", android360)) as DeviceView;
    expect(await A("device.unlist", { device: device.id })).toMatchObject({ code: "NOT_ALLOWED" });
  });

  test("원래 있던 디바이스는 지우거나 슬림 설정할 수 없다 (M8·N5)", async () => {
    const { A, server, driver } = await start();
    seedDevice(server, driver, "pix6", "Pixel 6a", false);
    expect(await A("device.delete", { device: "pix6" })).toMatchObject({ code: "NOT_ALLOWED" });
    expect(await A("device.slim", { devices: ["pix6"] })).toMatchObject({ code: "NOT_ALLOWED" });
    expect(await A("device.rename", { device: "pix6", name: "계정 A 폰" })).toMatchObject({
      name: "계정 A 폰",
    });
  });

  test("밖에서 지워진 디바이스는 정보와 점유가 함께 사라진다", async () => {
    const { A, server, driver } = await start();
    seedDevice(server, driver, "pix6", "Pixel 6a", false);
    await A("lease.acquire", { devices: ["pix6"] });
    driver.existing = [];
    expect(await A("device.list")).toEqual([]);
    expect(server.registry.get("pix6")).toBeUndefined();
    expect(server.leases.heldBy("A")).toEqual([]);
  });

  test("목록을 못 읽으면 정보를 지우지 않는다", async () => {
    const { A, server, driver } = await start();
    seedDevice(server, driver, "pix6", "Pixel 6a", false);
    driver.list = async () => {
      throw new Error("simctl 실패");
    };
    expect(await A("device.list")).toEqual([]);
    expect(server.registry.get("pix6")).toBeDefined();
  });

  test("점유는 디바이스를 지정해야 한다", async () => {
    const { A } = await start();
    expect(await A("lease.acquire", {})).toMatchObject({ code: "INVALID" });
  });

  test("관리 디바이스 목록 파일을 남긴다 — 서버가 꺼졌을 때 훅이 읽는다 (P9)", async () => {
    const { A, env } = await start();
    const device = (await A("device.create", android360)) as DeviceView;
    await A("device.list");
    expect(existsSync(env.paths.managedIndex)).toBe(true);
    const index = JSON.parse(readFileSync(env.paths.managedIndex, "utf8"));
    expect(index.devices[0]).toMatchObject({ id: device.id, native: `simless_${device.id}` });
  });
});

describe("슬림 재적용 (M6)", () => {
  test("켤 때 풀린 것을 찾으면 다시 적용하고, 결과에는 바뀐 상태가 나온다 (M6)", async () => {
    const { A, server, driver } = await start();
    const device = (await A("device.create", android360)) as DeviceView;
    server.registry.update(device.id, { slim: "drifted" });
    server.invalidate();
    let checks = 0;
    driver.checkSlim = async () => (checks++ === 0 ? "drifted" : "applied");
    await A("lease.acquire", { devices: [device.id] });
    const up: { devices: DeviceView[] } = await A("device.up");
    expect(up.devices[0]?.slim).toBe("applied");
  });
});

describe("기종 목록과 만들기 (M1·M4)", () => {
  test("catalog 은 플랫폼별 기종·OS·슬림하면 꺼지는 것을 준다 (M1·M4)", async () => {
    const { A } = await start();
    const { platforms, problems } = await A("catalog");
    expect(problems).toEqual([]);
    expect(platforms[0]).toMatchObject({
      platform: "android",
      models: [{ id: "small-360" }, { id: "large-412" }],
      os: [{ recommended: true }],
      slimOff: [{ name: "Assistant & Search", count: 3 }],
    });
  });

  test("슬림하지 않으면 접두사 없이 기종 이름으로 (R5)", async () => {
    const { A } = await start();
    expect(await A("device.create", { model: "large-412", slim: false })).toMatchObject({
      name: "Large 412",
      slim: "none",
      createdBySimless: true,
    });
  });

  test("없는 기종은 NOT_FOUND", async () => {
    const { A } = await start();
    expect(await A("device.create", { model: "nope" })).toMatchObject({ code: "NOT_FOUND" });
  });

  test("이미 있는 기기 이름과도 겹치지 않게 번호를 붙인다", async () => {
    const { A, server, driver } = await start();
    seedDevice(server, driver, "xc17", "simless Small 360", false);
    expect(await A("device.create", android360)).toMatchObject({ name: "simless Small 360 2" });
  });
});

describe("사람(웹 UI)의 켜기·끄기 (R11·P1)", () => {
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

describe("슬림 수치 (M10)", () => {
  test("켜진 디바이스에는 뒤에서 읽어 둔 슬림 수치가 붙는다", async () => {
    const { H } = await start();
    const device = (await H("device.create", android360)) as DeviceView;
    await H("device.up", { devices: [device.id] });
    await H("device.list"); // 첫 목록이 뒤에서 읽기를 시작한다
    await Bun.sleep(20);
    const [view] = (await H("device.list")) as DeviceView[];
    expect(view?.slimStats).toMatchObject({ disabled: 49, total: 52, unit: "packages" });
  });
});

describe("Simless 가 하지 않은 슬림 (M6)", () => {
  /** 켜고 목록을 두 번 — 첫 목록이 뒤에서 읽기를 시작한다 */
  async function listAfterRead(H: (m: string, p?: unknown) => Promise<unknown>) {
    await H("device.list");
    await Bun.sleep(20);
    return (await H("device.list")) as DeviceView[];
  }

  test("이 Mac 의 기기도 켜져 있으면 슬림 수치를 읽고 슬림으로 본다", async () => {
    const { H, server, driver } = await start();
    seedDevice(server, driver, "pix6", "Pixel 6a", false);
    await H("device.up", { devices: ["pix6"] });
    const view = (await listAfterRead(H)).find((d) => d.id === "pix6");
    expect(view?.slim).toBe("none"); // Simless 가 한 슬림이 아니므로 다시 걸지 않는다
    expect(view?.slimStats).toMatchObject({ disabled: 49, total: 52 });
    expect(view && observedSlim(view)).toMatchObject({ disabled: 49, total: 52 });
  });

  test("꺼진 뒤에는 마지막으로 본 값과 시각을 보여 준다", async () => {
    const { H, server, driver } = await start();
    seedDevice(server, driver, "pix6", "Pixel 6a", false);
    await H("device.up", { devices: ["pix6"] });
    await listAfterRead(H);
    await H("device.down", { devices: ["pix6"] });
    const view = ((await H("device.list")) as DeviceView[]).find((d) => d.id === "pix6");
    expect(view?.slimStats).toBeUndefined();
    expect(view?.slimSeen).toMatchObject({ disabled: 49, total: 52, unit: "packages" });
    expect(view && observedSlim(view)?.seenAt).toBeString();
  });

  test("Android 는 프로필 패키지가 절반 넘게 꺼져야 슬림 — 켜진 적 없는 기기도 표시하지 않는다", async () => {
    const { H, server, driver } = await start();
    seedDevice(server, driver, "pix6", "Pixel 6a", false);
    seedDevice(server, driver, "pix7", "Pixel 7", false);
    driver.slimStats = async (devices) =>
      new Map(
        devices.map((d) => [
          d.id,
          { disabled: 20, total: 52, unit: "packages" as const, measuredAt: 0 },
        ]),
      );
    await H("device.up", { devices: ["pix6"] });
    const views = await listAfterRead(H);
    expect(observedSlim(views.find((d) => d.id === "pix6") as DeviceView)).toBeUndefined();
    expect(observedSlim(views.find((d) => d.id === "pix7") as DeviceView)).toBeUndefined();
  });
});

describe("직접 입력 (M1)", () => {
  test("Android 크기를 직접 넣어 만든다 — 기종과 직접 입력은 함께 못 준다", async () => {
    const { A } = await start();
    const device = (await A("device.create", {
      custom: { widthDp: 375, heightDp: 812, density: 320 },
    })) as DeviceView;
    expect(device).toMatchObject({ name: "simless Android 375dp", label: "Android 375dp" });
    expect(
      await A("device.create", {
        model: "Small 360",
        custom: { widthDp: 1, heightDp: 1, density: 160 },
      }),
    ).toMatchObject({
      code: "INVALID",
    });
  });
});

describe("슬림 전 기준값 (M10)", () => {
  test("만들 때 슬림 전에 켜서 재고, 끄고, 슬림한다", async () => {
    const { A, driver } = await start();
    const device = (await A("device.create", android360)) as DeviceView;
    expect(device.slimBaseline).toMatchObject({ memoryBytes: 7.8 * 1024 ** 3, processes: 167 });
    expect(device.slim).toBe("applied");
    expect(driver.booted.has(device.id)).toBe(false); // 재고 나서 껐다
  });

  test("baseline: false 면 재지 않는다", async () => {
    const { A } = await start();
    const device = (await A("device.create", { ...android360, baseline: false })) as DeviceView;
    expect(device.slimBaseline).toBeUndefined();
  });

  test("재다 실패해도 만들기는 이어 간다", async () => {
    const { A, driver } = await start();
    driver.measure = async () => {
      throw new Error("측정 실패");
    };
    const device = (await A("device.create", android360)) as DeviceView;
    expect(device).toMatchObject({ slim: "applied" });
    expect(device.slimBaseline).toBeUndefined();
    expect(driver.booted.has(device.id)).toBe(false);
  });
});

describe("기본 디바이스가 없을 때 (R22)", () => {
  test("디바이스가 하나도 없으면 NO_DEFAULT 와 플랫폼별 대수, create 면 추천 기종을 만들어 점유한다", async () => {
    const { A, server } = await start();
    const missing = await A("lease.acquire", { default: "android" });
    expect(missing.code).toBe("NO_DEFAULT");
    expect(missing.data).toEqual({ missing: [{ platform: "android", devices: 0 }] });

    const result = await A("lease.acquire", { default: "android", create: true });
    expect(result.status).toBe("granted");
    const [device] = await server.devices();
    expect(device).toMatchObject({ name: "simless Small 360", slim: "applied" });
    expect(server.registry.defaults().android).toBe(device?.id);
    expect(result.deviceIds).toEqual([device?.id]);
  });

  test("디바이스는 있는데 기본이 없으면 만들지 않고 사람에게 고르게 한다", async () => {
    const { A, server, driver } = await start();
    seedDevice(server, driver, "aaaa", "Added phone", false);
    const before = (await server.devices()).length;
    const result = await A("lease.acquire", { default: "android", create: true });
    expect(result.code).toBe("NO_DEFAULT");
    expect(result.data).toEqual({ missing: [{ platform: "android", devices: 1 }] });
    expect(await server.devices()).toHaveLength(before);
  });
});
