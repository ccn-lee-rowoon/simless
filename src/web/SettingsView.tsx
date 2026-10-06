import { useEffect, useState } from "react";
import type { SettingsResult, StatusResult } from "../shared/api.ts";
import { t } from "../shared/i18n.ts";
import { call } from "./api.ts";
import { openSetup } from "./bridge.ts";
import type { Act } from "./types.ts";
import { Dialog } from "./ui.tsx";

const RAM_CHOICES = [1536, 2048, 3072, 4096];

/** 설정 화면 — 언어·자동 해제 시간·Android RAM·simslim 프로필 (M11·R25) */
export function SettingsView({
  status,
  act,
  onSaved,
}: {
  status: StatusResult;
  act: Act;
  onSaved: () => void;
}) {
  const [settings, setSettings] = useState<SettingsResult | null>(null);
  const [removing, setRemoving] = useState(false);
  const [purge, setPurge] = useState(false);
  const [removed, setRemoved] = useState(false);
  const [draft, setDraft] = useState<SettingsResult | null>(null);

  useEffect(() => {
    call<SettingsResult>("settings.get").then((s) => {
      setSettings(s);
      setDraft(s);
    });
  }, []);

  if (removed)
    return (
      <section className="panel settings-section">
        <h3>{t("web.uninstall.doneTitle")}</h3>
        <p className="sub">{t("web.uninstall.done")}</p>
      </section>
    );
  if (!draft || !settings) return <p className="sub">{t("web.loading")}</p>;
  const createdCount = status.devices.filter((d) => d.createdBySimless).length;

  const changed = JSON.stringify(draft) !== JSON.stringify(settings);
  const systemName = status.systemLanguage === "ko" ? "한국어" : "English";

  return (
    <form
      className="settings"
      onSubmit={(e) => {
        e.preventDefault();
        void act(t("web.settings.title"), async () => {
          const saved = await call<SettingsResult>("settings.set", {
            language: draft.language,
            idleReleaseMinutes: draft.idleReleaseMinutes,
            historyRetentionDays: draft.historyRetentionDays,
            androidRamMb: draft.androidRamMb,
            simslimProfile: draft.simslimProfile?.trim() ? draft.simslimProfile.trim() : null,
          });
          setSettings(saved);
          setDraft(saved);
          onSaved();
        });
      }}
    >
      <section className="panel settings-section">
        <h3>{t("web.settings.about")}</h3>
        <dl className="about-list">
          <dt>{t("web.settings.version")}</dt>
          <dd>{t("web.server.version", { version: status.serverVersion })}</dd>
          <dt>{t("web.settings.configFile")}</dt>
          <dd>
            <code>~/.config/simless/config.json</code>
          </dd>
        </dl>
      </section>

      <section className="panel settings-section">
        <h3>{t("web.settings.setup")}</h3>
        <div className="setup-intro">
          <p className="sub">{t("web.settings.setupHint")}</p>
          <button type="button" className="button button-small" onClick={openSetup}>
            {t("web.settings.openSetup")}
          </button>
        </div>
      </section>

      <section className="panel settings-section">
        <h3>{t("web.settings.language")}</h3>
        <fieldset className="radio-list">
          <legend className="visually-hidden">{t("web.settings.language")}</legend>
          {(["system", "ko", "en"] as const).map((value) => (
            <label key={value} className="check">
              <input
                type="radio"
                name="language"
                checked={draft.language === value}
                onChange={() => setDraft({ ...draft, language: value })}
              />
              {value === "system"
                ? t("web.settings.languageSystem", { current: systemName })
                : value === "ko"
                  ? "한국어"
                  : "English"}
            </label>
          ))}
        </fieldset>
      </section>

      <section className="panel settings-section">
        <h3>{t("web.settings.leases")}</h3>
        <label className="field field-inline">
          <span>{t("web.settings.idle")}</span>
          <input
            type="number"
            min={1}
            max={1440}
            value={draft.idleReleaseMinutes}
            onChange={(e) => setDraft({ ...draft, idleReleaseMinutes: Number(e.target.value) })}
          />
        </label>
        <p className="sub">{t("web.settings.idleHint")}</p>
        <label className="field field-inline">
          <span>{t("web.settings.retention")}</span>
          <input
            type="number"
            min={1}
            max={3650}
            value={draft.historyRetentionDays}
            onChange={(e) => setDraft({ ...draft, historyRetentionDays: Number(e.target.value) })}
          />
        </label>
        <p className="sub">{t("web.settings.retentionHint")}</p>
      </section>

      <section className="panel settings-section">
        <h3>{t("web.settings.devices")}</h3>
        <label className="field field-inline">
          <span>{t("web.settings.androidRam")}</span>
          <select
            value={draft.androidRamMb}
            onChange={(e) => setDraft({ ...draft, androidRamMb: Number(e.target.value) })}
          >
            {[...new Set([...RAM_CHOICES, draft.androidRamMb])]
              .sort((a, b) => a - b)
              .map((mb) => (
                <option key={mb} value={mb}>
                  {mb} MB
                </option>
              ))}
          </select>
        </label>
        <p className="sub">{t("web.settings.androidRamHint")}</p>
        <label className="field">
          <span>{t("web.settings.simslimProfile")}</span>
          <input
            value={draft.simslimProfile ?? ""}
            placeholder={t("web.settings.simslimProfilePlaceholder")}
            onChange={(e) => setDraft({ ...draft, simslimProfile: e.target.value })}
          />
        </label>
      </section>

      <footer className="settings-footer">
        <span className="spacer" />
        <button
          type="button"
          className="button"
          disabled={!changed}
          onClick={() => setDraft(settings)}
        >
          {t("web.settings.revert")}
        </button>
        <button type="submit" className="button button-primary" disabled={!changed}>
          {t("web.save")}
        </button>
      </footer>

      <section className="panel settings-section">
        <h3>{t("web.uninstall.title")}</h3>
        <div className="setup-intro">
          <p className="sub">{t("web.uninstall.hint")}</p>
          <button
            type="button"
            className="button button-small button-danger-outline"
            onClick={() => setRemoving(true)}
          >
            {t("web.uninstall.open")}
          </button>
        </div>
      </section>

      <Dialog open={removing} onClose={() => setRemoving(false)} title={t("web.uninstall.title")}>
        <div className="dialog-body">
          <p>{t("web.uninstall.removes")}</p>
          <ul className="uninstall-list">
            <li>{t("web.uninstall.itemSkill")}</li>
            <li>{t("web.uninstall.itemAgents")}</li>
            <li>{t("web.uninstall.itemApp")}</li>
          </ul>
          <label className="check">
            <input type="checkbox" checked={purge} onChange={(e) => setPurge(e.target.checked)} />
            {t("web.uninstall.purge")}
          </label>
          <p className="sub">
            {purge ? t("web.uninstall.purgeHint") : t("web.uninstall.keepHint")}
          </p>
          {createdCount > 0 && (
            <p className="sub">{t("web.uninstall.devices", { count: createdCount })}</p>
          )}
          <p className="sub">{t("web.uninstall.cli")}</p>
          <footer className="dialog-footer">
            <span className="spacer" />
            <button type="button" className="button" onClick={() => setRemoving(false)}>
              {t("web.cancel")}
            </button>
            <button
              type="button"
              className="button button-danger"
              onClick={() => {
                setRemoving(false);
                void act(t("web.uninstall.title"), async () => {
                  await call("setup.uninstall", { purge });
                  setRemoved(true);
                });
              }}
            >
              {t("web.uninstall.confirm")}
            </button>
          </footer>
        </div>
      </Dialog>
    </form>
  );
}
