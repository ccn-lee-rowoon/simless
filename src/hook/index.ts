import { ExitCode } from "../shared/exit-codes.ts";

/** 실행 직전 훅을 붙인 에이전트 — 어댑터가 생길 때마다 늘린다 (docs/design.md §13). */
const adapters = {
  claude: ["pre-tool-use"],
} as const satisfies Record<string, readonly string[]>;

type Agent = keyof typeof adapters;

function isAgent(name: string | undefined): name is Agent {
  return name !== undefined && Object.hasOwn(adapters, name);
}

/**
 * 에이전트 훅 진입점 (`corgi hook <에이전트> <이벤트>`).
 * 지금은 입력을 읽고 모두 통과시킨다 — 판정은 5단계에서 붙인다 (P3~P9).
 * 아무것도 출력하지 않고 0 으로 끝나면 에이전트는 평소대로 진행한다.
 */
export async function runHook(
  agent: string | undefined,
  event: string | undefined,
  stdin: Blob,
): Promise<number> {
  if (!isAgent(agent)) {
    console.error(`훅을 지원하지 않는 에이전트: ${agent ?? "(없음)"}`);
    return ExitCode.usage;
  }
  const events: readonly string[] = adapters[agent];
  if (event === undefined || !events.includes(event)) {
    console.error(`${agent} 훅에 없는 이벤트: ${event ?? "(없음)"}`);
    return ExitCode.usage;
  }
  await stdin.text();
  return ExitCode.ok;
}
