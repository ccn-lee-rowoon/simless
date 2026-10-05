import { useEffect, useMemo, useState } from "react";
import type { DeviceView, HistoryEvent, HistoryKind, StatusResult } from "../shared/api.ts";
import { language, type MessageKey, t } from "../shared/i18n.ts";
import { call } from "./api.ts";
import type { Act } from "./types.ts";
import { ago, shortPath, who, widthText } from "./ui.tsx";

/** 세션 화면 — 세션마다 점유한 디바이스와 기다리는 디바이스 (M13). 사람은 강제 해제 */
export function SessionsView({ status, act }: { status: StatusResult; act: Act }) {
  const byId = useMemo(() => new Map(status.devices.map((d) => [d.id, d])), [status.devices]);
  const name = (id: string) => byId.get(id)?.name ?? id;

  return (
    <>
      {status.sessions.length === 0 ? (
        <div className="empty">
          <p>{t("web.sessions.empty")}</p>
          <p className="sub">{t("web.sessions.emptyHint")}</p>
        </div>
      ) : (
        <Current status={status} act={act} byId={byId} name={name} />
      )}
      <HistorySection status={status} name={name} />
    </>
  );
}

function Current({
  status,
  act,
  byId,
  name,
}: {
  status: StatusResult;
  act: Act;
  byId: Map<string, DeviceView>;
  name: (id: string) => string;
}) {
  return (
    <div className="session-list">
      {status.sessions.map((s) => {
        const mine = s.sessionKey === status.session.key;
        return (
          <article key={s.sessionKey} className="panel session-card">
            <header className="group-head">
              <h3>{who(s)}</h3>
              {mine && <span className="chip chip-default">{t("web.device.mine")}</span>}
              <span className="sub mono">{s.sessionKey}</span>
              <span className="spacer" />
              <span className="sub">{t("web.sessions.lastUsed", { ago: ago(s.lastUsedAt) })}</span>
            </header>
            {!s.human && <p className="sub mono session-cwd">{shortPath(s.cwd)}</p>}

            {s.held.length > 0 && (
              <section>
                <h4 className="section-label">
                  {t("web.sessions.held", { count: s.held.length })}
                </h4>
                <ul className="group-devices">
                  {s.held.map((h) => {
                    const device = byId.get(h.deviceId);
                    return (
                      <li key={h.deviceId}>
                        <span className={device?.booted ? "dot dot-on" : "dot"} />
                        {device && <span className="mono">{widthText(device)}</span>}
                        <span className="strong">{name(h.deviceId)}</span>
                        <span className="sub">
                          {t("web.sessions.since", { ago: ago(h.since) })}
                        </span>
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
              </section>
            )}

            {s.queued.length > 0 && (
              <section>
                <h4 className="section-label">
                  {t("web.sessions.queued", { position: s.queuePosition ?? "?" })}
                </h4>
                <ul className="group-devices">
                  {s.queued.map((id) => {
                    const holder = byId.get(id)?.holder;
                    return (
                      <li key={id}>
                        <span className="dot" />
                        <span className="strong">{name(id)}</span>
                        {holder && (
                          <span className="sub">
                            {t("web.sessions.heldBy", { who: who(holder) })}
                          </span>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </section>
            )}
          </article>
        );
      })}
    </div>
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

function timeText(at: number): string {
  const date = new Date(at);
  const today = new Date().toDateString() === date.toDateString();
  return date.toLocaleString(language() === "ko" ? "ko-KR" : "en-US", {
    month: today ? undefined : "numeric",
    day: today ? undefined : "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: today ? "2-digit" : undefined,
  });
}

/** 기록 — 누가 언제 무엇을 점유하고 놓았는지 (M13). 서버를 다시 켜도 남는다 */
function HistorySection({ status, name }: { status: StatusResult; name: (id: string) => string }) {
  const [events, setEvents] = useState<HistoryEvent[] | null>(null);
  const [session, setSession] = useState("");

  // 상태가 바뀔 때마다(SSE·주기 갱신) 다시 읽는다
  useEffect(() => {
    void status;
    call<HistoryEvent[]>("lease.history", { limit: 200 }).then(setEvents, () => setEvents([]));
  }, [status]);

  const sessions = [...new Map((events ?? []).map((e) => [e.sessionKey, e] as const)).values()];
  const shown = (events ?? []).filter((e) => session === "" || e.sessionKey === session);

  return (
    <section className="history">
      <header className="history-head">
        <h2 className="section-title">{t("web.history.title")}</h2>
        <span className="spacer" />
        <label className="inline-field">
          <span>{t("web.nav.sessions")}</span>
          <select value={session} onChange={(e) => setSession(e.target.value)}>
            <option value="">{t("web.history.allSessions")}</option>
            {sessions.map((e) => (
              <option key={e.sessionKey} value={e.sessionKey}>
                {who(e)} · {e.sessionKey}
              </option>
            ))}
          </select>
        </label>
      </header>
      {!events ? (
        <p className="sub">{t("web.loading")}</p>
      ) : shown.length === 0 ? (
        <p className="sub">{t("web.history.empty")}</p>
      ) : (
        <div className="panel table-scroll">
          <table className="table history-table">
            <thead>
              <tr>
                <th className="col-time">{t("web.history.time")}</th>
                <th>{t("web.nav.sessions")}</th>
                <th>{t("web.history.what")}</th>
                <th>{t("web.nav.devices")}</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((e) => (
                <tr key={`${e.at}-${e.sessionKey}-${e.kind}-${e.deviceIds.join()}`}>
                  <td className="mono sub nowrap">{timeText(e.at)}</td>
                  <td>
                    <div>{who(e)}</div>
                    {!e.human && <div className="sub mono">{shortPath(e.cwd)}</div>}
                  </td>
                  <td>
                    <span className={`history-kind history-${e.kind}`}>{t(KIND[e.kind])}</span>
                  </td>
                  <td>{e.deviceIds.map(name).join(", ")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
