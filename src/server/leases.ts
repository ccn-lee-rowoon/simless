import { z } from "zod";
import { type SessionInfo, SessionInfo as SessionInfoSchema } from "../shared/protocol.ts";

// 점유·대기 (R13·R14·R17, docs/design.md §8). 시간·저장은 밖에서 주입받는 순수 로직이다.

export interface SessionRecord extends SessionInfo {
  lastUsedAt: number;
}

export interface Lease {
  deviceId: string;
  sessionKey: string;
  acquiredAt: number;
}

/** 대기 항목은 연결이 아니라 세션에 붙는다 — CLI 가 끊겨도 순번이 남는다 */
export interface QueueEntry {
  sessionKey: string;
  deviceIds: string[];
  enqueuedAt: number;
}

export interface LeaseState {
  sessions: SessionRecord[];
  leases: Lease[];
  queue: QueueEntry[];
}

export interface Holder {
  deviceId: string;
  session: SessionRecord;
  since: number;
  /** held = 쓰는 중, queued = 먼저 기다리는 중 */
  reason: "held" | "queued";
}

export type AcquireResult =
  | { status: "granted"; deviceIds: string[] }
  | { status: "busy"; holders: Holder[] }
  | { status: "queued"; position: number; holders: Holder[] };

export interface LeaseOptions {
  /** 마지막 사용 후 이 시간이 지나고 기다리는 세션이 있으면 푼다 */
  idleMs: number;
  now?: () => number;
  /** 대기하던 세션이 점유를 받았을 때 */
  onGranted?: (sessionKey: string, deviceIds: string[]) => void;
  /** 상태가 바뀔 때마다 — 저장·화면 갱신용 */
  onChange?: (state: LeaseState) => void;
}

export class LeaseManager {
  private sessions = new Map<string, SessionRecord>();
  private leases = new Map<string, Lease>();
  private queue: QueueEntry[] = [];
  private readonly now: () => number;

  constructor(
    state: LeaseState,
    private readonly options: LeaseOptions,
  ) {
    this.now = options.now ?? Date.now;
    for (const s of state.sessions) this.sessions.set(s.key, s);
    for (const l of state.leases) this.leases.set(l.deviceId, l);
    this.queue = [...state.queue];
  }

  snapshot(): LeaseState {
    return {
      sessions: [...this.sessions.values()],
      leases: [...this.leases.values()],
      queue: this.queue.map((e) => ({ ...e, deviceIds: [...e.deviceIds] })),
    };
  }

  session(key: string): SessionRecord | undefined {
    return this.sessions.get(key);
  }

  holderOf(deviceId: string): SessionRecord | undefined {
    const lease = this.leases.get(deviceId);
    return lease ? this.sessions.get(lease.sessionKey) : undefined;
  }

  heldBy(sessionKey: string): string[] {
    return [...this.leases.values()]
      .filter((l) => l.sessionKey === sessionKey)
      .map((l) => l.deviceId);
  }

  queuePosition(sessionKey: string): number | undefined {
    const index = this.queue.findIndex((e) => e.sessionKey === sessionKey);
    return index < 0 ? undefined : index + 1;
  }

  /** 세션의 마지막 사용 시각을 갱신한다. 같은 키에서 에이전트 세션 ID 가 바뀌면 새 대화로 본다. */
  touch(info: SessionInfo): SessionRecord {
    const existing = this.sessions.get(info.key);
    if (
      existing?.agentSessionId !== undefined &&
      info.agentSessionId !== undefined &&
      existing.agentSessionId !== info.agentSessionId
    ) {
      // 새 대화(/clear 등)는 자기가 점유했다는 걸 모른다 — 이전 점유를 푼다 (§7)
      this.endSession(info.key);
    }
    const record: SessionRecord = { ...info, lastUsedAt: this.now() };
    this.sessions.set(info.key, record);
    return record;
  }

  acquire(info: SessionInfo, deviceIds: string[], { wait }: { wait: boolean }): AcquireResult {
    const session = this.touch(info);
    const wanted = [...new Set(deviceIds)].sort();
    const blockers = this.blockers(session.key, wanted);

    if (blockers.length === 0) {
      this.grant(session.key, wanted);
      this.queue = this.queue.filter((e) => e.sessionKey !== session.key);
      this.changed();
      return { status: "granted", deviceIds: wanted };
    }
    if (!wait) return { status: "busy", holders: blockers };

    const entry = this.queue.find((e) => e.sessionKey === session.key);
    if (entry) {
      entry.deviceIds = wanted;
    } else {
      this.queue.push({ sessionKey: session.key, deviceIds: wanted, enqueuedAt: this.now() });
    }
    this.changed();
    return {
      status: "queued",
      position: this.queuePosition(session.key) ?? this.queue.length,
      holders: this.blockers(session.key, wanted),
    };
  }

