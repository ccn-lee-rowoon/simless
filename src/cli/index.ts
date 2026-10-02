import { Command, CommanderError } from "commander";
import { ExitCode } from "../shared/exit-codes.ts";
import { VERSION } from "../shared/version.ts";
import { registerDevices } from "./commands/devices.ts";
import { registerLease } from "./commands/lease.ts";
import { registerStatus } from "./commands/status.ts";
import { CliError, makeContext, output, type Run } from "./context.ts";

export async function runCli(argv: string[]): Promise<number> {
  let exitCode: number = ExitCode.ok;

  const program = new Command("corgi")
    .description("크기별 디바이스 레이아웃 확인 도구")
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
    .description("서버를 launchd 에 등록한다 — 로그인 시 켜지고 죽으면 다시 살아난다")
    .action(
      run(async (ctx) => {
        const { install } = await import("./launchd.ts");
        await install(ctx.paths);
        output(
          ctx,
          { installed: ctx.paths.launchAgent },
          () => `등록했습니다: ${ctx.paths.launchAgent}`,
        );
      }),
    );

  program
    .command("uninstall")
    .description("launchd 등록을 지운다 — 만든 디바이스는 지우지 않는다")
    .action(
      run(async (ctx) => {
        const { uninstall } = await import("./launchd.ts");
        await uninstall(ctx.paths);
        output(ctx, { uninstalled: ctx.paths.launchAgent }, () => "등록을 지웠습니다");
      }),
    );

  registerStatus(program, run);
  registerLease(program, run);
  registerDevices(program, run);

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
