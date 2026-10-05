import { StrictMode, useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { CatalogResult, StatusResult } from "../shared/api.ts";
import { ApiError, call, subscribe, token } from "./api.ts";
import { CreateDialog } from "./CreateDialog.tsx";
import corgiIcon from "./corgi.svg";
import { DevicesTab } from "./DevicesTab.tsx";
import type { LogLine } from "./types.ts";

/** 메인 목록의 플랫폼 탭 */
type Tab = "all" | "android" | "ios";

const TABS: { id: Tab; label: string }[] = [
  { id: "all", label: "All" },
  { id: "android", label: "Android" },
  { id: "ios", label: "iOS" },
];

const TAB_KEY = "corgi-tab";

function savedTab(): Tab {
  try {
    const saved = localStorage.getItem(TAB_KEY);
    return saved === "android" || saved === "ios" ? saved : "all";
  } catch {
    return "all";
  }
}

export interface Notice {
  id: number;
  kind: "info" | "error";
  text: string;
}

let noticeId = 0;
let logId = 0;

function App() {
  const [tab, setTabState] = useState<Tab>(savedTab);
  const setTab = (next: Tab) => {
    setTabState(next);
    try {
      localStorage.setItem(TAB_KEY, next);
    } catch {
      // 저장 못 해도 화면은 그대로 쓴다
    }
  };
  const [status, setStatus] = useState<StatusResult | null>(null);
  const [catalog, setCatalog] = useState<CatalogResult | null>(null);
  const [online, setOnline] = useState(true);
  const [notices, setNotices] = useState<Notice[]>([]);
  const [log, setLog] = useState<LogLine[]>([]);
  const [creating, setCreating] = useState(false);

  const notify = useCallback((kind: Notice["kind"], text: string) => {
    const id = ++noticeId;
    setNotices((list) => [...list, { id, kind, text }]);
    setTimeout(
      () => setNotices((list) => list.filter((n) => n.id !== id)),
      kind === "error" ? 8000 : 4000,
    );
  }, []);

  const refreshStatus = useCallback(() => {
    call<StatusResult>("status").then(setStatus, (e: unknown) =>
      notify("error", String((e as Error).message)),
    );
  }, [notify]);

  const refreshCatalog = useCallback(() => {
    call<CatalogResult>("catalog").then(setCatalog, (e: unknown) =>
      notify("error", String((e as Error).message)),
    );
  }, [notify]);

  useEffect(() => {
    if (!token) return;
    refreshStatus();
    const unsubscribe = subscribe({
      changed: refreshStatus,
      progress: (message) => setLog((list) => [...list.slice(-7), { id: ++logId, text: message }]),
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
    if (creating) refreshCatalog();
  }, [creating, refreshCatalog]);

  /** 버튼 동작 공통 — 실패하면 알림, 다른 세션이 쓰는 중이면 누가 쓰는지 */
  const act = useCallback(
    async (label: string, fn: () => Promise<unknown>) => {
      try {
        await fn();
        notify("info", `${label} 완료`);
      } catch (error) {
        const message =
          error instanceof ApiError || error instanceof Error ? error.message : String(error);
        notify("error", `${label} 실패 — ${message}`);
      } finally {
        refreshStatus();
      }
    },
    [notify, refreshStatus],
  );

  if (!token) {
    return (
      <main className="empty-page">
        <img src={corgiIcon} alt="" width={96} height={96} />
        <h1>Corgi</h1>
        <p>
          터미널에서 <code>corgi ui</code> 로 열거나, Corgi 앱을 실행하세요.
        </p>
      </main>
    );
  }

  const devices = status?.devices ?? [];
  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <img src={corgiIcon} alt="" width={36} height={36} />
          <div>
            <h1>Corgi</h1>
            <p className="subtle">크기별 레이아웃 확인 디바이스</p>
          </div>
        </div>
        <div className="topbar-right">
          <span
            className={online ? "dot dot-on" : "dot dot-off"}
            title={online ? "서버 연결됨" : "서버 연결 끊김"}
          />
          <span className="subtle">{status ? `서버 ${status.serverVersion}` : "연결 중…"}</span>
          <button type="button" className="button button-primary" onClick={() => setCreating(true)}>
            + 생성
          </button>
        </div>
      </header>

      <nav className="tabs" aria-label="플랫폼">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            className={tab === t.id ? "tab tab-active" : "tab"}
            onClick={() => setTab(t.id)}
          >
            {t.label}{" "}
            <span className="count">
              {t.id === "all"
                ? devices.length
                : devices.filter((d) => d.spec.platform === t.id).length}
            </span>
          </button>
        ))}
      </nav>

      <main className="content">
        <DevicesTab
          devices={tab === "all" ? devices : devices.filter((d) => d.spec.platform === tab)}
          platform={tab}
          queue={status?.queue ?? []}
          act={act}
          onCreate={() => setCreating(true)}
        />
      </main>

      {log.length > 0 && (
        <section className="log" aria-label="작업 기록">
          <h3>작업 기록</h3>
          {log.map((line) => (
            <p key={line.id}>{line.text}</p>
          ))}
        </section>
      )}

      <div className="notices" aria-live="polite">
        {notices.map((n) => (
          <div key={n.id} className={`notice notice-${n.kind}`}>
            {n.text}
          </div>
        ))}
      </div>

      <CreateDialog
        open={creating}
        catalog={catalog}
        log={log}
        onClose={() => setCreating(false)}
        onCreated={(name) => {
          setCreating(false);
          notify("info", `만들었습니다: ${name}`);
          refreshStatus();
        }}
        onError={(message) => notify("error", message)}
      />
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
