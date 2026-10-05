import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import {
  AGENT_INTEGRATIONS,
  AgentConfigError,
  integrationOf,
  isAgentInstalled,
} from "../install/agents.ts";
import { runChecks } from "../install/checks.ts";
import {
  hookStatus,
  installHook,
  installRule,
  ruleStatus,
  uninstallHook,
  uninstallRule,
} from "../install/claude-hook.ts";
import {
  claudeBinary,
  installMcp,
  McpInstallError,
  mcpStatus,
  uninstallMcp,
} from "../install/claude-mcp.ts";
import { FIXES, type Fix, fixCommandLine } from "../install/fixes.ts";
import { selfCommand } from "../install/launchd.ts";
import {
  combineStates,
  installSkillAt,
  loadSkillLocations,
  locationStatus,
  sameLocation,
  saveSkillLocations,
  uninstallSkillAt,
} from "../install/skill.ts";
import type { FixId, SetupAgents, SetupStatus, SkillLocation } from "../shared/api.ts";
import { run } from "../shared/exec.ts";
import { t } from "../shared/i18n.ts";
import type { Paths } from "../shared/paths.ts";
import { VERSION } from "../shared/version.ts";
import type { CorgiServer } from "./app.ts";
import { isFixId, Jobs } from "./jobs.ts";
import { parse } from "./params.ts";
import { HandlerError } from "./socket.ts";
import { readJson, writeJson } from "./store.ts";

// 첫 실행 설정 (M14) — 앱을 처음 열면 뜨는 창이 부른다. 터미널 없이 점검·에이전트 연결·기본 디바이스까지.
// 설치 자체는 CLI(`corgi install`)와 같은 함수를 쓴다. 서버가 하므로 창은 버튼만 누르면 된다.

/** 스킬 업데이트 확인 간격 — 작업 트리가 새로 생겼는지도 이때 본다 */
const SKILL_CHECK_MS = 10 * 60_000;

const SetupFile = z.object({ finishedAt: z.number(), version: z.string() });

const ScopeParams = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("global") }),
  z.object({ kind: z.literal("project"), paths: z.array(z.string().min(1)).min(1) }),
]);

const FixParams = z.object({ fix: z.string() });
const JobParams = z.object({ job: z.string() });

const ApplyParams = z.object({
  item: z.enum(["skill", "mcp", "protection"]),
  enabled: z.boolean(),
  /** 보호·MCP 를 붙일 에이전트 — 기본은 Claude Code. 스킬은 모든 에이전트가 같이 쓴다 */
  agent: z.enum(["claude", "copilot", "codex", "cursor", "gemini"]).default("claude"),
});

/** 설정을 한 번도 안 끝냈으면 true — 앱이 처음 뜰 때 설정 창을 연다 */
export function setupNeeded(paths: Paths): boolean {
  return !existsSync(paths.setup);
}

