import { afterEach, describe, expect, test } from "bun:test";
import { CorgiServer } from "../src/server/app.ts";
import { listen } from "../src/server/socket.ts";
import type { DeviceView, StatusResult } from "../src/shared/api.ts";
import { call } from "../src/shared/client.ts";
import type { Group } from "../src/shared/model.ts";
import { VERSION } from "../src/shared/version.ts";
import { fakeDriver, seedDevice, session, tempEnv } from "./helpers.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
});

async function start() {
  const env = tempEnv();
  const driver = fakeDriver();
  const server = new CorgiServer({ ...env, drivers: [driver] });
  seedDevice(server, driver, "mod1", "Pixel 6a", false);
  seedDevice(server, driver, "usr1", "iPhone 17 Pro", false);
  const listener = await listen(env.paths.socket, VERSION, server.handle);
  cleanups.push(() => listener.stop(), env.cleanup);
  const as =
    (key: string, human = false) =>
    // biome-ignore lint/suspicious/noExplicitAny: 테스트 편의 — 결과와 오류를 같은 값으로 받는다
    (method: string, params: unknown = {}): Promise<any> =>
      call(env.paths.socket, method, params, session(key, { human }))
        .then((r) => r.result)
        .catch((e: unknown) => e);
  return { server, driver, A: as("A"), H: as("web", true) };
}

describe("그룹 (R21)", () => {
  test("만들면 디바이스·설명·고친 쪽이 남고, 디바이스 목록에 그룹 ID 가 붙는다", async () => {
    const { A } = await start();
    const group = (await A("group.create", {
      name: "DM 확인",
      description: "모더레이터 + 일반 회원 — 2대 모두 필요",
      devices: ["Pixel 6a", "usr1"],
    })) as Group;
    expect(group).toMatchObject({
      name: "DM 확인",
      deviceIds: ["mod1", "usr1"],
      updatedBy: "test-agent",
    });
    const devices = (await A("device.list")) as DeviceView[];
    expect(devices.every((d) => d.groups.includes(group.id))).toBe(true);
  });

  test("한 디바이스가 여러 그룹에 든다, 이름은 겹치지 않는다", async () => {
    const { A } = await start();
    await A("group.create", { name: "DM 확인", devices: ["mod1"] });
    await A("group.create", { name: "UI 레이아웃 체크", devices: ["mod1"] });
    expect(await A("group.create", { name: "dm 확인" })).toMatchObject({ code: "INVALID" });
    const [device] = (await A("device.list")) as DeviceView[];
    expect(device?.groups).toHaveLength(2);
  });

  test("고치기 — 넣고 빼고 이름·설명을 바꾸며, 안 준 값은 그대로", async () => {
    const { A, H } = await start();
    await A("group.create", { name: "DM 확인", description: "설명", devices: ["mod1"] });
    const updated = (await H("group.update", {
      group: "dm 확인",
      add: ["usr1"],
      remove: ["mod1"],
    })) as Group;
    expect(updated).toMatchObject({
      name: "DM 확인",
      description: "설명",
      deviceIds: ["usr1"],
      updatedBy: "human",
    });
    expect(await A("group.update", { group: "nope" })).toMatchObject({ code: "NOT_FOUND" });
  });

  test("디바이스가 사라지면 그룹에서도 빠진다", async () => {
    const { A, driver } = await start();
    await A("group.create", { name: "DM 확인", devices: ["mod1", "usr1"] });
    driver.existing = driver.existing.filter((e) => !e.native.endsWith("mod1"));
    const [group] = (await A("group.list")) as Group[];
    await A("device.list");
    const [after] = (await A("group.list")) as Group[];
    expect(group?.deviceIds).toEqual(["mod1", "usr1"]);
    expect(after?.deviceIds).toEqual(["usr1"]);
  });

  test("지우면 그룹만 없어지고 디바이스는 그대로", async () => {
    const { A } = await start();
    const group = (await A("group.create", { name: "DM 확인", devices: ["mod1"] })) as Group;
    expect(await A("group.delete", { group: group.id })).toEqual({ deleted: group.id });
    expect((await A("status")) as StatusResult).toMatchObject({ groups: [] });
    expect((await A("device.list")) as DeviceView[]).toHaveLength(2);
  });
});

describe("메모 (R24)", () => {
  test("디바이스에 메모를 남기고, 빈 글이면 지운다", async () => {
    const { A } = await start();
    expect(await A("device.setMemo", { device: "mod1", memo: " 모더레이터 계정 " })).toMatchObject({
      memo: "모더레이터 계정",
    });
    const cleared = (await A("device.setMemo", { device: "mod1", memo: "" })) as DeviceView;
    expect(cleared.memo).toBeUndefined();
  });
});

describe("기본 디바이스 (R22)", () => {
  test("처음 만든 디바이스가 그 플랫폼의 기본이 되고, 다음 것은 아니다", async () => {
    const { A } = await start();
    const first = (await A("device.create", { model: "Small 360" })) as DeviceView;
    const second = (await A("device.create", { model: "Large 412" })) as DeviceView;
    expect(first.default).toBe(true);
    expect(second.default).toBe(false);
    expect(((await A("status")) as StatusResult).defaults).toEqual({ android: first.id });
  });

  test("다른 디바이스를 기본으로 바꿀 수 있고, 기본 디바이스는 지울 수 없다", async () => {
    const { A } = await start();
    const first = (await A("device.create", { model: "Small 360" })) as DeviceView;
    expect(await A("device.delete", { device: first.id })).toMatchObject({ code: "NOT_ALLOWED" });
    expect(await A("device.setDefault", { device: "mod1" })).toMatchObject({ default: true });
    expect(await A("device.delete", { device: first.id })).toEqual({ deleted: first.id });
  });
});
