import { type CSSProperties, type ReactNode, useEffect, useRef, useState } from "react";
import {
  type DeviceView,
  type HolderView,
  memoryChange,
  observedSlim,
  type SlimStats,
} from "../shared/api.ts";
import { t } from "../shared/i18n.ts";
import iconUrl from "./icon.svg";

export function ago(since: number): string {
  const minutes = Math.floor((Date.now() - since) / 60_000);
  if (minutes < 1) return t("common.justNow");
  if (minutes < 60) return t("common.minutesAgo", { minutes });
  return t("common.hoursAgo", { hours: Math.floor(minutes / 60), minutes: minutes % 60 });
}

export function shortPath(path: string): string {
  return path.replace(/^\/Users\/[^/]+/, "~");
}

export function who(holder: { human: boolean; agent: string }): string {
  return holder.human ? t("common.human") : holder.agent;
}

export function holderText(holder: HolderView): string {
  return `${who(holder)} · ${ago(holder.since)}`;
}

export function gigabytes(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)}GB`;
}

/** 폭 — Android dp, iOS pt (M2) */
export function widthText(device: Pick<DeviceView, "layoutWidth" | "platform">): string {
  return `${Math.round(device.layoutWidth)}${device.platform === "android" ? "dp" : "pt"}`;
}

/** 보조 표시 — 해상도·밀도 */
export function resolutionText(device: DeviceView): string {
  const { spec } = device;
  if (spec.platform === "android") return `${spec.widthPx}×${spec.heightPx} · ${spec.density}dpi`;
  return `${spec.widthPt * spec.scale}×${spec.heightPt * spec.scale} · @${spec.scale}x`;
}

/** OS — Android 시스템 이미지에서 `android-36`, iOS 런타임 이름 */
export function osText(device: DeviceView): string {
  const { spec } = device;
  if (spec.platform === "ios") return spec.runtimeName;
  return /android-[\w.]+/.exec(spec.systemImage)?.[0] ?? "Android";
}

export function slimStatsText(stats: Pick<SlimStats, "disabled" | "total" | "unit">): string {
  return t("slim.stats", {
    unit: t(stats.unit === "packages" ? "slim.unit.packages" : "slim.unit.daemons"),
    disabled: stats.disabled,
    total: stats.total,
  });
}

function seenText(seenAt: string): string {
  return t("web.slim.seenAt", {
    when: new Date(seenAt).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" }),
  });
}

/** `SLIM` 배지 (M6) — 마우스를 올리면 슬림 수치·전후 비교 (M10), 실패면 이유 */
export function SlimBadge({ device }: { device: DeviceView }) {
  if (device.slim === "none") {
    // Simless 가 하지 않은 슬림 — 꺼져 있으면 마지막으로 본 값이라 흐리게
    const seen = observedSlim(device);
    if (!seen) return null;
    return (
      <span className={device.booted ? "slim" : "slim slim-stale"}>
        SLIM
        <span className="tip" role="tooltip">
          <strong>{t("web.slim.applied")}</strong>
          <span>{slimStatsText(seen)}</span>
          {device.booted && device.slimStats?.memoryBytes ? (
            <span className="mono">{gigabytes(device.slimStats.memoryBytes)}</span>
          ) : null}
          {!device.booted && seen.seenAt && <span>{seenText(seen.seenAt)}</span>}
        </span>
      </span>
    );
  }
  const failed = device.slim === "failed";
  const applying = device.slim === "applying";
  const stats = device.slimStats;
  const change = memoryChange(device.slimBaseline?.memoryBytes, stats?.memoryBytes);
  return (
    <span className={failed ? "slim slim-warn" : applying ? "slim slim-busy" : "slim"}>
      {failed ? "SLIM ⚠" : "SLIM"}
      <span className="tip" role="tooltip">
        <strong>
          {t(failed ? "slim.failed" : applying ? "slim.applying" : "web.slim.applied")}
        </strong>
        {failed && device.slimError && <span>{device.slimError.split("\n")[0]}</span>}
        {device.slimKeep?.length ? (
          <span>{t("web.slim.keptCount", { count: device.slimKeep.length })}</span>
        ) : null}
        {stats && <span>{slimStatsText(stats)}</span>}
        {change ? (
          <span className="mono">{change}</span>
        ) : stats?.memoryBytes ? (
          <span className="mono">{gigabytes(stats.memoryBytes)}</span>
        ) : null}
        {!stats && !failed && device.slimSeen && (
          <>
            <span>{slimStatsText(device.slimSeen)}</span>
            <span>{seenText(device.slimSeen.seenAt)}</span>
          </>
        )}
        {!stats && !failed && !device.slimSeen && <span>{t("web.slim.statsWhenOn")}</span>}
      </span>
    </span>
  );
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
    if (open && !dialog.open) {
      dialog.showModal();
      // showModal 은 처음 버튼(닫기)에 포커스를 준다 — 입력칸이 있으면 그리로
      dialog.querySelector<HTMLElement>("[data-autofocus]")?.focus();
    }
    if (!open && dialog.open) dialog.close();
  }, [open]);
  return (
    <dialog ref={ref} className={wide ? "dialog dialog-wide" : "dialog"} onClose={onClose}>
      <header className="dialog-header">
        <h2>{title}</h2>
        <button type="button" className="icon-button" aria-label={t("web.close")} onClick={onClose}>
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
            <path
              d="M3 3l8 8M11 3l-8 8"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
            />
          </svg>
        </button>
      </header>
      {open && children}
    </dialog>
  );
}

/**
 * 더보기(⋯) 메뉴 — 다른 곳을 누르거나 Esc·스크롤하면 닫힌다. 표의 스크롤 상자에 잘리지 않게
 * 버튼 위치를 재서 화면 기준(fixed)으로 띄운다. 아래 공간이 모자라면 위로 연다.
 */
export function Menu({ label, children }: { label: string; children: ReactNode }) {
  const [position, setPosition] = useState<CSSProperties>({});
  return (
    <details
      className="menu"
      onToggle={(event) => {
        const details = event.currentTarget;
        if (!details.open) return;
        const rect = details.querySelector("summary")?.getBoundingClientRect();
        if (!rect) return;
        const right = window.innerWidth - rect.right;
        setPosition(
          rect.bottom > window.innerHeight * 0.6
            ? { right, bottom: window.innerHeight - rect.top + 4 }
            : { right, top: rect.bottom + 4 },
        );
      }}
    >
      <summary className="icon-button" aria-label={label}>
        <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
          <circle cx="3" cy="8" r="1.4" />
          <circle cx="8" cy="8" r="1.4" />
          <circle cx="13" cy="8" r="1.4" />
        </svg>
      </summary>
      <div className="menu-items" role="menu" style={position}>
        {children}
      </div>
    </details>
  );
}

/** 메뉴 항목 — 누르면 메뉴(<details>)를 닫고 동작한다 */
export function MenuItem({
  onClick,
  disabled,
  danger,
  title,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
  title?: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      className={danger ? "menu-item danger" : "menu-item"}
      disabled={disabled}
      title={title}
      onClick={(event) => {
        const menu = event.currentTarget.closest("details");
        if (menu) menu.open = false;
        onClick();
      }}
    >
      {children}
    </button>
  );
}

export function MenuSeparator() {
  return <div className="menu-separator" />;
}

/** 열린 메뉴(⋯)는 다른 곳을 누르거나 Esc 를 누르면 닫는다 — 앱에서 한 번만 건다 */
export function useMenuDismiss(): void {
  useEffect(() => {
    const closeAll = (except?: Element | null) => {
      for (const menu of document.querySelectorAll<HTMLDetailsElement>("details.menu[open]")) {
        if (menu !== except) menu.open = false;
      }
    };
    const onPointer = (event: PointerEvent) =>
      closeAll((event.target as Element | null)?.closest("details.menu"));
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeAll();
    };
    // 화면 기준으로 띄운 메뉴는 스크롤하면 버튼과 떨어진다 — 닫는다
    const onScroll = () => closeAll();
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    document.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("scroll", onScroll, true);
    };
  }, []);
}

/** 앱 아이콘 — 폭이 다른 기기 세 대 (M12) */
/** 로고 — 앱 아이콘(icon.svg)을 그대로. 앱 아이콘·탭 아이콘·화면 로고가 한 그림이다 (M12) */
export function Logo({ size = 24 }: { size?: number }) {
  return (
    <img className="logo" src={iconUrl} width={size} height={size} alt="" aria-hidden="true" />
  );
}
