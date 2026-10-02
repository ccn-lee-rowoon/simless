import { describe, expect, test } from "bun:test";
import { LeaseManager, type LeaseManager as LM } from "../src/server/leases.ts";
import type { SessionInfo } from "../src/shared/protocol.ts";

function session(key: string, agentSessionId?: string): SessionInfo {
  return { key, agent: "codex", cwd: "/w", human: false, agentSessionId };
}
const A = session("A");
const B = session("B");
const C = session("C");

function setup(idleMs = 1000) {
  let now = 0;
  const granted: [string, string[]][] = [];
  const leases = new LeaseManager(
    { sessions: [], leases: [], queue: [] },
    { idleMs, now: () => now, onGranted: (key, ids) => granted.push([key, ids]) },
  );
  return { leases, granted, advance: (ms: number) => (now += ms) };
}

function holders(leases: LM, ids: string[]) {
  return ids.map((id) => leases.holderOf(id)?.key);
}

describe("LeaseManager", () => {
  test("비어 있으면 전부 잡고, 같은 세션의 재요청은 통과", () => {
    const { leases } = setup();
    expect(leases.acquire(A, ["d1", "d2"], { wait: false }).status).toBe("granted");
    expect(leases.acquire(A, ["d1"], { wait: false }).status).toBe("granted");
    expect(holders(leases, ["d1", "d2"])).toEqual(["A", "A"]);
  });

  test("전부 아니면 전무 — 하나라도 남의 것이면 아무것도 안 잡는다", () => {
    const { leases } = setup();
    leases.acquire(A, ["d1"], { wait: false });
    const result = leases.acquire(B, ["d1", "d2"], { wait: false });
    expect(result.status).toBe("busy");
    if (result.status === "busy")
      expect(result.holders[0]).toMatchObject({ deviceId: "d1", reason: "held" });
    expect(leases.holderOf("d2")).toBeUndefined();
  });

  test("기다리기 — 풀리면 대기하던 세션이 자동으로 점유", () => {
    const { leases, granted } = setup();
    leases.acquire(A, ["d1"], { wait: false });
    expect(leases.acquire(B, ["d1"], { wait: true })).toMatchObject({
      status: "queued",
      position: 1,
    });
    leases.release("A");
    expect(leases.holderOf("d1")?.key).toBe("B");
    expect(granted).toEqual([["B", ["d1"]]]);
  });

  test("다시 기다려도 순번이 유지된다 (연결이 끊겨도 대기는 세션에 남는다)", () => {
    const { leases } = setup();
    leases.acquire(A, ["d1"], { wait: false });
    leases.acquire(B, ["d1"], { wait: true });
    leases.acquire(C, ["d1"], { wait: true });
    expect(leases.acquire(B, ["d1"], { wait: true })).toMatchObject({
      status: "queued",
      position: 1,
    });
    expect(leases.acquire(C, ["d1"], { wait: true })).toMatchObject({
      status: "queued",
      position: 2,
    });
  });

  test("같은 디바이스를 먼저 기다리는 세션이 있으면 비어 있어도 새치기 못 한다", () => {
    const { leases } = setup();
    leases.acquire(A, ["d2"], { wait: false });
    leases.acquire(B, ["d1", "d2"], { wait: true }); // d2 때문에 대기
    const result = leases.acquire(C, ["d1"], { wait: false });
    expect(result.status).toBe("busy");
    if (result.status === "busy")
      expect(result.holders[0]).toMatchObject({ deviceId: "d1", reason: "queued" });
  });

  test("겹치지 않는 디바이스는 대기열과 상관없이 잡는다", () => {
    const { leases } = setup();
    leases.acquire(A, ["d1"], { wait: false });
    leases.acquire(B, ["d1"], { wait: true });
    expect(leases.acquire(C, ["d9"], { wait: false }).status).toBe("granted");
  });

  test("일부만 놓으면 나머지는 그대로", () => {
    const { leases } = setup();
    leases.acquire(A, ["d1", "d2"], { wait: false });
    expect(leases.release("A", ["d1"])).toEqual(["d1"]);
    expect(holders(leases, ["d1", "d2"])).toEqual([undefined, "A"]);
  });

  test("세션이 끝나면 점유·대기가 바로 풀린다", () => {
    const { leases } = setup();
    leases.acquire(A, ["d1"], { wait: false });
    leases.acquire(B, ["d1"], { wait: true });
    leases.endSession("A");
    expect(leases.holderOf("d1")?.key).toBe("B");
    expect(leases.session("A")).toBeUndefined();
  });

  test("오래 안 써도 기다리는 세션이 없으면 풀지 않는다", () => {
    const { leases, advance } = setup(1000);
    leases.acquire(A, ["d1"], { wait: false });
    advance(5000);
    expect(leases.sweepIdle()).toEqual([]);
    expect(leases.holderOf("d1")?.key).toBe("A");
  });

  test("오래 안 쓰고 기다리는 세션이 있으면 푼다", () => {
    const { leases, advance } = setup(1000);
    leases.acquire(A, ["d1"], { wait: false });
    leases.acquire(B, ["d1"], { wait: true });
    advance(999);
    expect(leases.sweepIdle()).toEqual([]);
    advance(1);
    expect(leases.sweepIdle()).toEqual(["A"]);
    expect(leases.holderOf("d1")?.key).toBe("B");
  });

  test("사용하면 마지막 사용 시각이 갱신돼 풀리지 않는다", () => {
    const { leases, advance } = setup(1000);
    leases.acquire(A, ["d1"], { wait: false });
    leases.acquire(B, ["d1"], { wait: true });
    advance(900);
    leases.touch(A);
    advance(900);
    expect(leases.sweepIdle()).toEqual([]);
  });

  test("같은 세션 키에서 에이전트 세션 ID 가 바뀌면 이전 점유를 푼다", () => {
    const { leases } = setup();
    leases.acquire(session("A", "conv-1"), ["d1"], { wait: false });
    leases.touch(session("A", "conv-2"));
    expect(leases.holderOf("d1")).toBeUndefined();
  });

  test("상태를 저장했다가 다시 불러와도 같다", () => {
    const { leases } = setup();
    leases.acquire(A, ["d1"], { wait: false });
    leases.acquire(B, ["d1"], { wait: true });
    const restored = new LeaseManager(leases.snapshot(), { idleMs: 1000 });
    expect(restored.holderOf("d1")?.key).toBe("A");
    expect(restored.queuePosition("B")).toBe(1);
  });
});
