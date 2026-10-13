import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { History } from "../src/server/history.ts";
import type { HistoryEvent } from "../src/shared/api.ts";
import { tempEnv } from "./helpers.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
});

const DAY = 24 * 60 * 60_000;

function event(at: number, sessionKey: string, extra: Partial<HistoryEvent> = {}): HistoryEvent {
  return {
    at,
    kind: "acquired",
    sessionKey,
    agent: "claude-code",
    cwd: "/work",
    human: false,
    deviceIds: ["aaaa"],
    ...extra,
  };
}

function open(options: ConstructorParameters<typeof History>[1] = {}) {
  const env = tempEnv();
  const history = new History(env.paths.history, options);
  cleanups.push(() => history.close(), env.cleanup);
  return { history, paths: env.paths };
}

describe("점유 기록 (M13) — SQLite", () => {
  test("최근 것부터, 세션으로 거르고 개수를 제한한다", () => {
    const now = 1_000 * DAY;
    const { history } = open({ now: () => now });
    history.add(event(now - 3000, "A"));
    history.add(event(now - 2000, "B", { kind: "queued" }));
    history.add(event(now - 1000, "A", { kind: "released", deviceIds: ["aaaa", "bbbb"] }));
    expect(history.list().map((e) => [e.sessionKey, e.kind])).toEqual([
      ["A", "released"],
      ["B", "queued"],
      ["A", "acquired"],
    ]);
    expect(history.list({ sessionKey: "A", limit: 1 })).toEqual([
      event(now - 1000, "A", { kind: "released", deviceIds: ["aaaa", "bbbb"] }),
    ]);
  });

  test("세션마다 마지막 활동·기록 수·에이전트 세션 ID 를 묶어 준다", () => {
    const now = 1_000 * DAY;
    const { history } = open({ now: () => now });
    history.add(event(now - 5000, "A", { agentSessionId: "s-1" }));
    history.add(event(now - 4000, "B", { human: true, agent: "web", cwd: "web" }));
    history.add(event(now - 1000, "A", { kind: "released", cwd: "/other" }));
    expect(history.sessions()).toEqual([
      {
        sessionKey: "A",
        agentSessionId: "s-1",
        agent: "claude-code",
        cwd: "/other",
        human: false,
        lastAt: now - 1000,
        events: 2,
      },
      {
        sessionKey: "B",
        agentSessionId: undefined,
        agent: "web",
        cwd: "web",
        human: true,
        lastAt: now - 4000,
        events: 1,
      },
    ]);
  });

  test("작업(purpose)을 남기고, 세션 묶음에는 마지막으로 남긴 작업을 준다", () => {
    const now = 1_000 * DAY;
    const { history } = open({ now: () => now });
    history.add(event(now - 3000, "A", { purpose: "로그인 화면" }));
    history.add(event(now - 2000, "A", { purpose: "결제 화면" }));
    history.add(event(now - 1000, "A", { kind: "deadlock" }));
    history.add(event(now - 500, "B"));
    expect(history.list({ sessionKey: "A" }).map((e) => e.purpose)).toEqual([
      undefined,
      "결제 화면",
      "로그인 화면",
    ]);
    expect(history.sessions().map((x) => [x.sessionKey, x.purpose])).toEqual([
      ["B", undefined],
      ["A", "결제 화면"],
    ]);
  });

  test("작업 열이 없던 예전 기록 파일은 열을 더하고 예전 기록은 그대로 읽는다", () => {
    const env = tempEnv();
    cleanups.push(env.cleanup);
    mkdirSync(env.paths.stateDir, { recursive: true });
    const old = new Database(env.paths.history, { create: true });
    old.run(`CREATE TABLE events (
      id INTEGER PRIMARY KEY, at INTEGER NOT NULL, kind TEXT NOT NULL, session_key TEXT NOT NULL,
      agent_session_id TEXT, agent TEXT NOT NULL, cwd TEXT NOT NULL, human INTEGER NOT NULL,
      device_ids TEXT NOT NULL
    )`);
    const now = Date.now();
    old
      .query(
        "INSERT INTO events (at, kind, session_key, agent, cwd, human, device_ids) VALUES (?, 'acquired', 'A', 'codex', '/w', 0, '[\"aaaa\"]')",
      )
      .run(now - 1000);
    old.close();

    const history = new History(env.paths.history);
    cleanups.push(() => history.close());
    history.add(event(now, "A", { kind: "released", purpose: "레이아웃" }));
    expect(history.list().map((e) => [e.kind, e.purpose])).toEqual([
      ["released", "레이아웃"],
      ["acquired", undefined],
    ]);
  });

  test("보관 기간이 지난 기록은 지운다 — 열 때, 한 시간마다, 기간을 바꿀 때", () => {
    let now = 1_000 * DAY;
    const { history } = open({ now: () => now, retentionDays: 90 });
    history.add(event(now - 91 * DAY, "old"));
    history.add(event(now - 10 * DAY, "recent"));
    expect(history.prune()).toBe(1);
    expect(history.list().map((e) => e.sessionKey)).toEqual(["recent"]);

    // 한 시간이 안 지났으면 지우지 않는다
    history.add(event(now - 91 * DAY, "stale"));
    now += 30 * 60_000;
    history.pruneIfDue();
    expect(history.list()).toHaveLength(2);
    now += 30 * 60_000;
    history.pruneIfDue();
    expect(history.list().map((e) => e.sessionKey)).toEqual(["recent"]);

    history.setRetentionDays(1);
    expect(history.list()).toHaveLength(0);
  });

  test("예전 history.json 을 한 번 옮기고 .migrated 로 남긴다", () => {
    const env = tempEnv();
    cleanups.push(env.cleanup);
    const now = Date.now();
    const old = [event(now - 2000, "A"), event(now - 1000, "B", { agentSessionId: "s-2" })];
    mkdirSync(env.paths.stateDir, { recursive: true });
    writeFileSync(env.paths.legacyHistory, JSON.stringify({ events: old }));

    const history = new History(env.paths.history, { legacyPath: env.paths.legacyHistory });
    expect(history.list()).toEqual([...old].reverse());
    expect(existsSync(env.paths.legacyHistory)).toBe(false);
    expect(existsSync(`${env.paths.legacyHistory}.migrated`)).toBe(true);
    history.close();

    // 다시 열어도 두 번 옮기지 않는다
    const again = new History(env.paths.history, { legacyPath: env.paths.legacyHistory });
    expect(again.list()).toHaveLength(2);
    again.close();
    expect(statSync(env.paths.history).mode & 0o777).toBe(0o600);
  });

  test("예전 파일을 못 읽으면 건드리지 않는다", () => {
    const env = tempEnv();
    cleanups.push(env.cleanup);
    mkdirSync(env.paths.stateDir, { recursive: true });
    writeFileSync(env.paths.legacyHistory, "{ not json");
    const history = new History(env.paths.history, { legacyPath: env.paths.legacyHistory });
    expect(history.list()).toHaveLength(0);
    expect(existsSync(env.paths.legacyHistory)).toBe(true);
    history.close();
  });
});
