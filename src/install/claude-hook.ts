import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import rulePath from "../../integrations/rules/simless.md" with { type: "file" };
import { HOOK_MATCHERS } from "../shared/hook-scope.ts";

// Claude Code 연동 — 실행 직전 훅(P3)과 전역 규칙(P2). simless install 이 설치한다 (docs/design.md §13).
// 훅은 ~/.claude/settings.json 의 hooks.PreToolUse 에 한 줄을 넣는다. 다른 설정은 건드리지 않는다.

/** 훅 명령의 표시 — 이 글자가 든 항목을 simless 훅으로 본다 */
const HOOK_MARK = " hook claude pre-tool-use";
/** 셸과 모든 MCP 도구 (P10) */
export const HOOK_MATCHER = HOOK_MATCHERS.claude;

function home(env: NodeJS.ProcessEnv): string {
  return env.HOME ?? homedir();
}

export function settingsPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(home(env), ".claude", "settings.json");
}

export function ruleTarget(env: NodeJS.ProcessEnv = process.env): string {
  return join(home(env), ".claude", "rules", "simless.md");
}

function shellQuote(text: string): string {
  return /^[\w./-]+$/.test(text) ? text : `'${text.replace(/'/g, "'\\''")}'`;
}

export function hookCommand(command: string[]): string {
  return `${command.map(shellQuote).join(" ")}${HOOK_MARK}`;
}

/** 다른 에이전트의 훅 명령 — `<simless> hook <에이전트> <이벤트>` (install/agents.ts) */
export function hookCommandFor(command: string[], agent: string, event: string): string {
  return `${command.map(shellQuote).join(" ")} hook ${agent} ${event}`;
}

interface HookEntry {
  type?: string;
  command?: string;
}
interface MatcherEntry {
  matcher?: string;
  hooks?: HookEntry[];
}
type Settings = { hooks?: { PreToolUse?: MatcherEntry[] } & Record<string, unknown> } & Record<
  string,
  unknown
>;

function readSettings(path: string): Settings {
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, "utf8")) as Settings;
}

function isSimless(hook: HookEntry): boolean {
  return typeof hook.command === "string" && hook.command.endsWith(HOOK_MARK);
}

/** missing = 없음, outdated = 명령·matcher 가 다름(옮겼거나 개발·배포가 바뀜, 보는 범위가 바뀜), current = 같음 */
export function hookStatus(
  command: string[],
  env: NodeJS.ProcessEnv = process.env,
): "missing" | "outdated" | "current" {
  const settings = readSettings(settingsPath(env));
  const entry = (settings.hooks?.PreToolUse ?? []).find((m) => (m.hooks ?? []).some(isSimless));
  const found = entry?.hooks?.find(isSimless);
  if (!entry || !found) return "missing";
  return found.command === hookCommand(command) && entry.matcher === HOOK_MATCHER
    ? "current"
    : "outdated";
}

/** 훅을 넣는다 — 예전 simless 훅은 바꾸고, 쓰기 전에 settings.json 을 .simless-backup 으로 남긴다 */
export function installHook(command: string[], env: NodeJS.ProcessEnv = process.env): string {
  const path = settingsPath(env);
  const settings = readSettings(path);
  const hooks = { ...(settings.hooks ?? {}) };
  const entries = (hooks.PreToolUse ?? [])
    .map((m) => ({ ...m, hooks: (m.hooks ?? []).filter((h) => !isSimless(h)) }))
    .filter((m) => m.hooks.length > 0);
  entries.push({
    matcher: HOOK_MATCHER,
    hooks: [{ type: "command", command: hookCommand(command) }],
  });
  hooks.PreToolUse = entries;
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path)) copyFileSync(path, `${path}.simless-backup`);
  writeFileSync(path, `${JSON.stringify({ ...settings, hooks }, null, 2)}\n`);
  return path;
}

export function uninstallHook(env: NodeJS.ProcessEnv = process.env): void {
  const path = settingsPath(env);
  if (!existsSync(path)) return;
  const settings = readSettings(path);
  const before = settings.hooks?.PreToolUse;
  if (!before?.some((m) => (m.hooks ?? []).some(isSimless))) return;
  const entries = before
    .map((m) => ({ ...m, hooks: (m.hooks ?? []).filter((h) => !isSimless(h)) }))
    .filter((m) => m.hooks.length > 0);
  const { PreToolUse: _old, ...rest } = settings.hooks ?? {};
  const hooks = entries.length > 0 ? { ...rest, PreToolUse: entries } : rest;
  // 훅이 하나도 안 남으면 빈 "hooks": {} 도 남기지 않는다
  const { hooks: _hooks, ...others } = settings;
  const next = Object.keys(hooks).length > 0 ? { ...others, hooks } : others;
  copyFileSync(path, `${path}.simless-backup`);
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`);
}

export async function bundledRule(): Promise<string> {
  return Bun.file(rulePath).text();
}

export async function ruleStatus(
  env: NodeJS.ProcessEnv = process.env,
): Promise<"missing" | "outdated" | "current"> {
  const target = ruleTarget(env);
  if (!existsSync(target)) return "missing";
  return readFileSync(target, "utf8") === (await bundledRule()) ? "current" : "outdated";
}

export async function installRule(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const target = ruleTarget(env);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, await bundledRule());
  return target;
}

export function uninstallRule(env: NodeJS.ProcessEnv = process.env): void {
  rmSync(ruleTarget(env), { force: true });
}
