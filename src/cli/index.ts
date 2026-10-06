import { Command, CommanderError } from "commander";
import type { OtherAgent } from "../shared/api.ts";
import { loadConfig } from "../shared/config.ts";
import { ExitCode } from "../shared/exit-codes.ts";
import { resolveLanguage, setLanguage, t } from "../shared/i18n.ts";
import { resolvePaths } from "../shared/paths.ts";
import { systemLanguages } from "../shared/system-language.ts";
import { VERSION } from "../shared/version.ts";
import { registerApp } from "./commands/app.ts";
import { registerConfig } from "./commands/config.ts";
import { registerDevices } from "./commands/devices.ts";
import { registerDoctor } from "./commands/doctor.ts";
import { registerGroups } from "./commands/groups.ts";
import { registerLease } from "./commands/lease.ts";
import { registerSkill } from "./commands/skill.ts";
import { registerStatus } from "./commands/status.ts";
import { CliError, confirm, makeContext, output, type Run, request } from "./context.ts";

/** 설정 언어 — 명령 설명(--help)도 이 언어로 나오도록 명령을 만들기 전에 정한다 (R25) */
function applyLanguage(): void {
  try {
    const config = loadConfig(resolvePaths().config);
    setLanguage(resolveLanguage(config.language, systemLanguages()));
  } catch {
    setLanguage(resolveLanguage("system", systemLanguages()));
  }
}

