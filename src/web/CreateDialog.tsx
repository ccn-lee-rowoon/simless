import { useEffect, useMemo, useState } from "react";
import type { CatalogModel, CatalogResult, DeviceView, PlatformCatalog } from "../shared/api.ts";
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
      onError(`만들기 실패 — ${(error as Error).message}`);
      setCreating(false);
    }
  };

  const group = (form: CatalogModel["form"]) => models.filter((m) => m.form === form);

  return (
    <Dialog open={open} onClose={creating ? () => {} : onClose} title="디바이스 생성" wide>
      <form
        className="dialog-body create"
        onSubmit={(e) => {
          e.preventDefault();
          void create();
        }}
      >
        <fieldset className="segmented" aria-label="플랫폼">
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

        {!catalog && <p className="subtle">만들 수 있는 기종을 읽는 중…</p>}
        {problems.map((p) => (
          <p key={p.message} className="notice-inline">
            {p.message}
          </p>
        ))}

        <fieldset className="models" disabled={creating}>
          <legend>기종</legend>
          {(["phone", "tablet"] as const).map((form) =>
            group(form).length === 0 ? null : (
              <div key={form} className="model-group">
                <h4>{form === "phone" ? "폰" : "태블릿"}</h4>
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
                        <span className="subtle mono">{m.detail}</span>
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
                    <span className="picker-name">직접 입력</span>
                    <span className="subtle">폭·높이·밀도</span>
                  </button>
                </li>
              </ul>
              {custom && (
                <div className="grid3">
                  <label className="field">
                    <span>폭 (dp)</span>
                    <input
                      inputMode="numeric"
                      value={size.widthDp}
                      onChange={(e) => setSize({ ...size, widthDp: e.target.value })}
                    />
                  </label>
                  <label className="field">
                    <span>높이 (dp)</span>
                    <input
                      inputMode="numeric"
                      value={size.heightDp}
                      onChange={(e) => setSize({ ...size, heightDp: e.target.value })}
                    />
                  </label>
                  <label className="field">
                    <span>밀도 (dpi)</span>
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
            <span>{platform === "ios" ? "런타임" : "시스템 이미지"}</span>
            <select
              value={os?.id ?? ""}
              disabled={creating || osChoices.length === 0}
              onChange={(e) => setOsId(e.target.value)}
            >
              {osChoices.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                  {o.recommended ? " (기본)" : ""}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>이름</span>
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
            슬림화 — UI 테스트용으로 가볍게 (이름 앞에 corgi)
          </label>
          <button
            type="button"
            className="icon-button info-button"
            aria-label="슬림화하면 안 되는 기능"
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
          슬림 전후 비교 — 슬림하기 전에 한 번 켜서 메모리를 재 둔다 (1~2분 더 걸림)
        </label>

        {creating && <Progress log={log} logStart={logStart} />}
        <footer className="dialog-footer">
          <span className="subtle">앱은 설치하지 않습니다</span>
          <span className="spacer" />
          <button type="button" className="button" disabled={creating} onClick={onClose}>
            취소
          </button>
          <button
            type="submit"
            className="button button-primary"
            disabled={creating || (!model && !custom)}
          >
            {creating ? "만드는 중…" : "만들기"}
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
      <p className="subtle">
        {catalog.platform === "ios" ? "simslim" : "avdslim"} 이 없어 목록을 읽지 못했습니다.
      </p>
    );
  }
  return (
    <div className="slim-info">
      <p>슬림화하면 아래 기능이 꺼집니다. 테스트에 필요하면 슬림을 끄고 만드세요.</p>
      <ul>
        {catalog.slimOff.map((c) => (
          <li key={c.name}>
            <strong>{c.name}</strong>
            {c.count ? <span className="subtle"> · {c.count}개</span> : null}
            {c.detail && <div className="subtle">{c.detail}</div>}
          </li>
        ))}
      </ul>
      {catalog.slimKeeps.length > 0 && (
        <>
          <p>그대로 남는 것</p>
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
        {(log.at(-1)?.id ?? 0) === logStart && <p className="subtle">시작하는 중…</p>}
      </div>
    </div>
  );
}
