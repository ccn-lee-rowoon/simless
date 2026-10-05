# 다른 에이전트 연결 조사 (Q16)

2026-10-05 조사 — **각 CLI 최신 버전 기준**(Codex 0.160.0·Copilot CLI 1.0.91 은 처음부터 최신, Cursor·Gemini·OpenCode 는 업데이트한 뒤 다시 확인). Claude Code 처럼 훅(P3)·스킬(S9)·규칙(P2)·MCP(R12)를 붙일 수 있는지.
표시: **[L]** 이 Mac 의 설치본으로 확인 · **[D]** 문서만 · **[S]** 원본 소스(GitHub main) · **[?]** 미확인.

## 요약

| 에이전트 (설치본) | 훅(실행 직전 막기) | 막는 응답 | 셸 명령의 세션 ID | 스킬 | 전역 규칙 | MCP 등록 |
| --- | --- | --- | --- | --- | --- | --- |
| **Copilot CLI** 1.0.91 | ✅ `~/.copilot/hooks/simless.json` — Claude 형식도 받음 [L 실행 확인] | Claude 형식 그대로 | ✅ `COPILOT_AGENT_SESSION_ID` = 훅 `sessionId` [L] | `~/.agents/skills` | `~/.copilot/copilot-instructions.md` | `copilot mcp add` |
| **Codex CLI** 0.160.0 | ✅ `~/.codex/hooks.json` — Claude 와 거의 같음. 사용자가 `/hooks` 에서 한 번 확인해야 돈다 | Claude 형식 그대로 | `CODEX_THREAD_ID` [?] — 실측 필요 | `~/.agents/skills` | `~/.codex/AGENTS.md`(파일에 덧붙임) | `codex mcp add` |
| **Cursor** CLI 2026.10.01 | ✅ `~/.cursor/hooks.json` — `beforeShellExecution`·`beforeMCPExecution`, 형식이 다름 | `{"permission":"deny","user_message","agent_message"}` | ✅ `CURSOR_CONVERSATION_ID` = 훅 `conversation_id` [L 코드] | `~/.agents/skills` | `~/.cursor/rules/simless.mdc` | `~/.cursor/mcp.json` 직접 고침 |
| **OpenCode** 2.0.20 | ✅ 플러그인 `api.tool.hook("execute.before")` — v1 형식(`tool.execute.before`)은 없어짐. 던져서 막기는 [?] → 권한 규칙도 후보 | [?] | ✅ `OPENCODE_SESSION_ID` 를 셸 명령에 기본으로 준다 [L 코드] | `~/.agents/skills`·`~/.claude/skills` | `<설정 폴더>/AGENTS.md` | `opencode mcp add --global` |
| **Gemini CLI** 0.46.0 | ✅ `BeforeTool` — 단 **신뢰한 폴더에서만** 돈다 | `{"decision":"deny","reason"}` | ❌ 훅만 앎 — 부모 프로세스로(세션마다 프로세스가 따로) | `~/.agents/skills` | `~/.gemini/GEMINI.md` | `gemini mcp add -s user` (신뢰한 폴더에서만 뜸) |

**공통으로 알게 된 것**
- 스킬은 `~/.agents/skills/simless/SKILL.md` 하나로 Codex·Copilot·Cursor·Gemini(새 버전)가 같이 읽는다. OpenCode 는 지금 넣는 `~/.claude/skills` 를 읽는다.
- 세션 구분은 부모 프로세스보다 **에이전트가 셸에 주는 세션 ID** 가 정확하다 — Codex(공용 데몬 아래에서 돎)·OpenCode(서버 프로세스 하나에 세션 여럿)는 부모 프로세스로는 가릴 수 없다. CLI 가 `COPILOT_AGENT_SESSION_ID`·`CURSOR_CONVERSATION_ID`·`CODEX_THREAD_ID`·`OPENCODE_SESSION_ID` 를 읽고, 훅은 입력의 세션 ID 를 쓰면 같은 세션으로 묶인다. Gemini 만 셸에 세션 ID 가 없다.
- **Cursor 는 Claude Code 훅도 읽는다**(CLI 는 설정과 상관없이 항상) — `~/.claude/settings.json` 의 simless 훅이 Cursor 에서도 돌지만 입력 모양이 Cursor 식(`Shell`·`MCP:<도구>`)이라 지금 훅은 전부 통과시킨다. 해는 없지만 Cursor 용 어댑터를 붙이면 같은 명령이 두 번 돌지 않게 해야 한다.
- 시간 초과·오류 때 동작이 다르다 — Copilot·Gemini 는 시간 초과면 그냥 실행, Cursor 는 `failClosed` 를 안 주면 실행.
- 업그레이드 뒤 로그인이 다시 필요했다 — Cursor(`unauthenticated` 로 업데이트 실패 → 다시 로그인), Gemini(도움말이 로그인 페이지를 열려고 함).

