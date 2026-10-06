import { afterEach, describe, expect, test } from "bun:test";
import { SimlessServer } from "../src/server/app.ts";
import { listen } from "../src/server/socket.ts";
import type { AcquireResult, StatusResult } from "../src/shared/api.ts";
import { call, RemoteError, ServerDownError } from "../src/shared/client.ts";
import { VERSION } from "../src/shared/version.ts";
import { fakeDriver, seedDevice, session, tempEnv, testServers } from "./helpers.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
});

const startServer = testServers();
const start = (options: { isAlive?: (pid: number) => boolean } = {}) =>
  startServer({
    deps: { isAlive: options.isAlive },
    seed: (server, driver) => {
      seedDevice(server, driver, "aaaa", "Small");
      seedDevice(server, driver, "bbbb", "Large");
    },
  });

describe("소켓 서버 — 점유·대기·자동 해제 (R13·R14·R17)", () => {
  test("status — 디바이스와 이 세션의 점유를 돌려준다", async () => {
    const { socket } = await start();
    const { result } = await call<StatusResult>(socket, "status", {}, session("A"));
    expect(result.devices.map((d) => [d.id, d.label])).toEqual([
      ["aaaa", "Android 360dp"],
      ["bbbb", "Android 360dp"],
    ]);
    expect(result.held).toEqual([]);
  });

  test("점유 → 다른 세션은 BUSY 와 누가 쓰는지 받는다", async () => {
    const { socket } = await start();
    const granted = await call<AcquireResult>(
      socket,
      "lease.acquire",
      { devices: ["Small"] },
      session("A"),
    );
    expect(granted.result).toMatchObject({ status: "granted", deviceIds: ["aaaa"] });

    const error = await call(socket, "lease.acquire", { devices: ["aaaa"] }, session("B")).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(RemoteError);
    expect(error).toMatchObject({
      code: "BUSY",
      data: { holders: [{ deviceId: "aaaa", sessionKey: "A", reason: "held" }] },
    });
  });

  test("status 의 sessions — 세션마다 점유한 것·기다리는 것 (M13)", async () => {
    const { socket } = await start();
    await call(socket, "lease.acquire", { devices: ["aaaa"] }, session("A"));
    await call(
      socket,
      "lease.acquire",
      { devices: ["aaaa"], wait: true, timeoutMs: 10 },
      session("B"),
    );
    const { result } = await call<StatusResult>(socket, "status", {}, session("C"));
    expect(result.sessions).toEqual([
      expect.objectContaining({
        sessionKey: "A",
        held: [expect.objectContaining({ deviceId: "aaaa" })],
        queued: [],
      }),
      expect.objectContaining({ sessionKey: "B", held: [], queued: ["aaaa"], queuePosition: 1 }),
    ]);
  });

  test("기다리기 — 풀리는 순간 대기하던 호출이 점유로 끝난다", async () => {
    const { socket } = await start();
    await call(socket, "lease.acquire", { devices: ["aaaa"] }, session("A"));

    const events: string[] = [];
    const waiting = call<AcquireResult>(
      socket,
      "lease.acquire",
      { devices: ["aaaa"], wait: true },
      session("B"),
      {
        onEvent: (event) => events.push(event),
      },
    );
    await Bun.sleep(50);
    await call(socket, "lease.release", {}, session("A"));

    expect((await waiting).result).toMatchObject({ status: "granted", deviceIds: ["aaaa"] });
    expect(events).toEqual(["queued"]);
  });

  test("기다리기 시간이 지나면 «아직 대기 중» 으로 끝나고 순번은 남는다", async () => {
    const { socket, server } = await start();
    await call(socket, "lease.acquire", { devices: ["aaaa"] }, session("A"));
    const { result } = await call<AcquireResult>(
      socket,
      "lease.acquire",
      { devices: ["aaaa"], wait: true, timeoutMs: 30 },
      session("B"),
    );
    expect(result).toMatchObject({ status: "queued", position: 1 });
    expect(server.leases.queuePosition("B")).toBe(1);
  });

  test("세션 프로세스가 끝나면 tick 에서 점유가 풀린다", async () => {
    const alive = new Set([100]);
    const { socket, server } = await start({ isAlive: (pid) => alive.has(pid) });
    await call(socket, "lease.acquire", { devices: ["aaaa"] }, session("A", { pid: 100 }));
    server.tick();
    expect(server.leases.holderOf("aaaa")?.key).toBe("A");
    alive.delete(100);
    server.tick();
    expect(server.leases.holderOf("aaaa")).toBeUndefined();
  });

  test("모르는 메서드는 INVALID, 없는 디바이스는 NOT_FOUND", async () => {
    const { socket } = await start();
    const invalid = await call(socket, "nope", {}, session("A")).catch((e: unknown) => e);
    expect(invalid).toMatchObject({ code: "INVALID" });
    const missing = await call(socket, "lease.acquire", { devices: ["zzzz"] }, session("A")).catch(
      (e: unknown) => e,
    );
    expect(missing).toMatchObject({ code: "NOT_FOUND" });
  });

  test("서버가 없으면 ServerDownError", async () => {
    await expect(
      call("/tmp/simless-test-none.sock", "status", {}, session("A")),
    ).rejects.toBeInstanceOf(ServerDownError);
  });

  test("이미 떠 있으면 두 번째 서버는 시작하지 않는다", async () => {
    const env = tempEnv();
    cleanups.push(env.cleanup);
    const handle = new SimlessServer({ ...env, drivers: [] }).handle;
    const first = await listen(env.paths.socket, VERSION, handle);
    cleanups.push(() => first.stop());
    await expect(listen(env.paths.socket, VERSION, handle)).rejects.toThrow("이미 실행 중");
  });
});

describe("큰 응답", () => {
  test("여러 조각으로 나뉘어도 한글이 깨지지 않는다", async () => {
    const env = tempEnv();
    const text = "가나다라마바사".repeat(50_000); // 약 1MB — 여러 조각으로 온다
    const listener = await listen(env.paths.socket, VERSION, async () => ({ text }));
    cleanups.push(() => listener.stop(), env.cleanup);
    const { result } = await call<{ text: string }>(env.paths.socket, "big", {}, session("A"));
    expect(result.text).toBe(text);
  });
});

describe("점유 기록 (M13)", () => {
  test("lease.history — 최근 것부터, 세션으로 거를 수 있고 서버를 다시 켜도 남는다", async () => {
    const env = tempEnv();
    const driver = fakeDriver();
    const server = new SimlessServer({ ...env, drivers: [driver] });
    seedDevice(server, driver, "aaaa", "Small");
    const listener = await listen(env.paths.socket, VERSION, server.handle);
    cleanups.push(() => listener.stop(), env.cleanup);
    const socket = env.paths.socket;
    await call(socket, "lease.acquire", { devices: ["aaaa"] }, session("A"));
    await call(socket, "lease.release", {}, session("A"));
    const { result } = await call<{ kind: string }[]>(socket, "lease.history", {}, session("B"));
    expect(result.map((e) => e.kind)).toEqual(["released", "acquired"]);
    const again = new SimlessServer({ ...env, drivers: [driver] });
    expect(again.history.list({ sessionKey: "A" })).toHaveLength(2);
    expect(again.history.list({ sessionKey: "B" })).toHaveLength(0);
  });
});