export function registerSetupMethods(server: CorgiServer): void {
  const deps = server.setupDeps;
  const env = deps.env ?? process.env;
  const command = () => deps.selfCommand ?? selfCommand();

  const locations = () => loadSkillLocations(server.paths.skills);
  const skillLocations = () => Promise.all(locations().map((l) => locationStatus(l, env)));

  const agents = async (): Promise<SetupAgents> => {
    const views = await skillLocations();
    return {
      claude: claudeBinary(env) !== undefined,
      skill: combineStates(views.map((v) => v.state)),
      skillLocations: views,
      mcp: mcpStatus(command(), env),
      hook: hookStatus(command(), env),
      rule: await ruleStatus(env),
      others: await Promise.all(
        AGENT_INTEGRATIONS.map(async (a) => ({
          agent: a.agent,
          label: a.label,
          installed: isAgentInstalled(a, env),
          hook: await a.hookState(command(), env).catch(() => "missing" as const),
          rule: await a.ruleState(env).catch(() => "missing" as const),
          mcp: await a.mcpState(command(), env).catch(() => "missing" as const),
        })),
      ),
    };
  };

  const checks = () =>
    deps.setupChecks?.() ??
    runChecks(
      {
        paths: server.paths,
        config: server.config,
        session: { key: "setup", agent: "web", cwd: "web", human: true },
      },
      { serverVersion: VERSION },
    );

  /** 넣어 둔 곳 중 예전 스킬이 있으면(작업 트리에 빠진 것 포함) 알린다. 바뀌면 화면에 알린다 */
  const checkSkillUpdate = async () => {
    const views = await skillLocations().catch(() => []);
    const next = views.some((v) => v.state === "outdated");
    if (next !== server.skillUpdate) {
      server.skillUpdate = next;
      server.notify();
    }
  };
  void checkSkillUpdate();
  setInterval(() => void checkSkillUpdate(), SKILL_CHECK_MS).unref();

  server.addMethod("setup.status", async (): Promise<SetupStatus> => {
    const done = readJson(server.paths.setup, SetupFile.optional(), undefined);
    return {
      needed: done === undefined,
      finishedAt: done?.finishedAt,
      checks: await checks(),
      agents: await agents(),
    };
  });

  server.addMethod("setup.apply", async (p) => {
    const { item, enabled, agent } = parse(ApplyParams, p);
    try {
      if (item !== "skill" && agent !== "claude") {
        // 다른 에이전트 (Q16) — 보호 = 훅 + 규칙
        const a = integrationOf(agent);
        if (item === "mcp") {
          if (enabled) await a.installMcp(command(), env);
          else await a.uninstallMcp(env);
        } else if (enabled) {
          await a.installHook(command(), env);
          await a.installRule(env);
        } else {
          await a.uninstallHook(env);
          await a.uninstallRule(env);
        }
      } else if (item === "skill") {
        for (const location of locations()) {
          if (enabled) await installSkillAt(location, env);
          else await uninstallSkillAt(location, env);
        }
      } else if (item === "mcp") {
        if (enabled) await installMcp(command(), env);
        else await uninstallMcp(env);
      } else if (enabled) {
        installHook(command(), env);
        await installRule(env);
      } else {
        uninstallHook(env);
        uninstallRule(env);
      }
      if (item === "skill") await checkSkillUpdate();
    } catch (error) {
      if (error instanceof AgentConfigError)
        throw new HandlerError("FAILED", t("setup.agentConfig", { detail: error.message }));
      if (error instanceof McpInstallError) {
        if (error.message === "claude") throw new HandlerError("TOOL_MISSING", t("setup.noClaude"));
        throw new HandlerError("FAILED", t("setup.mcpFailed", { error: error.message }));
      }
      throw error;
    }
    return agents();
  });

  /** 스킬을 넣을 곳 바꾸기 (S9) — 전역 하나, 또는 프로젝트 여러 개. 빠진 곳은 지우고 새 곳에 넣는다 */
  server.addMethod("setup.skillScope", async (p) => {
    const params = parse(ScopeParams, p);
    const next: SkillLocation[] =
      params.kind === "global"
        ? [{ kind: "global" }]
        : params.paths.map((path) => {
            const absolute = resolve(path.replace(/^~(?=\/|$)/, env.HOME ?? ""));
            if (!existsSync(absolute) || !statSync(absolute).isDirectory())
              throw new HandlerError("INVALID", t("setup.noFolder", { path }));
            return { kind: "project", path: absolute };
          });
    for (const old of locations())
      if (!next.some((l) => sameLocation(l, old))) await uninstallSkillAt(old, env);
    for (const location of next) await installSkillAt(location, env);
    saveSkillLocations(server.paths.skills, next);
    await checkSkillUpdate();
    return agents();
  });

  // --- 바로 설치 (M14) — 정해 둔 명령만, 뒤에서 돌리고 출력을 SSE 로 ---
  const fixes = { ...FIXES, ...deps.fixes } as Record<FixId, Fix>;
  const jobs = new Jobs(
    (event) => server.publish(event),
    () => env,
  );
  const fixOf = (id: string): Fix => {
    if (!isFixId(id, fixes)) throw new HandlerError("INVALID", t("setup.unknownFix", { fix: id }));
    return fixes[id];
  };

  server.addMethod("setup.run", async (p) => jobs.start(fixOf(parse(FixParams, p).fix)));
  server.addMethod("setup.jobs", async () => jobs.list());
  server.addMethod("setup.cancel", async (p) => {
    const job = jobs.cancel(parse(JobParams, p).job);
    if (!job) throw new HandlerError("NOT_FOUND", parse(JobParams, p).job);
    return job;
  });
  /** 창에서 안 될 때(입력이 필요할 때) — 터미널 앱에 같은 명령을 띄운다 */
  server.addMethod("setup.openTerminal", async (p) => {
    const line = fixCommandLine(fixOf(parse(FixParams, p).fix));
    const script = `tell application "Terminal"\nactivate\ndo script "${line.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"\nend tell`;
    const result = await run(["osascript", "-e", script], { timeoutMs: 10_000 });
    if (result.code !== 0) throw new HandlerError("FAILED", result.stderr.trim() || "osascript");
    return { opened: true };
  });

  server.addMethod("setup.finish", async () => {
    writeJson(server.paths.setup, { finishedAt: Date.now(), version: VERSION });
    server.notify();
    return { finished: true };
  });
}
