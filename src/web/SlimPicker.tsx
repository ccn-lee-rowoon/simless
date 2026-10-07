import { useEffect, useState } from "react";
import type { CatalogResult, DeviceView, PlatformCatalog, SlimCategory } from "../shared/api.ts";
import { type MessageKey, t } from "../shared/i18n.ts";
import { call } from "./api.ts";
import { Dialog } from "./ui.tsx";

/** 슬림 안 함 · 전체 슬림(UI 확인용) · 커스텀(남길 것을 고름) (R5·M15) */
export type SlimMode = "none" | "full" | "custom";

const MODES: { mode: SlimMode; title: MessageKey; hint: MessageKey }[] = [
  { mode: "none", title: "web.slim.none", hint: "web.slim.noneHint" },
  { mode: "full", title: "web.slim.full", hint: "web.slim.fullHint" },
  { mode: "custom", title: "web.slim.custom", hint: "web.slim.customHint" },
];

/** Android 는 패키지 묶음·기기 설정·하드웨어로 나눠 보인다. iOS 는 simslim 묶음 하나 */
const KINDS: { kind: SlimCategory["kind"]; title: MessageKey }[] = [
  { kind: "packages", title: "web.slim.kind.packages" },
  { kind: "settings", title: "web.slim.kind.settings" },
  { kind: "host", title: "web.slim.kind.host" },
];

/**
 * 슬림 방식 고르기 — 세 가지를 카드로 보여 주고, 커스텀이면 **남길 것**을 체크한다(체크 안 한 것은 끈다).
 * 전체 슬림이면 무엇이 꺼지는지 접어 둔 목록으로 보여 준다 (M4)
 */