## 제안 순서

1. **Copilot CLI** — 훅 형식·막는 응답이 Claude 와 같고 세션 ID 도 맞는다. 어댑터가 거의 필요 없다.
2. **Codex CLI** — 형식은 같다. `CODEX_THREAD_ID` 실측, 샌드박스에서 소켓 접근, `/hooks` 확인 안내가 필요하다.
3. **Cursor** — 이벤트·응답 형식이 달라 어댑터가 필요하지만 세션 ID 는 맞는다. 규칙은 `.mdc`.
4. **OpenCode** — 세션 ID 는 받지만 v2 플러그인에서 «막기» 가 어떻게 모델에게 보이는지 실측이 필요하다(안 되면 권한 규칙으로).
5. **Gemini CLI** — 훅은 되지만 신뢰한 폴더에서만 돌고, 셸 명령에 세션 ID 가 없어 부모 프로세스로 묶어야 한다.

## Codex CLI (`codex-cli 0.160.0` [L])

문서: https://developers.openai.com/codex/hooks · /codex/skills · /codex/mcp · /codex/guides/agents-md

- **훅** — 이벤트 `PreToolUse`. 사용자 전역 `~/.codex/hooks.json`(또는 `config.toml` 의 `[hooks]`), 저장소 `.codex/hooks.json` 이 우선. 기능 플래그 `hooks` 는 stable·켜짐 [L].
  ```json
  {"hooks":{"PreToolUse":[{"matcher":"^Bash$|^mcp__argent__.*","hooks":[{"type":"command","command":"<simless> hook codex pre-tool-use","timeout":30}]}]}}
  ```
  matcher 는 `tool_name` 정규식. 셸(`Bash`)·MCP 도구 모두. timeout 은 **초**.
- **입력** [D] — `session_id`·`turn_id`·`cwd`·`tool_name`·`tool_input`. 셸은 `tool_input.command`, MCP 는 인자 그대로(`udid`·`serial`). MCP 이름은 `mcp__<서버>__<도구>`.
- **막기** — Claude 와 같은 `hookSpecificOutput.permissionDecision: "deny"` JSON [L·D], 또는 exit 2 + stderr.
- **주의**
  - **훅 신뢰 확인** — 새로 넣은 훅은 사용자가 TUI 의 `/hooks` 에서 확인해야 돈다. 명령이 바뀌면 다시 확인. 설정 창에 안내가 필요하다.
  - 셸 명령이 공용 app-server 데몬(launchd 자식) 아래에서 돌 수 있어 **부모 프로세스로 세션을 찾기 어렵다** — `CODEX_THREAD_ID` 를 쓰고, 훅의 `session_id` 와 같은지 실측 필요 [?].
  - Codex 샌드박스(workspace-write, 네트워크 꺼짐) 안에서 simless 소켓에 붙을 수 있는지 실측 필요 [?].
- **스킬** — `~/.agents/skills/<이름>/SKILL.md`(이 Mac 에 폴더 있음, argent 스킬이 들어 있음) [L]. `~/.codex/skills` 도 읽는다.
- **규칙** — `~/.codex/AGENTS.md`(있음, 비어 있음) [L]. 규칙 폴더는 없다 — 파일에 덧붙여야 한다.
- **MCP** — `codex mcp add simless -- <simless> mcp` → `~/.codex/config.toml` 의 `[mcp_servers.simless]` [L].

## Gemini CLI (`0.46.0` [L] — brew 로 0.16.0 에서 올림, npm 최신 0.62.0)

문서: https://geminicli.com/docs/hooks/ · /docs/hooks/reference/ · /docs/cli/skills/

- **훅** — `hooksConfig.enabled` 기본 켜짐 [L]. 이벤트 `BeforeTool`, `~/.gemini/settings.json` 의 `hooks`.
  ```json
  {"hooks":{"BeforeTool":[{"matcher":"^run_shell_command$|^mcp_argent_","hooks":[{"type":"command","command":"<simless> hook gemini before-tool","name":"simless","timeout":10000}]}]}}
  ```
  matcher 는 앵커 없는 정규식, timeout 은 **밀리초**(기본 60000). 같은 훅은 하나로 합치고 기본으로 함께 돈다.
