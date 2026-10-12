import { z } from "zod";
import type { HistoryEvent, HistoryKind } from "../shared/api.ts";
import { type SessionInfo, SessionInfo as SessionInfoSchema } from "../shared/protocol.ts";

export type { HistoryEvent, HistoryKind };

// 점유·대기 (R13·R14·R17, docs/design.md §8). 시간·저장은 밖에서 주입받는 순수 로직이다.

export interface SessionRecord extends SessionInfo {
  lastUsedAt: number;
}

export interface Lease {
  deviceId: string;
  sessionKey: string;
  acquiredAt: number;
}

/**
 * 대기 항목은 연결이 아니라 세션에 붙는다 — CLI 가 끊겨도 순번이 남는다.
 * `all` 은 전부 빌 때 한 번에, `each` 는 하나씩 빌 때마다 준다 (R23, docs/design.md §8).
 */
export interface QueueEntry {
  sessionKey: string;
  deviceIds: string[];
  enqueuedAt: number;
  mode?: "all" | "each";
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

/**
 * 여러 대를 요청할 때 무엇을 잡을지 (R23) — `all` 은 전부 아니면 아무것도,
 * `available` 은 비어 있는 것만 (기다리기면 나머지는 하나씩 빌 때마다).
 */
export type AcquireMode = "all" | "available";

export type AcquireResult =
  | { status: "granted"; deviceIds: string[] }
  /** available — 일부만 잡았다. queued 면 나머지는 대기열에 */
  | { status: "partial"; deviceIds: string[]; holders: Holder[]; queued: boolean }
  | { status: "busy"; holders: Holder[] }
  | { status: "queued"; position: number; holders: Holder[] }
  /** 기다리면 서로를 기다리게 된다 — 대기열에 넣지 않았다 */
  | { status: "deadlock"; holders: Holder[]; cycle: string[] };

export interface LeaseOptions {
  /** 마지막 사용 후 이 시간이 지나고 기다리는 세션이 있으면 푼다 */
  idleMs: number;
  now?: () => number;
  /** 대기하던 세션이 점유를 받았을 때 */
  onGranted?: (sessionKey: string, deviceIds: string[]) => void;
  /** 상태가 바뀔 때마다 — 저장·화면 갱신용 */
  onChange?: (state: LeaseState) => void;
  /** 점유·해제·대기가 일어날 때마다 — 기록용 (M13) */
  onHistory?: (event: HistoryEvent) => void;
}

export class LeaseManager {
  private sessions = new Map<string, SessionRecord>();
  private leases = new Map<string, Lease>();
  private queue: QueueEntry[] = [];
  private readonly now: () => number;

  constructor(
    state: LeaseState,
    private options: LeaseOptions,
  ) {
    this.now = options.now ?? Date.now;
    for (const s of state.sessions) this.sessions.set(s.key, s);
    for (const l of state.leases) this.leases.set(l.deviceId, l);
    this.queue = [...state.queue];
  }

