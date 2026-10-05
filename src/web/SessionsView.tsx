import { useMemo } from "react";
import type { StatusResult } from "../shared/api.ts";
import { t } from "../shared/i18n.ts";
import { call } from "./api.ts";
import type { Act } from "./types.ts";
import { ago, shortPath, who, widthText } from "./ui.tsx";

/** 세션 화면 — 세션마다 점유한 디바이스와 기다리는 디바이스 (M13). 사람은 강제 해제 */
export function SessionsView({ status, act }: { status: StatusResult; act: Act }) {
  const byId = useMemo(() => new Map(status.devices.map((d) => [d.id, d])), [status.devices]);
  const name = (id: string) => byId.get(id)?.name ?? id;

  if (status.sessions.length === 0) {
    return (
      <div className="empty">
        <p>{t("web.sessions.empty")}</p>
        <p className="sub">{t("web.sessions.emptyHint")}</p>
      </div>
    );
  }

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
