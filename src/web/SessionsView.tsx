import { useEffect, useMemo, useState } from "react";
import type {
  DeviceView,
  HistoryEvent,
  HistoryKind,
  HistorySession,
  SessionView,
  StatusResult,
} from "../shared/api.ts";
import { type MessageKey, t } from "../shared/i18n.ts";
import { fullTime, when } from "../shared/time.ts";
import { AgentIcon, agentLabel } from "./agents.tsx";
import { call } from "./api.ts";
import { postToApp } from "./bridge.ts";
import { PlatformIcon } from "./icons.tsx";
import type { Act } from "./types.ts";
import { SkeletonRows, shortPath, widthText } from "./ui.tsx";

/** 세션 하나 — 지금 점유·대기(status)와 기록을 세션 키로 묶은 것 */
interface SessionRow {
  sessionKey: string;
  agentSessionId?: string;
  agent: string;
  human: boolean;
  cwd: string;
  /** 마지막 활동 — 기록의 마지막 시각 또는 마지막 사용 */
  lastAt: number;
  events: number;
  /**
   * 위에 하나로 보일 작업 (M13) — 지금 쓰는 세션은 점유·대기의 작업이 하나일 때만(여럿이면 줄마다),
   * 지난 세션은 기록의 마지막 작업
   */
  purpose?: string;
  /** 지금 점유하거나 기다리는 중이면 */
  active?: SessionView;
}

function rows(status: StatusResult, past: HistorySession[]): SessionRow[] {
  const byKey = new Map<string, SessionRow>();
  // 서버가 세션마다 묶어 준다 (lease.sessions — 마지막 활동·기록 수)
  for (const s of past) byKey.set(s.sessionKey, { ...s });
  for (const s of status.sessions) {
    const row = byKey.get(s.sessionKey);
    byKey.set(s.sessionKey, {
      sessionKey: s.sessionKey,
      agentSessionId: s.agentSessionId ?? row?.agentSessionId,
      agent: s.agent,
      human: s.human,
      cwd: s.cwd,
      lastAt: Math.max(s.lastUsedAt, row?.lastAt ?? 0),
      events: row?.events ?? 0,
      // 기록의 작업은 이미 끝났을 수 있다 — 지금 쓰는 세션은 지금 점유·대기의 작업만 본다
      purpose: singlePurpose(s),
      active: s,
    });
  }
  return [...byKey.values()].sort(
    (a, b) => Number(Boolean(b.active)) - Number(Boolean(a.active)) || b.lastAt - a.lastAt,
  );
}

/** 지금 점유·대기의 작업 (빈 것은 빼고) */
function purposes(s: SessionView): Set<string> {
  const all = [...s.held.map((h) => h.purpose), s.queuedPurpose];
  return new Set(all.filter((p): p is string => Boolean(p)));
}

/** 작업이 하나뿐이면 그것 — 여럿이면 위에 하나를 고르지 않고 기기 줄마다 보인다 */
function singlePurpose(s: SessionView): string | undefined {
  const set = purposes(s);
  return set.size === 1 ? [...set][0] : undefined;
}

/** 세션 기록 창 열기 — 앱이면 Swift 에 알려 별도 창, 브라우저면 새 창 */
export function openSessionWindow(sessionKey: string): void {
  if (postToApp({ open: "session", key: sessionKey })) return;
  window.open(
    `/?window=session&key=${encodeURIComponent(sessionKey)}`,
    `simless-session-${sessionKey}`,
    "width=820,height=700",
  );
}