export async function runCli(argv: string[]): Promise<number> {
  let exitCode: number = ExitCode.ok;
  applyLanguage();

  const program = new Command("simless")
    .description(t("cli.description"))
    .version(VERSION, "-v, --version")
    .option("--json", t("cli.opt.json"))
    .option("--session <id>", t("cli.opt.session"))
    // 에이전트가 사용법을 찾아보지 않아도 되게 — JSON·종료 코드·오류 코드·예
    .addHelpText("after", t("cli.helpAgents"))
    .exitOverride();

  // 각 명령의 공통 처리 — 컨텍스트를 만들고, CliError 를 종료 코드로 바꾼다.
  const run: Run =
    (fn) =>
    async (...args: unknown[]) => {
      const globals = program.opts<{ json?: boolean; session?: string }>();
      const ctx = makeContext(globals);
      try {
        await fn(ctx, ...args.slice(0, -1));
      } catch (error) {
        if (!(error instanceof CliError)) throw error;
        exitCode = error.exitCode;
        if (ctx.json) {
          console.log(
            JSON.stringify(
              { error: { code: error.code, message: error.message, data: error.data } },
              null,
              2,
            ),
          );
        } else {
          console.error(error.message);
        }
      }
    };

  program
    .command("serve")
    .description(t("cli.serve"))
    .action(async () => {
      const { serve } = await import("../server/index.ts");
      await serve();
      await new Promise(() => {}); // 신호를 받을 때까지 계속 돈다
    });

  program
    .command("install")
    .description(t("cli.install"))
    .option("--no-launchd", t("cli.install.noLaunchd"))
    .option("--no-skill", t("cli.install.noSkill"))
    .option("--no-app", t("cli.install.noApp"))
    .option("--hook", t("cli.install.hook"))
    .option("--mcp", t("cli.install.mcp"))
    .option("--agents <names>", t("cli.install.agents"), "claude")
    .action(
      run(
        async (
          ctx,
          o: {
            launchd: boolean;
            skill: boolean;
            app: boolean;
            hook?: boolean;
            mcp?: boolean;
            agents: string;
          },
        ) => {
          const done: Record<string, string> = {};
          // 예전 이름(Corgi)으로 설치된 것이 있으면 먼저 옮긴다 — 서버를 새로 올리기 전에
          {
            const { migrateLegacy } = await import("../install/legacy.ts");
            const { selfCommand } = await import("../install/launchd.ts");
            const moved = await migrateLegacy(ctx.paths, selfCommand());
            if (moved.length > 0) done.legacy = moved.join(", ");
          }
          if (o.launchd) {
            const { install } = await import("../install/launchd.ts");
            await install(ctx.paths);
            done.launchd = ctx.paths.launchAgent;
          }
          if (o.skill) {
            const { installSkillAt, loadSkillLocations } = await import("../install/skill.ts");
            const files: string[] = [];
            for (const l of loadSkillLocations(ctx.paths.skills))
              files.push(...(await installSkillAt(l)));
            done.skill = files.join(", ");
          }
          // 보호·MCP 를 붙일 에이전트 — claude,codex,copilot,cursor,gemini (Q16)
          const agents = o.agents
            .split(",")
            .map((a) => a.trim())
            .filter(Boolean);
          const { selfCommand } = await import("../install/launchd.ts");
          const { integrationOf } = await import("../install/agents.ts");
          const others = agents.filter((a) => a !== "claude") as OtherAgent[];
          if (o.hook) {
            if (agents.includes("claude")) {
              const { installHook, installRule } = await import("../install/claude-hook.ts");
              done.hook = installHook(selfCommand());
              done.rule = await installRule();
            }
            for (const a of others) {
              await integrationOf(a).installHook(selfCommand(), process.env);
              await integrationOf(a).installRule(process.env);
              done[`hook:${a}`] = integrationOf(a).label;
            }
          }
          if (o.mcp) {
            if (agents.includes("claude")) {
              const { installMcp } = await import("../install/claude-mcp.ts");
              done.mcp = await installMcp(selfCommand());
            }
            for (const a of others) {
              await integrationOf(a).installMcp(selfCommand(), process.env);
              done[`mcp:${a}`] = integrationOf(a).label;
            }
          }
          if (o.app) {
            const { installApp } = await import("../install/app-bundle.ts");
            const app = await installApp(ctx.paths, ctx.config);
            done.app = app.menubar ? t("cli.install.menubar", { path: app.path }) : app.path;
            if (app.warning) console.error(app.warning);
          }
          output(ctx, done, () =>
            Object.entries(done)
              .map(([what, path]) => t("cli.install.done", { what, path }))
              .join("\n"),
          );
        },
      ),
    );

  program
    .command("uninstall")
    .description(t("cli.uninstall"))
    .option("--purge", t("cli.uninstall.purge"))
    .option("--yes", t("cli.uninstall.yes"))
    .action(
      run(async (ctx, o: { purge?: boolean; yes?: boolean }) => {
        const u = await import("../install/uninstall.ts");
        if (o.purge && !o.yes) {
          const dirs = u.dataDirs(ctx.paths).join("\n  ");
          if (!(await confirm(t("cli.uninstall.confirmPurge", { dirs }))))
            throw new CliError(t("cli.uninstall.needYes"), ExitCode.usage, "INVALID");
        }
        // 서버가 떠 있으면 남게 될 기기 수를 알려 준다 — 기기는 지우지 않는다
        const devicesLeft = await request<{ createdBySimless: boolean }[]>(ctx, "device.list", {})
          .then((list) => list.filter((d) => d.createdBySimless).length)
          .catch(() => undefined);
        const steps = [
          ...(await u.removeIntegrations(ctx.paths)),
          ...(await u.removeApp(ctx.paths)),
          ...(await u.removeLaunchd(ctx.paths)),
          ...(o.purge ? u.purgeData(ctx.paths) : []),
        ];
        const failed = steps.filter((s) => !s.ok);
        output(ctx, { steps, devicesLeft, purged: o.purge ?? false }, () =>
          [
            t("cli.uninstall.done"),
            ...failed.map((s) => t("cli.failedFor", { name: s.what, error: s.error ?? "" })),
            o.purge ? "" : t("cli.uninstall.dataKept", { dirs: u.dataDirs(ctx.paths).join(", ") }),
            devicesLeft ? t("cli.uninstall.devicesLeft", { count: devicesLeft }) : "",
            t("cli.uninstall.cliLeft"),
          ]
            .filter(Boolean)
            .join("\n"),
        );
        if (failed.length > 0)
          throw new CliError(t("cli.uninstall.someFailed"), ExitCode.failed, "FAILED", steps);
      }),
    );

  program
    .command("ui")
    .description(t("cli.ui"))
    .option("--print", t("cli.ui.print"))
    .action(
      run(async (ctx, o: { print?: boolean }) => {
        const { openUi } = await import("./ui.ts");
        const url = await openUi(ctx, { open: !o.print });
        output(ctx, { url }, () =>
          o.print ? url : t("cli.ui.opened", { url: url.replace(/#.*/, "") }),
        );
      }),
    );

  registerStatus(program, run);
  registerLease(program, run);
  registerDevices(program, run);
  registerGroups(program, run);
  registerConfig(program, run);
  registerDoctor(program, run);
  registerSkill(program, run);
  registerApp(program, run);

  try {
    await program.parseAsync(argv, { from: "user" });
    return exitCode;
  } catch (error) {
    if (error instanceof CommanderError) {
      // --help·--version 은 exitCode 0 으로, 사용법 오류는 그 밖의 값으로 던져진다.
      return error.exitCode === 0 ? ExitCode.ok : ExitCode.usage;
    }
    throw error;
  }
}
