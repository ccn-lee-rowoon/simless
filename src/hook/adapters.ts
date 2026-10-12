// 에이전트마다 다른 훅 입력·출력을 하나의 모양으로 (P3, docs/agent-integrations.md).
// 대상 추출(targets.ts)은 Claude Code 의 도구 이름(Bash·mcp__argent__<도구>)을 기준으로 하므로
// 다른 에이전트의 입력은 그 이름으로 바꿔 넘기고, 막을 때는 그 에이전트가 읽는 모양으로 출력한다.

import { isAbsolute } from "node:path";
import { agentSessionKey } from "../shared/session.ts";

export type HookAgent = "claude" | "copilot" | "codex" | "cursor" | "gemini";

/** 어댑터마다 받는 이벤트 — `simless hook <에이전트> <이벤트>` */
export const HOOK_EVENTS: Record<HookAgent, readonly string[]> = {
  claude: ["pre-tool-use"],
  copilot: ["pre-tool-use"],
  codex: ["pre-tool-use"],
  cursor: ["before-shell", "before-mcp"],
  gemini: ["before-tool"],
};

export function isHookAgent(name: string | undefined): name is HookAgent {
  return name !== undefined && Object.hasOwn(HOOK_EVENTS, name);
}

/** 훅이 판단에 쓰는 것 */
export interface HookInput {
  /** Claude Code 식 도구 이름 — Bash, mcp__argent__<도구> */
  tool: string;
  input: unknown;
  /** 에이전트 세션 ID — 있으면 세션을 이 ID 로 찾는다 */
  sessionId?: string;
  /** 세션 키를 에이전트 세션 ID 로 만든다 (CLI 쪽 session.ts 와 같은 규칙) */
  sessionKey?: string;
  /** 에이전트의 지금 작업 폴더 — 훅 프로세스의 폴더는 에이전트를 켠 폴더일 수 있다 */
  cwd?: string;
}

type Raw = Record<string, unknown>;

const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

function parseMaybe(text: unknown): unknown {
  if (typeof text !== "string") return text;
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

/** 에이전트 입력 → 공통 모양. 판단할 게 없으면 undefined(통과) */
export function normalize(agent: HookAgent, event: string, raw: Raw): HookInput | undefined {
  const input = byAgent(agent, event, raw);
  // 모든 에이전트가 `cwd` 로 준다(Cursor 는 셸 호출에만, docs/agent-integrations.md) — 절대 경로만 믿는다
  const cwd = str(raw.cwd);
  return input && cwd && isAbsolute(cwd) ? { ...input, cwd } : input;
}

function byAgent(agent: HookAgent, event: string, raw: Raw): HookInput | undefined {
  switch (agent) {
    case "claude": {
      // Cursor 는 Claude Code 훅도 가져와 Cursor 식 입력으로 돌린다 — Cursor 용 훅이 따로 판단한다
      if (raw.cursor_version !== undefined) return undefined;
      return {
        tool: str(raw.tool_name) ?? "",
        input: raw.tool_input,
        sessionId: str(raw.session_id),
      };
    }
    case "codex": {
      const id = str(raw.session_id);
      return {
        tool: str(raw.tool_name) ?? "",
        input: raw.tool_input,
        sessionId: id,
        sessionKey: id ? agentSessionKey("codex", id) : undefined,
      };
    }
    case "copilot": {
      // PreToolUse(Claude 식)로 걸면 tool_name·tool_input, preToolUse 면 toolName·toolArgs
      const id = str(raw.session_id) ?? str(raw.sessionId);
      const name = str(raw.tool_name) ?? str(raw.toolName) ?? "";
      const input = raw.tool_input ?? raw.toolArgs;
      // 셸은 bash·Bash, MCP 는 «<서버>-<도구>» — argent- 로 시작하는 것만 argent 다
      const tool = /^bash$/i.test(name)
        ? "Bash"
        : name.startsWith("argent-")
          ? `mcp__argent__${name.slice("argent-".length)}`
          : name;
      return {
        tool,
        input: parseMaybe(input),
        sessionId: id,
        sessionKey: id ? agentSessionKey("copilot", id) : undefined,
      };
    }
    case "cursor": {
      const id = str(raw.conversation_id) ?? str(raw.session_id);
      const sessionKey = id ? agentSessionKey("cursor-agent", id) : undefined;
      if (event === "before-shell")
        return { tool: "Bash", input: { command: raw.command }, sessionId: id, sessionKey };
      if (raw.mcp_server_name !== "argent") return undefined;
      return {
        tool: `mcp__argent__${str(raw.tool_name) ?? ""}`,
        input: parseMaybe(raw.tool_input),
        sessionId: id,
        sessionKey,
      };
    }
    case "gemini": {
      // 셸 명령에 세션 ID 가 없어 세션은 프로세스로 찾는다 — 키는 그대로
      const name = str(raw.tool_name) ?? "";
      const context = (raw.mcp_context ?? {}) as Raw;
      if (name === "run_shell_command")
        return { tool: "Bash", input: raw.tool_input, sessionId: str(raw.session_id) };
      if (context.server_name !== "argent") return undefined;
      return {
        tool: `mcp__argent__${str(context.tool_name) ?? ""}`,
        input: raw.tool_input,
        sessionId: str(raw.session_id),
      };
    }
  }
}

/** 막을 때 — 그 에이전트가 읽는 모양 */
export function denyOutput(agent: HookAgent, reason: string): string {
  const text = `[simless] ${reason}`;
  switch (agent) {
    case "claude":
    case "codex":
    case "copilot":
      return JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: text,
        },
      });
    case "cursor":
      // CLI 는 user_message 를 모델에게 준다 — 둘 다 같은 글로
      return JSON.stringify({ permission: "deny", user_message: text, agent_message: text });
    case "gemini":
      return JSON.stringify({ decision: "deny", reason: text });
  }
}

/** 통과할 때 — Cursor 는 출력이 비거나 틀리면 막으므로 늘 허락을 적는다. 나머지는 아무것도 안 쓴다 */
export function allowOutput(agent: HookAgent): string | undefined {
  return agent === "cursor" ? JSON.stringify({ permission: "allow" }) : undefined;
}
