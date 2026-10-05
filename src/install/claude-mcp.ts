import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { run, which } from "../shared/exec.ts";

// Claude Code 에 `simless mcp` 를 사용자 범위로 등록한다 (R12, 6단계).
// ~/.claude.json 은 Claude Code 가 수시로 고쳐 쓰는 파일이라 직접 쓰지 않고 `claude mcp` 명령에 맡긴다.
// 읽기(등록 여부)만 파일에서 한다 — `claude mcp get` 은 서버에 연결까지 해 봐서 느리다.

export const MCP_NAME = "simless";

function home(env: NodeJS.ProcessEnv): string {
  return env.HOME ?? homedir();
}

export function claudeJsonPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(home(env), ".claude.json");
}

/** claude 명령 — PATH 에 없으면(launchd 서버) 설치 스크립트가 두는 곳도 본다 */
export function claudeBinary(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const local = join(home(env), ".claude", "local", "claude");
  return which("claude", env) ?? (existsSync(local) ? local : undefined);
}

interface McpEntry {
  type?: string;
  command?: string;
  args?: string[];
}

/** missing = 없음, outdated = 명령이 다름(옮겼거나 개발·배포가 바뀜), current = 같음 */
export function mcpStatus(
  command: string[],
  env: NodeJS.ProcessEnv = process.env,
): "missing" | "outdated" | "current" {
  const path = claudeJsonPath(env);
  if (!existsSync(path)) return "missing";
  let entry: McpEntry | undefined;
  try {
    const json = JSON.parse(readFileSync(path, "utf8")) as {
      mcpServers?: Record<string, McpEntry>;
    };
    entry = json.mcpServers?.[MCP_NAME];
  } catch {
    return "missing";
  }
  if (!entry) return "missing";
  const [bin, ...rest] = command;
  const same =
    entry.command === bin && JSON.stringify(entry.args ?? []) === JSON.stringify([...rest, "mcp"]);
  return same ? "current" : "outdated";
}

/** `claude mcp add` 인자 — 이미 있으면 지우고 다시 넣는다 */
export function mcpAddArgs(command: string[]): string[] {
  return ["mcp", "add", "--scope", "user", MCP_NAME, "--", ...command, "mcp"];
}

export class McpInstallError extends Error {}

export async function installMcp(
  command: string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const claude = claudeBinary(env);
  if (!claude) throw new McpInstallError("claude");
  const options = { cwd: home(env), env, timeoutMs: 30_000 };
  await run([claude, "mcp", "remove", "--scope", "user", MCP_NAME], options);
  const result = await run([claude, ...mcpAddArgs(command)], options);
  if (result.code !== 0) throw new McpInstallError((result.stderr || result.stdout).trim());
  return claudeJsonPath(env);
}

export async function uninstallMcp(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const claude = claudeBinary(env);
  if (!claude || mcpStatus([], env) === "missing") return;
  await run([claude, "mcp", "remove", "--scope", "user", MCP_NAME], {
    cwd: home(env),
    env,
    timeoutMs: 30_000,
  });
}