  /** deviceIds 를 안 주면 이 세션의 점유·대기를 모두 푼다. */
  release(sessionKey: string, deviceIds?: string[]): string[] {
    const targets = deviceIds ?? this.heldBy(sessionKey);
    const released = targets.filter((id) => this.leases.get(id)?.sessionKey === sessionKey);
    for (const id of released) this.leases.delete(id);
    if (deviceIds === undefined) this.queue = this.queue.filter((e) => e.sessionKey !== sessionKey);
    this.prune(sessionKey);
    this.processQueue();
    this.changed();
    return released;
  }

  /** 세션 프로세스가 끝났다 — 점유·대기·기록을 모두 지운다 (R17 ①) */
  endSession(sessionKey: string): void {
    for (const id of this.heldBy(sessionKey)) this.leases.delete(id);
    this.queue = this.queue.filter((e) => e.sessionKey !== sessionKey);
    this.sessions.delete(sessionKey);
    this.processQueue();
    this.changed();
  }

  /** 오래 안 쓴 점유 중 누가 기다리는 것만 푼다 (R17 ②). 푼 세션 키를 돌려준다. */
  sweepIdle(): string[] {
    const now = this.now();
    const wanted = new Set(this.queue.flatMap((e) => e.deviceIds));
    const idle = new Set<string>();
    for (const lease of this.leases.values()) {
      const holder = this.sessions.get(lease.sessionKey);
      if (holder && now - holder.lastUsedAt >= this.options.idleMs && wanted.has(lease.deviceId)) {
        idle.add(holder.key);
      }
    }
    for (const key of idle) {
      for (const id of this.heldBy(key)) this.leases.delete(id);
    }
    if (idle.size > 0) {
      this.processQueue();
      this.changed();
    }
    return [...idle];
  }

  /** 이 세션이 지금 잡을 수 없게 막는 것 — 남의 점유, 같은 디바이스를 먼저 기다리는 세션 */
  private blockers(sessionKey: string, deviceIds: string[]): Holder[] {
    const result: Holder[] = [];
    for (const id of deviceIds) {
      const lease = this.leases.get(id);
      const holder = lease && this.sessions.get(lease.sessionKey);
      if (lease && holder && lease.sessionKey !== sessionKey) {
        result.push({ deviceId: id, session: holder, since: lease.acquiredAt, reason: "held" });
      }
    }
    // 디바이스마다 먼저 온 순서 — 앞에서 같은 디바이스를 기다리는 세션이 있으면 새치기하지 않는다.
    const myIndex = this.queue.findIndex((e) => e.sessionKey === sessionKey);
    const ahead = myIndex < 0 ? this.queue : this.queue.slice(0, myIndex);
    for (const entry of ahead) {
      const waiter = this.sessions.get(entry.sessionKey);
      if (!waiter || entry.sessionKey === sessionKey) continue;
      for (const id of entry.deviceIds) {
        if (deviceIds.includes(id) && !result.some((h) => h.deviceId === id)) {
          result.push({ deviceId: id, session: waiter, since: entry.enqueuedAt, reason: "queued" });
        }
      }
    }
    return result;
  }

  private grant(sessionKey: string, deviceIds: string[]): void {
    const now = this.now();
    for (const id of deviceIds) {
      if (this.leases.get(id)?.sessionKey !== sessionKey) {
        this.leases.set(id, { deviceId: id, sessionKey, acquiredAt: now });
      }
    }
  }

  private processQueue(): void {
    let index = 0;
    while (index < this.queue.length) {
      const entry = this.queue[index];
      if (entry && this.blockers(entry.sessionKey, entry.deviceIds).length === 0) {
        this.grant(entry.sessionKey, entry.deviceIds);
        this.queue.splice(index, 1);
        const session = this.sessions.get(entry.sessionKey);
        if (session) session.lastUsedAt = this.now();
        this.options.onGranted?.(entry.sessionKey, entry.deviceIds);
        index = 0; // 앞이 빠졌으니 처음부터 다시 본다
      } else {
        index += 1;
      }
    }
  }

  /** 점유도 대기도 없는 세션 기록은 지운다 */
  private prune(sessionKey: string): void {
    if (this.heldBy(sessionKey).length === 0 && this.queuePosition(sessionKey) === undefined) {
      this.sessions.delete(sessionKey);
    }
  }

  private changed(): void {
    this.options.onChange?.(this.snapshot());
  }
}

const SessionRecordSchema = SessionInfoSchema.extend({ lastUsedAt: z.number() });

/** leases.json 형식 — 서버를 다시 켜도 점유·대기열을 복원한다 */
export const LeaseStateSchema = z.object({
  sessions: z.array(SessionRecordSchema),
  leases: z.array(
    z.object({ deviceId: z.string(), sessionKey: z.string(), acquiredAt: z.number() }),
  ),
  queue: z.array(
    z.object({ sessionKey: z.string(), deviceIds: z.array(z.string()), enqueuedAt: z.number() }),
  ),
});

export const EMPTY_LEASE_STATE: LeaseState = { sessions: [], leases: [], queue: [] };
