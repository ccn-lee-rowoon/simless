import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { InstallState, OtherAgent } from "../shared/api.ts";
import { run, which } from "../shared/exec.ts";
import { bundledRule, hookCommandFor } from "./claude-hook.ts";

// Claude Code 말고 다른 에이전트 연결 (Q16, docs/agent-integrations.md) — 보호(훅 + 규칙)와 MCP.
// 스킬은 ~/.agents/skills 하나로 같이 읽으므로 skill.ts 가 넣는다.
// 원칙: Corgi 가 넣은 것만 넣고 뺀다. 남의 설정은 그대로, 고치기 전에 .corgi-backup 을 남긴다.
// 설정 파일을 읽지 못하면(주석이 든 JSON 등) 덮어쓰지 않고 오류를 낸다.

export class AgentConfigError extends Error {}

type Json = Record<string, unknown>;

function home(env: NodeJS.ProcessEnv): string {
  return env.HOME ?? homedir();
}

function readJson(path: string): Json {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Json;
  } catch {
    throw new AgentConfigError(path);
  }
}

function writeJson(path: string, data: Json): void {
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path)) copyFileSync(path, `${path}.corgi-backup`);
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
}

/** 이벤트 배열에서 Corgi 항목만 빼고, 넣을 게 있으면 넣는다. 빈 배열·빈 hooks 는 남기지 않는다 */
function setHookEntries(
  config: Json,
  event: string,
  isCorgi: (entry: Json) => boolean,
  add?: Json,
): Json {
  const hooks = { ...((config.hooks as Json | undefined) ?? {}) };
  const entries = ((hooks[event] as Json[] | undefined) ?? []).filter((e) => !isCorgi(e));
  if (add) entries.push(add);
  if (entries.length > 0) hooks[event] = entries;
  else delete hooks[event];
  const { hooks: _old, ...rest } = config;
  return Object.keys(hooks).length > 0 ? { ...rest, hooks } : rest;
}

/** Claude 식 중첩 항목 {matcher, hooks: [{command}]} 안에 Corgi 명령이 있는지 */
const nestedHas = (mark: string) => (entry: Json) =>
  ((entry.hooks as Json[] | undefined) ?? []).some(
    (h) => typeof h.command === "string" && h.command.endsWith(mark),
  );
/** 평평한 항목 {command} 가 Corgi 명령인지 (Cursor) */
const flatIs = (mark: string) => (entry: Json) =>
  typeof entry.command === "string" && entry.command.endsWith(mark);

function nestedState(config: Json, event: string, command: string, mark: string): InstallState {
  const entry = ((config.hooks as Json | undefined)?.[event] as Json[] | undefined)?.find(
    nestedHas(mark),
  );
  if (!entry) return "missing";
  const hook = ((entry.hooks as Json[]) ?? []).find(
    (h) => typeof h.command === "string" && h.command.endsWith(mark),
  );
  return hook?.command === command ? "current" : "outdated";
}

// --- 규칙 — 전역 지시 파일에 Corgi 블록 하나 ---

const BLOCK_START = "<!-- corgi:start — Corgi 가 넣고 지운다 -->";
const BLOCK_END = "<!-- corgi:end -->";

function withoutBlock(text: string): string {
  const start = text.indexOf(BLOCK_START);
  const end = text.indexOf(BLOCK_END);
  if (start < 0 || end < start) return text;
  return (text.slice(0, start) + text.slice(end + BLOCK_END.length)).replace(/\n{3,}/g, "\n\n");
}

async function blockState(path: string): Promise<InstallState> {
  if (!existsSync(path)) return "missing";
  const text = readFileSync(path, "utf8");
  const start = text.indexOf(BLOCK_START);
  if (start < 0) return "missing";
  return text.includes(`${BLOCK_START}\n${await bundledRule()}${BLOCK_END}`)
    ? "current"
    : "outdated";
}

async function writeBlock(path: string): Promise<void> {
  const before = existsSync(path) ? readFileSync(path, "utf8") : "";
  const rest = withoutBlock(before).trimEnd();
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path)) copyFileSync(path, `${path}.corgi-backup`);
  const block = `${BLOCK_START}\n${await bundledRule()}${BLOCK_END}\n`;
  writeFileSync(path, rest ? `${rest}\n\n${block}` : block);
}

