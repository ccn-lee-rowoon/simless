// 훅이 보는 범위 (P10, docs/design.md §13). Simless 는 기기를 관리만 하고, 화면 조작·테스트는 프로젝트가 고른
// 도구가 한다 — 훅은 그 도구의 이름을 모른다. 셸 명령과 모든 MCP 호출을 받아, 관리 기기의 ID 가 들어 있는지만 본다.
// 설치(install)와 훅(hook)이 같이 쓰므로 shared 에 둔다.

/** Simless 자신의 MCP 서버 — 점유 요청에 기기 ID 가 들어가므로 훅이 보지 않는다 */
export const SELF_MCP_SERVER = "simless";

/** 에이전트마다 훅을 거는 도구 이름 패턴 — 셸과 모든 MCP 도구 */
export const HOOK_MATCHERS = {
  claude: "Bash|mcp__.*",
  codex: "^Bash$|^mcp__.*",
  // Copilot 의 MCP 도구 이름은 «<서버>-<도구>», 기본 도구(bash·view·edit …)에는 «-» 가 없다
  copilot: "Bash|.+-.+",
  gemini: "^run_shell_command$|^mcp_",
} as const;

/** 공통 도구 이름 — Claude Code 식 `mcp__<서버>__<도구>` */
export function mcpToolName(server: string, tool: string): string {
  return `mcp__${server}__${tool}`;
}
