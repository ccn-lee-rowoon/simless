import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import {
  hookStatus,
  installHook,
  installRule,
  ruleStatus,
  uninstallHook,
  uninstallRule,
} from "../cli/claude-hook.ts";
import {
  claudeBinary,
  installMcp,
  McpInstallError,
  mcpStatus,
  uninstallMcp,
} from "../cli/claude-mcp.ts";
import { runChecks } from "../cli/commands/doctor.ts";
import { selfCommand } from "../cli/launchd.ts";
import {
  combineStates,
  installSkillAt,
  loadSkillLocations,
  locationStatus,
  sameLocation,
  saveSkillLocations,
  uninstallSkillAt,
} from "../cli/skill.ts";
import type { SetupAgents, SetupStatus, SkillLocation } from "../shared/api.ts";
import { t } from "../shared/i18n.ts";
import type { Paths } from "../shared/paths.ts";
import { VERSION } from "../shared/version.ts";
import type { CorgiServer } from "./app.ts";
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

const ApplyParams = z.object({
  item: z.enum(["skill", "mcp", "protection"]),
  enabled: z.boolean(),
});

/** 설정을 한 번도 안 끝냈으면 true — 앱이 처음 뜰 때 설정 창을 연다 */
export function setupNeeded(paths: Paths): boolean {
  return !existsSync(paths.setup);
}

function parse<T extends z.ZodType>(schema: T, params: unknown): z.infer<T> {
  const parsed = schema.safeParse(params ?? {});
  if (!parsed.success) throw new HandlerError("INVALID", z.prettifyError(parsed.error));
  return parsed.data;
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
    const { item, enabled } = parse(ApplyParams, p);
    try {
      if (item === "skill") {
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

  server.addMethod("setup.finish", async () => {
    writeJson(server.paths.setup, { finishedAt: Date.now(), version: VERSION });
    server.notify();
    return { finished: true };
  });
}