- **신뢰한 폴더에서만** [L] — 사용자 훅도 «프로젝트» 출처로 묶여서, 작업 폴더를 신뢰하지 않으면 건너뛴다(`security.folderTrust.enabled` 기본 켜짐). 신뢰: 대화 중 `/trust`, `~/.gemini/trustedFolders.json`, `GEMINI_CLI_TRUST_WORKSPACE=true`, `--skip-trust`. **이 Mac 에는 아직 신뢰한 폴더가 없다** — 지금은 어떤 훅도 돌지 않는다. stdio MCP 서버도 신뢰한 폴더에서만 뜬다.
- **입력** [L] — `session_id`·`cwd`·`tool_name`·`tool_input`·`mcp_context`(`server_name`·`tool_name`·`command`·`args`… — `args` 에 비밀이 있을 수 있어 남기지 않는다). 셸 도구 `run_shell_command`(`tool_input.command`). MCP 이름 `mcp_<서버>_<도구>` — 나누지 말고 `mcp_context` 를 본다.
- **막기** [L] — stdout 에 `{"decision":"deny","reason":"…"}`(exit 0), 또는 stdout 을 비우고 exit 2 + stderr. Claude 형식은 안 읽는다. 여러 훅 중 하나라도 막으면 막힌다. 시간 초과·실행 실패면 그냥 실행된다.
- **세션** [L] — 훅은 `GEMINI_SESSION_ID` 를 받지만, 셸 명령은 `GEMINI_CLI=1` 만 받는다(0.46.0 도 그대로). 프로세스는 `node …/gemini` → 자식 `node …/gemini` → 셸 명령으로 세션마다 따로라 부모 프로세스로 묶을 수 있다.
- **스킬** [L] — 기본 켜짐. `~/.gemini/skills` → `~/.agents/skills` 순(뒤가 이김). 모델이 `activate_skill` 로 부르고 대화 중엔 사용자가 확인한다. `gemini skills install|link|list`.
- **규칙** — `~/.gemini/GEMINI.md`(있음, 비어 있음) [L].
- **MCP** — `gemini mcp add -s user simless <simless> mcp`(기본 범위가 project 라 `-s user` 필요) [L]. MCP 자식 환경에서 TOKEN·KEY 같은 이름의 변수는 지운다.
- **다른 도구의 훅** — `~/.gemini/settings.json` 에 Orca·Superset 훅이 있다. 이제 신뢰한 폴더에서 돌지만 늘 통과(`{}`)만 돌려준다.

## Copilot CLI (`1.0.91` [L] — brew 의 1.0.47 이 자동 업데이트본을 실행)

문서: https://docs.github.com/en/copilot/reference/hooks-configuration · …/customize-copilot/add-skills · …/add-custom-instructions · …/add-mcp-servers

- **훅** — `~/.copilot/hooks/*.json`(Orca 의 `orca.json` 이 이미 있음 — 옆에 `simless.json`). 저장소 `.github/hooks/*.json` 과 합쳐진다.
  ```json
  {"version":1,"hooks":{"preToolUse":[{"type":"command","bash":"<simless> hook copilot pre-tool-use","timeoutSec":10,"matcher":"bash|argent-.*"}]}}
  ```
  Claude 의 `{"hooks":{"PreToolUse":[{"matcher","hooks":[…]}]}}` 형식도 받는다(1.0.6~) [L]. matcher 는 도구 이름 전체에 맞추는 정규식. 셸·MCP·하위 에이전트 호출 모두 [L].
