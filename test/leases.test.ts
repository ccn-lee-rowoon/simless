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

describe("LeaseManager — 점유·대기·자동 해제 (R13·R14·R17·R23)", () => {
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

describe("LeaseManager — 비어 있는 것만 (R23)", () => {
  test("available 은 비어 있는 것만 잡고 바쁜 것은 알려 준다", () => {
    const { leases } = setup();
    leases.acquire(A, ["d1"], { wait: false });
    const result = leases.acquire(B, ["d1", "d2", "d3"], { wait: false, mode: "available" });
    expect(result).toMatchObject({ status: "partial", deviceIds: ["d2", "d3"], queued: false });
    expect(holders(leases, ["d1", "d2", "d3"])).toEqual(["A", "B", "B"]);
  });

  test("하나도 비어 있지 않으면 busy", () => {
    const { leases } = setup();
    leases.acquire(A, ["d1"], { wait: false });
    expect(leases.acquire(B, ["d1"], { wait: false, mode: "available" }).status).toBe("busy");
  });

  test("available + 기다리기 — 나머지는 하나씩 빌 때마다 받는다", () => {
    const { leases, granted } = setup();
    leases.acquire(A, ["d1"], { wait: false });
    leases.acquire(C, ["d2"], { wait: false });
    const result = leases.acquire(B, ["d1", "d2", "d3"], { wait: true, mode: "available" });
    expect(result).toMatchObject({ status: "partial", deviceIds: ["d3"], queued: true });
    leases.release("A");
    expect(granted).toEqual([["B", ["d1"]]]);
    expect(leases.queuedFor("B")).toEqual(["d2"]);
    leases.release("C");
    expect(holders(leases, ["d1", "d2", "d3"])).toEqual(["B", "B", "B"]);
    expect(leases.queuePosition("B")).toBeUndefined();
  });
});

describe("LeaseManager — 교착 막기 (R23)", () => {
  test("서로 상대가 쥔 것을 기다리게 되면 대기열에 넣지 않고 deadlock", () => {
    const { leases } = setup();
    leases.acquire(A, ["x"], { wait: false });
    leases.acquire(B, ["y"], { wait: false });
    expect(leases.acquire(A, ["y"], { wait: true }).status).toBe("queued");
    const result = leases.acquire(B, ["x"], { wait: true });
    expect(result).toMatchObject({ status: "deadlock", cycle: ["B", "A"] });
    expect(leases.queuePosition("B")).toBeUndefined();
  });

  test("available + 기다리기로 쥔 것도 셈한다 — 비어 있던 것을 잡은 뒤 서로 기다리게 되면 deadlock", () => {
    const { leases } = setup();
    leases.acquire(A, ["y"], { wait: false });
    leases.acquire(A, ["x"], { wait: true }); // x 는 비어 있어 바로 잡힘
    leases.release("A", ["x"]);
    // A: y 를 쥠. B: x 를 쥐고 y 를 기다림
    leases.acquire(B, ["x", "y"], { wait: true, mode: "available" });
    // A 가 x 를 기다리면 A→B→A
    expect(leases.acquire(A, ["x"], { wait: true })).toMatchObject({ status: "deadlock" });
  });

  test("아무것도 쥐지 않고 기다리면 순환이 없다", () => {
    const { leases } = setup();
    leases.acquire(A, ["x"], { wait: false });
    leases.acquire(B, ["x"], { wait: true });
    expect(leases.acquire(C, ["x"], { wait: true }).status).toBe("queued");
  });

  test("먼저 기다리는 세션이 내 것을 기다려도 교착이다 (빈 기기를 앞에서 막는 경우)", () => {
    const { leases } = setup();
    leases.acquire(A, ["x"], { wait: false });
    leases.acquire(C, ["d"], { wait: false });
    // B 는 d·x 를 함께 기다린다 (all) — x 는 A 가 쥠
    leases.acquire(B, ["d", "x"], { wait: true });
    leases.release("C"); // d 는 비었지만 B 가 먼저 기다린다
    expect(leases.acquire(A, ["d"], { wait: true })).toMatchObject({ status: "deadlock" });
  });
});

describe("LeaseManager — 기록 (M13)", () => {
  function withHistory() {
    let now = 0;
    const events: { kind: string; sessionKey: string; deviceIds: string[] }[] = [];
    const leases = new LeaseManager(
      { sessions: [], leases: [], queue: [] },
      {
        idleMs: 1000,
        now: () => now,
        onHistory: ({ kind, sessionKey, deviceIds }) =>
          events.push({ kind, sessionKey, deviceIds }),
      },
    );
    return { leases, events, advance: (ms: number) => (now += ms) };
  }

  test("점유·대기·대기 끝 점유·해제·강제 해제·세션 종료·자동 해제를 남긴다", () => {
    const { leases, events, advance } = withHistory();
    leases.acquire(A, ["d1"], { wait: false });
    leases.acquire(A, ["d1"], { wait: false }); // 이미 쥔 것을 다시 — 기록하지 않음
    leases.acquire(B, ["d1"], { wait: true });
    leases.acquire(B, ["d1"], { wait: true }); // 같은 대기를 이어 감 — 기록하지 않음
    leases.release("A");
    leases.release("B", ["d1"], "forced");
    leases.acquire(C, ["d2"], { wait: false });
    leases.endSession("C");
    leases.acquire(A, ["d3"], { wait: false });
    leases.acquire(B, ["d3"], { wait: true });
    advance(2000);
    leases.sweepIdle();
    expect(events.map((e) => `${e.kind} ${e.sessionKey} ${e.deviceIds.join(",")}`)).toEqual([
      "acquired A d1",
      "queued B d1",
      "released A d1",
      "granted B d1",
      "forced B d1",
      "acquired C d2",
      "ended C d2",
      "acquired A d3",
      "queued B d3",
      "idle A d3",
      "granted B d3",
    ]);
  });
});
