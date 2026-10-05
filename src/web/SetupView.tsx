import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import type {
  CheckId,
  CheckView,
  FixId,
  InstallState,
  JobView,
  OtherAgent,
  OtherAgentView,
  SetupAgents,
  SetupItem,
  SetupStatus,
  SkillLocation,
  StatusResult,
} from "../shared/api.ts";
import { type MessageKey, t } from "../shared/i18n.ts";
import { call, subscribe } from "./api.ts";
import { postToApp } from "./bridge.ts";
import { PlatformIcon } from "./icons.tsx";
import type { Act } from "./types.ts";
import { Logo } from "./ui.tsx";

// 첫 실행 설정 창 — ?window=setup (M14). 앱을 처음 열면 뜬다.
// 터미널 없이 차례로: 이 Mac 점검 → 에이전트 연결 → 기본 디바이스. 설치는 서버가 한다.

type Step = "check" | "agents" | "devices";
const STEPS: { id: Step; label: MessageKey }[] = [
  { id: "check", label: "web.setup.steps.check" },
  { id: "agents", label: "web.setup.steps.agents" },
  { id: "devices", label: "web.setup.steps.devices" },
];

/** 점검을 묶어 보이는 차례 — 서버 등록·스킬·훅 같은 simless 자신의 것은 다른 단계에서 */
const CHECK_SECTIONS: { label: MessageKey; ids: CheckId[] }[] = [
  { label: "web.setup.check.server", ids: ["server", "launchd"] },
  { label: "web.setup.check.ios", ids: ["xcode", "simslim"] },
  { label: "web.setup.check.android", ids: ["androidSdk", "images", "avdslim"] },
  { label: "web.setup.check.screen", ids: ["argent"] },
];

export function SetupView({
  status,
  act,
  onCreate,
}: {
  status: StatusResult;
  act: Act;
  onCreate: () => void;
}) {
  const [step, setStep] = useState<Step>("check");
  const [setup, setSetup] = useState<SetupStatus | null>(null);
  const [checking, setChecking] = useState(false);

  const load = useCallback(() => {
    setChecking(true);
    call<SetupStatus>("setup.status").then(
      (next) => {
        setSetup(next);
        setChecking(false);
      },
      () => setChecking(false),
    );
  }, []);
  useEffect(load, [load]);

  // 바로 설치 (M14) — 서버가 돌리는 설치와 그 출력. 항목(fix)마다 마지막 실행 하나
  const [jobs, setJobs] = useState<Partial<Record<FixId, JobView>>>({});
  useEffect(() => {
    call<JobView[]>("setup.jobs").then(
      (list) => setJobs(Object.fromEntries(list.map((j) => [j.fix, j]))),
      () => {},
    );
    return subscribe({
      output: (id, line) =>
        setJobs((all) => {
          const job = Object.values(all).find((j) => j?.id === id);
          return job ? { ...all, [job.fix]: { ...job, lines: [...job.lines, line] } } : all;
        }),
      job: (job) => {
        setJobs((all) => ({
          ...all,
          [job.fix]: { ...job, lines: all[job.fix]?.lines ?? job.lines },
        }));
        // 끝나면 다시 확인한다 — 설치됐으면 ✓ 로 바뀐다
        if (job.status === "done") load();
      },
    });
  }, [load]);
  const fixes: FixControls = {
    jobs,
    // 시작은 바로 돌아온다 — 결과는 출력 창에. 시작 못 하면 그 오류를 출력 창에
    run: (fix) => {
      void call<JobView>("setup.run", { fix }).then(
        // 출력이 응답보다 먼저 올 수 있다 — 이미 받고 있는 같은 실행이면 덮어쓰지 않는다
        (job) => setJobs((all) => (all[fix]?.id === job.id ? all : { ...all, [fix]: job })),
        (error: unknown) =>
          setJobs((all) => ({
            ...all,
            [fix]: {
              id: `error-${fix}`,
              fix,
              status: "failed",
              lines: [String((error as Error).message ?? error)],
              command: "",
              startedAt: Date.now(),
              endedAt: Date.now(),
            },
          })),
      );
    },
    cancel: (job) => act(t("web.setup.fix.cancel"), () => call("setup.cancel", { job: job.id })),
    terminal: (fix) => act(t("web.setup.fix.terminal"), () => call("setup.openTerminal", { fix })),
    hide: (fix) =>
      setJobs((all) => {
        const { [fix]: _gone, ...rest } = all;
        return rest;
      }),
  };

  const index = STEPS.findIndex((s) => s.id === step);
  const finish = () =>
    act(t("web.setup.finish"), async () => {
      await call("setup.finish");
      // 앱이면 대시보드를 열고 이 창을 닫는다. 브라우저면 이 창이 대시보드가 된다
      if (postToApp({ open: "dashboard" })) postToApp({ close: "setup" });
      else location.href = "/";
    });

  return (
    <div className="setup">
      <header className="setup-head">
        <Logo size={48} />
        <div>
          <h1 className="page-title">{t("web.setup.title")}</h1>
          <p className="setup-slogan">{t("web.slogan")}</p>
          <p className="sub">{t("web.setup.intro")}</p>
        </div>
      </header>

      <ol className="setup-steps">
        {STEPS.map((s, i) => (
          <li key={s.id}>
            <button
              type="button"
              className={
                s.id === step
                  ? "setup-step setup-step-active"
                  : i < index
                    ? "setup-step setup-step-done"
                    : "setup-step"
              }
              aria-current={s.id === step ? "step" : undefined}
              onClick={() => setStep(s.id)}
            >
              <span className="setup-step-number mono">{i + 1}</span>
              {t(s.label)}
            </button>
          </li>
        ))}
      </ol>

      <section className="setup-body">
        {step === "check" && (
          <CheckStep setup={setup} checking={checking} onRecheck={load} fixes={fixes} />
        )}
        {step === "agents" && (
          <AgentsStep
            agents={setup?.agents}
            checking={checking}
            onRecheck={load}
            onChanged={(agents) => setSetup((s) => (s ? { ...s, agents } : s))}
            act={act}
          />
        )}
        {step === "devices" && <DevicesStep status={status} act={act} onCreate={onCreate} />}
      </section>

      <footer className="setup-footer">
        {index > 0 && (
          <button
            type="button"
            className="button"
            onClick={() => setStep(STEPS[index - 1]?.id ?? "check")}
          >
            {t("web.setup.back")}
          </button>
        )}
        <span className="spacer" />
        {index < STEPS.length - 1 ? (
          <button
            type="button"
            className="button button-primary"
            onClick={() => setStep(STEPS[index + 1]?.id ?? "devices")}
          >
            {t("web.setup.next")}
          </button>
        ) : (
          <button type="button" className="button button-primary" onClick={finish}>
            {t("web.setup.finish")}
          </button>
        )}
      </footer>
    </div>
  );
}

