import { useEffect, useMemo, useState } from "react";
import type { CatalogModel, CatalogResult, DeviceView, PlatformCatalog } from "../shared/api.ts";
import { t } from "../shared/i18n.ts";
import { call } from "./api.ts";
import type { LogLine } from "./types.ts";
import { Dialog } from "./ui.tsx";

type Platform = "android" | "ios";

const CUSTOM = "__custom__";
const PLATFORM_KEY = "corgi-create-platform";

function savedPlatform(): Platform {
  try {
    return localStorage.getItem(PLATFORM_KEY) === "android" ? "android" : "ios";
  } catch {
    return "ios";
  }
}

/** 생성(+) — 플랫폼 → 기종 → OS → 이름·슬림 (M1·M4) */
export function CreateDialog({
  open,
  catalog,
  log,
  onClose,
  onCreated,
  onError,
}: {
  open: boolean;
  catalog: CatalogResult | null;
  log: LogLine[];
  onClose: () => void;
  onCreated: (name: string) => void;
  onError: (message: string) => void;
}) {
  const [platform, setPlatformState] = useState<Platform>(savedPlatform);
  const [modelId, setModelId] = useState("");
  const [osId, setOsId] = useState("");
  const [size, setSize] = useState({ widthDp: "375", heightDp: "812", density: "420" });
  const [name, setName] = useState("");
  const [slim, setSlim] = useState(true);
  const [baseline, setBaseline] = useState(true);
  const [showSlimInfo, setShowSlimInfo] = useState(false);
  const [creating, setCreating] = useState(false);
  const [logStart, setLogStart] = useState(0);

  const setPlatform = (next: Platform) => {
    setPlatformState(next);
    setModelId("");
    setOsId("");
    try {
      localStorage.setItem(PLATFORM_KEY, next);
    } catch {
      // 기억 못 해도 된다
    }
  };

  useEffect(() => {
    if (!open) return;
    setModelId("");
    setOsId("");
    setName("");
    setSlim(true);
    setBaseline(true);
    setShowSlimInfo(false);
    setCreating(false);
  }, [open]);

  const current: PlatformCatalog | undefined = catalog?.platforms.find(
    (p) => p.platform === platform,
  );
  const models = useMemo(
    () =>
      [...(current?.models ?? [])].sort(
        (a, b) => a.layoutWidth - b.layoutWidth || a.name.localeCompare(b.name),
      ),
    [current],
  );
  const model: CatalogModel | undefined = models.find((m) => m.id === modelId);
  const custom = modelId === CUSTOM;
  // iOS 는 기종마다 만들 수 있는 런타임이 다르다
  const osChoices = (current?.os ?? []).filter((o) => !model?.os || model.os.includes(o.id));
  const os =
    osChoices.find((o) => o.id === osId) ?? osChoices.find((o) => o.recommended) ?? osChoices[0];
  const unit = platform === "android" ? "dp" : "pt";
  const modelName = custom ? `Android ${size.widthDp}dp` : (model?.name ?? "");
  const defaultName = modelName ? (slim ? `corgi ${modelName}` : modelName) : "";
  const problems = catalog?.problems.filter((p) => p.platform === platform) ?? [];

  const create = async () => {
    if (!model && !custom) return;
    setCreating(true);
    setLogStart(log.at(-1)?.id ?? 0);
    try {
      const device = await call<DeviceView>("device.create", {
        platform,
        model: custom ? undefined : model?.id,
        custom: custom
          ? {
              widthDp: Number(size.widthDp),
              heightDp: Number(size.heightDp),
              density: Number(size.density),
            }
          : undefined,
        os: os?.id,
        name: name.trim() || undefined,
        slim,
        baseline: slim && baseline,
      });
      onCreated(device.name);
    } catch (error) {
      onError(t("web.create.failed", { message: (error as Error).message }));
      setCreating(false);
    }
  };

  const group = (form: CatalogModel["form"]) => models.filter((m) => m.form === form);

  return (
    <Dialog open={open} onClose={creating ? () => {} : onClose} title={t("web.create.title")} wide>
      <form
        className="dialog-body create"
        onSubmit={(e) => {
          e.preventDefault();
          void create();
        }}
      >
        <fieldset className="segmented" aria-label={t("web.platform")}>
          {(["ios", "android"] as const).map((p) => (
            <button
              key={p}
              type="button"
              aria-pressed={platform === p}
              className={platform === p ? "segment segment-active" : "segment"}
              disabled={creating}
              onClick={() => setPlatform(p)}
            >
              {p === "ios" ? "iOS" : "Android"}
            </button>
          ))}
        </fieldset>

        {!catalog && <p className="sub">{t("web.create.loading")}</p>}
        {problems.map((p) => (
          <p key={p.message} className="notice-inline">
            {p.message}
          </p>
        ))}

        <fieldset className="models" disabled={creating}>
          <legend>{t("table.model")}</legend>
          {(["phone", "tablet"] as const).map((form) =>
            group(form).length === 0 ? null : (
              <div key={form} className="model-group">
                <h4>{t(form === "phone" ? "web.create.phones" : "web.create.tablets")}</h4>
                <ul className="picker">
                  {group(form).map((m) => (
                    <li key={m.id}>
                      <button
                        type="button"
                        className={m.id === modelId ? "picker-row picker-row-active" : "picker-row"}
                        aria-pressed={m.id === modelId}
                        onClick={() => setModelId(m.id)}
                      >
                        <span className="size mono">
                          {Math.round(m.layoutWidth)}
                          {unit}
                        </span>
                        <span className="picker-name">{m.name}</span>
                        <span className="sub mono">{m.detail}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ),
          )}
          {current?.custom && (
            <div className="model-group">
              <ul className="picker">
                <li>
                  <button
                    type="button"
                    className={custom ? "picker-row picker-row-active" : "picker-row"}
                    aria-pressed={custom}
                    onClick={() => setModelId(CUSTOM)}
                  >
                    <span className="size mono">—</span>
                    <span className="picker-name">{t("web.create.custom")}</span>
                    <span className="sub">{t("web.create.customHint")}</span>
                  </button>
                </li>
              </ul>
              {custom && (
                <div className="grid3">
                  <label className="field">
                    <span>{t("web.create.widthDp")}</span>
                    <input
                      inputMode="numeric"
                      value={size.widthDp}
                      onChange={(e) => setSize({ ...size, widthDp: e.target.value })}
                    />
                  </label>
                  <label className="field">
                    <span>{t("web.create.heightDp")}</span>
                    <input
                      inputMode="numeric"
                      value={size.heightDp}
                      onChange={(e) => setSize({ ...size, heightDp: e.target.value })}
                    />
                  </label>
                  <label className="field">
                    <span>{t("web.create.density")}</span>
                    <select
                      value={size.density}
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
              )}
            </div>
          )}
        </fieldset>

        <div className="grid2">
          <label className="field">
            <span>{t(platform === "ios" ? "web.create.runtime" : "web.create.image")}</span>
            <select
              value={os?.id ?? ""}
              disabled={creating || osChoices.length === 0}
              onChange={(e) => setOsId(e.target.value)}
            >
              {osChoices.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                  {o.recommended ? t("web.create.recommended") : ""}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>{t("table.name")}</span>
            <input
              value={name}
              placeholder={defaultName}
              disabled={creating}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
        </div>

        <div className="slim-option">
          <label className="check">
            <input
              type="checkbox"
              checked={slim}
              disabled={creating}
              onChange={(e) => setSlim(e.target.checked)}
            />
            {t("web.create.slim")}
          </label>
          <button
            type="button"
            className="icon-button info-button"
            aria-label={t("web.create.slimInfo")}
            aria-expanded={showSlimInfo}
            onClick={() => setShowSlimInfo(!showSlimInfo)}
          >
            ⓘ
          </button>
        </div>
        {showSlimInfo && current && <SlimInfo catalog={current} />}
        <label className="check">
          <input
            type="checkbox"
            checked={slim && baseline}
            disabled={creating || !slim}
            onChange={(e) => setBaseline(e.target.checked)}
          />
          {t("web.create.baseline")}
        </label>

        {creating && <Progress log={log} logStart={logStart} />}
        <footer className="dialog-footer">
          <span className="sub">{t("web.create.noApps")}</span>
          <span className="spacer" />
          <button type="button" className="button" disabled={creating} onClick={onClose}>
            {t("web.cancel")}
          </button>
          <button
            type="submit"
            className="button button-primary"
            disabled={creating || (!model && !custom)}
          >
            {creating ? t("web.create.creating") : t("web.create.submit")}
          </button>
        </footer>
      </form>
    </Dialog>
  );
}

/** 슬림화하면 꺼지는 것 (M4 ⓘ) — simslim·avdslim 이 알려 주는 그대로 */
function SlimInfo({ catalog }: { catalog: PlatformCatalog }) {
  if (catalog.slimOff.length === 0) {
    return (
      <p className="sub">
        {t("web.create.slimInfoMissing", {
          tool: catalog.platform === "ios" ? "simslim" : "avdslim",
        })}
      </p>
    );
  }
  return (
    <div className="slim-info">
      <p>{t("web.create.slimInfoIntro")}</p>
      <ul>
        {catalog.slimOff.map((c) => (
          <li key={c.name}>
            <strong>{c.name}</strong>
            {c.count ? (
              <span className="sub"> · {t("web.create.slimCount", { count: c.count })}</span>
            ) : null}
            {c.detail && <div className="sub">{c.detail}</div>}
          </li>
        ))}
      </ul>
      {catalog.slimKeeps.length > 0 && (
        <>
          <p>{t("web.create.slimKeeps")}</p>
          <ul className="keeps">
            {catalog.slimKeeps.map((k) => (
              <li key={k}>{k}</li>
            ))}
          </ul>
        </>
      )}
    </div>
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
        {(log.at(-1)?.id ?? 0) === logStart && <p className="sub">{t("web.create.starting")}</p>}
      </div>
    </div>
  );
}