  /** 설정에서 자동 해제 시간을 바꿨을 때 (M11) */
  setIdleMs(idleMs: number): void {
    this.options.idleMs = idleMs;
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

  /** 이 세션이 대기열에서 기다리는 디바이스 */
  queuedFor(sessionKey: string): string[] {
    return this.queue.find((e) => e.sessionKey === sessionKey)?.deviceIds ?? [];
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
    const prev = this.sessions.get(info.key);
    const keep = prev !== undefined && keepFolder(prev, info);
    const record: SessionRecord = {
      ...info,
      cwd: keep ? prev.cwd : info.cwd,
      cwdKind: keep ? prev.cwdKind : info.cwdKind,
      lastUsedAt: this.now(),
    };
    this.sessions.set(info.key, record);
    return record;
  }

  acquire(
    info: SessionInfo,
    deviceIds: string[],
    { wait, mode = "all" }: { wait: boolean; mode?: AcquireMode },
  ): AcquireResult {
    const session = this.touch(info);
    const wanted = [...new Set(deviceIds)].sort();
    const blockers = this.blockers(session.key, wanted);

    if (blockers.length === 0) {
      this.grant(session.key, wanted);
      this.queue = this.queue.filter((e) => e.sessionKey !== session.key);
      this.changed();
      return { status: "granted", deviceIds: wanted };
    }

    const blocked = new Set(blockers.map((h) => h.deviceId));
    const free = mode === "available" ? wanted.filter((id) => !blocked.has(id)) : [];
    const rest = mode === "available" ? wanted.filter((id) => blocked.has(id)) : wanted;
    if (!wait) {
      if (free.length === 0) return { status: "busy", holders: blockers };
      this.grant(session.key, free);
      this.changed();
      return { status: "partial", deviceIds: free, holders: blockers, queued: false };
    }

    // 대기열에 넣기 전에 — 기다리면 서로를 기다리게 되는지 본다 (교착을 생기기 전에 막는다)
    const cycle = this.cycle(session.key, rest, free);
    if (cycle) {
      this.record("deadlock", session.key, rest);
      if (free.length > 0) {
        this.grant(session.key, free);
        this.changed();
      }
      return { status: "deadlock", holders: blockers, cycle };
    }

    this.grant(session.key, free);
    const entryMode = mode === "available" ? "each" : "all";
    const entry = this.queue.find((e) => e.sessionKey === session.key);
    // 같은 대기를 다시 요청(--wait 이어 가기)하면 기록하지 않는다
    if (entry?.deviceIds.join() !== rest.join()) this.record("queued", session.key, rest);
    if (entry) {
      entry.deviceIds = rest;
      entry.mode = entryMode;
    } else {
      this.queue.push({
        sessionKey: session.key,
        deviceIds: rest,
        enqueuedAt: this.now(),
        mode: entryMode,
      });
    }
    this.changed();
    if (free.length > 0) {
      return { status: "partial", deviceIds: free, holders: blockers, queued: true };
    }
    return {
      status: "queued",
      position: this.queuePosition(session.key) ?? this.queue.length,
      holders: this.blockers(session.key, wanted),
    };
  }

  /**
   * 이 세션이 rest 를 기다리면 순환이 생기는가 — 기다리는 기기의 주인(또는 먼저 기다리는 세션)이
   * 직간접으로 이 세션이 쥔(또는 곧 쥘 extra) 기기를 기다리면 교착이다. 생기면 세션 키 순환을 돌려준다.
   */
  private cycle(sessionKey: string, rest: string[], extra: string[]): string[] | undefined {
    const mine = new Set([...this.heldBy(sessionKey), ...extra]);
    if (mine.size === 0) return undefined; // 아무것도 쥐지 않고 기다리면 순환이 없다
    const waitsFor = (key: string, ids: string[]): string[] =>
      [...new Set(this.blockers(key, ids).map((h) => h.session.key))].filter((k) => k !== key);
    const start = waitsFor(sessionKey, rest);
    const seen = new Set<string>();
    const stack = start.map((key) => [sessionKey, key]);
    while (stack.length > 0) {
      const path = stack.pop() as string[];
      const key = path.at(-1) as string;
      if (seen.has(key)) continue;
      seen.add(key);
      const entry = this.queue.find((e) => e.sessionKey === key);
      if (!entry) continue;
      // 이 세션이 쥔 기기를 기다리면 순환
      if (entry.deviceIds.some((id) => mine.has(id))) return path;
      for (const next of waitsFor(key, entry.deviceIds)) {
        if (next === sessionKey) return path;
        stack.push([...path, next]);
      }
    }
    return undefined;
  }

  /** deviceIds 를 안 주면 이 세션의 점유·대기를 모두 푼다. forced 는 사람이 강제로 푼 것 */
  release(
    sessionKey: string,
    deviceIds?: string[],
    reason: "released" | "forced" = "released",
  ): string[] {
    const targets = deviceIds ?? this.heldBy(sessionKey);
    const released = targets.filter((id) => this.leases.get(id)?.sessionKey === sessionKey);
    if (released.length > 0) this.record(reason, sessionKey, released);
    for (const id of released) this.leases.delete(id);
    if (deviceIds === undefined) this.queue = this.queue.filter((e) => e.sessionKey !== sessionKey);
    this.prune(sessionKey);
    this.processQueue();
    this.changed();
    return released;
  }

  /** 세션 프로세스가 끝났다 — 점유·대기·기록을 모두 지운다 (R17 ①) */
  endSession(sessionKey: string): void {
    const held = this.heldBy(sessionKey);
    if (held.length > 0) this.record("ended", sessionKey, held);
    for (const id of held) this.leases.delete(id);
    this.queue = this.queue.filter((e) => e.sessionKey !== sessionKey);
    this.sessions.delete(sessionKey);
    this.processQueue();
    this.changed();
  }

  /** 디바이스가 사라졌다(지웠거나 밖에서 지워짐) — 점유와 대기열에서 뺀다 */
  forgetDevice(deviceId: string): void {
    const lease = this.leases.get(deviceId);
    this.leases.delete(deviceId);
    for (const entry of this.queue)
      entry.deviceIds = entry.deviceIds.filter((id) => id !== deviceId);
    this.queue = this.queue.filter((e) => e.deviceIds.length > 0);
    if (lease) this.prune(lease.sessionKey);
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
      const held = this.heldBy(key);
      this.record("idle", key, held);
      for (const id of held) this.leases.delete(id);
    }
    if (idle.size > 0) {
      this.processQueue();
      this.changed();
    }
    return [...idle];
  }

