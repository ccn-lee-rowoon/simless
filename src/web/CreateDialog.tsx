import { useEffect, useMemo, useState } from "react";
import type { DeviceView, SourceEntry, SourceListResult } from "../shared/api.ts";
import { call } from "./api.ts";
import type { LogLine } from "./types.ts";
import { Dialog, PlatformBadge } from "./ui.tsx";

type Filter = "all" | "android" | "ios";

/** 생성(+) — 이 Mac 의 원본을 골라 같은 크기로 복제 + 슬림 (M1~M4) */
export function CreateDialog({
  open,
  initial,
  sources,
  log,
  onClose,
  onCreated,
  onError,
}: {
  open: boolean;
  initial: SourceEntry | null;
  sources: SourceListResult | null;
  log: LogLine[];
  onClose: () => void;
  onCreated: (name: string) => void;
  onError: (message: string) => void;
}) {
  const [picked, setPicked] = useState<SourceEntry | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [name, setName] = useState("");
  const [slim, setSlim] = useState(true);
  const [creating, setCreating] = useState(false);
  const [logStart, setLogStart] = useState(0);

  useEffect(() => {
    if (!open) return;
    setPicked(initial);
    setName(initial ? `corgi ${initial.name}` : "");
    setSlim(true);
    setQuery("");
    setCreating(false);
  }, [open, initial]);

  const candidates = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (sources?.items ?? []).filter(
      (s) =>
        !s.managed &&
        (filter === "all" || s.platform === filter) &&
        (q === "" || `${s.name} ${s.detail} ${s.label}`.toLowerCase().includes(q)),
    );
  }, [sources, filter, query]);

  const pick = (s: SourceEntry) => {
    setPicked(s);
    setName(`corgi ${s.name}`);
  };

  const create = async () => {
    if (!picked) return;
    setCreating(true);
    setLogStart(log.at(-1)?.id ?? 0);
    try {
      const device = await call<DeviceView>("device.create", {
        source: picked.native,
        name: name.trim() || undefined,
        slim,
      });
      onCreated(device.name);
    } catch (error) {
      onError(`만들기 실패 — ${(error as Error).message}`);
      setCreating(false);
    }
  };

  return (
    <Dialog open={open} onClose={creating ? () => {} : onClose} title="디바이스 생성" wide>
      {!picked ? (
        <div className="dialog-body">
          <p className="subtle">
            원본을 고르세요. 같은 크기로 복제하고 슬림화합니다 — 크기는 원본과 같고, 앱은 설치하지
            않습니다.
          </p>
          <div className="filters">
            {(["all", "android", "ios"] as const).map((f) => (
              <button
                key={f}
                type="button"
                className={filter === f ? "chip chip-active" : "chip"}
                onClick={() => setFilter(f)}
              >
                {f === "all" ? "전체" : f === "android" ? "Android" : "iOS"}
              </button>
            ))}
            <input
              className="search"
              placeholder="이름·기기·크기 검색"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          {!sources && <p className="subtle">이 Mac 의 디바이스를 읽는 중…</p>}
          <ul className="picker">
            {candidates.map((s) => (
              <li key={s.native}>
                <button
                  type="button"
                  className="picker-row"
                  disabled={s.created !== undefined}
                  onClick={() => pick(s)}
                >
                  <span className="size">{s.label.replace(/^(Android|iOS) /, "")}</span>
                  <PlatformBadge platform={s.platform} />
                  <span className="picker-name">
                    {s.name}
                    <span className="subtle"> · {s.detail}</span>
                  </span>
                  {s.created ? (
                    <span className="badge badge-neutral">생성됨</span>
                  ) : (
                    <span className="picker-go">선택 →</span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <form
          className="dialog-body"
          onSubmit={(e) => {
            e.preventDefault();
            void create();
          }}
        >
          <div className="summary">
            <span className="size size-large">{picked.label.replace(/^(Android|iOS) /, "")}</span>
            <div>
              <PlatformBadge platform={picked.platform} /> <strong>{picked.name}</strong>
              <div className="subtle">{picked.detail}</div>
            </div>
          </div>
          <label className="field">
            <span>이름</span>
            <input value={name} disabled={creating} onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={slim}
              disabled={creating}
              onChange={(e) => setSlim(e.target.checked)}
            />
            만든 뒤 슬림화 (UI 확인용 — 기본)
            {picked.platform === "ios" ? " · iOS 는 2~3분 걸립니다" : ""}
          </label>
          {creating && (
            <div className="progress">
              <div className="spinner" />
              <div>
                {log
                  .filter((line) => line.id > logStart)
                  .map((line) => (
                    <p key={line.id}>{line.text}</p>
                  ))}
                {(log.at(-1)?.id ?? 0) === logStart && <p className="subtle">시작하는 중…</p>}
              </div>
            </div>
          )}
          <footer className="dialog-footer">
            {!initial && (
              <button
                type="button"
                className="button"
                disabled={creating}
                onClick={() => setPicked(null)}
              >
                ← 원본 다시 고르기
              </button>
            )}
            <span className="spacer" />
            <button type="submit" className="button button-primary" disabled={creating}>
              {creating ? "만드는 중…" : "만들기"}
            </button>
          </footer>
        </form>
      )}
    </Dialog>
  );
}
