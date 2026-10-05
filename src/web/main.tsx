import { type ReactNode, StrictMode, useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { CatalogResult, StatusResult } from "../shared/api.ts";
import { language, resolveLanguage, setLanguage, t } from "../shared/i18n.ts";
import { ApiError, call, subscribe, token } from "./api.ts";
import { postToApp } from "./bridge.ts";
import { CreateDialog } from "./CreateDialog.tsx";
import { DevicesView } from "./DevicesView.tsx";
import { GroupsView } from "./GroupsView.tsx";
import {
  DevicesIcon,
  ExternalIcon,
  GroupsIcon,
  PlusIcon,
  SessionsIcon,
  SettingsIcon,
} from "./icons.tsx";
import { SessionsView, SessionWindow } from "./SessionsView.tsx";
import { SettingsView } from "./SettingsView.tsx";
import { SetupView } from "./SetupView.tsx";
import type { Act, LogLine } from "./types.ts";
import { Logo, useMenuDismiss } from "./ui.tsx";

type View = "devices" | "groups" | "sessions";

/** 새 창 — ?window=settings 면 설정(M11)만, ?window=session&key=… 면 그 세션의 기록(M13)만 그린다 */
const PARAMS = new URLSearchParams(location.search);
const SETTINGS_WINDOW = PARAMS.get("window") === "settings";
const SESSION_WINDOW = PARAMS.get("window") === "session" ? PARAMS.get("key") : null;
/** ?window=setup — 첫 실행 설정 (M14) */
const SETUP_WINDOW = PARAMS.get("window") === "setup";

/** 설정 창 열기 — 앱(simless.app)이면 Swift 에 알려 별도 창, 브라우저면 새 창 */
function openSettings(): void {
  if (!postToApp({ open: "settings" }))
    window.open("/?window=settings", "simless-settings", "width=760,height=720");
}
const VIEW_KEY = "simless-view";

function savedView(): View {
  try {
    const value = localStorage.getItem(VIEW_KEY);
    return value === "groups" || value === "sessions" ? value : "devices";
  } catch {
    return "devices";
  }
}

interface Notice {
  id: number;
  kind: "info" | "error";
  text: string;
}

let noticeId = 0;
let logId = 0;

// 서버 상태가 오기 전까지는 브라우저(macOS) 언어로
setLanguage(resolveLanguage("system", navigator.languages));

function App() {
  const [view, setViewState] = useState<View>(savedView);
  const [status, setStatus] = useState<StatusResult | null>(null);
  const [catalog, setCatalog] = useState<CatalogResult | null>(null);
  const [online, setOnline] = useState(true);
  const [notices, setNotices] = useState<Notice[]>([]);
  const [log, setLog] = useState<LogLine[]>([]);
  const [showLog, setShowLog] = useState(true);
  const [creating, setCreating] = useState(false);
  /** 머리의 «새 그룹» 을 누를 때마다 늘어난다 — 그룹 화면이 만들기 창을 연다 */
  const [newGroup, setNewGroup] = useState(0);
  const [, setLang] = useState(language());
  useMenuDismiss();

  const setView = (next: View) => {
    setViewState(next);
    try {
      localStorage.setItem(VIEW_KEY, next);
    } catch {
      // 기억 못 해도 된다
    }
  };

  const notify = useCallback((kind: Notice["kind"], text: string) => {
    const id = ++noticeId;
    setNotices((list) => [...list, { id, kind, text }]);
    setTimeout(
      () => setNotices((list) => list.filter((n) => n.id !== id)),
      kind === "error" ? 8000 : 4000,
    );
  }, []);

  const refreshStatus = useCallback(() => {
    call<StatusResult>("status").then(
      (next) => {
        // 설정 언어 (R25) — 바뀌면 화면 전체를 다시 그린다
        if (next.language !== language()) {
          setLanguage(next.language);
          document.documentElement.lang = next.language;
          setLang(next.language);
        }
        setStatus(next);
      },
      (e: unknown) => notify("error", String((e as Error).message)),
    );
  }, [notify]);

  useEffect(() => {
    if (!token) return;
    refreshStatus();
    const unsubscribe = subscribe({
      changed: refreshStatus,
      progress: (message) => {
        setShowLog(true);
        setLog((list) => [...list.slice(-11), { id: ++logId, text: message }]);
      },
      connection: setOnline,
    });
    // 밖에서 켜고 끈 것(창 닫기 등)도 따라가도록 가끔 다시 읽는다
    const timer = setInterval(refreshStatus, 10_000);
    return () => {
      unsubscribe();
      clearInterval(timer);
    };
  }, [refreshStatus]);

  // 만들 수 있는 기종·OS 는 생성(+) 화면을 열 때 읽는다
  useEffect(() => {
    if (creating)
      call<CatalogResult>("catalog").then(setCatalog, (e: unknown) =>
        notify("error", String((e as Error).message)),
      );
  }, [creating, notify]);

  const act: Act = useCallback(
    async (label, fn) => {
      try {
        await fn();
        notify("info", t("web.done", { label }));
      } catch (error) {
        const message =
          error instanceof ApiError || error instanceof Error ? error.message : String(error);
        notify("error", t("web.failed", { label, message }));
      } finally {
        refreshStatus();
      }
    },
    [notify, refreshStatus],
  );

  if (!token) {
    return (
      <main className="empty-page">
        <Logo size={56} />
        <h1>simless</h1>
        <p>{t("web.noToken")}</p>
      </main>
    );
  }

  const createDialog = (
    <CreateDialog
      open={creating}
      catalog={catalog}
      log={log}
      onClose={() => setCreating(false)}
      onCreated={(name) => {
        setCreating(false);
        notify("info", t("web.created", { name }));
        refreshStatus();
      }}
      onAdded={(name) => {
        notify("info", t("web.create.added", { name }));
        refreshStatus();
      }}
      onError={(message) => notify("error", message)}
    />
  );

  if (SETUP_WINDOW) {
    return (
      <div className="setup-window">
        {status ? (
          <SetupView status={status} act={act} onCreate={() => setCreating(true)} />
        ) : (
          <p className="sub">{t("web.loading")}</p>
        )}
        <Notices notices={notices} />
        {createDialog}
      </div>
    );
  }

  if (SESSION_WINDOW) {
    return status ? (
      <SessionWindow status={status} sessionKey={SESSION_WINDOW} />
    ) : (
      <p className="sub">{t("web.loading")}</p>
    );
  }

  if (SETTINGS_WINDOW) {
    return (
      <div className="settings-window">
        <h1 className="page-title">{t("web.settings.title")}</h1>
        {status ? (
          <SettingsView status={status} act={act} onSaved={refreshStatus} />
        ) : (
          <p className="sub">{t("web.loading")}</p>
        )}
        <Notices notices={notices} />
      </div>
    );
  }

  const nav: { id: View; label: string; icon: ReactNode; count?: number }[] = [
    {
      id: "devices",
      label: t("web.nav.devices"),
      icon: <DevicesIcon />,
      count: status?.devices.length,
    },
    {
      id: "groups",
      label: t("web.nav.groups"),
      icon: <GroupsIcon />,
      count: status?.groups.length,
    },
    {
      id: "sessions",
      label: t("web.nav.sessions"),
      icon: <SessionsIcon />,
      count: status?.sessions.length,
    },
  ];
  const title = nav.find((n) => n.id === view)?.label ?? "";

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <Logo />
          <span className="side-text">simless</span>
        </div>
        <nav className="side-nav" aria-label={t("web.nav")}>
          {nav.map((item) => (
            <button
              key={item.id}
              type="button"
              className={view === item.id ? "side-item side-item-active" : "side-item"}
              aria-current={view === item.id ? "page" : undefined}
              title={item.label}
              onClick={() => setView(item.id)}
            >
              <span className="side-label">
                {item.icon}
                <span className="side-text">{item.label}</span>
              </span>
              {item.count !== undefined && item.count > 0 && (
                <span className="mono count side-text">{item.count}</span>
              )}
            </button>
          ))}
        </nav>
        <span className="spacer" />
        <button
          type="button"
          className="side-item"
          title={t("web.nav.settings")}
          onClick={openSettings}
        >
          <span className="side-label">
            <SettingsIcon />
            <span className="side-text">{t("web.nav.settings")}</span>
          </span>
          <span className="side-text">
            <ExternalIcon />
          </span>
        </button>
        <div
          className="server-state"
          title={status ? t("web.server.connected", { version: status.serverVersion }) : undefined}
        >
          <span className={online ? "dot dot-on" : "dot dot-bad"} />
          <span className="side-text">
            {status && online
              ? t("web.server.connected", { version: status.serverVersion })
              : online
                ? t("web.loading")
                : t("web.server.offline")}
          </span>
        </div>
      </aside>

      <main className="content">
        <header className="page-header">
          <h1 className="page-title">{title}</h1>
          <span className="spacer" />
          {view === "devices" && (
            <button
              type="button"
              className="button button-primary"
              onClick={() => setCreating(true)}
            >
              <PlusIcon />
              {t("web.create")}
            </button>
          )}
          {view === "groups" && (
            <button
              type="button"
              className="button button-primary"
              onClick={() => setNewGroup((n) => n + 1)}
            >
              <PlusIcon />
              {t("web.groups.new")}
            </button>
          )}
        </header>
        {status?.skillUpdate && (
          <div className="banner" role="status">
            <span className="banner-text">
              <span className="strong">{t("web.skillUpdate.title")}</span>{" "}
              <span className="sub">{t("web.skillUpdate.desc")}</span>
            </span>
            <button
              type="button"
              className="button button-primary button-small"
              onClick={() =>
                act(t("web.skillUpdate.action"), () =>
                  call("setup.apply", { item: "skill", enabled: true }),
                )
              }
            >
              {t("web.setup.update")}
            </button>
          </div>
        )}
        {!status ? (
          <p className="sub">{t("web.loading")}</p>
        ) : view === "devices" ? (
          <DevicesView status={status} act={act} onCreate={() => setCreating(true)} />
        ) : view === "groups" ? (
          <GroupsView status={status} act={act} newRequest={newGroup} />
        ) : (
          <SessionsView status={status} act={act} />
        )}
      </main>

      {log.length > 0 && showLog && (
        <section className="log" aria-label={t("web.log")}>
          <header>
            <h3>{t("web.log")}</h3>
            <button
              type="button"
              className="icon-button"
              aria-label={t("web.close")}
              onClick={() => setShowLog(false)}
            >
              <svg width="12" height="12" viewBox="0 0 14 14" aria-hidden="true">
                <path
                  d="M3 3l8 8M11 3l-8 8"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                />
              </svg>
            </button>
          </header>
          {log.map((line) => (
            <p key={line.id}>{line.text}</p>
          ))}
        </section>
      )}

      <Notices notices={notices} />

      {createDialog}
    </div>
  );
}

function Notices({ notices }: { notices: Notice[] }) {
  return (
    <div className="notices" aria-live="polite">
      {notices.map((n) => (
        <div key={n.id} className={`notice notice-${n.kind}`}>
          {n.text}
        </div>
      ))}
    </div>
  );
}

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