  /** 이 세션이 지금 잡을 수 없게 막는 것 — 남의 점유, 같은 디바이스를 먼저 기다리는 세션 */
  blockers(sessionKey: string, deviceIds: string[]): Holder[] {
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

  /** 점유를 준다 — 새로 잡은 것만 기록한다 (이미 쥔 것을 다시 요청한 건 빼고) */
  private grant(
    sessionKey: string,
    deviceIds: string[],
    kind: "acquired" | "granted" = "acquired",
  ): void {
    const now = this.now();
    const fresh = deviceIds.filter((id) => this.leases.get(id)?.sessionKey !== sessionKey);
    for (const id of fresh) this.leases.set(id, { deviceId: id, sessionKey, acquiredAt: now });
    if (fresh.length > 0) this.record(kind, sessionKey, fresh);
  }

  private record(kind: HistoryKind, sessionKey: string, deviceIds: string[]): void {
    const session = this.sessions.get(sessionKey);
    this.options.onHistory?.({
      at: this.now(),
      kind,
      sessionKey,
      agentSessionId: session?.agentSessionId,
      agent: session?.agent ?? "unknown",
      cwd: session?.cwd ?? "",
      human: session?.human ?? false,
      deviceIds: [...deviceIds],
    });
  }

  private processQueue(): void {
    let index = 0;
    while (index < this.queue.length) {
      const entry = this.queue[index];
      // each — 하나씩 빌 때마다 준다
      if (entry?.mode === "each") {
        const blocked = new Set(
          this.blockers(entry.sessionKey, entry.deviceIds).map((h) => h.deviceId),
        );
        const free = entry.deviceIds.filter((id) => !blocked.has(id));
        if (free.length > 0) {
          this.grant(entry.sessionKey, free, "granted");
          entry.deviceIds = entry.deviceIds.filter((id) => blocked.has(id));
          if (entry.deviceIds.length === 0) this.queue.splice(index, 1);
          const session = this.sessions.get(entry.sessionKey);
          if (session) session.lastUsedAt = this.now();
          this.options.onGranted?.(entry.sessionKey, free);
          index = 0;
          continue;
        }
        index += 1;
        continue;
      }
      if (entry && this.blockers(entry.sessionKey, entry.deviceIds).length === 0) {
        this.grant(entry.sessionKey, entry.deviceIds, "granted");
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

/**
 * 앞서 받은 작업 폴더를 지킬지 (docs/design.md §7 «작업 폴더») — 덜 정확한 값이 더 정확한 값을 덮지 않게.
 * 대화 도중 worktree 로 옮겨 간 세션이 MCP 로 부를 때마다 처음 폴더로 되돌아 보이던 것을 막는다.
 */
function keepFolder(prev: SessionInfo, next: SessionInfo): boolean {
  if (next.cwdKind === undefined) return false; // 지금 폴더(CLI·훅)는 늘 따른다
  if (next.cwdKind === "launch") return prev.cwdKind !== "launch"; // 띄운 폴더는 아무것도 덮지 않는다
  // roots — 지금 폴더가 그 작업 공간 안이면(셸 cd 로 하위 폴더·worktree) 더 구체적인 쪽을 둔다
  return prev.cwdKind === undefined && within(prev.cwd, next.cwd);
}

function within(path: string, folder: string): boolean {
  return path === folder || path.startsWith(folder.endsWith("/") ? folder : `${folder}/`);
}

const SessionRecordSchema = SessionInfoSchema.extend({ lastUsedAt: z.number() });

/** leases.json 형식 — 서버를 다시 켜도 점유·대기열을 복원한다 */
export const LeaseStateSchema = z.object({
  sessions: z.array(SessionRecordSchema),
  leases: z.array(
    z.object({ deviceId: z.string(), sessionKey: z.string(), acquiredAt: z.number() }),
  ),
  queue: z.array(
    z.object({
      sessionKey: z.string(),
      deviceIds: z.array(z.string()),
      enqueuedAt: z.number(),
      mode: z.enum(["all", "each"]).optional(),
    }),
  ),
});

export const EMPTY_LEASE_STATE: LeaseState = { sessions: [], leases: [], queue: [] };
