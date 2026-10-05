# 다른 에이전트 연결 조사 (Q16)

2026-10-05 조사. Claude Code 처럼 훅(P3)·스킬(S9)·규칙(P2)·MCP(R12)를 붙일 수 있는지.
표시: **[L]** 이 Mac 의 설치본으로 확인 · **[D]** 문서만 · **[S]** 원본 소스(GitHub main) · **[?]** 미확인.

## 요약

| 에이전트 (설치본) | 훅(실행 직전 막기) | 막는 응답 | 셸 명령의 세션 ID | 스킬 | 전역 규칙 | MCP 등록 |
| --- | --- | --- | --- | --- | --- | --- |
| **Copilot CLI** 1.0.91 | ✅ `~/.copilot/hooks/corgi.json` — Claude 형식도 받음 [L 실행 확인] | Claude 형식 그대로 | ✅ `COPILOT_AGENT_SESSION_ID` = 훅 `sessionId` [L] | `~/.agents/skills` | `~/.copilot/copilot-instructions.md` | `copilot mcp add` |
| **Codex CLI** 0.160.0 | ✅ `~/.codex/hooks.json` — Claude 와 거의 같음. 사용자가 `/hooks` 에서 한 번 확인해야 돈다 | Claude 형식 그대로 | `CODEX_THREAD_ID` [?] — 실측 필요 | `~/.agents/skills` | `~/.codex/AGENTS.md`(파일에 덧붙임) | `codex mcp add` |
| **Cursor** CLI 2026.07.09 · IDE 3.22 | ✅ `~/.cursor/hooks.json` — `beforeShellExecution`·`beforeMCPExecution`, 형식이 다름 | `{"permission":"deny","user_message","agent_message"}` | ✅ `CURSOR_CONVERSATION_ID` = 훅 `conversation_id` [L 코드] | `~/.agents/skills` | `~/.cursor/rules/corgi.mdc` | `~/.cursor/mcp.json` 직접 고침 |
| **OpenCode** 1.0.220 | ✅ 플러그인(`~/.config/opencode/plugins/corgi.js`)의 `tool.execute.before` | `throw new Error(이유)` | ❌ 이 버전엔 없음 — 플러그인만 앎(새 버전 `shell.env` 로 넣을 수 있음) | `~/.claude/skills` 를 그대로 읽음 | 설정 `instructions` 에 경로 | `opencode.json` 직접 고침 |
| **Gemini CLI** 0.16.0 | ❌ 이 버전은 훅이 안 돎 — **0.26.0 이상** | `{"decision":"deny","reason"}` | ❌ 훅만 앎 | ❌ (새 버전 `~/.agents/skills`) | `~/.gemini/GEMINI.md` | `gemini mcp add -s user` |

**공통으로 알게 된 것**
- 스킬은 `~/.agents/skills/corgi/SKILL.md` 하나로 Codex·Copilot·Cursor·Gemini(새 버전)가 같이 읽는다. OpenCode 는 지금 넣는 `~/.claude/skills` 를 읽는다.
- 세션 구분은 부모 프로세스보다 **에이전트가 셸에 주는 세션 ID** 가 정확하다 — Codex(공용 데몬 아래에서 돎)·OpenCode(프로세스 하나에 세션 여럿)는 부모 프로세스로는 가릴 수 없다. CLI 가 `COPILOT_AGENT_SESSION_ID`·`CURSOR_CONVERSATION_ID`·`CODEX_THREAD_ID` 를 읽고, 훅은 입력의 세션 ID 를 쓰면 같은 세션으로 묶인다.
- **Cursor 는 Claude Code 훅도 읽는다**(기본 켜짐) — `~/.claude/settings.json` 의 Corgi 훅이 Cursor 에서도 돌지만 입력 모양이 Cursor 식(`Shell`·`MCP:<도구>`)이라 지금 훅은 전부 통과시킨다. 해는 없지만 Cursor 용 어댑터를 붙이면 같은 명령이 두 번 돌지 않게 해야 한다.
- 시간 초과·오류 때 동작이 다르다 — Copilot 은 시간 초과면 그냥 실행(오류면 막음), Cursor 는 `failClosed` 를 안 주면 실행.

## 제안 순서

1. **Copilot CLI** — 훅 형식·막는 응답이 Claude 와 같고 세션 ID 도 맞는다. 어댑터가 거의 필요 없다.
2. **Codex CLI** — 형식은 같다. `CODEX_THREAD_ID` 실측, 샌드박스에서 소켓 접근, `/hooks` 확인 안내가 필요하다.
3. **Cursor** — 이벤트·응답 형식이 달라 어댑터가 필요하지만 세션 ID 는 맞는다. 규칙은 `.mdc`.
4. **OpenCode·Gemini** — 셸 명령에 세션 ID 가 없어 지금 설치본으로는 `corgi use` 를 세션에 묶기 어렵다. 업그레이드 뒤 다시 본다.