function removeBlock(path: string): void {
  if (!existsSync(path)) return;
  const before = readFileSync(path, "utf8");
  const after = withoutBlock(before);
  if (after !== before) writeFileSync(path, after.trimEnd() ? `${after.trimEnd()}\n` : "");
}

// --- 에이전트마다 ---

export interface AgentIntegration {
  agent: OtherAgent;
  label: string;
  /** 설치돼 있는지 — 실행 파일 */
  binary: string;
  hookState(command: string[], env: NodeJS.ProcessEnv): Promise<InstallState>;
  installHook(command: string[], env: NodeJS.ProcessEnv): Promise<void>;
  uninstallHook(env: NodeJS.ProcessEnv): Promise<void>;
  ruleState(env: NodeJS.ProcessEnv): Promise<InstallState>;
  installRule(env: NodeJS.ProcessEnv): Promise<void>;
  uninstallRule(env: NodeJS.ProcessEnv): Promise<void>;
  mcpState(command: string[], env: NodeJS.ProcessEnv): Promise<InstallState>;
  installMcp(command: string[], env: NodeJS.ProcessEnv): Promise<void>;
  uninstallMcp(env: NodeJS.ProcessEnv): Promise<void>;
}

/** {mcpServers: {corgi: {command, args}}} 모양의 JSON 설정 — Copilot·Cursor·Gemini */
function jsonMcp(file: (env: NodeJS.ProcessEnv) => string, extra: Json = {}) {
  return {
    async mcpState(command: string[], env: NodeJS.ProcessEnv): Promise<InstallState> {
      const entry = (readJson(file(env)).mcpServers as Json | undefined)?.corgi as Json | undefined;
      if (!entry) return "missing";
      const [bin, ...rest] = command;
      return entry.command === bin &&
        JSON.stringify(entry.args) === JSON.stringify([...rest, "mcp"])
        ? "current"
        : "outdated";
    },
    async installMcp(command: string[], env: NodeJS.ProcessEnv): Promise<void> {
      const path = file(env);
      const config = readJson(path);
      const [bin, ...rest] = command;
      const servers = { ...((config.mcpServers as Json | undefined) ?? {}) };
      servers.corgi = { ...extra, command: bin, args: [...rest, "mcp"] };
      writeJson(path, { ...config, mcpServers: servers });
    },
    async uninstallMcp(env: NodeJS.ProcessEnv): Promise<void> {
      const path = file(env);
      const config = readJson(path);
      const servers = { ...((config.mcpServers as Json | undefined) ?? {}) };
      if (!("corgi" in servers)) return;
      delete servers.corgi;
      writeJson(path, { ...config, mcpServers: servers });
    },
  };
}

const COPILOT_MARK = " hook copilot pre-tool-use";
const CODEX_MARK = " hook codex pre-tool-use";
const CURSOR_SHELL = " hook cursor before-shell";
const CURSOR_MCP = " hook cursor before-mcp";
const GEMINI_MARK = " hook gemini before-tool";

const copilot: AgentIntegration = {
  agent: "copilot",
  label: "Copilot CLI",
  binary: "copilot",
  // 훅은 Corgi 파일 하나 — Claude 식(PascalCase)으로 걸면 입력도 Claude 식(tool_name·tool_input)으로 온다
  async hookState(command, env) {
    const path = join(home(env), ".copilot", "hooks", "corgi.json");
    if (!existsSync(path)) return "missing";
    return nestedState(
      readJson(path),
      "PreToolUse",
      hookCommandFor(command, "copilot", "pre-tool-use"),
      COPILOT_MARK,
    );
  },
  async installHook(command, env) {
    writeJson(join(home(env), ".copilot", "hooks", "corgi.json"), {
      hooks: {
        PreToolUse: [
          {
            matcher: "Bash|argent-.*",
            hooks: [
              {
                type: "command",
                command: hookCommandFor(command, "copilot", "pre-tool-use"),
                timeout: 10,
              },
            ],
          },
        ],
      },
    });
  },
  async uninstallHook(env) {
    rmSync(join(home(env), ".copilot", "hooks", "corgi.json"), { force: true });
  },
  ruleState: async (env) => blockState(join(home(env), ".copilot", "copilot-instructions.md")),
  installRule: async (env) => writeBlock(join(home(env), ".copilot", "copilot-instructions.md")),
  uninstallRule: async (env) => removeBlock(join(home(env), ".copilot", "copilot-instructions.md")),
  ...jsonMcp((env) => join(home(env), ".copilot", "mcp-config.json"), { type: "stdio" }),
};