const MARK: Record<CheckView["status"], string> = { ok: "✓", warn: "!", fail: "✕" };

/** 바로 설치 — 항목마다 실행·취소·터미널·닫기 */
interface FixControls {
  jobs: Partial<Record<FixId, JobView>>;
  run: (fix: FixId) => void;
  cancel: (job: JobView) => void;
  terminal: (fix: FixId) => void;
  hide: (fix: FixId) => void;
}

function CheckStep({
  setup,
  checking,
  onRecheck,
  fixes,
}: {
  setup: SetupStatus | null;
  checking: boolean;
  onRecheck: () => void;
  fixes: FixControls;
}) {
  const byId = new Map((setup?.checks ?? []).map((c) => [c.id, c]));
  const shown = CHECK_SECTIONS.flatMap((s) => s.ids.flatMap((id) => byId.get(id) ?? []));
  const fails = shown.filter((c) => c.status === "fail").length;
  const warns = shown.filter((c) => c.status === "warn").length;

  return (
    <>
      <div className="setup-intro">
        <p className="sub">{t("web.setup.check.intro")}</p>
        <button
          type="button"
          className="button button-small"
          disabled={checking}
          onClick={onRecheck}
        >
          {checking ? t("web.setup.check.checking") : t("web.setup.check.recheck")}
        </button>
      </div>
      {!setup ? (
        <p className="sub">{t("web.setup.check.checking")}</p>
      ) : (
        <>
          <p className={fails + warns === 0 ? "setup-summary setup-summary-ok" : "setup-summary"}>
            {fails + warns === 0
              ? t("web.setup.check.allGood")
              : t("web.setup.check.summary", { fails, warns })}
          </p>
          {CHECK_SECTIONS.map((section) => {
            const checks = section.ids.flatMap((id) => byId.get(id) ?? []);
            if (checks.length === 0) return null;
            return (
              <div key={section.label} className="panel setup-section">
                <h3>{t(section.label)}</h3>
                <ul className="setup-checks">
                  {checks.map((c) => (
                    <CheckRow key={c.id} check={c} fixes={fixes} />
                  ))}
                </ul>
              </div>
            );
          })}
        </>
      )}
    </>
  );
}

