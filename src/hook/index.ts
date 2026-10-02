import { ExitCode } from "../shared/exit-codes.ts";

/**
 * Claude Code 훅 진입점 (`corgi hook <이벤트>`).
 * 지금은 입력을 읽고 모두 통과시킨다 — 판정은 3단계에서 붙인다 (P3~P9).
 * 아무것도 출력하지 않고 0 으로 끝나면 Claude Code 는 평소대로 진행한다.
 */
export async function runHook(event: string | undefined, stdin: Blob): Promise<number> {
  if (event !== "pre-tool-use") {
    console.error(`알 수 없는 훅 이벤트: ${event ?? "(없음)"}`);
    return ExitCode.usage;
  }
  await stdin.text();
  return ExitCode.ok;
}