const codexHooks = (env: NodeJS.ProcessEnv) => join(home(env), ".codex", "hooks.json");
const codexConfig = (env: NodeJS.ProcessEnv) => join(home(env), ".codex", "config.toml");

const codex: AgentIntegration = {
  agent: "codex",
  label: "Codex",
  binary: "codex",
  async hookState(command, env) {
    return nestedState(
      readJson(codexHooks(env)),
      "PreToolUse",
      hookCommandFor(command, "codex", "pre-tool-use"),
      CODEX_MARK,
    );
  },
  // Codex 는 새 훅을 사용자가 /hooks 에서 한 번 확인해야 돌린다 — 설정 창이 안내한다
  async installHook(command, env) {
    const path = codexHooks(env);
    writeJson(
      path,
      setHookEntries(readJson(path), "PreToolUse", nestedHas(CODEX_MARK), {
        matcher: "^Bash$|^mcp__argent__.*",
        hooks: [
          {
            type: "command",
            command: hookCommandFor(command, "codex", "pre-tool-use"),
            timeout: 30,
          },
        ],
      }),
    );
  },
  async uninstallHook(env) {
    const path = codexHooks(env);
    if (!existsSync(path)) return;
    const config = readJson(path);
    const next = setHookEntries(config, "PreToolUse", nestedHas(CODEX_MARK));
    if (JSON.stringify(next) !== JSON.stringify(config)) writeJson(path, next);
  },
  ruleState: async (env) => blockState(join(home(env), ".codex", "AGENTS.md")),
  installRule: async (env) => writeBlock(join(home(env), ".codex", "AGENTS.md")),
  uninstallRule: async (env) => removeBlock(join(home(env), ".codex", "AGENTS.md")),
  // config.toml 은 TOML 이라 직접 고치지 않고 codex mcp 명령에 맡긴다. 읽기만 한다
  async mcpState(command, env) {
    const path = codexConfig(env);
    if (!existsSync(path)) return "missing";
    const text = readFileSync(path, "utf8");
    const section = /\[mcp_servers\.corgi\]([\s\S]*?)(?=\n\[|$)/.exec(text)?.[1];
    if (section === undefined) return "missing";
    const [bin] = command;
    return section.includes(`command = "${bin}"`) ? "current" : "outdated";
  },
  async installMcp(command, env) {
    const bin = which("codex", env);
    if (!bin) throw new AgentConfigError("codex");
    await run([bin, "mcp", "remove", "corgi"], { env, cwd: home(env), timeoutMs: 30_000 });
    const result = await run([bin, "mcp", "add", "corgi", "--", ...command, "mcp"], {
      env,
      cwd: home(env),
      timeoutMs: 30_000,
    });
    if (result.code !== 0) throw new AgentConfigError((result.stderr || result.stdout).trim());
  },
  async uninstallMcp(env) {
    const bin = which("codex", env);
    if (bin) await run([bin, "mcp", "remove", "corgi"], { env, cwd: home(env), timeoutMs: 30_000 });
  },
};

const cursorHooks = (env: NodeJS.ProcessEnv) => join(home(env), ".cursor", "hooks.json");

const cursor: AgentIntegration = {
  agent: "cursor",
  label: "Cursor",
  binary: "cursor-agent",
  async hookState(command, env) {
    const config = readJson(cursorHooks(env));
    const states = (
      [
        ["beforeShellExecution", CURSOR_SHELL, "before-shell"],
        ["beforeMCPExecution", CURSOR_MCP, "before-mcp"],
      ] as const
    ).map(([event, mark, name]) => {
      const entry = ((config.hooks as Json | undefined)?.[event] as Json[] | undefined)?.find(
        flatIs(mark),
      );
      if (!entry) return "missing";
      return entry.command === hookCommandFor(command, "cursor", name) ? "current" : "outdated";
    });
    if (states.every((s) => s === "missing")) return "missing";
    return states.every((s) => s === "current") ? "current" : "outdated";
  },
  // 셸 명령과 MCP 호출을 따로 건다 — MCP 는 서버 이름(argent)을 입력에서 본다
  async installHook(command, env) {
    const path = cursorHooks(env);
    let config = readJson(path);
    config = setHookEntries(config, "beforeShellExecution", flatIs(CURSOR_SHELL), {
      command: hookCommandFor(command, "cursor", "before-shell"),
      timeout: 10,
    });
    config = setHookEntries(config, "beforeMCPExecution", flatIs(CURSOR_MCP), {
      command: hookCommandFor(command, "cursor", "before-mcp"),
      timeout: 10,
    });
    writeJson(path, { version: 1, ...config });
  },
  async uninstallHook(env) {
    const path = cursorHooks(env);
    if (!existsSync(path)) return;
    const config = readJson(path);
    let next = setHookEntries(config, "beforeShellExecution", flatIs(CURSOR_SHELL));
    next = setHookEntries(next, "beforeMCPExecution", flatIs(CURSOR_MCP));
    if (JSON.stringify(next) !== JSON.stringify(config)) writeJson(path, next);
  },
  // 파일 규칙은 .mdc 만 읽는다 — 늘 적용
  async ruleState(env) {
    const path = join(home(env), ".cursor", "rules", "corgi.mdc");
    if (!existsSync(path)) return "missing";
    return readFileSync(path, "utf8") === (await cursorRule()) ? "current" : "outdated";
  },
  async installRule(env) {
    const path = join(home(env), ".cursor", "rules", "corgi.mdc");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, await cursorRule());
  },
  async uninstallRule(env) {
    rmSync(join(home(env), ".cursor", "rules", "corgi.mdc"), { force: true });
  },
  ...jsonMcp((env) => join(home(env), ".cursor", "mcp.json")),
};