## Codex CLI (`codex-cli 0.160.0` [L])

문서: https://developers.openai.com/codex/hooks · /codex/skills · /codex/mcp · /codex/guides/agents-md

- **훅** — 이벤트 `PreToolUse`. 사용자 전역 `~/.codex/hooks.json`(또는 `config.toml` 의 `[hooks]`), 저장소 `.codex/hooks.json` 이 우선. 기능 플래그 `hooks` 는 stable·켜짐 [L].
  ```json
  {"hooks":{"PreToolUse":[{"matcher":"^Bash$|^mcp__argent__.*","hooks":[{"type":"command","command":"<corgi> hook codex pre-tool-use","timeout":30}]}]}}
  ```
  matcher 는 `tool_name` 정규식. 셸(`Bash`)·MCP 도구 모두. timeout 은 **초**.
- **입력** [D] — `session_id`·`turn_id`·`cwd`·`tool_name`·`tool_input`. 셸은 `tool_input.command`, MCP 는 인자 그대로(`udid`·`serial`). MCP 이름은 `mcp__<서버>__<도구>`.
- **막기** — Claude 와 같은 `hookSpecificOutput.permissionDecision: "deny"` JSON [L·D], 또는 exit 2 + stderr.
- **주의**
  - **훅 신뢰 확인** — 새로 넣은 훅은 사용자가 TUI 의 `/hooks` 에서 확인해야 돈다. 명령이 바뀌면 다시 확인. 설정 창에 안내가 필요하다.
  - 셸 명령이 공용 app-server 데몬(launchd 자식) 아래에서 돌 수 있어 **부모 프로세스로 세션을 찾기 어렵다** — `CODEX_THREAD_ID` 를 쓰고, 훅의 `session_id` 와 같은지 실측 필요 [?].
  - Codex 샌드박스(workspace-write, 네트워크 꺼짐) 안에서 Corgi 소켓에 붙을 수 있는지 실측 필요 [?].
- **스킬** — `~/.agents/skills/<이름>/SKILL.md`(이 Mac 에 폴더 있음, argent 스킬이 들어 있음) [L]. `~/.codex/skills` 도 읽는다.
- **규칙** — `~/.codex/AGENTS.md`(있음, 비어 있음) [L]. 규칙 폴더는 없다 — 파일에 덧붙여야 한다.
- **MCP** — `codex mcp add corgi -- <corgi> mcp` → `~/.codex/config.toml` 의 `[mcp_servers.corgi]` [L].

## Gemini CLI (설치본 `0.16.0` [L], npm 최신 0.62.0, brew 0.46.0)

문서: https://geminicli.com/docs/hooks/ · /docs/hooks/reference/ · /docs/cli/skills/

- **지금 설치본(0.16.0)으로는 훅·스킬 모두 안 된다** [L] — 훅 코드는 있지만 연결돼 있지 않다. `~/.gemini/settings.json` 에 다른 도구(Orca·Superset)가 넣은 `BeforeTool` 훅도 이 버전에서는 돌지 않는다. 훅이 기본으로 켜지는 건 **0.26.0** 부터.
- **훅(새 버전)** — 이벤트 `BeforeTool`, `~/.gemini/settings.json` 의 `hooks`.
  ```json
  {"hooks":{"BeforeTool":[{"matcher":"^run_shell_command$|^mcp_argent_","hooks":[{"type":"command","command":"<corgi> hook gemini before-tool","name":"corgi","timeout":10000}]}]}}
  ```
  matcher 는 앵커 없는 정규식, timeout 은 **밀리초**.
- **입력** [S] — `session_id`·`cwd`·`tool_name`·`tool_input`·`mcp_context`(`server_name`·`tool_name`). 셸 도구 `run_shell_command`(`tool_input.command`). MCP 이름은 `mcp_<서버>_<도구>`(밑줄 하나 — 나누지 말고 `mcp_context` 를 본다).
- **막기** — stdout 에 `{"decision":"deny","reason":"…"}` 만(exit 0), 또는 exit 2 + stderr. Claude 형식은 **안 읽는다** [S].
- **세션** — 훅 프로세스는 `GEMINI_SESSION_ID` 를 받지만, 모델이 실행하는 셸 명령은 `GEMINI_CLI=1` 만 받는다 [L·S]. `corgi use` 가 어느 세션인지 알려면 부모 프로세스(`node … gemini-cli`, 두 겹)로 찾아야 한다.
- **스킬(새 버전)** — `~/.agents/skills` 또는 `~/.gemini/skills`. Codex 와 `~/.agents/skills/corgi` 하나로 같이 쓸 수 있다.
- **규칙** — `~/.gemini/GEMINI.md`(있음, 비어 있음) [L].
- **MCP** — `gemini mcp add -s user corgi <corgi> mcp`(기본 범위가 project 라 `-s user` 필요) [L].

