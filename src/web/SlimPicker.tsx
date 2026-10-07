import { useEffect, useState } from "react";
import type { CatalogResult, DeviceView, PlatformCatalog, SlimCategory } from "../shared/api.ts";
import { type MessageKey, t } from "../shared/i18n.ts";
import { call } from "./api.ts";
import { Dialog } from "./ui.tsx";

export type SlimMode = "full" | "custom";

/** Android 는 패키지 묶음·기기 설정·하드웨어로 나눠 보인다. iOS 는 simslim 묶음 하나 */
const KINDS: { kind: SlimCategory["kind"]; title: MessageKey }[] = [
  { kind: "packages", title: "web.slim.kind.packages" },
  { kind: "settings", title: "web.slim.kind.settings" },
  { kind: "host", title: "web.slim.kind.host" },
];

/**
 * 슬림 방식 고르기 (M15) — 전체(UI 확인용) 또는 커스텀. 커스텀은 플랫폼마다 항목이 다르고,
 * 체크한 것을 끈다(체크를 풀면 남긴다)
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
  const toggle = (id: string, off: boolean) => {
    const next = new Set(kept);
    if (off) next.delete(id);
    else next.add(id);
    onChange(
      "custom",
      items.map((i) => i.id).filter((i) => next.has(i)),
    );
  };
  const row = (item: SlimCategory) => (
    <li key={item.id}>
      <label className="check slim-item">
        <input
          type="checkbox"
          checked={!kept.has(item.id)}
          disabled={disabled}
          onChange={(e) => toggle(item.id, e.target.checked)}
        />
        <span>
          <strong>{item.name}</strong>
          {item.count ? (
            <span className="sub"> · {t("web.create.slimCount", { count: item.count })}</span>
          ) : null}
          {item.detail && <span className="sub slim-item-detail">{item.detail}</span>}
        </span>
      </label>
    </li>
  );
  const grouped = KINDS.map((k) => ({ ...k, items: items.filter((i) => i.kind === k.kind) }));
  const plain = items.filter((i) => !i.kind);
  return (
    <div className="slim-picker">
      <div className="slim-modes" role="radiogroup" aria-label={t("web.slim.mode")}>
        <label className="check">
          <input
            type="radio"
            name="slim-mode"
            checked={mode === "full"}
            disabled={disabled}
            onChange={() => onChange("full", [])}
          />
          <span>
            <strong>{t("web.slim.full")}</strong>
            <span className="sub"> — {t("web.slim.fullHint")}</span>
          </span>
        </label>
        <label className="check">
          <input
            type="radio"
            name="slim-mode"
            checked={mode === "custom"}
            disabled={disabled || items.length === 0}
            onChange={() => onChange("custom", keep)}
          />
          <span>
            <strong>{t("web.slim.custom")}</strong>
            <span className="sub"> — {t("web.slim.customHint")}</span>
          </span>
        </label>
      </div>
      {mode === "custom" && (
        <div className="slim-info slim-items">
          <p className="sub">
            {t("web.slim.customIntro", { kept: keep.length, total: items.length })}
          </p>
          {plain.length > 0 && <ul>{plain.map(row)}</ul>}
          {grouped
            .filter((g) => g.items.length > 0)
            .map((g) => (
              <div key={g.kind}>
                <p className="slim-kind">{t(g.title)}</p>
                <ul>{g.items.map(row)}</ul>
              </div>
            ))}
        </div>
      )}
    </div>
  );
}

/** 만든 디바이스의 슬림 설정 바꾸기 (M15) — 바꾸면 다시 슬림한다 */
export function SlimDialog({
  device,
  onClose,
  onApply,
}: {
  device: DeviceView | null;
  onClose: () => void;
  onApply: (device: DeviceView, keep: string[]) => void;
}) {
  const [catalog, setCatalog] = useState<PlatformCatalog | undefined>();
  const [error, setError] = useState("");
  const [mode, setMode] = useState<SlimMode>("full");
  const [keep, setKeep] = useState<string[]>([]);

  useEffect(() => {
    if (!device) return;
    const initial = device.slimKeep ?? [];
    setMode(initial.length > 0 ? "custom" : "full");
    setKeep(initial);
    setCatalog(undefined);
    setError("");
    call<CatalogResult>("catalog", { platform: device.platform }).then(
      (result) => setCatalog(result.platforms.find((p) => p.platform === device.platform)),
      (e: unknown) => setError(String((e as Error).message)),
    );
  }, [device]);

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
              {device.slim === "none" ? t("web.slim.applyHint") : t("web.slim.reapplyHint")}
            </span>
            <span className="spacer" />
            <button type="button" className="button" onClick={onClose}>
              {t("web.cancel")}
            </button>
            <button
              type="button"
              className="button button-primary"
              disabled={!catalog}
              onClick={() => onApply(device, mode === "custom" ? keep : [])}
            >
              {t("web.slim.apply")}
            </button>
          </footer>
        </div>
      )}
    </Dialog>
  );
}
