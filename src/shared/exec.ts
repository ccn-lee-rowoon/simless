import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  timeoutMs?: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export type Runner = (command: string[], options?: RunOptions) => Promise<RunResult>;

/** 외부 명령 실행. 시간이 지나면 끝내고 code 124 를 돌려준다. */
export const run: Runner = async (command, options = {}) => {
  const proc = Bun.spawn(command, {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    cwd: options.cwd,
    env: options.env,
  });
  const timer = options.timeoutMs ? setTimeout(() => proc.kill(), options.timeoutMs) : undefined;
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timer);
  return { code: proc.signalCode ? 124 : code, stdout, stderr };
};

/** 실패하면 stderr 를 담아 던진다 */
export async function runOk(
  runner: Runner,
  command: string[],
  options?: RunOptions,
): Promise<string> {
  const result = await runner(command, options);
  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout).trim().split("\n").slice(-5).join("\n");
    throw new Error(`${command.join(" ")} 실패 (code ${result.code})\n${detail}`);
  }
  return result.stdout;
}

/**
 * 명령 위치를 찾는다. launchd 로 뜬 서버는 로그인 셸 PATH 를 못 받으므로
 * Homebrew·mise 등 흔한 위치도 함께 본다 (docs/design.md §4).
 */
export function which(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const home = env.HOME ?? homedir();
  const dirs = [
    ...(env.PATH ?? "").split(":"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    join(home, ".local", "bin"),
    join(home, ".bun", "bin"),
    "/usr/bin",
  ];
  for (const dir of dirs) {
    if (dir && existsSync(join(dir, name))) return join(dir, name);
  }
  return undefined;
}
