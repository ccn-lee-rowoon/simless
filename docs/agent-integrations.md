# 다른 에이전트 연결 조사 (Q16)

2026-10-05 조사. Claude Code 처럼 훅(P3)·스킬(S9)·규칙(P2)·MCP(R12)를 붙일 수 있는지.
표시: **[L]** 이 Mac 의 설치본으로 확인 · **[D]** 문서만 · **[S]** 원본 소스(GitHub main) · **[?]** 미확인.

## 요약

| 에이전트 | 훅(실행 직전 막기) | 스킬 | 전역 규칙 | MCP | 세션 구분 |
| --- | --- | --- | --- | --- | --- |
| Codex CLI 0.160.0 | ✅ `PreToolUse` — Claude 와 거의 같은 형식 | `~/.agents/skills` | `~/.codex/AGENTS.md` | `codex mcp add` | `CODEX_THREAD_ID` [?] — 부모 프로세스로는 불안정 |
| Gemini CLI 0.16.0 (설치본) | ❌ 이 버전은 훅이 실행되지 않음 — **0.26.0 이상 필요** | ❌ (새 버전은 `~/.agents/skills`) | `~/.gemini/GEMINI.md` | `gemini mcp add -s user` | 셸 명령에 세션 ID 없음 — 훅만 앎 |
| Copilot CLI | 조사 중 | | | | |
| Cursor | 조사 중 | | | | |
| OpenCode | 조사 중 | | | | |

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

## 남은 일

- Copilot CLI·Cursor·OpenCode 조사 결과를 채운다.
- 실측: Codex `CODEX_THREAD_ID` = 훅 `session_id` 인지, Codex 샌드박스에서 소켓 접근.
- Gemini 는 업그레이드할지 사용자 결정.
