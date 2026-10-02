// 서브커맨드마다 필요한 모듈만 불러온다.
// 훅은 Bash 호출마다 실행되므로 CLI 파서(commander)조차 불러오지 않고 바로 끝낸다.

export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;

  if (command === "hook") {
    const { runHook } = await import("./hook/index.ts");
    return runHook(rest[0], rest[1], Bun.stdin);
  }

  const { runCli } = await import("./cli/index.ts");
  return runCli(argv);
}