const ACTION_LABEL: Record<NonNullable<CheckView["action"]>["kind"], MessageKey> = {
  install: "web.setup.install",
  update: "web.setup.update",
  open: "web.setup.fix.open",
};

/** 점검 한 줄 — 고칠 수 있으면 버튼, 누르면 아래에 실행 출력 */
function CheckRow({ check: c, fixes }: { check: CheckView; fixes: FixControls }) {
  const action = c.action;
  const job = action ? fixes.jobs[action.fix] : undefined;
  const running = job?.status === "running";
  return (
    <li className="setup-check setup-check-row">
      <span className={`setup-mark setup-mark-${c.status}`} aria-hidden="true">
        {MARK[c.status]}
      </span>
      <div className="setup-check-text">
        <span className="strong">{c.name}</span>
        <span className="sub">{c.detail}</span>
        {/* 버튼으로 못 고치는 것만 명령을 보여 준다(복사) */}
        {c.fix && !action && <Command text={c.fix} />}
        {action?.fix === "argent.install" && !job && (
          <span className="notice-inline setup-fix-warn">{t("web.setup.fix.argentWarn")}</span>
        )}
        {job && action && <FixTerminal job={job} fixes={fixes} openOnly={action.kind === "open"} />}
      </div>
      {action && (
        <button
          type="button"
          className={
            action.kind === "open" ? "button button-small" : "button button-primary button-small"
          }
          disabled={running}
          onClick={() => fixes.run(action.fix)}
        >
          {running ? t("web.setup.fix.running") : t(ACTION_LABEL[action.kind])}
        </button>
      )}
    </li>
  );
}

/** 설치 출력 — 터미널처럼 한 줄씩, 끝나면 결과와 버튼 */
function FixTerminal({
  job,
  fixes,
  openOnly,
}: {
  job: JobView;
  fixes: FixControls;
  openOnly: boolean;
}) {
  const box = useRef<HTMLPreElement>(null);
  // 새 줄이 오면 맨 아래로
  useEffect(() => {
    void job.lines.length;
    box.current?.scrollTo({ top: box.current.scrollHeight });
  }, [job.lines.length]);
  if (openOnly && job.status === "done") return null;
  const seconds = job.endedAt ? Math.max(1, Math.round((job.endedAt - job.startedAt) / 1000)) : 0;
  return (
    <div className="setup-terminal-wrap">
      <pre ref={box} className="setup-terminal mono">
        {job.lines.join("\n")}
      </pre>
      <div className="setup-terminal-status">
        <span className={`setup-job setup-job-${job.status}`}>
          {job.status === "running"
            ? t("web.setup.fix.running")
            : job.status === "done"
              ? t("web.setup.fix.done", { seconds })
              : job.status === "canceled"
                ? t("web.setup.fix.canceled")
                : t("web.setup.fix.failed", { code: job.exitCode ?? "?" })}
        </span>
        <span className="spacer" />
        {job.status === "running" ? (
          <button type="button" className="button button-small" onClick={() => fixes.cancel(job)}>
            {t("web.setup.fix.cancel")}
          </button>
        ) : (
          <button type="button" className="button button-small" onClick={() => fixes.hide(job.fix)}>
            {t("web.setup.fix.hide")}
          </button>
        )}
        {job.status !== "done" && job.status !== "running" && (
          <button
            type="button"
            className="button button-small"
            title={t("web.setup.fix.inputHint")}
            onClick={() => fixes.terminal(job.fix)}
          >
            {t("web.setup.fix.terminal")}
          </button>
        )}
      </div>
    </div>
  );
}