- **입력** [L] — 이벤트 이름을 camelCase 로 쓰면 `{sessionId, cwd, toolName, toolArgs}`(셸 `bash`), PascalCase 면 Claude 식 `{session_id, cwd, tool_name, tool_input}`(셸 `Bash`). MCP 도구 이름은 `<서버>-<도구>`(예 `argent-gesture-tap`) — 서버 이름에 `-` 가 들어갈 수 있어 `argent-` 접두어로 본다.
- **막기** [L] — stdout `{"permissionDecision":"deny","permissionDecisionReason":"…"}` 또는 Claude 형식 그대로. 모델에게 `Denied by preToolUse hook: …`. exit 2 도 막고, 그 밖의 오류도 막는다(1.0.57~). **시간 초과면 그냥 실행된다.**
- **세션** [L] — 셸 명령에 `COPILOT_AGENT_SESSION_ID`(훅의 `sessionId` 와 같음). 부모 프로세스 이름 `copilot`. MCP 서버 프로세스도 받지만 세션을 바꿔도 다시 뜨지 않아 믿으면 안 된다. 훅 자신의 환경에는 없다 — 입력에서 읽는다.
- **스킬** — `~/.copilot/skills`·`~/.agents/skills` [L]. `COPILOT_HOME` 을 바꾸면 `~/.agents/skills` 는 안 읽는다. `~/.claude/skills` 는 1.0.36 부터 안 읽는다.
- **규칙** — `~/.copilot/copilot-instructions.md`(있음) 또는 `~/.copilot/instructions/**/*.instructions.md` [L·D].
- **MCP** — `copilot mcp add simless -- <simless> mcp` → `~/.copilot/mcp-config.json` [L]. `~/.copilot/config.json` 은 Copilot 이 관리(로그인 정보) — 쓰지 않는다.
- **주의** — 기업 정책 `allowManagedHooksOnly`·설정 `disableAllHooks` 면 사용자 훅이 꺼진다.

## Cursor (`cursor-agent 2026.10.01-e373342` · Cursor.app 3.22.12 [L] — 2026.07.09 에서 다시 확인)

2026.10.01 에서 바뀐 것: Claude 형식 훅 응답을 항상 Cursor 형식으로 바꿔 받는다(전에는 기능 플래그), 훅 입력은 기본으로 stdin, 심볼릭 링크로 가리킨 훅 설정 파일은 읽지 않는다, 셸 명령에 `CURSOR_REQUEST_ID` 도 준다. 아래 내용은 그대로다.

문서: https://cursor.com/docs/agent/hooks · /docs/reference/third-party-hooks · /docs/context/rules · /docs/context/skills · /docs/cli/mcp

- **훅** — `~/.cursor/hooks.json`(Superset·Orca 항목이 이미 있음 — 배열에 더한다). 파일을 고치면 바로 다시 읽는다. CLI 도 훅을 돌린다 [L 코드]. 실제 실행은 확인 안 함 [?].
  ```json
  {"version":1,"hooks":{"beforeShellExecution":[{"command":"<simless> hook cursor before-shell","timeout":10}],"beforeMCPExecution":[{"command":"<simless> hook cursor before-mcp","timeout":10}]}}
  ```
  matcher 는 이벤트마다 대상이 다르다 — 셸은 명령 문자열, MCP 는 `MCP:<도구>`(서버 이름 없음).
- **입력** [L] — 공통 `conversation_id`·`session_id`(= conversation_id)·`workspace_roots`. 셸: `command`·`cwd`. MCP: `mcp_server_name`(예 `argent`)·`tool_name`(서버 없이)·`tool_input`(**JSON 문자열**). argent 판별은 `beforeMCPExecution` 의 `mcp_server_name` 으로.
- **막기** [L] — `{"permission":"deny","user_message":"…","agent_message":"…"}`. CLI 는 모델에게 `user_message` 를 준다 — 둘 다 같은 글로. 잘못된 JSON 도 막는다(항상 올바른 JSON 출력). 시간 초과·충돌은 `failClosed:true` 가 아니면 실행.
- **세션** [L] — 셸 명령에 `CURSOR_AGENT=1`·`CURSOR_CONVERSATION_ID`(훅의 `conversation_id` 와 같음). CLI 프로세스는 `node …/cursor-agent/versions/*/index.js`, IDE 는 `Cursor Helper (Plugin)` 아래.
- **스킬** — `~/.agents/skills`·`~/.cursor/skills` [L]. `~/.claude/skills` 는 «타사 가져오기» 를 켰을 때만.
- **규칙** — 파일 규칙은 `.mdc` 만(`.md` 는 무시 — argent 가 넣은 `~/.cursor/rules/argent.md` 는 안 읽힐 것). `~/.cursor/rules/simless.mdc` 는 HOME 아래 작업 폴더에서만 읽힌다.
- **MCP** — `~/.cursor/mcp.json` 의 `mcpServers`. `mcp add` 명령이 없어 파일을 고친다. 승인은 `--approve-mcps`·`mcp enable`.
- **Claude 훅 가져오기** — CLI 는 `~/.claude/settings.json` 훅을 항상 돌린다(IDE 는 «타사 설정 가져오기», 기본 켜짐)(이름 바꿔서 — `Bash`→`Shell`, `mcp__argent__x`→`MCP:x`, 응답 형식은 바꿔 줌). 입력은 Cursor 식이라 지금 simless 훅은 전부 통과시킨다.

