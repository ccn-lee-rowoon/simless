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
  const [custom, setCustom] = useState(false);
  const [size, setSize] = useState({ widthDp: "375", heightDp: "812", density: "420", image: "" });
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [name, setName] = useState("");
  const [slim, setSlim] = useState(true);
  const [creating, setCreating] = useState(false);
  const [logStart, setLogStart] = useState(0);

  useEffect(() => {
    if (!open) return;
    setPicked(initial);
    setCustom(false);
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
    if (!picked && !custom) return;
    setCreating(true);
    setLogStart(log.at(-1)?.id ?? 0);
    try {
      const device = await call<DeviceView>("device.create", {
        source: custom ? undefined : picked?.native,
        custom: custom
          ? {
              widthDp: Number(size.widthDp),
              heightDp: Number(size.heightDp),
              density: Number(size.density),
              systemImage: size.image || undefined,
            }
          : undefined,
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
      {custom ? (
        <form
          className="dialog-body"
          onSubmit={(e) => {
            e.preventDefault();
            void create();
          }}
        >
          <p className="subtle">Android 크기를 직접 정합니다. 폭(dp) = 해상도(px) × 160 ÷ 밀도.</p>
          <div className="grid3">
            <label className="field">
              <span>폭 (dp)</span>
              <input
                inputMode="numeric"
                value={size.widthDp}
                disabled={creating}
                onChange={(e) => {
                  setSize({ ...size, widthDp: e.target.value });
                  setName(`corgi Android ${e.target.value}dp`);
                }}
              />
            </label>
            <label className="field">
              <span>높이 (dp)</span>
              <input
                inputMode="numeric"
                value={size.heightDp}
                disabled={creating}
                onChange={(e) => setSize({ ...size, heightDp: e.target.value })}
              />
            </label>
            <label className="field">
              <span>밀도 (dpi)</span>
              <select
                value={size.density}
                disabled={creating}
                onChange={(e) => setSize({ ...size, density: e.target.value })}
              >
                {["160", "240", "320", "420", "440", "480", "560", "640"].map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <p className="subtle">
            해상도 {Math.round((Number(size.widthDp) * Number(size.density)) / 160) || "?"}×
            {Math.round((Number(size.heightDp) * Number(size.density)) / 160) || "?"}px
          </p>
          <label className="field">
            <span>시스템 이미지</span>
            <select
              value={size.image}
              disabled={creating}
              onChange={(e) => setSize({ ...size, image: e.target.value })}
            >
              <option value="">
                권장 ({sources?.androidImages.find((i) => i.recommended)?.label ?? "없음"})
              </option>
              {sources?.androidImages.map((i) => (
                <option key={i.sysdir} value={i.sysdir}>
                  {i.label}
                </option>
              ))}
            </select>
          </label>
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
          </label>
          {creating && <Progress log={log} logStart={logStart} />}
          <footer className="dialog-footer">
            <button
              type="button"
              className="button"
              disabled={creating}
              onClick={() => setCustom(false)}
            >
              ← 목록으로
            </button>
            <span className="spacer" />
            <button type="submit" className="button button-primary" disabled={creating}>
              {creating ? "만드는 중…" : "만들기"}
            </button>
          </footer>
        </form>
      ) : !picked ? (
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
            {filter !== "ios" && (
              <button
                type="button"
                className="button"
                onClick={() => {
                  setCustom(true);
                  setName(`corgi Android ${size.widthDp}dp`);
                }}
              >
                직접 입력…
              </button>
            )}
          </div>
          {!sources && <p className="subtle">이 Mac 의 디바이스를 읽는 중…</p>}
          <ul className="picker">
            {candidates.map((s) => (
              <li key={s.native}>
                <button type="button" className="picker-row" onClick={() => pick(s)}>
                  <span className="size">{s.label.replace(/^(Android|iOS) /, "")}</span>
                  <PlatformBadge platform={s.platform} />
                  <span className="picker-name">
                    {s.kind === "profile" && <span className="badge badge-info">대표 프로필</span>}
                    {s.name}
                    <span className="subtle"> · {s.detail}</span>
                  </span>
                  <span className="picker-go">
                    {s.created && (
                      <span
                        className="badge badge-neutral"
                        title={`같은 크기로 만든 디바이스: ${s.created}`}
                      >
                        만든 것 있음
                      </span>
                    )}{" "}
                    선택 →
                  </span>
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
          {creating && <Progress log={log} logStart={logStart} />}
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

function Progress({ log, logStart }: { log: LogLine[]; logStart: number }) {
  return (
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
  );
}
