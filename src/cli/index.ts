import { Command, CommanderError } from "commander";
import { ExitCode } from "../shared/exit-codes.ts";
import { VERSION } from "../shared/version.ts";

export async function runCli(argv: string[]): Promise<number> {
  const program = new Command("corgi")
    .description("크기별 디바이스 레이아웃 확인 도구")
    .version(VERSION, "-v, --version")
    .exitOverride();

  // 명령은 1단계부터 붙인다 (docs/design.md §12).

  try {
    await program.parseAsync(argv, { from: "user" });
    return ExitCode.ok;
  } catch (error) {
    if (error instanceof CommanderError) {
      // --help·--version 은 exitCode 0 으로, 사용법 오류는 그 밖의 값으로 던져진다.
      return error.exitCode === 0 ? ExitCode.ok : ExitCode.usage;
    }
    throw error;
  }
}
