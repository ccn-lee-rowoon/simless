import { type ReactNode, useEffect, useRef } from "react";
import { type HolderView, memoryChange, type SlimStats } from "../shared/api.ts";

export function Badge({
  tone = "neutral",
  children,
}: {
  tone?: "neutral" | "ok" | "warn" | "bad" | "info";
  children: ReactNode;
}) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

const SLIM: Record<string, { tone: "neutral" | "ok" | "warn" | "bad" | "info"; text: string }> = {
  none: { tone: "neutral", text: "미적용" },
  applying: { tone: "info", text: "진행 중" },
  applied: { tone: "ok", text: "적용됨" },
  drifted: { tone: "warn", text: "풀림" },
  failed: { tone: "bad", text: "실패" },
};

export function SlimBadge({ state, error }: { state: string; error?: string }) {
  const slim = SLIM[state] ?? { tone: "neutral" as const, text: state };
  return (
    <span title={error}>
      <Badge tone={slim.tone}>{slim.text}</Badge>
    </span>
  );
}

export function PlatformBadge({ platform }: { platform: "android" | "ios" }) {
  return (
    <span className={`platform platform-${platform}`}>
      {platform === "android" ? "Android" : "iOS"}
    </span>
  );
}

export function ago(since: number): string {
  const minutes = Math.floor((Date.now() - since) / 60_000);
  if (minutes < 1) return "방금";
  if (minutes < 60) return `${minutes}분 전`;
  return `${Math.floor(minutes / 60)}시간 전`;
}

export function holderText(holder: HolderView): string {
  const who = holder.human ? "사람" : holder.agent;
  const where = holder.cwd.replace(/^\/Users\/[^/]+/, "~");
  return `${who} · ${where} · ${ago(holder.since)}부터`;
}

/** <dialog> 를 open 값에 맞춰 열고 닫는다 */
export function Dialog({
  open,
  onClose,
  title,
  children,
  wide,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);
  return (
    <dialog ref={ref} className={wide ? "dialog dialog-wide" : "dialog"} onClose={onClose}>
      <header className="dialog-header">
        <h2>{title}</h2>
        <button type="button" className="icon-button" aria-label="닫기" onClick={onClose}>
          ✕
        </button>
      </header>
      {open && children}
    </dialog>
  );
}

export function gigabytes(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)}GB`;
}

/** 얼마나 슬림화됐는지 — 꺼진 항목 수와 지금 메모리 (켜진 디바이스만) */
export function SlimStatsText({
  stats,
  baselineBytes,
}: {
  stats: SlimStats;
  baselineBytes?: number;
}) {
  // 슬림 전 기준값이 있으면 «7.8GB → 1.6GB (−79%)», 없으면 지금 값만
  const change = memoryChange(baselineBytes, stats.memoryBytes);
  const memory = change
    ? ` · ${change}`
    : stats.memoryBytes
      ? ` · ${gigabytes(stats.memoryBytes)}`
      : "";
  const title = [
    `꺼진 ${stats.unit} ${stats.disabled}/${stats.total}`,
    stats.memoryBytes
      ? `메모리 ${gigabytes(stats.memoryBytes)}${stats.unit === "packages" ? " (Activity Monitor 기준)" : ""}`
      : "",
    stats.processes ? `프로세스 ${stats.processes}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <div className="subtle stat" title={title}>
      {stats.unit} {stats.disabled}/{stats.total} 꺼짐{memory}
    </div>
  );
}