## Copilot CLI (`1.0.91` [L] — brew 의 1.0.47 이 자동 업데이트본을 실행)

문서: https://docs.github.com/en/copilot/reference/hooks-configuration · …/customize-copilot/add-skills · …/add-custom-instructions · …/add-mcp-servers

- **훅** — `~/.copilot/hooks/*.json`(Orca 의 `orca.json` 이 이미 있음 — 옆에 `corgi.json`). 저장소 `.github/hooks/*.json` 과 합쳐진다.
  ```json
  {"version":1,"hooks":{"preToolUse":[{"type":"command","bash":"<corgi> hook copilot pre-tool-use","timeoutSec":10,"matcher":"bash|argent-.*"}]}}
  ```
  Claude 의 `{"hooks":{"PreToolUse":[{"matcher","hooks":[…]}]}}` 형식도 받는다(1.0.6~) [L]. matcher 는 도구 이름 전체에 맞추는 정규식. 셸·MCP·하위 에이전트 호출 모두 [L].
- **입력** [L] — 이벤트 이름을 camelCase 로 쓰면 `{sessionId, cwd, toolName, toolArgs}`(셸 `bash`), PascalCase 면 Claude 식 `{session_id, cwd, tool_name, tool_input}`(셸 `Bash`). MCP 도구 이름은 `<서버>-<도구>`(예 `argent-gesture-tap`) — 서버 이름에 `-` 가 들어갈 수 있어 `argent-` 접두어로 본다.
- **막기** [L] — stdout `{"permissionDecision":"deny","permissionDecisionReason":"…"}` 또는 Claude 형식 그대로. 모델에게 `Denied by preToolUse hook: …`. exit 2 도 막고, 그 밖의 오류도 막는다(1.0.57~). **시간 초과면 그냥 실행된다.**
- **세션** [L] — 셸 명령에 `COPILOT_AGENT_SESSION_ID`(훅의 `sessionId` 와 같음). 부모 프로세스 이름 `copilot`. MCP 서버 프로세스도 받지만 세션을 바꿔도 다시 뜨지 않아 믿으면 안 된다. 훅 자신의 환경에는 없다 — 입력에서 읽는다.
- **스킬** — `~/.copilot/skills`·`~/.agents/skills` [L]. `COPILOT_HOME` 을 바꾸면 `~/.agents/skills` 는 안 읽는다. `~/.claude/skills` 는 1.0.36 부터 안 읽는다.
- **규칙** — `~/.copilot/copilot-instructions.md`(있음) 또는 `~/.copilot/instructions/**/*.instructions.md` [L·D].
- **MCP** — `copilot mcp add corgi -- <corgi> mcp` → `~/.copilot/mcp-config.json` [L]. `~/.copilot/config.json` 은 Copilot 이 관리(로그인 정보) — 쓰지 않는다.
- **주의** — 기업 정책 `allowManagedHooksOnly`·설정 `disableAllHooks` 면 사용자 훅이 꺼진다.

## Cursor (`cursor-agent 2026.07.09-a3815c0` · Cursor.app 3.22.12 [L])

문서: https://cursor.com/docs/agent/hooks · /docs/reference/third-party-hooks · /docs/context/rules · /docs/context/skills · /docs/cli/mcp

- **훅** — `~/.cursor/hooks.json`(Superset·Orca 항목이 이미 있음 — 배열에 더한다). 파일을 고치면 바로 다시 읽는다. CLI 도 훅을 돌린다 [L 코드]. 실제 실행은 확인 안 함 [?].
  ```json
  {"version":1,"hooks":{"beforeShellExecution":[{"command":"<corgi> hook cursor before-shell","timeout":10}],"beforeMCPExecution":[{"command":"<corgi> hook cursor before-mcp","timeout":10}]}}
  ```
  matcher 는 이벤트마다 대상이 다르다 — 셸은 명령 문자열, MCP 는 `MCP:<도구>`(서버 이름 없음).