## OpenCode (`2.0.20` [L] — brew 로 1.0.220 에서 올림)

문서: https://opencode.ai/docs/plugins/ · /docs/skills/ · /docs/rules/ · /docs/mcp-servers/ · /docs/permissions/

v2 에서 거의 다 바뀌었다. 바이너리 안의 코드를 읽어 확인했고, 실행은 안 했다.

- **플러그인** [L] — `~/.config/opencode/plugins/*.{js,ts}` 또는 폴더(`server`·`index` 진입점). 형식은 `export default {id, setup}`(v1 의 이름 붙은 함수 내보내기는 안 받는다). `setup(api)` 안에서 `api.tool.hook("execute.before", e => …)` — `e` = `{tool, sessionID, agent, messageID, id, input}`, 인자는 `e.input`. 셸 도구 이름은 이제 **`shell`**, MCP 도구는 기본으로 «Code Mode»(`execute` 도구) 안에서 돌지만 안쪽 도구마다 훅이 불린다.
- **막기** [?] — 훅에서 던지면 모델에게 오류로 가는지 확인 못 했다(Effect 의 «defect» 로 처리될 수 있음). 대안: 권한 규칙(도구 ID `shell`·`<서버>_<도구>` 에 allow·ask·deny) — 다만 인자(기기 ID)로는 못 거른다.
- **세션** [L] — 셸 명령에 기본으로 **`OPENCODE_SESSION_ID`**·`OPENCODE=1`·`AGENT=1`·`AI_AGENT=opencode`. 플러그인 없이 CLI 가 세션을 알 수 있다. 기본은 공용 백그라운드 서버 하나가 세션 여럿을 돌린다 — 부모 프로세스로는 못 가린다.
- **스킬** [L] — `~/.claude/skills` 와 `~/.agents/skills` 둘 다 읽는다.
- **규칙** [L] — `<설정 폴더>/AGENTS.md` 만. `~/.claude/CLAUDE.md` 로 돌아가는 동작은 없어졌다. 설정 `instructions` 는 있다.
- **MCP** [L] — v2 형식 `"mcp": {"servers": {"simless": {"type":"local","command":["<simless>","mcp"]}}}`(v1 형식도 바꿔 읽음). `opencode mcp add --global simless -- <simless> mcp` 가 이제 묻지 않고 쓴다(`--global` 없으면 프로젝트 설정).
- **설정 폴더 주의** [L] — `OPENCODE_CONFIG_DIR` 가 있으면 `~/.config/opencode` 대신 그것만 쓴다. Orca 터미널은 이 값을 Orca 폴더로 바꿔 두므로, Orca 안에서 띄운 OpenCode 는 `~/.config/opencode` 의 플러그인·규칙을 안 읽을 수 있다(실측 안 함).
- 같이 깔린 플러그인 타입(`~/.config/opencode/node_modules/@opencode-ai/plugin`)은 1.0.220 그대로라 v2 를 설명하지 않는다.

## 남은 일

- 실측: Codex `CODEX_THREAD_ID` = 훅 `session_id` 인지, Codex 샌드박스에서 소켓 접근, Cursor 훅이 CLI 에서 실제로 도는지, OpenCode v2 플러그인에서 막기가 모델에게 어떻게 보이는지.
- **구현함 (2026-10-05)** — Copilot CLI·Codex·Cursor·Gemini CLI: 세션 ID 로 세션 묶기(`shared/session.ts`), 훅 어댑터(`hook/adapters.ts`), 보호·MCP 설치(`install/agents.ts`), 스킬은 `~/.agents/skills` 에도, 설정 창 «다른 에이전트». **실제 에이전트로는 아직 확인하지 않았다.** OpenCode 는 뺐다.
- 조사 중 생긴 것: Copilot 시험 세션 기록 4개(`~/.copilot/session-state/`, 2026-10-05 15:12~15:13), OpenCode `service status` 가 만든 `~/Library/Application Support/orca/opencode-hooks/shared/service.json`(17:26) — 지울지 사용자 결정.