/** 세션 화면 — 세션마다 지금 점유·대기와 마지막 활동. 누르면 그 세션의 기록이 새 창으로 (M13) */
export function SessionsView({ status, act }: { status: StatusResult; act: Act }) {
  const [recorded, setRecorded] = useState<HistorySession[] | null>(null);
  const byId = useMemo(() => new Map(status.devices.map((d) => [d.id, d])), [status.devices]);

  // 상태가 바뀔 때마다(SSE·주기 갱신) 다시 읽는다
  useEffect(() => {
    void status;
    call<HistorySession[]>("lease.sessions", { limit: 200 }).then(setRecorded, () =>
      setRecorded([]),
    );
  }, [status]);

  if (!recorded) return <SkeletonRows />;
  const list = rows(status, recorded);
  const active = list.filter((r) => r.active);
  const past = list.filter((r) => !r.active);

  if (list.length === 0) {
    return (
      <div className="empty">
        <p>{t("web.sessions.empty")}</p>
        <p className="sub">{t("web.sessions.emptyHint")}</p>
      </div>
    );
  }

  const card = (row: SessionRow) => (
    <SessionCard
      key={row.sessionKey}
      row={row}
      mine={row.sessionKey === status.session.key}
      byId={byId}
      act={act}
    />
  );

  return (
    <div className="session-sections">
      <section>
        <h2 className="section-title">{t("web.sessions.active", { count: active.length })}</h2>
        {active.length === 0 ? (
          <p className="sub">{t("web.sessions.noneActive")}</p>
        ) : (
          <div className="session-list">{active.map(card)}</div>
        )}
      </section>
      {past.length > 0 && (
        <section>
          <h2 className="section-title">{t("web.sessions.past", { count: past.length })}</h2>
          <div className="session-list">{past.map(card)}</div>
        </section>
      )}
    </div>
  );
}

/** 세션 ID — 에이전트가 주는 ID 가 있으면 그것과 simless 세션 키를 함께 */
function SessionIds({ row }: { row: Pick<SessionRow, "agentSessionId" | "sessionKey"> }) {
  return (
    <span className="session-ids">
      {row.agentSessionId && (
        <span className="mono" title={t("web.sessions.agentSessionId")}>
          {row.agentSessionId}
        </span>
      )}
      <span className="mono sub" title={t("web.sessions.simlessKey")}>
        {row.sessionKey}
      </span>
    </span>
  );
}

