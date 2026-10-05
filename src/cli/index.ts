import { Command, CommanderError } from "commander";
import { loadConfig } from "../shared/config.ts";
import { ExitCode } from "../shared/exit-codes.ts";
import { resolveLanguage, setLanguage, t } from "../shared/i18n.ts";
import { resolvePaths } from "../shared/paths.ts";
import { systemLanguages } from "../shared/system-language.ts";
import { VERSION } from "../shared/version.ts";
import { registerConfig } from "./commands/config.ts";
import { registerDevices } from "./commands/devices.ts";
import { registerDoctor } from "./commands/doctor.ts";
import { registerGroups } from "./commands/groups.ts";
import { registerLease } from "./commands/lease.ts";
import { registerStatus } from "./commands/status.ts";
import { CliError, makeContext, output, type Run } from "./context.ts";

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

  const program = new Command("corgi")
    .description(t("cli.description"))
    .version(VERSION, "-v, --version")
    .option("--json", t("cli.opt.json"))
    .option("--session <id>", t("cli.opt.session"))
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
    .option("--no-hook", t("cli.install.noHook"))
    .action(
      run(async (ctx, o: { launchd: boolean; skill: boolean; app: boolean; hook: boolean }) => {
        const done: Record<string, string> = {};
        if (o.launchd) {
          const { install } = await import("./launchd.ts");
          await install(ctx.paths);
          done.launchd = ctx.paths.launchAgent;
        }
        if (o.skill) {
          const { installSkill } = await import("./skill.ts");
          done.skill = await installSkill();
        }
        if (o.hook) {
          const { installHook, installRule } = await import("./claude-hook.ts");
          const { selfCommand } = await import("./launchd.ts");
          done.hook = installHook(selfCommand());
          done.rule = await installRule();
        }
        if (o.app) {
          const { installApp } = await import("./app-bundle.ts");
          const app = await installApp(ctx.paths, ctx.config);
          done.app = app.menubar ? t("cli.install.menubar", { path: app.path }) : app.path;
          if (app.warning) console.error(app.warning);
        }
        output(ctx, done, () =>
          Object.entries(done)
            .map(([what, path]) => t("cli.install.done", { what, path }))
            .join("\n"),
        );
      }),
    );

  program
    .command("uninstall")
    .description(t("cli.uninstall"))
    .action(
      run(async (ctx) => {
        const { uninstall } = await import("./launchd.ts");
        await uninstall(ctx.paths);
        await (await import("./app-bundle.ts")).uninstallApp(ctx.paths);
        const { uninstallHook, uninstallRule } = await import("./claude-hook.ts");
        uninstallHook();
        uninstallRule();
        output(ctx, { uninstalled: ctx.paths.launchAgent }, () => t("cli.uninstall.done"));
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