async function cursorRule(): Promise<string> {
  return `---\ndescription: Corgi — shared simulators and emulators\nalwaysApply: true\n---\n\n${await bundledRule()}`;
}

const geminiSettings = (env: NodeJS.ProcessEnv) => join(home(env), ".gemini", "settings.json");

const gemini: AgentIntegration = {
  agent: "gemini",
  label: "Gemini CLI",
  binary: "gemini",
  async hookState(command, env) {
    return nestedState(
      readJson(geminiSettings(env)),
      "BeforeTool",
      hookCommandFor(command, "gemini", "before-tool"),
      GEMINI_MARK,
    );
  },
  // 훅은 작업 폴더를 신뢰해야(/trust) 돈다 — 설정 창이 안내한다
  async installHook(command, env) {
    const path = geminiSettings(env);
    writeJson(
      path,
      setHookEntries(readJson(path), "BeforeTool", nestedHas(GEMINI_MARK), {
        matcher: "^run_shell_command$|^mcp_argent_",
        hooks: [
          {
            type: "command",
            name: "corgi",
            command: hookCommandFor(command, "gemini", "before-tool"),
            timeout: 10_000,
          },
        ],
      }),
    );
  },
  async uninstallHook(env) {
    const path = geminiSettings(env);
    if (!existsSync(path)) return;
    const config = readJson(path);
    const next = setHookEntries(config, "BeforeTool", nestedHas(GEMINI_MARK));
    if (JSON.stringify(next) !== JSON.stringify(config)) writeJson(path, next);
  },
  ruleState: async (env) => blockState(join(home(env), ".gemini", "GEMINI.md")),
  installRule: async (env) => writeBlock(join(home(env), ".gemini", "GEMINI.md")),
  uninstallRule: async (env) => removeBlock(join(home(env), ".gemini", "GEMINI.md")),
  // gemini mcp 명령은 로그인 창을 열려고 할 수 있어 settings.json 을 직접 고친다
  ...jsonMcp(geminiSettings),
};

export const AGENT_INTEGRATIONS: AgentIntegration[] = [copilot, codex, cursor, gemini];

export function integrationOf(agent: OtherAgent): AgentIntegration {
  const found = AGENT_INTEGRATIONS.find((a) => a.agent === agent);
  if (!found) throw new AgentConfigError(agent);
  return found;
}

export function isAgentInstalled(integration: AgentIntegration, env: NodeJS.ProcessEnv): boolean {
  return which(integration.binary, env) !== undefined;
}