/** 사람이 터미널에서 실행할 명령 — 복사 버튼과 함께 */
function Command({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  // 명령이 아니라 설명(«Xcode 를 설치하고 …»)이면 그냥 글로
  if (!/^[a-z]/.test(text)) return <span className="sub setup-fix">→ {text}</span>;
  // 끝의 괄호는 덧붙인 설명 — 복사하지 않는다
  const [, command = text, note] = /^(.*?)\s*(\([^()]*\))?$/.exec(text) ?? [];
  return (
    <span className="setup-command">
      <code className="mono">{command}</code>
      {note && <span className="sub">{note}</span>}
      <button
        type="button"
        className="button button-small"
        title={t("web.setup.check.terminal")}
        onClick={() => {
          void navigator.clipboard?.writeText(command).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          });
        }}
      >
        {copied ? t("web.setup.copied") : t("web.setup.copy")}
      </button>
    </span>
  );
}

const STATE_LABEL: Record<InstallState, MessageKey> = {
  current: "web.setup.state.current",
  outdated: "web.setup.state.outdated",
  missing: "web.setup.state.missing",
};

function AgentsStep({
  agents,
  checking,
  onRecheck,
  onChanged,
  act,
}: {
  agents: SetupAgents | undefined;
  checking: boolean;
  onRecheck: () => void;
  onChanged: (agents: SetupAgents) => void;
  act: Act;
}) {
  if (!agents) return <p className="sub">{t("web.setup.check.checking")}</p>;

  const apply = (item: SetupItem, enabled: boolean, label: string) =>
    act(label, async () => {
      onChanged(await call<SetupAgents>("setup.apply", { item, enabled }));
    });

  /** 보호는 훅과 규칙이 둘 다 있어야 «설치됨» */
  const protection: InstallState =
    agents.hook === "current" && agents.rule === "current"
      ? "current"
      : agents.hook === "missing" && agents.rule === "missing"
        ? "missing"
        : "outdated";

  return (
    <>
      <div className="setup-intro">
        <p className="sub">{t("web.setup.agents.intro")}</p>
        <button
          type="button"
          className="button button-small"
          disabled={checking}
          onClick={onRecheck}
        >
          {checking ? t("web.setup.check.checking") : t("web.setup.check.recheck")}
        </button>
      </div>
      <Integration
        title={t("web.setup.skill.title")}
        badge={t("web.setup.recommended")}
        description={t("web.setup.skill.desc")}
        path={agents.skillLocations.map((l) => locationText(l.location)).join(" · ")}
        state={agents.skill}
        onApply={(enabled) => apply("skill", enabled, t("web.setup.skill.title"))}
      >
        <SkillScope agents={agents} onChanged={onChanged} act={act} />
      </Integration>
      <Integration
        title={t("web.setup.protect.title")}
        badge={t("web.setup.recommended")}
        description={t("web.setup.protect.desc")}
        path="~/.claude/settings.json · ~/.claude/rules/simless.md"
        state={protection}
        warning={protection === "current" ? undefined : t("web.setup.protect.warn")}
        onApply={(enabled) => apply("protection", enabled, t("web.setup.protect.title"))}
      />
      <Integration
        title={t("web.setup.mcp.title")}
        badge={t("web.setup.optional")}
        description={t("web.setup.mcp.desc")}
        path="~/.claude.json"
        state={agents.mcp}
        disabled={agents.claude ? undefined : t("web.setup.mcp.noClaude")}
        onApply={(enabled) => apply("mcp", enabled, t("web.setup.mcp.title"))}
      />
      <h3 className="setup-agents-title">{t("web.setup.agents.othersTitle")}</h3>
      <p className="sub">{t("web.setup.agents.othersIntro")}</p>
      {agents.others.map((other) => (
        <OtherAgentCard key={other.agent} other={other} onChanged={onChanged} act={act} />
      ))}
    </>
  );
}

const AGENT_NOTE: Partial<Record<OtherAgent, MessageKey>> = {
  codex: "web.setup.agents.note.codex",
  cursor: "web.setup.agents.note.cursor",
  gemini: "web.setup.agents.note.gemini",
};

