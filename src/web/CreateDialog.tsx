import { Fragment, type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import type { CatalogModel, CatalogResult, DeviceView, PlatformCatalog } from "../shared/api.ts";
import { t } from "../shared/i18n.ts";
import { call } from "./api.ts";
import { PlatformIcon } from "./icons.tsx";
import { type SlimMode, SlimPicker } from "./SlimPicker.tsx";
import type { LogLine } from "./types.ts";
import { Dialog, Loading, osText, resolutionText, widthText } from "./ui.tsx";

type Platform = "android" | "ios";

const CUSTOM = "__custom__";
const PLATFORM_KEY = "simless-create-platform";

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
  onAdded,
  onError,
}: {
  open: boolean;
  catalog: CatalogResult | null;
  log: LogLine[];
  onClose: () => void;
  onCreated: (name: string) => void;
  onAdded: (name: string) => void;
  onError: (message: string) => void;
}) {
  const [mode, setMode] = useState<"new" | "mac">("new");
  const [platform, setPlatformState] = useState<Platform>(savedPlatform);
  const [modelId, setModelId] = useState("");
  const [osId, setOsId] = useState("");
  const [size, setSize] = useState({ widthDp: "375", heightDp: "812", density: "420" });
  const [name, setName] = useState("");
  const [baseline, setBaseline] = useState(true);
  const [slimMode, setSlimMode] = useState<SlimMode>("ui");
  const [slimKeep, setSlimKeep] = useState<string[]>([]);
  const slim = slimMode !== "none";
  const [creating, setCreating] = useState(false);
  const [logStart, setLogStart] = useState(0);

  const setPlatform = (next: Platform) => {
    setPlatformState(next);
    setModelId("");
    setOsId("");
    // 남길 항목은 플랫폼마다 다르다 — 커스텀이었으면 전체 슬림으로 (M15)
    setSlimMode((m) => (m === "custom" ? "ui" : m));
    setSlimKeep([]);
    try {
      localStorage.setItem(PLATFORM_KEY, next);
    } catch {
      // 기억 못 해도 된다
    }
  };

  useEffect(() => {
    if (!open) return;
    setMode("new");
    setModelId("");
    setOsId("");
    setName("");
    setBaseline(true);
    setSlimMode("ui");
    setSlimKeep([]);
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
  const defaultName = modelName ? (slim ? `simless ${modelName}` : modelName) : "";
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
        slimKeep: slim && slimMode === "custom" ? slimKeep : undefined,
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
      <div className="mode-tabs" role="tablist" aria-label={t("web.create.title")}>
        {(["new", "mac"] as const).map((m) => (
          <button
            key={m}
            type="button"
            role="tab"
            aria-selected={mode === m}
            className={mode === m ? "mode-tab mode-tab-active" : "mode-tab"}
            disabled={creating}
            onClick={() => setMode(m)}
          >
            {t(m === "new" ? "web.create.modeNew" : "web.create.modeMac")}
          </button>
        ))}
      </div>
      {mode === "mac" ? (
        <MacDevices onAdded={onAdded} onError={onError} />
      ) : (
        <form
          className="dialog-body create"
          onSubmit={(e) => {
            e.preventDefault();
            void create();
          }}
        >
          <Section step={1} title={t("web.platform")}>
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
          </Section>

          {!catalog && <p className="sub">{t("web.create.loading")}</p>}
          {problems.map((p) => (
            <p key={p.message} className="notice-inline">
              {p.message}
            </p>
          ))}

          <Section step={2} title={t("table.model")}>
            <fieldset className="models" disabled={creating}>
              <legend className="visually-hidden">{t("table.model")}</legend>
              {(["phone", "tablet"] as const).map((form) =>
                group(form).length === 0 ? null : (
                  <div key={form} className="model-group">
                    <h4>{t(form === "phone" ? "web.create.phones" : "web.create.tablets")}</h4>
                    <ul className="picker">
                      {group(form).map((m) => (
                        <li key={m.id}>
                          <button
                            type="button"
                            className={
                              m.id === modelId ? "picker-row picker-row-active" : "picker-row"
                            }
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
          </Section>

          <Section step={3} title={t("web.create.step.details")}>
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
          </Section>

          <Section step={4} title={t("web.slim.legend")}>
            <fieldset className="slim-field">
              <legend className="visually-hidden">{t("web.slim.legend")}</legend>
              <SlimPicker
                catalog={current}
                mode={slimMode}
                keep={slimKeep}
                disabled={creating}
                onChange={(m, k) => {
                  setSlimMode(m);
                  setSlimKeep(k);
                }}
              />
            </fieldset>
            {slim && (
              <label className="check">
                <input
                  type="checkbox"
                  checked={baseline}
                  disabled={creating}
                  onChange={(e) => setBaseline(e.target.checked)}
                />
                {t("web.create.baseline")}
              </label>
            )}
          </Section>

          {creating && <Progress log={log} logStart={logStart} />}
          <footer className="dialog-footer">
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
      )}
    </Dialog>
  );
}

/** 이 Mac 의 디바이스 — simless 목록에 없는 것을 골라 추가한다 (M1·R20) */
function MacDevices({
  onAdded,
  onError,
}: {
  onAdded: (name: string) => void;
  onError: (message: string) => void;
}) {
  const [devices, setDevices] = useState<DeviceView[] | null>(null);
  const [platform, setPlatform] = useState<"all" | "android" | "ios">("all");
  const [query, setQuery] = useState("");
  const [adding, setAdding] = useState<string | null>(null);

  const load = useCallback(() => {
    call<DeviceView[]>("device.available").then(setDevices, (e: unknown) =>
      onError((e as Error).message),
    );
  }, [onError]);
  useEffect(load, [load]);

  const q = query.trim().toLowerCase();
  const shown = (devices ?? [])
    .filter((d) => platform === "all" || d.platform === platform)
    .filter((d) => q === "" || `${d.name} ${osText(d)}`.toLowerCase().includes(q))
    .sort(
      (a, b) =>
        a.platform.localeCompare(b.platform) ||
        Number(b.booted) - Number(a.booted) ||
        a.layoutWidth - b.layoutWidth ||
        a.name.localeCompare(b.name),
    );

  return (
    <div className="dialog-body">
      <p className="sub">{t("web.create.macIntro")}</p>
      <div className="picker-toolbar">
        <div className="segmented" role="tablist" aria-label={t("web.platform")}>
          {(["all", "android", "ios"] as const).map((p) => (
            <button
              key={p}
              type="button"
              role="tab"
              aria-selected={platform === p}
              className={platform === p ? "segment segment-active" : "segment"}
              onClick={() => setPlatform(p)}
            >
              {p === "all" ? "All" : p === "android" ? "Android" : "iOS"}{" "}
              <span className="mono count">
                {(devices ?? []).filter((d) => p === "all" || d.platform === p).length}
              </span>
            </button>
          ))}
        </div>
        <input
          type="search"
          className="search"
          placeholder={t("web.search")}
          aria-label={t("web.search")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      {!devices ? (
        <Loading />
      ) : shown.length === 0 ? (
        <p className="sub">{t("web.create.macEmpty")}</p>
      ) : (
        <ul className="mac-list">
          {shown.map((d, i) => (
            <Fragment key={d.id}>
              {platform === "all" && d.platform !== shown[i - 1]?.platform && (
                <li className="picker-heading">{d.platform === "android" ? "Android" : "iOS"}</li>
              )}
              <li className="mac-row">
                <PlatformIcon platform={d.platform} />
                <span className="mono strong picker-width">{widthText(d)}</span>
                <span className="strong">{d.name}</span>
                <span className="sub">
                  {osText(d)} · {resolutionText(d)}
                </span>
                {d.booted && (
                  <span className="sub">
                    <span className="dot dot-on" />
                    {t("common.on")}
                  </span>
                )}
                <span className="spacer" />
                <button
                  type="button"
                  className="button button-small"
                  disabled={adding !== null}
                  onClick={async () => {
                    setAdding(d.id);
                    try {
                      await call("device.add", { device: d.id });
                      onAdded(d.name);
                      load();
                    } catch (error) {
                      onError((error as Error).message);
                    } finally {
                      setAdding(null);
                    }
                  }}
                >
                  {adding === d.id ? "…" : t("web.create.add")}
                </button>
              </li>
            </Fragment>
          ))}
        </ul>
      )}
    </div>
  );
}

/** 생성 화면의 한 단계 — 번호와 제목, 위에 구분선 */
function Section({ step, title, children }: { step: number; title: string; children: ReactNode }) {
  return (
    <section className="create-section">
      <h3 className="create-step">
        <span className="create-step-num">{step}</span>
        {title}
      </h3>
      {children}
    </section>
  );
}

/** 만드는 중 — 서버가 보내는 진행 알림 */
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
