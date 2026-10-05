import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import type { HistorySession } from "../shared/api.ts";
import type { HistoryEvent } from "./leases.ts";

// 점유 기록 (M13) — SQLite(`history.db`). 사건은 한 줄씩 덧붙이기만 하고, 보관 기간이 지난 것은 지운다.
// 설정·레지스트리처럼 작은 «지금 상태» 는 JSON 으로 두고, 계속 쌓이는 기록만 여기에 둔다(설계 결정 기록).
// SQLite 는 macOS 에 들어 있는 것을 Bun 이 쓴다 — 단일 실행 파일에 따로 넣을 것이 없다.

const DAY_MS = 24 * 60 * 60_000;
/** 지난 기록 지우기는 이 간격보다 자주 하지 않는다 */
const PRUNE_EVERY_MS = 60 * 60_000;

/** 예전 `history.json` (최근 500개) — 처음 한 번 옮긴다 */
const LegacyFile = z.object({
  events: z.array(
    z.object({
      at: z.number(),
      kind: z.enum([
        "acquired",
        "queued",
        "granted",
        "released",
        "forced",
        "ended",
        "idle",
        "deadlock",
      ]),
      sessionKey: z.string(),
      agentSessionId: z.string().optional(),
      agent: z.string(),
      cwd: z.string(),
      human: z.boolean(),
      deviceIds: z.array(z.string()),
    }),
  ),
});

interface Row {
  at: number;
  kind: HistoryEvent["kind"];
  session_key: string;
  agent_session_id: string | null;
  agent: string;
  cwd: string;
  human: number;
  device_ids: string;
}

function toEvent(row: Row): HistoryEvent {
  return {
    at: row.at,
    kind: row.kind,
    sessionKey: row.session_key,
    agentSessionId: row.agent_session_id ?? undefined,
    agent: row.agent,
    cwd: row.cwd,
    human: row.human === 1,
    deviceIds: JSON.parse(row.device_ids) as string[],
  };
}

export interface HistoryOptions {
  /** 이보다 오래된 기록은 지운다 (기본 90일) */
  retentionDays?: number;
  /** 있으면 처음 열 때 옮기고 `.migrated` 로 이름을 바꾼다 */
  legacyPath?: string;
  now?: () => number;
}

export class History {
  private readonly db: Database;
  private readonly now: () => number;
  private retentionDays: number;
  private lastPrune = 0;

  constructor(path: string, options: HistoryOptions = {}) {
    this.now = options.now ?? Date.now;
    this.retentionDays = options.retentionDays ?? 90;
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const fresh = !existsSync(path);
    this.db = new Database(path, { create: true });
    if (fresh) chmodSync(path, 0o600);
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run("PRAGMA busy_timeout = 2000");
    this.db.run(`CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY,
      at INTEGER NOT NULL,
      kind TEXT NOT NULL,
      session_key TEXT NOT NULL,
      agent_session_id TEXT,
      agent TEXT NOT NULL,
      cwd TEXT NOT NULL,
      human INTEGER NOT NULL,
      device_ids TEXT NOT NULL
    )`);
    this.db.run("CREATE INDEX IF NOT EXISTS events_at ON events (at)");
    this.db.run("CREATE INDEX IF NOT EXISTS events_session ON events (session_key, at)");
    if (options.legacyPath) this.migrate(options.legacyPath);
    this.prune();
  }

  private readonly insert = (event: HistoryEvent) =>
    this.db
      .query(
        `INSERT INTO events (at, kind, session_key, agent_session_id, agent, cwd, human, device_ids)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        event.at,
        event.kind,
        event.sessionKey,
        event.agentSessionId ?? null,
        event.agent,
        event.cwd,
        event.human ? 1 : 0,
        JSON.stringify(event.deviceIds),
      );

  /** 예전 JSON 기록을 한 번에 옮긴다 — 읽지 못하면 건드리지 않고 남겨 둔다 */
  private migrate(legacyPath: string): void {
    if (!existsSync(legacyPath)) return;
    let events: HistoryEvent[];
    try {
      events = LegacyFile.parse(JSON.parse(readFileSync(legacyPath, "utf8"))).events;
    } catch (error) {
      console.error(`예전 기록(${legacyPath})을 읽지 못해 옮기지 않았습니다: ${String(error)}`);
      return;
    }
    this.db.transaction((list: HistoryEvent[]) => {
      for (const event of list) this.insert(event);
    })(events);
    renameSync(legacyPath, `${legacyPath}.migrated`);
  }

  add(event: HistoryEvent): void {
    this.insert(event);
  }

  /** 최근 것부터 */
  list(options: { limit?: number; sessionKey?: string } = {}): HistoryEvent[] {
    const limit = options.limit ?? 100;
    const rows = options.sessionKey
      ? this.db
          .query<Row, [string, number]>(
            "SELECT * FROM events WHERE session_key = ? ORDER BY at DESC, id DESC LIMIT ?",
          )
          .all(options.sessionKey, limit)
      : this.db
          .query<Row, [number]>("SELECT * FROM events ORDER BY at DESC, id DESC LIMIT ?")
          .all(limit);
    return rows.map(toEvent);
  }

  /** 세션마다 마지막 활동·기록 수 — 세션 화면 (M13). 마지막 활동이 최근인 것부터 */
  sessions(options: { limit?: number } = {}): HistorySession[] {
    // SQLite 는 max() 와 같이 고른 열을 그 최대 행의 값으로 준다 — 세션의 마지막 기록의 에이전트·폴더
    const rows = this.db
      .query<
        {
          session_key: string;
          last_at: number;
          events: number;
          agent: string;
          cwd: string;
          human: number;
          agent_session_id: string | null;
        },
        [number]
      >(
        `SELECT session_key, max(at) AS last_at, count(*) AS events, agent, cwd, human,
           (SELECT agent_session_id FROM events AS e2
             WHERE e2.session_key = e.session_key AND agent_session_id IS NOT NULL
             ORDER BY at DESC LIMIT 1) AS agent_session_id
         FROM events AS e GROUP BY session_key ORDER BY last_at DESC LIMIT ?`,
      )
      .all(options.limit ?? 200);
    return rows.map((r) => ({
      sessionKey: r.session_key,
      agentSessionId: r.agent_session_id ?? undefined,
      agent: r.agent,
      cwd: r.cwd,
      human: r.human === 1,
      lastAt: r.last_at,
      events: r.events,
    }));
  }

  setRetentionDays(days: number): void {
    this.retentionDays = days;
    this.prune();
  }

  /** 보관 기간이 지난 기록을 지운다. 지운 수 */
  prune(): number {
    this.lastPrune = this.now();
    const before = this.now() - this.retentionDays * DAY_MS;
    return this.db.query("DELETE FROM events WHERE at < ?").run(before).changes;
  }

  /** 서버가 2초마다 부른다 — 한 시간에 한 번만 지운다 */
  pruneIfDue(): void {
    if (this.now() - this.lastPrune >= PRUNE_EVERY_MS) this.prune();
  }

  close(): void {
    this.db.close();
  }
}