export function SlimPicker({
  catalog,
  mode,
  keep,
  disabled,
  onChange,
}: {
  catalog: PlatformCatalog | undefined;
  mode: SlimMode;
  keep: string[];
  disabled?: boolean;
  onChange: (mode: SlimMode, keep: string[]) => void;
}) {
  const items = catalog?.slimOff ?? [];
  const kept = new Set(keep);
  const missing = catalog !== undefined && items.length === 0;
  const tool = catalog?.platform === "android" ? "avdslim" : "simslim";
  const toggle = (id: string, on: boolean) => {
    const next = new Set(kept);
    if (on) next.add(id);
    else next.delete(id);
    onChange(
      "custom",
      items.map((i) => i.id).filter((i) => next.has(i)),
    );
  };
  const row = (item: SlimCategory) => (
    <li key={item.id}>
      <label className={kept.has(item.id) ? "slim-item slim-item-kept" : "slim-item"}>
        <input
          type="checkbox"
          checked={kept.has(item.id)}
          disabled={disabled}
          onChange={(e) => toggle(item.id, e.target.checked)}
        />
        <span className="slim-item-text">
          <span className="slim-item-name">
            {item.name}
            {item.count ? <span className="sub"> · {item.count}</span> : null}
          </span>
          {item.detail && <span className="sub">{item.detail}</span>}
        </span>
        <span className={kept.has(item.id) ? "slim-tag slim-tag-kept" : "slim-tag"}>
          {t(kept.has(item.id) ? "web.slim.tagKept" : "web.slim.tagOff")}
        </span>
      </label>
    </li>
  );
  const groups = [
    { kind: undefined, title: undefined, items: items.filter((i) => !i.kind) },
    ...KINDS.map((k) => ({ ...k, items: items.filter((i) => i.kind === k.kind) })),
  ].filter((g) => g.items.length > 0);

  return (
    <div className="slim-picker">
      <div className="slim-modes" role="radiogroup" aria-label={t("web.slim.mode")}>
        {MODES.map((m) => {
          const off = m.mode !== "none" && missing;
          return (
            <label
              key={m.mode}
              className={mode === m.mode ? "slim-mode slim-mode-active" : "slim-mode"}
            >
              <input
                type="radio"
                name="slim-mode"
                className="visually-hidden"
                checked={mode === m.mode}
                disabled={disabled || off}
                onChange={() => onChange(m.mode, m.mode === "custom" ? keep : [])}
              />
              <span className="slim-mode-title">{t(m.title)}</span>
              <span className="sub">{t(m.hint)}</span>
            </label>
          );
        })}
      </div>

      {missing && mode !== "none" && (
        <p className="notice-inline">{t("web.create.slimInfoMissing", { tool })}</p>
      )}

      {mode === "full" && items.length > 0 && (
        <details className="slim-details">
          <summary>{t("web.slim.fullOff", { count: items.length })}</summary>
          <ul className="slim-off-list">
            {items.map((i) => (
              <li key={i.id}>
                <strong>{i.name}</strong>
                {i.detail && <span className="sub"> — {i.detail}</span>}
              </li>
            ))}
          </ul>
          {catalog && catalog.slimKeeps.length > 0 && (
            <p className="sub">
              {t("web.create.slimKeeps")}: {catalog.slimKeeps.join(" · ")}
            </p>
          )}
        </details>
      )}

      {mode === "custom" && items.length > 0 && (
        <div className="slim-items">
          <div className="slim-items-head">
            <span>{t("web.slim.customIntro")}</span>
            <span className="slim-count">
              {t("web.slim.keptOf", { kept: keep.length, total: items.length })}
            </span>
          </div>
          {groups.map((g) => (
            <div key={g.kind ?? "all"}>
              {g.title && <p className="slim-kind">{t(g.title)}</p>}
              <ul>{g.items.map(row)}</ul>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** 만든 디바이스의 슬림 설정 (M15) — 슬림 안 함·전체·커스텀. 바꾸면 그대로 다시 맞춘다 */
export function SlimDialog({
  device,
  onClose,
  onApply,
}: {
  device: DeviceView | null;
  onClose: () => void;
  onApply: (device: DeviceView, mode: SlimMode, keep: string[]) => void;
}) {
  const [catalog, setCatalog] = useState<PlatformCatalog | undefined>();
  const [error, setError] = useState("");
  const [mode, setMode] = useState<SlimMode>("full");
  const [keep, setKeep] = useState<string[]>([]);

  useEffect(() => {
    if (!device) return;
    const initial = device.slimKeep ?? [];
    setMode(device.slim === "none" ? "none" : initial.length > 0 ? "custom" : "full");
    setKeep(initial);
    setCatalog(undefined);
    setError("");
    call<CatalogResult>("catalog", { platform: device.platform }).then(
      (result) => setCatalog(result.platforms.find((p) => p.platform === device.platform)),
      (e: unknown) => setError(String((e as Error).message)),
    );
  }, [device]);

  const current = device
    ? device.slim === "none"
      ? "none"
      : (device.slimKeep?.length ?? 0) > 0
        ? "custom"
        : "full"
    : "none";
  const unchanged =
    device !== null &&
    mode === current &&
    (mode !== "custom" || [...keep].sort().join() === [...(device.slimKeep ?? [])].sort().join());

  return (
    <Dialog open={device !== null} onClose={onClose} title={t("web.slim.title")} wide>
      {device && (
        <div className="dialog-body">
          <p className="sub">{t("web.slim.intro", { name: device.name })}</p>
          {error && <p className="notice-inline">{error}</p>}
          {!catalog && !error && <p className="sub">{t("web.loading")}</p>}
          {catalog && (
            <SlimPicker
              catalog={catalog}
              mode={mode}
              keep={keep}
              onChange={(m, k) => {
                setMode(m);
                setKeep(k);
              }}
            />
          )}
          <footer className="dialog-footer">
            <span className="sub">
              {mode === "none"
                ? t("web.slim.offHint")
                : device.slim === "none"
                  ? t("web.slim.applyHint")
                  : t("web.slim.reapplyHint")}
            </span>
            <span className="spacer" />
            <button type="button" className="button" onClick={onClose}>
              {t("web.cancel")}
            </button>
            <button
              type="button"
              className="button button-primary"
              disabled={!catalog || unchanged}
              onClick={() => onApply(device, mode, mode === "custom" ? keep : [])}
            >
              {t("web.slim.apply")}
            </button>
          </footer>
        </div>
      )}
    </Dialog>
  );
}

/**
 * 슬림 내역 (M16) — 꺼진 항목과 켜진 항목. 켜져 있을 때 실제로 읽은 것인지, Simless 가 슬림한 내용으로
 * 계산한 것인지도 보인다. Simless 가 만든 기기면 «슬림 설정…» 으로 이어진다
 */
export function SlimDetailDialog({
  device,
  onClose,
  onEdit,
}: {
  device: DeviceView | null;
  onClose: () => void;
  onEdit?: (device: DeviceView) => void;
}) {
  const [catalog, setCatalog] = useState<PlatformCatalog | undefined>();
  const [error, setError] = useState("");

  useEffect(() => {
    if (!device) return;
    setCatalog(undefined);
    setError("");
    call<CatalogResult>("catalog", { platform: device.platform }).then(
      (result) => setCatalog(result.platforms.find((p) => p.platform === device.platform)),
      (e: unknown) => setError(String((e as Error).message)),
    );
  }, [device]);

  const off = new Set(device?.slimOff ?? []);
  const items = catalog?.slimOff ?? [];
  const offItems = items.filter((i) => off.has(i.id));
  const onItems = items.filter((i) => !off.has(i.id));
  const seenAt = device?.slimSeen?.seenAt;

  return (
    <Dialog open={device !== null} onClose={onClose} title={t("web.slimDetail.title")} wide>
      {device && (
        <div className="dialog-body">
          <p className="sub">
            {device.slimOffObserved && seenAt
              ? t("web.slimDetail.observed", {
                  name: device.name,
                  when: new Date(seenAt).toLocaleString(undefined, {
                    dateStyle: "short",
                    timeStyle: "short",
                  }),
                })
              : t("web.slimDetail.planned", { name: device.name })}
          </p>
          {error && <p className="notice-inline">{error}</p>}
          {!catalog && !error && <p className="sub">{t("web.loading")}</p>}
          {catalog && (
            <div className="slim-items">
              <div className="slim-items-head">
                <span>{t("web.slimDetail.off")}</span>
                <span className="slim-count">
                  {t("web.slimDetail.count", { off: offItems.length, total: items.length })}
                </span>
              </div>
              <ul>
                {offItems.map((i) => (
                  <li key={i.id} className="slim-item slim-item-static">
                    <span className="slim-tag">{t("web.slim.tagOff")}</span>
                    <span className="slim-item-text">
                      <span className="slim-item-name">{i.name}</span>
                      {i.detail && <span className="sub">{i.detail}</span>}
                    </span>
                    <span className="sub mono">{i.id}</span>
                  </li>
                ))}
              </ul>
              {onItems.length > 0 && (
                <>
                  <p className="slim-kind">{t("web.slimDetail.on")}</p>
                  <ul>
                    {onItems.map((i) => (
                      <li key={i.id} className="slim-item slim-item-static">
                        <span className="slim-tag slim-tag-kept">{t("web.slim.tagKept")}</span>
                        <span className="slim-item-text">
                          <span className="slim-item-name">{i.name}</span>
                        </span>
                        <span className="sub mono">{i.id}</span>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          )}
          <footer className="dialog-footer">
            <span className="spacer" />
            {onEdit && (
              <button type="button" className="button" onClick={() => onEdit(device)}>
                {t("web.device.slimSettings")}
              </button>
            )}
            <button type="button" className="button button-primary" onClick={onClose}>
              {t("web.close")}
            </button>
          </footer>
        </div>
      )}
    </Dialog>
  );
}
