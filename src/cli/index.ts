import { Command, CommanderError } from "commander";
import { ExitCode } from "../shared/exit-codes.ts";
import { VERSION } from "../shared/version.ts";
import { registerDevices } from "./commands/devices.ts";
import { registerDoctor } from "./commands/doctor.ts";
import { registerGroups } from "./commands/groups.ts";
import { registerLease } from "./commands/lease.ts";
import { registerStatus } from "./commands/status.ts";
import { CliError, makeContext, output, type Run } from "./context.ts";

export async function runCli(argv: string[]): Promise<number> {
  let exitCode: number = ExitCode.ok;

  const program = new Command("corgi")
    .description(
      "시뮬레이터·에뮬레이터 중개·관리 도구 — 용도별 그룹·기본 디바이스·UI 테스트용 슬림 디바이스",
    )
    .version(VERSION, "-v, --version")
    .option("--json", "결과를 JSON 으로 출력 (에이전트용)")
    .option("--session <id>", "세션을 직접 지정 (기본: 명령을 실행한 에이전트 프로세스)")
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
    .description("상주 서버를 띄운다 (보통 launchd 가 실행)")
    .action(async () => {
      const { serve } = await import("../server/index.ts");
      await serve();
      await new Promise(() => {}); // 신호를 받을 때까지 계속 돈다
    });

  program
    .command("install")
    .description(
      "서버를 launchd 에 등록하고(로그인 시 자동 실행), 에이전트 스킬을 설치하고, Corgi.app 을 만든다",
    )
    .option("--no-launchd", "launchd 등록은 건너뛴다")
    .option("--no-skill", "스킬 설치는 건너뛴다")
    .option("--no-app", "Corgi.app 만들기는 건너뛴다")
    .action(
      run(async (ctx, o: { launchd: boolean; skill: boolean; app: boolean }) => {
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
        if (o.app) {
          const { installApp } = await import("./app-bundle.ts");
          const app = await installApp(ctx.paths, ctx.config);
          done.app = app.menubar ? `${app.path} (메뉴바 앱)` : app.path;
          if (app.warning) console.error(app.warning);
        }
        output(ctx, done, () =>
          Object.entries(done)
            .map(([what, path]) => `설치했습니다 (${what}): ${path}`)
            .join("\n"),
        );
      }),
    );

  program
    .command("uninstall")
    .description("launchd 등록과 Corgi.app 을 지운다 — 만든 디바이스·스킬은 지우지 않는다")
    .action(
      run(async (ctx) => {
        const { uninstall } = await import("./launchd.ts");
        await uninstall(ctx.paths);
        await (await import("./app-bundle.ts")).uninstallApp(ctx.paths);
        output(ctx, { uninstalled: ctx.paths.launchAgent }, () => "등록을 지웠습니다");
      }),
    );

  program
    .command("ui")
    .description("웹 UI 를 브라우저로 연다 (서버가 꺼져 있으면 켠다)")
    .option("--print", "열지 않고 주소만 출력")
    .action(
      run(async (ctx, o: { print?: boolean }) => {
        const { openUi } = await import("./ui.ts");
        const url = await openUi(ctx, { open: !o.print });
        output(ctx, { url }, () => (o.print ? url : `열었습니다: ${url.replace(/#.*/, "")}`));
      }),
    );

  registerStatus(program, run);
  registerLease(program, run);
  registerDevices(program, run);
  registerGroups(program, run);
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
