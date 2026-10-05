import { z } from "zod";
import type { HistoryEvent } from "./leases.ts";
import { readJson, writeJson } from "./store.ts";

// 점유 기록 (M13) — 최근 것만 남긴다. 서버를 다시 켜도 이어서 보인다.

const MAX = 500;

const Event = z.object({
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
});
const HistoryFile = z.object({ events: z.array(Event) });

export class History {
  private events: HistoryEvent[];

  constructor(private readonly path: string) {
    this.events = readJson(path, HistoryFile, { events: [] }).events;
  }

  add(event: HistoryEvent): void {
    this.events.push(event);
    if (this.events.length > MAX) this.events = this.events.slice(-MAX);
    writeJson(this.path, { events: this.events });
  }

  /** 최근 것부터 */
  list(options: { limit?: number; sessionKey?: string } = {}): HistoryEvent[] {
    const matching = options.sessionKey
      ? this.events.filter((e) => e.sessionKey === options.sessionKey)
      : this.events;
    return matching.slice(-(options.limit ?? 100)).reverse();
  }
}