function SessionCard({
  row,
  mine,
  byId,
  act,
}: {
  row: SessionRow;
  mine: boolean;
  byId: Map<string, DeviceView>;
  act: Act;
}) {
  const name = (id: string) => byId.get(id)?.name ?? id;
  const s = row.active;
  // 작업이 하나면 위에 한 번, 여럿이면 기기 줄·대기 줄마다
  const perDevice = s !== undefined && purposes(s).size > 1;
  return (
    <article className="panel session-card">
      <button
        type="button"
        className="session-open"
        title={t("web.sessions.openHistory")}
        onClick={() => openSessionWindow(row.sessionKey)}
      >
        <AgentIcon agent={row.agent} human={row.human} size={28} />
        <span className="session-title">
          <span className="strong session-name">
            {agentLabel(row.agent, row.human)}
            {mine && <span className="chip chip-default">{t("web.device.mine")}</span>}
          </span>
          {row.purpose && (
            <span className="session-purpose" title={t("web.sessions.purpose")}>
              {row.purpose}
            </span>
          )}
          <SessionIds row={row} />
          {!row.human && <span className="sub mono">{shortPath(row.cwd)}</span>}
        </span>
        <span className="spacer" />
        <span className="session-meta sub">
          <span title={fullTime(row.lastAt)}>
            {s
              ? t("web.sessions.lastUsed", { ago: when(row.lastAt) })
              : t("web.sessions.lastActive", { ago: when(row.lastAt) })}
          </span>
          <span>{t("web.sessions.events", { count: row.events })} ↗</span>
        </span>
      </button>

      {s && s.held.length > 0 && (
        <ul className="group-devices session-devices">
          {s.held.map((h) => {
            const device = byId.get(h.deviceId);
            return (
              <li key={h.deviceId}>
                {device && <PlatformIcon platform={device.platform} />}
                {device && <span className="mono">{widthText(device)}</span>}
                <span className="strong">{name(h.deviceId)}</span>
                <span className="sub" title={fullTime(h.since)}>
                  {t("web.sessions.since", { ago: when(h.since) })}
                </span>
                {perDevice && h.purpose && (
                  <span className="sub session-purpose" title={t("web.sessions.purpose")}>
                    {h.purpose}
                  </span>
                )}
                <span className="spacer" />
                {!mine && (
                  <button
                    type="button"
                    className="button button-small"
                    onClick={() =>
                      act(`${name(h.deviceId)} — ${t("web.device.forceRelease")}`, () =>
                        call("lease.forceRelease", { device: h.deviceId }),
                      )
                    }
                  >
                    {t("web.device.forceRelease")}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {s && s.queued.length > 0 && (
        <p className="sub session-queued">
          {t("web.sessions.queued", { position: s.queuePosition ?? "?" })} —{" "}
          {s.queued.map(name).join(", ")}
          {perDevice && s.queuedPurpose && (
            <span className="session-purpose" title={t("web.sessions.purpose")}>
              {" "}
              · {s.queuedPurpose}
            </span>
          )}
        </p>
      )}
    </article>
  );
}

const KIND: Record<HistoryKind, MessageKey> = {
  acquired: "web.history.acquired",
  queued: "web.history.queued",
  granted: "web.history.granted",
  released: "web.history.released",
  forced: "web.history.forced",
  ended: "web.history.ended",
  idle: "web.history.idle",
  deadlock: "web.history.deadlock",
};

/** 세션 기록 창 — ?window=session&key=… (M13) */
export function SessionWindow({
  status,
  sessionKey,
}: {
  status: StatusResult;
  sessionKey: string;
}) {
  const [events, setEvents] = useState<HistoryEvent[] | null>(null);
  const byId = useMemo(() => new Map(status.devices.map((d) => [d.id, d])), [status.devices]);

  useEffect(() => {
    void status;
    call<HistoryEvent[]>("lease.history", { limit: 2000, session: sessionKey }).then(
      setEvents,
      () => setEvents([]),
    );
  }, [status, sessionKey]);

  if (!events) return <SkeletonRows />;
  const active = status.sessions.find((s) => s.sessionKey === sessionKey);
  const first = events.at(-1);
  // 작업이 있는 기록이 하나도 없으면(예전 기록) 작업 칸을 두지 않는다
  const withPurpose = events.some((e) => e.purpose);
  const head = active ?? events[0];
  const agentSessionId =
    active?.agentSessionId ?? events.find((e) => e.agentSessionId)?.agentSessionId;

  return (
    <div className="session-window">
      {head && (
        <header className="session-window-head">
          <AgentIcon agent={head.agent} human={head.human} size={32} />
          <div className="session-title">
            <h1 className="page-title">{agentLabel(head.agent, head.human)}</h1>
            <SessionIds row={{ sessionKey, agentSessionId }} />
            {!head.human && <span className="sub mono">{shortPath(head.cwd)}</span>}
          </div>
          <span className="spacer" />
          <span className={active ? "chip chip-default" : "chip"}>
            {active ? t("web.sessions.stateActive") : t("web.sessions.stateEnded")}
          </span>
        </header>
      )}
      {first && (
        <p className="sub">
          {t("web.sessions.range", {
            from: when(first.at, { seconds: true }),
            count: events.length,
          })}
        </p>
      )}
      {events.length === 0 ? (
        <p className="sub">{t("web.history.empty")}</p>
      ) : (
        <ol className={withPurpose ? "timeline timeline-with-purpose" : "timeline"}>
          {events.map((e) => (
            <li key={`${e.at}-${e.kind}-${e.deviceIds.join()}`} className="timeline-item">
              <span className="mono sub timeline-time" title={fullTime(e.at)}>
                {when(e.at, { seconds: true })}
              </span>
              <span className={`timeline-dot history-dot-${e.kind}`} />
              <span className={`history-kind history-${e.kind}`}>{t(KIND[e.kind])}</span>
              <span className="timeline-devices">
                {e.deviceIds.map((id) => {
                  const device = byId.get(id);
                  return (
                    <span key={id} className="timeline-device">
                      {device && <PlatformIcon platform={device.platform} />}
                      {device?.name ?? id}
                    </span>
                  );
                })}
              </span>
              {withPurpose && (
                <span className="timeline-purpose" title={e.purpose && t("web.sessions.purpose")}>
                  {e.purpose}
                </span>
              )}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