/** 다른 에이전트 하나 — 보호(훅 + 규칙)와 MCP 를 켜고 끈다 (Q16) */
function OtherAgentCard({
  other,
  onChanged,
  act,
}: {
  other: OtherAgentView;
  onChanged: (agents: SetupAgents) => void;
  act: Act;
}) {
  const [busy, setBusy] = useState(false);
  const protection: InstallState =
    other.hook === "current" && other.rule === "current"
      ? "current"
      : other.hook === "missing" && other.rule === "missing"
        ? "missing"
        : "outdated";
  const apply = (item: "protection" | "mcp", enabled: boolean) => {
    setBusy(true);
    void act(
      `${other.label} — ${t(item === "mcp" ? "web.setup.mcp.title" : "web.setup.protect.title")}`,
      async () => {
        onChanged(await call<SetupAgents>("setup.apply", { item, enabled, agent: other.agent }));
      },
    ).finally(() => setBusy(false));
  };
  const note = AGENT_NOTE[other.agent];
  const row = (item: "protection" | "mcp", state: InstallState) => (
    <div className="setup-agent-row">
      <span>{t(item === "mcp" ? "web.setup.mcp.title" : "web.setup.protect.title")}</span>
      <span className={`setup-state setup-state-${state}`}>{t(STATE_LABEL[state])}</span>
      <span className="spacer" />
      {state !== "current" && (
        <button
          type="button"
          className="button button-primary button-small"
          disabled={busy || !other.installed}
          onClick={() => apply(item, true)}
        >
          {state === "outdated" ? t("web.setup.update") : t("web.setup.install")}
        </button>
      )}
      {state !== "missing" && (
        <button
          type="button"
          className="button button-small"
          disabled={busy}
          onClick={() => apply(item, false)}
        >
          {t("web.setup.remove")}
        </button>
      )}
    </div>
  );
  return (
    <div
      className={other.installed ? "panel setup-section" : "panel setup-section setup-agent-absent"}
    >
      <div className="setup-integration-head">
        <h3>{other.label}</h3>
        {!other.installed && <span className="chip">{t("web.setup.agents.notInstalled")}</span>}
      </div>
      {row("protection", protection)}
      {row("mcp", other.mcp)}
      {note && other.installed && <p className="sub">{t(note)}</p>}
    </div>
  );
}

function Integration({
  title,
  badge,
  description,
  path,
  state,
  warning,
  disabled,
  onApply,
  children,
}: {
  children?: ReactNode;
  title: string;
  badge: string;
  description: string;
  path: string;
  state: InstallState;
  warning?: string;
  /** 설치할 수 없는 이유 */
  disabled?: string;
  onApply: (enabled: boolean) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const run = (enabled: boolean) => {
    setBusy(true);
    void onApply(enabled).finally(() => setBusy(false));
  };
  return (
    <div className="panel setup-section setup-integration">
      <div className="setup-integration-head">
        <h3>{title}</h3>
        <span className="chip">{badge}</span>
        <span className="spacer" />
        <span className={`setup-state setup-state-${state}`}>{t(STATE_LABEL[state])}</span>
      </div>
      <p>{description}</p>
      <p className="sub mono">{path}</p>
      {warning && <p className="notice-inline">{warning}</p>}
      {disabled && state === "missing" && <p className="notice-inline">{disabled}</p>}
      {children}
      <div className="setup-actions">
        {state !== "current" && (
          <button
            type="button"
            className="button button-primary button-small"
            disabled={busy || (disabled !== undefined && state === "missing")}
            onClick={() => run(true)}
          >
            {state === "outdated" ? t("web.setup.update") : t("web.setup.install")}
          </button>
        )}
        {state !== "missing" && (
          <button
            type="button"
            className="button button-small"
            disabled={busy}
            onClick={() => run(false)}
          >
            {t("web.setup.remove")}
          </button>
        )}
      </div>
    </div>
  );
}

function DevicesStep({
  status,
  act,
  onCreate,
}: {
  status: StatusResult;
  act: Act;
  onCreate: () => void;
}) {
  const rows: { platform: "ios" | "android"; label: string }[] = [
    { platform: "ios", label: "iOS" },
    { platform: "android", label: "Android" },
  ];
  return (
    <>
      <div className="setup-intro">
        <p className="sub">{t("web.setup.devices.intro")}</p>
      </div>
      <div className="panel setup-section">
        <ul className="setup-checks">
          {rows.map(({ platform, label }) => {
            const id = status.defaults[platform];
            const device = status.devices.find((d) => d.id === id);
            const others = status.devices.filter((d) => d.platform === platform);
            return (
              <li key={platform} className="setup-check setup-default">
                <PlatformIcon platform={platform} />
                <div className="setup-check-text">
                  <span className="strong">{label}</span>
                  <span className={device ? "" : "sub"}>
                    {device ? device.name : t("web.setup.devices.none")}
                  </span>
                </div>
                <span className="spacer" />
                {!device && others.length > 0 && (
                  <select
                    className="setup-select"
                    value=""
                    onChange={(e) => {
                      const picked = e.target.value;
                      if (picked)
                        void act(label, () => call("device.setDefault", { device: picked }));
                    }}
                  >
                    <option value="">{t("web.setup.devices.choose")}</option>
                    {others.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.name}
                      </option>
                    ))}
                  </select>
                )}
              </li>
            );
          })}
        </ul>
        <div className="setup-actions">
          <button type="button" className="button button-primary button-small" onClick={onCreate}>
            {t("web.setup.devices.create")}
          </button>
        </div>
      </div>
      <p className="sub">{t("web.setup.devices.later")}</p>
    </>
  );
}