- **입력** [L] — 공통 `conversation_id`·`session_id`(= conversation_id)·`workspace_roots`. 셸: `command`·`cwd`. MCP: `mcp_server_name`(예 `argent`)·`tool_name`(서버 없이)·`tool_input`(**JSON 문자열**). argent 판별은 `beforeMCPExecution` 의 `mcp_server_name` 으로.
- **막기** [L] — `{"permission":"deny","user_message":"…","agent_message":"…"}`. CLI 는 모델에게 `user_message` 를 준다 — 둘 다 같은 글로. 잘못된 JSON 도 막는다(항상 올바른 JSON 출력). 시간 초과·충돌은 `failClosed:true` 가 아니면 실행.
- **세션** [L] — 셸 명령에 `CURSOR_AGENT=1`·`CURSOR_CONVERSATION_ID`(훅의 `conversation_id` 와 같음). CLI 프로세스는 `node …/cursor-agent/versions/*/index.js`, IDE 는 `Cursor Helper (Plugin)` 아래.
- **스킬** — `~/.agents/skills`·`~/.cursor/skills` [L]. `~/.claude/skills` 는 «타사 가져오기» 를 켰을 때만.
- **규칙** — 파일 규칙은 `.mdc` 만(`.md` 는 무시 — argent 가 넣은 `~/.cursor/rules/argent.md` 는 안 읽힐 것). `~/.cursor/rules/corgi.mdc` 는 HOME 아래 작업 폴더에서만 읽힌다.
- **MCP** — `~/.cursor/mcp.json` 의 `mcpServers`. `mcp add` 명령이 없어 파일을 고친다. 승인은 `--approve-mcps`·`mcp enable`.
- **Claude 훅 가져오기** — 기본으로 `~/.claude/settings.json` 훅도 돈다(이름 바꿔서 — `Bash`→`Shell`, `mcp__argent__x`→`MCP:x`, 응답 형식은 바꿔 줌). 입력은 Cursor 식이라 지금 Corgi 훅은 전부 통과시킨다.

## OpenCode (`1.0.220` [L], npm 최신 1.18.34)

문서: https://opencode.ai/docs/plugins/ · /docs/skills/ · /docs/rules/ · /docs/mcp-servers/

- **막기** — 사용자 플러그인 `~/.config/opencode/plugins/*.{js,ts}`(Orca 플러그인이 이미 있음). 내보낸 함수가 `{"tool.execute.before": async (input, output) => …}` 를 돌려준다. `input` = `{tool, sessionID, callID}`, `output.args` = 실행할 인자. 셸(`bash`)·MCP 도구 모두 [L]. `throw new Error(이유)` 면 모델에게 `Error: 이유` 로 가고 작업은 계속된다 [L].
- 플러그인은 OpenCode 의 Bun 프로세스 안에서 돈다 — `$\`corgi …\`` 로 부르거나 소켓에 바로 붙는다(빠름).
- MCP 도구 이름 `<서버>_<도구>`(예 `argent_gesture-tap`), 인자 그대로.
- **세션** — 셸 명령은 `OPENCODE=1`·`AGENT=1` 만 받는다(이 버전) [L]. 프로세스 하나(`opencode`)가 세션 여럿을 돌려 부모 프로세스로 가릴 수 없다. 새 버전의 `shell.env` 훅으로 세션 변수를 넣을 수 있다 [D].
- **스킬** — `~/.claude/skills/**/SKILL.md` 를 읽는다 [L] → 지금 Corgi 스킬이 그대로 보인다. 새 버전은 `~/.agents/skills` 도.
- **규칙** — `~/.config/opencode/AGENTS.md`(없으면 `~/.claude/CLAUDE.md`). `~/.claude/rules` 는 안 읽는다 — 설정 `"instructions": ["~/.claude/rules/corgi.md"]` 로 넣는다.
- **MCP** — `~/.config/opencode/opencode.json` 의 `"mcp": {"corgi": {"type":"local","command":["<corgi>","mcp"],"enabled":true}}`. 이 버전의 `opencode mcp add` 는 로컬 서버를 저장하지 않는다 — 파일을 고친다.

## 남은 일

- 실측: Codex `CODEX_THREAD_ID` = 훅 `session_id` 인지, Codex 샌드박스에서 소켓 접근, Cursor 훅이 CLI 에서 실제로 도는지.
- 세션 묶기 설계 — CLI 가 에이전트 세션 ID 환경 변수를 읽고, 훅은 입력의 세션 ID 로 같은 세션을 찾게(§7·§13).
- Gemini·OpenCode 업그레이드할지 사용자 결정.
- 조사 중 생긴 것: Copilot 시험 세션 기록 4개(`~/.copilot/session-state/`, 2026-10-05 15:12~15:13) — 지울지 사용자 결정.
