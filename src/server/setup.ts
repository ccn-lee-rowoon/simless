import { existsSync } from "node:fs";
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
import { installSkill, skillStatus, uninstallSkill } from "../cli/skill.ts";
import type { SetupAgents, SetupStatus } from "../shared/api.ts";
import { t } from "../shared/i18n.ts";
import type { Paths } from "../shared/paths.ts";
import { VERSION } from "../shared/version.ts";
import type { CorgiServer } from "./app.ts";
import { HandlerError } from "./socket.ts";
import { readJson, writeJson } from "./store.ts";

// 첫 실행 설정 (M14) — 앱을 처음 열면 뜨는 창이 부른다. 터미널 없이 점검·에이전트 연결·기본 디바이스까지.
// 설치 자체는 CLI(`corgi install`)와 같은 함수를 쓴다. 서버가 하므로 창은 버튼만 누르면 된다.

const SetupFile = z.object({ finishedAt: z.number(), version: z.string() });

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

  const agents = async (): Promise<SetupAgents> => ({
    claude: claudeBinary(env) !== undefined,
    skill: await skillStatus(env),
    mcp: mcpStatus(command(), env),
    hook: hookStatus(command(), env),
    rule: await ruleStatus(env),
  });

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
        if (enabled) await installSkill(env);
        else uninstallSkill(env);
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
    } catch (error) {
      if (error instanceof McpInstallError) {
        if (error.message === "claude") throw new HandlerError("TOOL_MISSING", t("setup.noClaude"));
        throw new HandlerError("FAILED", t("setup.mcpFailed", { error: error.message }));
      }
      throw error;
    }
    return agents();
  });

  server.addMethod("setup.finish", async () => {
    writeJson(server.paths.setup, { finishedAt: Date.now(), version: VERSION });
    server.notify();
    return { finished: true };
  });
}