/** 스킬 위치를 사람에게 — 홈 폴더는 ~ 로 */
function locationText(location: SkillLocation): string {
  return location.kind === "global"
    ? "~/.claude/skills/simless · ~/.agents/skills/simless"
    : location.path;
}

/** 스킬을 넣는 곳 (S9) — 전역(기본) 또는 고른 프로젝트 폴더들 */
function SkillScope({
  agents,
  onChanged,
  act,
}: {
  agents: SetupAgents;
  onChanged: (agents: SetupAgents) => void;
  act: Act;
}) {
  const projects = agents.skillLocations.flatMap((l) =>
    l.location.kind === "project" ? [{ path: l.location.path, targets: l.targets }] : [],
  );
  const [mode, setMode] = useState<"global" | "project">(
    projects.length > 0 ? "project" : "global",
  );
  const [paths, setPaths] = useState<string[]>(projects.map((p) => p.path));
  const [input, setInput] = useState("");
  const targets = new Map(projects.map((p) => [p.path, p.targets]));

  const save = (scope: { kind: "global" } | { kind: "project"; paths: string[] }) =>
    act(t("web.setup.skill.title"), async () => {
      onChanged(await call<SetupAgents>("setup.skillScope", scope));
    });

  const add = () => {
    const path = input.trim();
    if (path && !paths.includes(path)) setPaths([...paths, path]);
    setInput("");
  };
  const changed = JSON.stringify(paths) !== JSON.stringify(projects.map((p) => p.path));

  return (
    <fieldset className="radio-list setup-scope">
      <legend className="sub">{t("web.setup.skill.scope")}</legend>
      <label className="check">
        <input
          type="radio"
          name="skill-scope"
          checked={mode === "global"}
          onChange={() => {
            setMode("global");
            if (projects.length > 0) void save({ kind: "global" });
          }}
        />
        <span>
          {t("web.setup.skill.scopeGlobal")}
          <span className="sub"> — {t("web.setup.skill.scopeGlobalHint")}</span>
        </span>
      </label>
      <label className="check">
        <input
          type="radio"
          name="skill-scope"
          checked={mode === "project"}
          onChange={() => setMode("project")}
        />
        <span>
          {t("web.setup.skill.scopeProject")}
          <span className="sub"> — {t("web.setup.skill.scopeProjectHint")}</span>
        </span>
      </label>
      {mode === "project" && (
        <div className="setup-projects">
          {paths.map((path) => (
            <div key={path} className="setup-project">
              <span className="mono">{path}</span>
              {targets.has(path) && (
                <span className="sub">
                  {t("web.setup.skill.worktrees", { count: targets.get(path) ?? 0 })}
                </span>
              )}
              <span className="spacer" />
              <button
                type="button"
                className="button button-small"
                onClick={() => setPaths(paths.filter((p) => p !== path))}
              >
                {t("web.setup.remove")}
              </button>
            </div>
          ))}
          <div className="setup-project">
            <input
              className="setup-input mono"
              value={input}
              placeholder={t("web.setup.skill.projectPlaceholder")}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  add();
                }
              }}
            />
            <button type="button" className="button button-small" onClick={add}>
              {t("web.setup.skill.add")}
            </button>
          </div>
          <div className="setup-actions">
            <button
              type="button"
              className="button button-primary button-small"
              disabled={paths.length === 0 || !changed}
              onClick={() => save({ kind: "project", paths })}
            >
              {t("web.setup.skill.applyScope")}
            </button>
          </div>
        </div>
      )}
    </fieldset>
  );
}
