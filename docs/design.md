# Simless 설계안 (v0.3 — 2026-10-05 사양 변경 반영)

> `requirements.md` 가 «무엇을», 이 문서가 «어떻게» 다. 둘이 충돌하면 `requirements.md` 가 이긴다.
> 설계를 바꾸면 이 문서를 고치고, 이유가 있는 결정은 맨 아래 «설계 결정 기록» 에 남긴다.
> 요구사항 ID(R·M·S·P·Q)는 `requirements.md` 를 가리킨다.

## 1. 한눈에 보기

```
 에이전트 A (Claude·Codex…) ── simless <명령> ──────────┐
 에이전트 B ───────────────── simless mcp ─────────────┤ Unix 소켓 (JSON Lines) — 상태를 바꾸는 요청은 여기로만
 에이전트의 실행 전 훅 ───── simless hook <에이전트> ──┤
                                                     ▼
                  simless serve  (launchd 가 띄우고, 죽으면 다시 살림)
                  ├─ 디바이스 목록 (이 Mac 전부 — 드라이버에서 읽음) + 레지스트리 (simless 가 붙인 정보)
                  ├─ 그룹·기본 디바이스
                  ├─ 점유·대기 관리
                  ├─ 드라이버 — Android: emulator·adb·avdslim / iOS: simctl·simslim
                  └─ HTTP 127.0.0.1 ── 웹 화면 (Simless.app 창 · 브라우저) · 메뉴바
                                   ▼
                  에뮬레이터 · 시뮬레이터  ◀── 화면 안 조작·테스트는 프로젝트의 도구 (S6·P10)
```

- 실행 파일은 **`simless` 하나**다. `serve`·`hook`·`mcp`·나머지 CLI 명령이 모두 서브커맨드고, 사람이 여는 `Simless.app` 도 같은 파일을 담은 껍데기다(§4).
- 상태는 **서버 하나만** 갖는다. 나머지는 요청을 보내는 창구라 상태가 없다(구조 전제).

## 2. 기술 선택

| 항목 | 선택 | 메모 |
| --- | --- | --- |
| 언어·런타임 | TypeScript · Bun | 개발·빌드용 Bun 버전은 `mise.toml` 로 고정 (현재 1.3.6). 받는 Mac 에는 Bun 이 필요 없다 |
| 배포 | `bun build --compile --minify --bytecode` **단일 실행 파일** (`darwin-arm64`, `bun run build` → `dist/simless`). 개발 중에는 `bun link` 로 `.ts` 를 바로 실행 | 약 55MB. 훅 경로 시작 약 21ms(0단계 실측, `--bytecode` 없이 약 26ms). 새 바이너리의 첫 실행만 macOS 검사로 약 1초. **`--bytecode` 는 CJS 만 지원 → 최상위 `await` 를 쓰지 않는다** |
| CLI 인자 | `commander` | 서브커맨드·`--help` 정리 |
| 검증·타입 | `zod` 4 | 설정·소켓 메시지·저장 파일 스키마를 한 곳에서 정의하고 타입도 뽑는다. MCP SDK 도 쓴다 |
| 프로세스 정보 | `bun:ffi` 로 macOS libproc(`proc_pidinfo`·`proc_pidpath`) 호출 | 세션 찾기(§7)·종료 감지. `ps` 는 한 번에 20~80ms, FFI 는 약 3ms(실측) — 훅이 Bash 마다 돌기 때문 |
| 기록 저장 | `bun:sqlite` | macOS 에 든 SQLite 를 Bun 이 쓴다 — 단일 실행 파일에 더할 것이 없고, Bun 이 없는 환경에서도 돈다(실측). 기록만 SQLite, 설정·레지스트리·점유는 JSON(«결정 기록») |
| MCP | `@modelcontextprotocol/sdk` (6단계) | stdio. zod 4 를 그대로 받는다. 단일 실행 파일이 약 3.4MB 커졌다(65→68MB) |
| 웹 화면 | React + Bun 내장 번들러(HTML import) | Vite 없이 `Bun.serve` 가 서빙. `Simless.app` 창(WKWebView)과 브라우저가 같은 화면을 연다 |
| 플랫폼 로고 | `simple-icons` (CC0) | 애플·안드로이드 로고 경로 두 개만 쓴다(번들에도 그 둘만 들어간다). 손으로 그리면 모양이 어긋난다 |
| 현지화 | 의존 없이 `src/shared/i18n/` 의 사전(`ko`·`en`) | 웹 화면·CLI 가 같은 사전을 쓴다. 메뉴바(Swift)는 문구가 적어 Swift 안에 따로 둔다 |
| 테스트 | `bun test` | |
| 포맷·린트·타입 | Biome · `tsc --noEmit` | |
| 메뉴바·앱 창 | Swift 소스(AppKit + WKWebView)를 바이너리에 넣고 `simless install` 때 `xcrun swiftc` 로 컴파일해 `Simless.app` 에 넣는다 | 서명·공증 불필요 |

외부 의존은 위 목록으로 제한하고, 늘릴 때는 이 표에 이유를 적는다.

## 3. 저장소 구조

결과물이 실행 파일 하나라 **패키지도 하나**다(모노레포로 나누지 않는다). 무엇을 고칠 때 어디를 보는지는 `docs/development.md`.

```
simless/
├── package.json · bun.lock · tsconfig.json · biome.json · mise.toml
├── bin/simless.ts             `#!/usr/bin/env bun` — 개발용 진입점(`bun link` 가 가리킴), src/main.ts 로
├── src/
│   ├── main.ts              진입점 — 서브커맨드별로 필요한 모듈만 동적 import (훅이 빨리 끝나게)
│   ├── shared/              모두가 쓰는 것 — 모델(model)·메시지 모양(api·protocol)·경로(paths)·설정(config)·
│   │                        소켓 클라이언트(client)·세션 찾기(session)·외부 명령(exec)·i18n(ko 정본, en)·
│   │                        훅이 보는 범위(hook-scope — 에이전트 훅 matcher, P10)
│   ├── install/             설치·점검 — CLI 와 서버(첫 실행 설정 창)가 같이 쓴다
│   │   ├── launchd.ts       서버 LaunchAgent 등록·kickstart
│   │   ├── app-bundle.ts    Simless.app 만들기(Swift 컴파일·서명·로그인 항목)
│   │   ├── self.ts          설치한 simless 를 버전 폴더에 두고 ~/.local/bin/simless 링크(R19)
│   │   ├── skill.ts         스킬 설치 위치(전역·프로젝트)·상태 (S9)
│   │   ├── claude-hook.ts   Claude Code 훅·규칙 (P2·P3)
│   │   ├── claude-mcp.ts    Claude Code MCP 등록 (R12)
│   │   └── checks.ts        점검 — simless doctor 와 설정 창의 «이 Mac 점검» (S1·S2)
│   ├── server/              상주 서버 — 상태를 갖는 유일한 곳
│   │   ├── index.ts         simless serve — 소켓·HTTP 시작, 2초 tick
│   │   ├── app.ts           SimlessServer — 디바이스 목록(드라이버 + 레지스트리)·status·알림·메서드 표
│   │   ├── devices.ts · groups.ts · lease-methods.ts · settings.ts · setup.ts · hook.ts
│   │   │                    메서드 묶음 — 각자 registerXMethods(server) 로 붙는다
│   │   ├── leases.ts        점유·대기열·교착·자동 해제 (순수 로직, 저장은 콜백)
│   │   ├── registry.ts      Simless 가 붙인 정보(슬림·만든 여부)·그룹·기본 디바이스 — JSON
│   │   ├── history.ts       점유 기록 — SQLite
│   │   ├── drivers/         android.ts · ios.ts · types.ts(Driver) · android-profiles.ts
│   │   ├── socket.ts · http.ts · params.ts(매개변수 검사) · store.ts(JSON 읽고 쓰기)
│   ├── builds/              네이티브 빌드 캐시 (R26) — 지문 계산·보관·정리·방금 빌드한 것 찾기. CLI 가 쓴다
│   ├── cli/                 Simless 명령 — index.ts(commander) + commands/*.ts, 서버와는 소켓으로만
│   ├── hook/                훅 — 대상 추출(targets.ts, 순수 함수) + 판정 요청 + 서버 꺼짐 처리
│   ├── mcp/                 MCP 서버(stdio) — 소켓으로 서버 메서드를 부른다
│   └── web/                 웹 화면(React) — main.tsx(창 고르기) · *View.tsx · ui.tsx · styles.css
├── tray/SimlessTray.swift     메뉴바 아이콘 + 앱 창(WKWebView) — 로직 없음, HTTP 로 status 만 읽는다
├── test/                    *.test.ts — 가짜 드라이버(helpers.ts)로 서버를 띄워 시나리오를 검증
├── integrations/            이 Mac 의 다른 도구에 설치하는 것
│   ├── skill/simless/SKILL.md          → ~/.claude/skills/simless (또는 프로젝트)
│   └── rules/simless.md                전역 규칙 (P2) → ~/.claude/rules/simless.md
├── scripts/                 build.ts(단일 실행 파일 → dist/simless, 설치 파일 → dist/simless-<버전>-install.sh) · trace.ts(요구사항 ↔ 테스트) · icon.sh
├── docs/                    design.md(이 문서) · protocol.md(메시지) · development.md(개발 가이드) ·
│                            agent-integrations.md(다른 에이전트 조사)
├── README.md                처음 보는 사람용 — 무엇을 하나·설치·쓰는 법
├── requirements.md · HANDOFF.md
├── SECURITY.md              지키는 것·지키지 않는 것·고칠 때 지킬 보안 규칙
├── AGENTS.md                작업 규칙 정본 (커밋 규칙 포함) — 모든 에이전트
└── CLAUDE.md                Claude Code 용 — AGENTS.md 를 불러온다
```

**폴더 경계** — `test/architecture.test.ts` 가 지킨다.

| 폴더 | import 해도 되는 것 |
| --- | --- |
| `shared` | (없음) |
| `install` | `shared` |
| `server` | `shared` · `install` (예외: `http.ts` 가 웹 화면 묶음 `web/index.html`) |
| `builds` | `shared` |
| `cli` | `shared` · `install` · `builds` (예외: `simless serve` 가 `server/index.ts`) — 나머지는 소켓으로만 |
| `hook` · `web` | `shared` |
| `mcp` | `shared` · `install`(서버를 켜려고 `launchd`) |

- `integrations/`·`tray/`·웹 UI·`Info.plist` 틀은 **실행 파일 안에 넣는다**. 코드에서 파일을 경로로 찾지 말고 `import … with { type: "file" }`·HTML import 로 불러온다 — 그래야 `bun link`(개발)와 단일 실행 파일(배포)에서 같은 코드가 돈다. `simless install` 이 꺼내 설치한다.

## 4. 설치·실행

| 명령 | 하는 일 |
| --- | --- |
| (배포) | 설치 파일 `simless-<버전>-install.sh` 하나를 메신저·드라이브로 나눈다(`bun run release` 가 만든다 — §19). 받는 사람은 어디서든 `bash <파일>` → 안의 실행 파일을 sha256 으로 확인하고 임시 폴더에 꺼내 `simless install`. 혼자 개발할 땐 저장소에서 `bun link` |
| `simless install` | (단일 실행 파일이면 먼저) 자기를 `~/.local/share/simless/versions/<버전>/simless` 에 복사하고 `~/.local/bin/simless` 링크를 바꾼다 — 아래에 적는 경로는 모두 이 링크, 받은 파일은 지워도 된다(R19). 이미 넣어 둔 훅·MCP 가 예전 경로를 가리키면 새 경로로 고친다 — `--hook`·`--mcp` 로 고른 에이전트가 아니어도 모두 보고, 넣어 두지 않은 것은 넣지 않으며, 한 에이전트를 못 고치면(지운 에이전트의 설정이 남은 경우 등) stderr 에 알리고 이어 간다. 사람이 터미널에서 실행하면 맨 위에 로고(M12). 그다음 LaunchAgent(`~/Library/LaunchAgents/simless.server.plist`, `RunAtLoad`·`KeepAlive`) 등록 → 서버 시작. launchd 는 로그인 셸 PATH 를 안 받으므로 **`simless`·Android SDK 경로를 절대 경로로** 적는다. 스킬 설치, `~/Applications/Simless.app` 생성 → 앱을 띄우면 **첫 실행 설정 창**(M14)이 뜬다. 보호(훅·규칙)와 MCP 는 그 창에서 고른다 — 터미널만 쓸 때는 `--hook`·`--mcp`. 훅·MCP 명령은 절대 경로로 적는다 |
| 제거 (S12) | `simless uninstall` 또는 설정 창 «Simless 제거» — 둘 다 `src/install/uninstall.ts`. 순서는 에이전트 연결(스킬·훅·규칙·MCP) → 앱·메뉴바 → (`--purge`) 데이터 폴더 → 서버 등록. 창에서 할 때는 서버(`setup.uninstall`)가 에이전트 연결을 지우고 답한 뒤, 1.5초 뒤 앱·데이터를 지우고 plist 를 먼저 지운 다음 자기를 `bootout` 한다(내리는 순간 프로세스가 끝나므로). 만든 디바이스와 `simless` 명령 자체는 남긴다 |
| `simless uninstall` | 위를 되돌린다(훅·규칙·MCP 등록 포함). 만든 디바이스는 지우지 않는다 |
| 첫 실행 설정 (M14) | 앱이 뜰 때 `status.setupNeeded` 면 설정 창(`?window=setup`)을 연다 — ① 이 Mac 점검(`simless doctor` 와 같은 점검. 점검 결과의 `action` 이 있으면 «설치·업데이트·열기» 버튼 — `setup.run` 이 `install/fixes.ts` 에 정해 둔 명령만 뒤에서 돌리고(`server/jobs.ts`, 묻지 않는 모드 `NONINTERACTIVE=1`·`HOMEBREW_NO_AUTO_UPDATE=1`), 출력은 SSE `output` 으로 한 줄씩, 상태는 `job` 으로. 출력에 «trust» 가 있으면 `brew trust` 후 다시. 끝나면 다시 점검. 실패하면 «터미널에서 열기»(osascript 로 Terminal 에 같은 명령). 버튼으로 못 고치는 것만 복사 버튼) ② 에이전트 연결(스킬 권장 · 보호 권장 · MCP 선택 — 버튼 하나로 설치·제거, 서버가 한다. 아래 «다른 에이전트»(Copilot CLI·Codex·Cursor·Gemini CLI)는 «실험적» 표시. 표시 색은 권장 초록·선택 테두리만·실험적 주의색. 상태를 읽는 동안은 도는 원, 누른 버튼에는 끝날 때까지 작은 도는 원) ③ 기본 디바이스(없으면 목록에서 고르거나 생성 창). «완료» 면 `setup.json` 을 남기고 대시보드를 연다. 끝내지 않고 닫으면 다음에 또 뜬다. 설정 창에서 다시 연다 |
| `Simless.app` | 메뉴바 앱 + 앱 창(§14). `tray/SimlessTray.swift` 를 컴파일한 실행 파일 + `Info.plist`(`LSUIElement` — 평소엔 Dock 아이콘 없음) + 아이콘, ad-hoc 서명. 더블클릭·Spotlight·Launchpad 에서 연다. Xcode 가 없어 컴파일을 못 하면 브라우저로 웹 화면을 여는 스크립트로 대신한다 |
| 로그인 항목 이름 | macOS 로그인 항목(«앱 백그라운드 활동»)에는 실행 파일 서명자 이름이 보인다 — 개발 모드는 bun 의 «Jarred Sumner». `Simless.app` 을 만들 때(3단계) plist 에 `AssociatedBundleIdentifiers` 로 앱을 연결해 «Simless» 로 보이게 한다. 사용자가 이 항목을 끄면 launchd 가 서버를 띄우지 않으므로 `simless doctor` 가 확인한다 |
| 서버 자동 시작 (Q10) | CLI·MCP 는 소켓이 없으면 `launchctl kickstart` 로 켜고 몇 초 기다린다. 훅은 켜지 않는다 |
| 업데이트 | `simless update`(U단계 — 아직 없음) — 확인·알림·교체·되돌리기는 §19. 클라이언트·서버 버전이 다르면 요청·응답의 `clientVersion`·`serverVersion` 으로 알린다(§11) |

## 5. 런타임 파일 위치

| 경로 | 내용 | 쓰는 쪽 |
| --- | --- | --- |
| `~/Library/Application Support/Simless/registry.json` | 디바이스에 Simless 가 붙인 정보(슬림·남길 항목·슬림 내역·만든 여부·기준값, 메모는 저장만 — R24 보류), 그룹, 기본 디바이스 (영속). 기기 자체 목록은 저장하지 않는다(§6) | 서버 |
| `…/Simless/leases.json` | 점유·대기열 — 서버를 다시 켜도 복원 | 서버 |
| `…/Simless/history.db` | 점유 기록 — SQLite(`bun:sqlite`, WAL). 사건마다 한 줄 덧붙이고, 보관 기간(`historyRetentionDays`, 기본 90일)이 지난 것은 서버가 한 시간마다 지운다 (M13). 예전 `history.json` 은 처음 켤 때 옮기고 `history.json.migrated` 로 남긴다 | 서버 |
| `…/Simless/managed-index.json` | 이 Mac 디바이스 식별자(UDID·AVD ID·마지막 시리얼). **서버가 꺼졌을 때 훅이 읽는다** | 서버 쓰기 / 훅 읽기 |
| `…/Simless/simless.sock` | 소켓 (권한 0600) | 서버 |
| `…/Simless/web-token` | 웹 화면 요청 토큰 (0600) | 서버 |
| `…/Simless/setup.json` | 첫 실행 설정을 끝낸 시각 (M14) | 서버 |
| `…/Simless/skills.json` | 스킬을 넣어 둔 위치(전역·프로젝트) (S9) | CLI·서버 |
| `…/Simless/update.json` | 마지막 확인 시각·최신 버전·알림 보낸 버전 — **U단계, 아직 없음** | 서버 |
| `~/Library/Logs/Simless/` | 서버 로그 | 서버 |
| `~/.local/share/simless/versions/<버전>/simless` · `~/.local/bin/simless`(링크) | 설치된 버전들과 지금 쓰는 버전 (§19) | `simless update` |
| `~/Library/Caches/Simless/builds/<앱>/<플랫폼>/<지문>/` | 캐시된 네이티브 빌드(.app·.apk) + `meta.json`. 앱·플랫폼마다 최근 5개 (R26). `SIMLESS_BUILD_CACHE` 로 바꿀 수 있다 | CLI |
| `~/.config/simless/config.json` | 사용자 설정 — 언어(`system`·`ko`·`en`, 기본 `system`), 자동 해제 시간(기본 30분), HTTP 포트, Android SDK 위치·RAM·에뮬레이터 옵션, simslim 프로필 경로. 앱 창의 설정 화면이 고친다 | 사람·서버 |
| `~/.config/simless/apps/<name>.json` | 앱별 설정 (Q8) | 사람 |
| `~/.android/avd/<AVD ID>.avd` · `.ini` | Android 디바이스 본체 — Simless 가 만든 것은 `simless_<id>` | Android Studio·서버 |
| CoreSimulator 기본 device set | iOS 디바이스 본체 | Xcode·서버(simctl) |

## 6. 모델

**디바이스 목록은 저장하지 않는다** (R20). 이 Mac 의 디바이스는 서버가 드라이버에서 그때그때 읽고(전부 — 생성 화면의 «이 Mac 의 디바이스» 에 쓴다), 메인 목록·점유·보호는 그중 `listed`(simless 목록)만 다룬다(Android `~/.android/avd/*.ini`, iOS `simctl list devices available`), 레지스트리에는 **Simless 가 붙인 정보만** 둔다. Xcode·Android Studio 에서 기기를 지우거나 만들어도 바로 맞는다.

**Device** (서버가 합쳐서 보여 주는 값)

| 필드 | 출처 | 설명 |
| --- | --- | --- |
| `id` | 레지스트리 | Simless 가 붙이는 짧은 ID(예: `k3f9`). 처음 본 기기에 붙이고 **절대 안 바뀐다** (R4). 그룹·점유·메모는 이 ID 를 가리킨다 |
| `platform` | 드라이버 | `android` / `ios` |
| `native` | 드라이버 | Android AVD ID · iOS UDID — 이름을 바꿔도 그대로. 레지스트리는 이 값으로 기기와 `id` 를 잇는다 |
| `name` | 드라이버 | 표시 이름 (Android `avd.ini.displayname`, iOS 시뮬레이터 이름) |
| `spec` | 드라이버 | Android `widthPx·heightPx·density·systemImage` · iOS `deviceType·runtime·widthPt·heightPt·scale` |
| `createdBySimless` | 레지스트리 | Simless 가 만든 기기 — 삭제·슬림 켜고 끄기는 이것만 (M7·M8·N5) |
| `listed` | 레지스트리 | Simless 목록에 있는지 (R20). 만든 기기는 늘, 원래 있던 기기는 생성 화면에서 추가했을 때만. 값이 없으면(이전 형식) `createdBySimless` 와 같다. 빼면 그룹 소속·기본 지정·점유도 푼다 |
| `slim` | 레지스트리 | `none`·`applying`·`applied`·`failed` (+ `slimError`). 풀림은 켤 때 자동 재적용하므로 따로 두지 않는다 (M6) |
| `slimBaseline` | 레지스트리 | 슬림 전 메모리 기준값 (M10) |
| `slimKeep` | 레지스트리 | 슬림해도 남길 항목 ID — 없으면 UI(전체 슬림) (M15) |
| `slimMode` | 레지스트리 | 남길 항목이 어디서 왔나 — `app`(에이전트가 앱 프로젝트에서 찾음) · `custom`(없으면 이것). 남길 것이 없으면 두지 않는다. 방식 이름 UI·App·Custom 과 보이는 방식(`DeviceView.slimMode` — none·ui·app·custom, 상태와 출처로 계산)은 `src/shared/slim-mode.ts` (M15) |
| `slimSeen.off` | 레지스트리 | 켜져 있을 때 실제로 읽은 꺼진 슬림 항목 ID — `DeviceView.slimOff`(못 읽었으면 `slimKeep` 으로 계산, `slimOffObserved: false`) (M16) |
| `slimSeen` | 레지스트리 | 켜져 있을 때 마지막으로 읽은 슬림 수치 `{ disabled, total, unit, seenAt }` — 누가 슬림했든 적는다. 값이 같으면 10분에 한 번만 쓴다 (M6) |
| `memo` | 레지스트리 | 디바이스 메모 — R24 보류: 저장만 하고 화면·CLI·스킬에는 보이지 않는다 |
| `default` | 레지스트리 | 이 플랫폼의 기본 디바이스인지 (R22) |
| `groups` | 레지스트리(그룹) | 든 그룹 ID 목록 (R21) |
| `createdAt` | 레지스트리 | Simless 가 처음 본(또는 만든) 시각 |

- **기기가 사라지면 붙인 정보도 지운다** — Simless 로 지웠을 때, 그리고 밖(Xcode·Android Studio)에서 지워 드라이버 목록에 없을 때 그 `id` 의 메모·슬림 정보·그룹 소속·기본 지정을 지운다. 밖에서 지운 경우는 **목록 읽기가 성공했을 때만** 지운다(`simctl` 오류로 빈 목록이 오면 지우지 않는다).
- Android AVD ID 는 Simless 가 만든 것만 `simless_<id>` 다. 표시 이름은 슬림이면 `simless …` 접두사(R5), 슬림을 나중에 켜고 꺼도 이름은 그대로.
- 이름은 만들 때만 정한다 — Simless 에는 이름 변경이 없다(다른 도구가 이름으로 찾는다, «결정 기록»). 밖에서 바뀐 이름은 목록을 읽을 때 따라간다.
- iOS 폭(pt) = `/Library/Developer/CoreSimulator/Profiles/DeviceTypes/<종류>.simdevicetype/Contents/Resources/profile.plist` 의 `mainScreenWidth ÷ mainScreenScale` (확인: iPhone 17 → 1206 ÷ 3 = 402pt). M2 의 «폭 맨 앞» 에 쓴다.

**Group** (R21) — `id`, `name`(겹치지 않게), `description`(에이전트도 읽음, «모두 필요» 같은 힌트), `deviceIds[]`, `updatedBy`(마지막으로 고친 세션 — `human` 또는 에이전트 이름), `updatedAt`. 한 디바이스가 여러 그룹에 들 수 있다.

**기본 디바이스** (R22) — `{ android?: deviceId, ios?: deviceId }`. 그 플랫폼에 기본이 없을 때 Simless 로 디바이스를 만들면 **그 디바이스가 자동으로 기본**이 된다. 사람·CLI 로 바꿀 수 있다. 기본이 없으면(만든 게 없거나 밖에서 지워짐) `NO_DEFAULT` 로 실패하고, data 에 플랫폼마다 디바이스 대수(`missing: [{platform, devices}]`)를 준다. 요청에 `create` 를 붙이면 **디바이스가 하나도 없는 플랫폼**만 추천 기종(Android `medium-phone`, iOS 가장 새 «iPhone N»)을 슬림으로 만들고(기준값 측정은 건너뜀) — 처음 만든 것이라 기본이 된다 — 이어서 점유한다. 디바이스가 있는데 기본이 없으면 사람이 고른다.

실행 중 값(켜짐 여부, Android 시리얼)은 저장하지 않고 서버가 들고 있다.

**Session** — `id`(§7 세션 키), `agent`(표시용 — `claude-code`·`codex`·`gemini`·…·`human`·`unknown`), `pid`·`pidStartedAt`, `agentSessionId`(어댑터가 주면), `cwd`(표시용 — 지금 작업 폴더, §7), `cwdKind`(없으면 지금 폴더 · `workspace` MCP roots · `launch` MCP 를 띄운 폴더, §7), `lastUsedAt`

**Lease** — `deviceId → sessionId, acquiredAt` · **대기열** — `[{sessionId, deviceIds, enqueuedAt}]` (디바이스마다 FIFO)

## 7. 세션 구분 (R13·R18)

세션 = **명령을 실행한 에이전트 프로세스**. 에이전트가 세션 ID 를 주는지와 상관없이 프로세스 트리를 거슬러 올라가 찾는다. CLI·MCP 서버·훅은 모두 에이전트가 띄운 자식이라 같은 방법으로 같은 세션이 나온다 — 에이전트 종류에 묶이지 않는다.

**찾는 순서** (`simless` 프로세스의 부모부터 위로)

| 순서 | 조건 | 세션 |
| --- | --- | --- |
| 1 | `--session <값>` 또는 `SIMLESS_SESSION_ID` 가 있음 | 그 값 (스크립트·특수한 에이전트용). 프로세스 기준 해제가 필요하면 `SIMLESS_SESSION_PID` 도 준다 |
| 2 | 셸·래퍼(`zsh`·`bash`·`sh`·`fish`·`env`·`timeout`·`sandbox-exec` 등)를 건너뛰고 처음 만난 프로세스가 **공용 호스트가 아님** | 그 프로세스 = 에이전트 (`claude`·`codex`·`gemini`·`node …` 등) |
| 3 | 처음 만난 셸 아닌 프로세스가 **공용 호스트**(`login`·`tmux`·`screen`·터미널 앱·IDE 의 Helper — `Terminal`·`iTerm2`·`Ghostty`·`Code Helper`·`Cursor Helper`·`Orca Helper` …) | 호스트 바로 아래 셸 = 터미널 탭 하나. 에이전트 표시 변수가 있으면 에이전트, 없으면 `human` |

- 세션 키 = `pid` + 프로세스 시작 시각 (PID 재사용 구분). 셸·래퍼·호스트 목록은 설정으로 늘릴 수 있다.
- 실측(이 Mac): `simless ← zsh ← claude ← zsh ← zsh ← login ← Orca Helper` → 2번, 세션은 `claude`. argent MCP 서버(`argent mcp`)의 부모도 `claude` 였다.

**에이전트 종류** — 표시용, 판정에는 쓰지 않는다: `AI_AGENT` 환경 변수(확인: `claude-code_2-1-287_agent`) → 에이전트별 표시 변수(`CLAUDECODE` 등) → 프로세스 이름·명령줄 → `unknown`.

**에이전트 어댑터** — 있으면 더 정확해지는 보조 정보. 없어도 위 방식만으로 동작한다.
- 에이전트 세션 ID 로 키 만들기: Copilot CLI(`COPILOT_AGENT_SESSION_ID`)·Codex(`CODEX_THREAD_ID`)·Cursor(`CURSOR_CONVERSATION_ID`)는 셸 명령에 세션 ID 를 준다 — 이 값이 있으면 세션 키를 `s:<에이전트>:<ID>` 로 만들고(프로세스는 살아 있는지 보는 데만), 훅은 입력의 세션 ID 로 같은 키를 만든다(`hook/adapters.ts`). Codex 는 셸을 공용 데몬 아래에서 돌려 부모 프로세스로는 세션이 섞인다. Gemini CLI 는 셸에 주지 않아 프로세스로 찾는다.
- 보조 세션 ID: Claude Code 는 CLI 에 `CLAUDE_CODE_SESSION_ID`, 훅 입력에 `session_id` 를 준다. 기록해 두고, **같은 프로세스에서 값이 바뀌면**(`/clear` 등) 새 세션으로 보고 이전 점유를 푼다 — 새 대화는 자기가 점유했다는 걸 모르기 때문.
- 실행 직전 훅: §13.

**작업 폴더** (M13) — 화면·기록에 보이는 세션의 `cwd` 는 «에이전트가 지금 일하는 폴더» 다. 보내는 쪽마다 아는 것이 달라, 더 정확한 값을 덜 정확한 값으로 덮지 않는다.

| 보내는 쪽 | 폴더 | 정확한가 |
| --- | --- | --- |
| CLI | 명령을 실행한 셸의 폴더(`process.cwd()`) — 부를 때마다 새로 뜬다 | 지금 폴더 |
| 훅 | 에이전트가 훅 입력에 주는 `cwd`(Claude Code·Codex·Copilot·Gemini, Cursor 는 셸 호출만). 없으면 훅 프로세스의 폴더 | 지금 폴더 |
| MCP | 요청마다 MCP **roots** 의 첫 `file://` (`mcp/folder.ts`, `cwdKind: "workspace"`). 클라이언트가 roots 를 지원하지 않거나 답하지 않으면 MCP 서버를 띄운 폴더(`cwdKind: "launch"`) | roots 는 작업 공간 단위, 띄운 폴더는 처음 폴더 |

- MCP 서버는 에이전트를 켤 때 한 번 떠서 처음 폴더에 머문다. 대화 도중 worktree 로 옮겨 가면 `process.cwd()` 는 그대로라, 예전에는 같은 세션이 CLI 로 부르면 worktree, MCP 로 부르면 처음 폴더로 번갈아 보였다(터미널·에이전트와 상관없음).
- 실측(2026-10-12, Claude Code): roots 기능(`listChanged`)을 켜 두고, `EnterWorktree` 뒤에는 roots 를 `<저장소>/.claude/worktrees/<이름>` 으로 바꾼다. MCP 서버의 폴더는 처음 그대로였다. 같은 날 이 브랜치의 서버(가짜 드라이버)와 실제 Claude Code 로 MCP 점유 → 셸 `cd sub` 뒤 CLI → MCP → `EnterWorktree` → MCP → CLI → 훅(`adb -s …`) → MCP 를 차례로 불러, 서버가 기억한 폴더가 `<저장소>` → `sub` → `sub` 유지 → worktree 로 이어지는 것을 확인했다(Claude Code 의 권한 검사는 `cd` 와 쓰기가 섞인 셸 명령을 막아, 폴더는 미리 만들어 둠).
- 서버(`leases.touch` 의 `keepFolder`)는 덜 정확한 값이 더 정확한 값을 덮지 않게 한다 — 지금 폴더는 늘 따르고, `workspace` 는 앞서 받은 지금 폴더가 그 안이면(셸 `cd` 로 하위 폴더·worktree) 두며, `launch` 는 아무것도 덮지 않는다(처음부터 `launch` 뿐이면 그 값을 보인다 — 더 나은 정보가 없다).
- roots 요청은 2초 안에 답이 없으면 그 MCP 서버가 사는 동안 다시 묻지 않는다(요청마다 기다리지 않게).
- 한계: roots 를 바꾸지 않는 이동(셸의 `cd`)은 MCP 만 쓰는 세션에서 따라가지 못한다 — CLI·훅이 한 번이라도 부르면 맞춰진다. 반대로 하위 폴더에서 작업 공간 맨 위로 `cd` 해 돌아가고 MCP 만 부르면 하위 폴더가 남는다(roots 만으로는 돌아간 것을 알 수 없다).

**사람·앱 창** — `human` 세션은 프로세스 기준 해제를 하지 않고 30분 규칙만 적용한다. 앱 창·브라우저의 웹 화면은 항상 `human`.

**한계** — 여러 대화가 프로세스 하나를 같이 쓰는 에이전트(IDE 안 에이전트 등)는 대화가 아니라 프로세스·터미널 단위로 구분된다. 필요하면 1번으로 보완한다.

## 8. 점유·대기 (R13·R14·R17·R23)

- **단위는 디바이스**. 요청은 디바이스(ID·이름), 그룹(`--group`), 기본 디바이스(`--default [android|ios]`)로 한다. 그룹·기본은 서버가 디바이스 목록으로 풀어서 같은 방식으로 처리한다.
- 같은 세션이 다시 요청하면 그대로 통과(재진입).
- **응답에 기기마다 상태**를 싣는다: `held`(이 세션이 잡음) · `free` · `busy`(누가·언제부터) · `queued`(대기 순번). 에이전트는 이걸 보고 판단한다 (R23).
- **모드** — 여러 대를 요청할 때 무엇을 잡을지는 에이전트가 고른다

  | 모드 | CLI | 동작 | 쓰는 예 |
  | --- | --- | --- | --- |
  | `all` (기본) | — | 전부 비어 있을 때만 전부 잡는다. 하나라도 바쁘면 아무것도 안 잡고 실패(종료 코드 3) | 두 계정 확인 (2대가 다 있어야 함) |
  | `available` | `--available` | 비어 있는 것만 잡고, 바쁜 것은 상태만 알려 준다 | 레이아웃 체크 (있는 것부터) |
  | `available` + 대기 | `--available --wait` | 비어 있는 것을 잡고, 나머지는 대기열에 넣어 풀리면 서버가 잡아 준다 | 레이아웃 체크 (나머지도 곧 필요) |
  | `all` + 대기 | `--wait` | 전부 빌 때까지 기다렸다가 한 번에 잡는다 | 두 계정 확인을 기다려서라도 |

- **교착 막기 — 대기열에 넣을 때 검사**: 기다리는 요청은 모두 대기열로 받는다. 다만 대기열(먼저 온 순서)만으로는 «A 가 X 를 쥐고 Y 를 기다리고, B 가 Y 를 쥐고 X 를 기다리는» 교착을 막지 못한다 — 둘 다 이미 쥔 것을 놓지 않기 때문이다. 그래서 **대기열에 넣는 순간** «기다리는 기기의 주인이 (직간접으로) 내가 쥔 기기를 기다리는지» 를 따라가 순환이 생기면 넣지 않고 바로 `DEADLOCK`(누구와 엮였는지)을 돌려준다 — 교착이 생기기 전에 막는다. 그 세션은 쥔 것으로 진행하거나, 놓고 `all + 대기` 로 다시 요청한다. `all + 대기` 는 아무것도 쥐지 않고 기다리므로 순환을 만들지 않는다.
- **`--wait`**: 대기열에 넣고, 차례가 오면 **서버가 알아서 점유**해 준다. 대기 항목은 연결이 아니라 **세션**에 붙는다 → CLI 가 Bash 시간 제한으로 끊겨도 순번이 유지되고, 다시 `--wait` 하면 이어서 기다린다. MCP 의 «대기 중 → 다시 호출» 도 같은 방식이다.
- 대기는 **디바이스마다 먼저 온 순서** — 같은 디바이스를 먼저 기다리는 세션이 있으면, 그 디바이스가 비어 있어도 뒤에 온 세션(기다리기 없는 요청 포함)이 새치기하지 못한다. 겹치지 않는 디바이스는 대기열과 상관없이 잡는다.
- **자동 해제**
  1. 세션 프로세스 종료 → 바로. 2초 간격으로 PID 생존과 시작 시각(PID 재사용 거르기)을 확인한다. 대기열에서도 뺀다.
  2. `lastUsedAt` 후 30분(설정) 지나고 **대기열에 누가 있을 때만**.
- `lastUsedAt` 갱신: 그 세션의 CLI 요청, MCP 요청, 훅이 통과시킨 기기 호출(어느 도구든).
- **사람(앱 창)** 은 점유 없이 켜고 끈다. 다른 세션이 잡고 있으면 막는다.
- **강제 해제**: 사람만 — 앱 창 ⋯ «강제 해제»(`lease.forceRelease`, 확인 질문). CLI 에는 없다. 스킬·규칙에는 «에이전트는 하지 않는다» 로 적는다.

## 9. 디바이스 수명주기 (드라이버)

| 단계 | Android | iOS |
| --- | --- | --- |
| 목록 (R20) | `~/.android/avd/*.ini` + 각 `config.ini` 를 읽는다 | `simctl list devices available -j` + 기기 종류 profile.plist(폭) |
| 생성 — 고를 것 (M1) | 기종: **Android Studio 의 기기 정의** — `/Applications`·`~/Applications` 의 `Android Studio*.app/Contents/plugins/android/lib/sdklib.jar` 안 `devices.xml`·`nexus.xml`(폰·태블릿, `unzip -p` 로 읽음)과 사람이 만든 `~/.android/devices.xml`(`ANDROID_USER_HOME`), 없으면 대표 프로필(`android-profiles.ts`). 사람 정의 → Android Studio → 대표 프로필 순으로 합치고 같은 ID(정의 ID 를 `pixel-9` 처럼 바꾼 것)는 앞의 것. 워치·TV·자동차·XR·데스크톱(`tag-id`)은 뺀다. 10분 기억. 또는 직접 입력(폭·높이·밀도). OS: 설치된 시스템 이미지(추천: 4KB 페이지 → `google_apis`(Play Store 없음, 가장 가벼움) → API 높은 순 — device-slim 과 같게. 16KB 페이지 이미지는 RAM 을 4GB 아래로 못 줄여 그것뿐일 때만) | 기종: `simctl list devicetypes` 중 설치된 런타임이 지원하는 것. OS: 설치된 런타임(기본: 최신) |
| 생성 — 만들기 | `simless_<id>.ini` + `.avd/config.ini` 를 새로 쓴다(`hw.lcd.width/height/density`, `image.sysdir.1`) | `simctl create <이름> <종류> <런타임>` → UDID. `simctl clone` 은 앱·데이터가 따라와 쓰지 않는다 |
| 슬림화 (R5) | `avdslim tune-avd` + 켠 뒤 `avdslim on <시리얼>` | `simslim on <udid> --preserve-boot-state` |
| 슬림화하면 꺼지는 기능 (M4 — 생성 화면 «꺼지는 것 보기»·Custom 목록) | avdslim 프로필이 끄는 패키지 목록(`avdslim profiles`)을 사람이 읽을 이름으로 묶어 보여 준다 | simslim 프로필이 끄는 서비스 목록을 묶어 보여 준다(Siri·Spotlight·iCloud·Wallet …) |
| 슬림 확인 (M6) | 프로필 패키지 중 꺼진 비율 ≥ 50% | `simslim verify` — 켜진 기기만 가능 |
| 켜기 | `emulator -avd <AVD ID> -port <빈 포트> -no-snapshot-save` 를 서버와 분리(detached)해 실행. `sys.boot_completed == 1` 까지 대기 | `simctl boot` **한 대씩 순서대로** (동시 부팅 중단 오류 회피) + `simctl bootstatus` |
| 끄기 | 슬림을 바꾼(`simless slim`·만들기·풀림 재적용 — 켤 때마다 다시 거는 것은 빼고) 뒤면 `adb -s <시리얼> shell sync` 하고 바꾼 지 20초가 될 때까지 기다림 → `emu kill` (device-slim 시험: 바로 끄면 `off` 가 남지 않은 적이 있음. 바꾸지 않았으면 바로 끈다) | `simctl shutdown` |
| 삭제 (M8, Simless 가 만든 것만) | 끄고 `.avd`·`.ini` 삭제 | 끄고 `simctl delete` |

- **Android 시리얼을 서버가 정한다**: `-port` 로 켜면 시리얼이 `emulator-<port>` 로 정해진다. 밖에서 켠 경우는 `adb -s <시리얼> emu avd name` 으로 역조회한다.
- 에뮬레이터·시뮬레이터는 서버의 자식으로 묶지 않는다 — 서버가 재시작해도 디바이스는 계속 돈다.
- **슬림 확인과 자동 재적용** (M6): 슬림한 기기를 켤 때마다(서버 시작 시엔 켜진 것) 확인하고, 풀렸으면 바로 다시 적용한다. 실패하면 `slim: failed` + 이유를 남겨 `SLIM ⚠` 로 보인다. 원래 있던 기기(`createdBySimless: false`)는 슬림화하지 않는다 (N5).
- **Simless 밖에서 한 슬림** (M6): 켜진 기기는 모두(만든 것·추가한 것) 15초마다 슬림 수치를 뒤에서 읽고 `slimSeen` 에 적는다. `slim: none` 인데 슬림돼 보이면(iOS 는 끈 데몬이 하나라도, Android 는 프로필 패키지가 절반 이상 꺼짐 — 위 «슬림 확인» 과 같은 기준) `SLIM` 으로 보인다. 꺼진 기기는 `slimSeen` 으로 판단해 흐리게, «마지막 확인» 시각과 함께. 이 슬림은 다시 적용하지 않는다. 판단은 `observedSlim()`(`src/shared/api.ts`) 하나를 화면·CLI·MCP 가 같이 쓴다.
- **슬림 항목 고르기** (M15): 기기마다 `slimKeep`(남길 항목 ID)을 기억하고, 처음 슬림·변경·풀렸을 때 다시 적용 모두 이것으로 한다.
  - iOS: `simslim on --except <묶음,…>`. 설정의 simslim 프로필(`--profile`)은 UI(전체 슬림)일 때만 쓴다(둘은 함께 못 준다). 이미 슬림한 기기의 남길 묶음이 바뀌어도 새 `--except` 로 `on` 한 번(끌 것은 끄고 다시 남길 것은 켬, 재부팅 한 번 — device-slim 0.6.0 이 simslim 0.12.0 으로 확인). `simslim version` 이 0.12.0 보다 낮거나 읽히지 않으면 예전처럼 `off` 뒤 `on`. 확인은 `simslim verify --except …`.
  - Android: 항목은 `avdslim profiles` 의 패키지 묶음(이름에서 만든 ID, 예: `assistant-search`) + 기기 설정 `location`·`sync`·`bglimit`·`bluetooth`·`setup` + 하드웨어 `camera`·`audio`. 기기 안 정리는 `avdslim on --skip=<남길 설정>` → 남길 설정을 `avdslim enable <설정>` 으로 되돌림(`setup` 은 되돌리는 명령이 없다) → 남길 묶음의 설치된 패키지를 `avdslim enable <패키지>`. 이 순서라 남길 항목이 바뀌어도 풀지 않고 그대로 맞춰진다. 하드웨어는 `tune-avd` 뒤 `avdslim enable camera|audio <AVD>`, 소리를 남기면 켤 때 `-no-audio` 를 뺀다. 슬림 확인·수치는 남긴 패키지를 세지 않는다.
  - 앱에 필요한 기능 찾기는 스킬이 한다 — simless 스킬의 «Finding what the app needs»(device-slim 스킬 4단계·기능 표를 Simless 항목 ID 로 옮긴 것, `.device-slim.json` 을 같이 씀). Simless 는 남길 ID 만 받는다.
- **슬림 내역** (M16): 서버의 2초 주기 작업이 15초마다 켜진 기기 전부의 슬림 수치를 읽고(목록을 볼 때도), 수치가 바뀌었거나 내역이 없거나 10분이 지났으면 꺼진 항목을 읽어 `slimSeen.off` 에 적는다(적으면 기기 목록 캐시를 비운다). iOS 는 `simslim status <udid> --dropped` 의 묶음 ID. Android 는 avdslim 에 상태 조회가 없어 — 패키지 묶음은 설치된 패키지의 절반 이상이 꺼졌으면, `location`·`bluetooth`·`sync` 는 avdslim 이 바꾸는 기기 설정(`location_mode`·`bluetooth_on`·`auto_sync` 가 0), `camera` 는 config.ini 의 앞뒤 카메라가 `none`, `audio` 는 켤 때 `-no-audio` 를 줬거나 `hw.audioOutput=no`, `bglimit`·`setup` 은 읽을 수 없어 Simless 가 슬림했고 남기지 않았으면 꺼진 것으로. 앱 창은 목록 «슬림» 칸의 `SLIM ↗` 버튼이나 ⋯ «슬림 내역» 으로 창(대화 상자).
- 생성·슬림화는 멱등 — 이미 맞으면 아무것도 안 한다.

## 10. 앱 설치·실행·같은 화면 이동 (R8·R9·R10) — 기기마다, Simless 밖에서

simless 는 하지 않는다. 에이전트가 `simless list --json`(또는 `simless use --json`)에서 기기마다 **도구에 넘길 ID**(`targetId` — UDID·시리얼)와 **크기 라벨**(`label` — 예: `Android 360dp`)을 받아, 기기마다 한다 (S6, 결정 기록). 설치·실행은 플랫폼 도구로 스킬이 안내하고, 화면 조작·테스트는 프로젝트가 고른 도구로 한다(P10) — Simless 는 특정 도구를 전제하지 않는다.

| 할 일 | 무엇으로 | 비고 |
| --- | --- | --- |
| 앱 설치 | `xcrun simctl install`·`adb -s … install -r` (캐시가 있으면 `simless app install`) | Android APK·iOS 시뮬레이터용 .app |
| 앱 실행 | dev client 는 `xcrun simctl openurl`·`adb -s … shell am start -d <주소>`, 그 밖에는 `simctl launch`·`adb … monkey` | Android 는 `adb -s <시리얼> reverse tcp:8081 tcp:<내 Metro 포트>` 로 그 기기만 내 Metro 에 붙인다 — 스킬이 안내 (S11) |
| 같은 화면 | 딥링크, 딥링크 없는 화면은 프로젝트 도구의 흐름·테스트를 기기마다 | |
| 화면 확인·테스트 | 프로젝트 도구 | 크기 라벨을 붙여 보고 |

- Metro 는 **세션마다 따로** 띄운다 (S11) — 8081부터 비어 있는 포트에 자기 작업 폴더의 Metro 를 띄우고, 점유한 기기만 그 포트를 보게 한다. 앱은 언제나 `127.0.0.1:<세션 포트>` 로 Metro 에 붙고 Mac 의 LAN IP 는 쓰지 않는다(결정 기록) — iOS 시뮬레이터는 Mac 의 네트워크를 같이 써서 그대로 닿고, Android 에뮬레이터 안의 `127.0.0.1` 은 에뮬레이터 자신이라 `adb reverse tcp:<포트> tcp:<포트>` 가 Mac 으로 잇는다. Expo 가 `run:*` 로 열 때도 `REACT_NATIVE_PACKAGER_HOSTNAME=127.0.0.1` 로 LAN IP 대신 이 주소를 쓰게 한다. Metro 는 IPv4 로 띄우고(`--dns-result-order=ipv4first` — macOS 가 `[::1]` 에만 열면 앱이 못 붙는다) Metro 의 `/status`(`packager-status:running`)로 준비를 기다린다. Android 는 기기마다 `adb reverse` 를 자기 포트와 8081 둘 다 걸어 다시 빌드할 필요가 없고, 앱은 그냥 실행하지 않는다 — Expo dev client 는 포트를 넣은 주소로, Expo 없는 iOS 는 `RCT_jsLocation` 을 써 둔 뒤 실행한다. 실행한 뒤 앱에서(Android Dev 메뉴, iOS 는 Metro 로그의 «iOS Bundled») 붙었는지 확인하고, Metro 에 붙는 도구(디버거·프로파일러)에는 항상 그 포트를 넘긴다. 도구의 «8081 Metro 하나» 안내는 Simless 스킬이 덮어쓴다. 포트는 Simless 가 나눠 주지 않고 스킬이 비어 있는 것을 고른다 — 필요해지면 점유 대상으로 넣는다. 남의 Metro 는 끄지 않는다 (S7).
- 점유한 디바이스만 다룬다(어느 도구든) — 5단계 훅이 지킨다 (P1·P8·P10).

**네이티브 빌드 캐시 (R26)** — 설치의 예외. 캐시를 Simless 가 가지고 있어 설치도 Simless 가 한다.

1. `simless app install` — CLI 가 지금 폴더에서 위로 `node_modules/.bin/fingerprint` 가 있는 앱 프로젝트를 찾고, 이 세션이 점유한 켜진 기기의 플랫폼마다 `fingerprint fingerprint:generate --platform <p>` 로 지문을 계산한다(큰 앱 약 30초). 호출한 셸의 환경 변수 그대로 — 앱 설정이 환경에 따라 바뀌면 지문도 바뀐다.
2. 캐시(`~/Library/Caches/Simless/builds/<package.json name>/<플랫폼>/<지문>/`)에 있으면 서버의 `device.install` 이 기기마다 설치한다(iOS `simctl install`, Android `adb -s <시리얼> install -r -t`). 서버는 점유·켜짐·플랫폼을 확인한다.
3. 없으면 `hit: false` 와 빌드 명령(`npx expo run:<p> --device <targetId>`)을 돌려준다. 에이전트가 빌드한 뒤 `simless app save` 가 방금 빌드한 것을 찾아 지문으로 보관한다 — iOS 는 `ios/*.xcworkspace` 이름의 DerivedData `…/Build/Products/Debug-iphonesimulator/*.app`(또는 `ios/build` 아래), Android 는 `android/app/build/outputs/apk/debug/*.apk`. 보관할 때 앱·플랫폼마다 최근 5개만 남긴다.
- 지문은 Expo 앱에 이미 든 도구로 계산하므로 앱 저장소는 고치지 않는다(결정 기록). Expo 가 아닌 앱은 `TOOL_MISSING` — 캐시 없이 빌드한다.

**나중에(L1~L3) 만들 때 참고** — 2단계에서 한 번 만들다 되돌린 내용이다.

| 동작 | Android | iOS |
| --- | --- | --- |
| 설치 | `adb -s <시리얼> install -r <apk>` (기기별 병렬, 큰 APK 는 몇 분) | `simctl install <udid> <.app>` |
| 실행 | `adb reverse tcp:<metro> tcp:<metro>` → dev client 주소 `am start -W -a android.intent.action.VIEW -d '<주소>' <패키지>`, 주소가 없으면 `monkey -p <패키지> -c android.intent.category.LAUNCHER 1` | `simctl openurl <udid> <주소>` (호스트 localhost 를 그대로 씀), 주소가 없으면 `simctl launch` |
| 딥링크 | `am start -W -a android.intent.action.VIEW -d '<딥링크>' [<패키지>]` | `simctl openurl <udid> <딥링크>` |

- `adb shell` 은 인자를 이어 붙여 기기 셸에 넘기므로 주소의 `?`·`&` 가 해석되지 않게 작은따옴표로 감싼다.
- 앱별 설정 `~/.config/simless/apps/<이름>.json` (Q8): `android.package`·`android.apk`·`ios.bundleId`·`ios.app`·`devClientScheme`(→ `<스킴>://expo-development-client/?url=http%3A%2F%2F127.0.0.1%3A<metroPort>`)·`deepLinkScheme`(`/home` → `<스킴>://home`)·`metroPort`(기본 8081, 응답이 없으면 경고만).

## 11. 통신 (요약 — 상세는 `docs/protocol.md`)

**Unix 소켓** — CLI·MCP·훅

- 한 줄에 JSON 하나(JSON Lines), 연결 하나에 요청 하나. 요청마다 `clientVersion`, 응답마다 `serverVersion` 을 실어 버전을 맞춘다(별도 `hello` 대신).
- 요청 `{"v":1,"id":"r1","method":"lease.acquire","session":{…},"params":{…}}`
- 응답 `{"id":"r1","ok":true,"result":{…}}` / `{"id":"r1","ok":false,"error":{"code":"BUSY","message":"…","holder":{…}}}`
- 긴 작업(부팅·설치)은 응답 전에 `{"id":"r1","event":"progress","data":{…}}` 를 여러 번 보낸다.
- 메서드·매개변수·결과의 정본은 `docs/protocol.md` 다(여기에 따로 적지 않는다).
- 오류 코드: `BUSY` · `NOT_HELD` · `NOT_FOUND` · `INVALID` · `NOT_ALLOWED`(원래 있던 기기 삭제·기본 디바이스 삭제 등) · `DEADLOCK` · `NO_DEFAULT` · `TOOL_MISSING`(avdslim 등 없음) · `FAILED` · (클라이언트 쪽) `SERVER_DOWN`
- **현지화 (R25)**: 서버·CLI·웹 화면이 **같은 설정 언어와 같은 사전**(`src/shared/i18n`, 키의 정본은 `ko.ts`, `en.ts`·`ja.ts` 는 같은 키를 다 갖춰야 컴파일된다)으로 문장을 만든다. 서버가 보내는 오류·진행 문장도 설정 언어다. 에이전트는 문장이 아니라 오류 `code` 로 판단한다. 언어 설정이 `system` 이면 macOS 언어 설정(`AppleLanguages`)을 먼저 보고 — 터미널의 `LANG` 은 macOS 언어와 다르게 잡혀 있는 경우가 많다 — 없으면 `LANG`, 그래도 없으면 영어. 언어를 바꾸면 웹 화면이 Swift 에 `{language}` 를 보내 이미 연 창 제목·앱 메뉴도 바로 바뀐다(메뉴바 앱은 15초마다 읽는 상태로도 맞춘다). 언어는 한국어·영어·일본어 — 웹 화면은 `<html lang>` 을 따라 일본어면 일본어 글꼴(Hiragino Sans)을 먼저 쓴다(한국어 글꼴이 먼저 잡히면 한자 자형이 달라진다)
- **시각 표시 (R25)**: `src/shared/time.ts` 의 `when` 하나를 웹 화면·CLI 가 같이 쓴다 — 1분 안 «방금», 1시간 안 «N분 전», 오늘 «오늘 14:05», 어제 «어제 14:05», 올해 «10월 5일 14:05», 작년 이전 «2025년 10월 5일»(24시간제). 기록(세션 기록 창·`simless history`)은 순서를 봐야 해서 늘 초까지 시각으로(«오늘 14:05:31»). 웹 화면은 `title` 로 전체 시각(«2026년 10월 7일 (수) 14:05:31», `fullTime`).

**HTTP** — 웹 화면(앱 창·브라우저)·메뉴바

- `127.0.0.1:<포트>`(기본 8791, 설정)에만 연다.
- `GET /api/status`, `GET /api/events`(SSE — 점유·켜짐·슬림·그룹 변화. 처음 보내는 `hello` 에 서버가 뜬 시각 `startedAt` 이 있어, 다시 연결했는데 값이 다르면 화면이 페이지를 새로 받는다 — 서버를 다시 켜면 열린 앱 창도 새 화면이 된다), 웹 화면의 조작은 `POST /api/…` 가 소켓과 같은 메서드를 부른다(세션은 `human`).
- 보안(다른 웹사이트가 localhost 로 요청하는 공격 대비): `Host` 가 `127.0.0.1`·`localhost` 가 아니면 거부(DNS rebinding), `POST` 는 `Origin` 검사 + `web-token` 헤더 필수. 토큰은 앱 창·`simless ui` 가 여는 URL 로 전달한다.

## 12. CLI

모든 명령에 `--json`. 디바이스는 ID 나 이름으로 가리킨다. 지정하지 않으면 «사용 중인 디바이스 전부». 문구는 설정 언어를 따른다(R25), `--json` 은 언어와 상관없이 같다.

| 명령 | 하는 일 | 요구사항 |
| --- | --- | --- |
| `simless status` | 서버 연결, 디바이스, 그룹, 점유·대기 한눈에 | S2·R13 |
| `simless doctor [--fix]` | 서버·launchd·Android SDK·시스템 이미지·avdslim·Xcode·simslim·스킬 점검과 고치는 방법(화면 조작·테스트 도구는 프로젝트 몫이라 보지 않는다 — P10). `--fix` 는 launchd·스킬만 고친다. 훅 점검은 5단계 | S1·S2 |
| `simless install [--no-launchd] [--no-skill] [--no-app] [--hook] [--mcp] [--agents <이름,…>]` | launchd 등록 + 스킬 + `Simless.app` (§4). 보호(훅)·MCP 는 고를 때만, `--agents` 는 어느 에이전트에(기본 `claude`) | S1·Q16 |
| `simless uninstall [--purge] [--yes]` | 제거 — 스킬(모든 위치)·모든 에이전트의 훅·규칙·MCP·앱·서버 등록, `--purge` 면 데이터·로그·설정·빌드 캐시까지. 만든 디바이스는 남긴다(§4) | S12 |
| `simless ui` | 웹 화면을 브라우저로 연다 (앱 창은 `Simless.app`) | R11 |
| `simless list [--platform] [--created] [--available]` | **Simless 목록** — 폭·이름·켜짐·SLIM·기본·사용 중인 세션·기기 ID(`targetId`). `--json` 에는 슬림 내역(`slimOff`)도. `--available` 은 목록에 없는 이 Mac 의 디바이스 | M5·R20·M16 |
| `simless catalog [--platform]` | 만들 수 있는 기종·OS 목록과 슬림 항목(`slimOff` — App·Custom 에서 남길 ID) | M1·M15 |
| `simless create <기종> [--os] [--name] [--no-slim \| --slim-keep <ID,…> [--app]] [--no-baseline]` · `simless create --width --height --density [--os]` | 새로 만들기. 슬림이면 `simless …` 이름, `--slim-keep` 은 남길 슬림 항목(`--app` 이면 App 방식, 아니면 Custom) | R1~R3·R5·M4·M15 |
| `simless default [<dev>]` · `delete <dev> [-y]` · `add <dev>` · `unlist <dev>` | 관리. 삭제는 Simless 가 만든 것만, `add`·`unlist` 는 이 Mac 의 디바이스를 목록에 넣고 빼기 | M7·M8·R20·R22 |
| `simless slim [<dev>…] [--off] [--check] [--keep <ID,…> [--app] \| --full]` | 슬림 적용·해제·확인, 남길 항목 바꾸기(`--app` 이면 App, 아니면 Custom, `--full` 은 UI) (simless 가 만든 것만) | M6·M7·M15 |
| `simless group list` · `show <그룹>` · `create <이름> [--desc] [<dev>…]` · `edit <그룹> [--name] [--desc] [--add <dev>…] [--remove <dev>…]` · `delete <그룹>` | 그룹 관리 — 사람·에이전트 모두 | R21·S10 |
| `simless acquire [<dev>… \| --group <그룹> \| --default [android\|ios]] [--available] [--wait] [--timeout 10m]` | 점유 (모드는 §8) | R14·R22·R23 |
| `simless release [<dev>…]` | 점유 해제(자기 것만 — 강제 해제는 앱 창에서 사람만) | R17·S8 |
| `simless who [<udid·시리얼·dev>]` | 누가 쓰는지 | R13 |
| `simless history [--session <키>] [--limit 50]` | 점유 기록 | M13 |
| `simless up` · `simless down` | 점유한 디바이스 켜기·끄기 | R7 |
| **`simless use [<dev>… \| --group … \| --default …] [--available] [--wait]`** | **acquire + up 한 번에** — 주 흐름의 첫 단계 | R15 |
| `simless app install [<dev>…] [--platform] [--project]` · `app save [--platform] [--path] [--project]` · `app list` · `app prune [--keep 5]` | 네이티브 빌드 캐시 — 지문이 같으면 점유한 켜진 기기에 설치, 빌드한 것 보관 (§10) | R26 |
| `simless config [<키> [<값>]]` | 설정 보기·바꾸기 (언어 등) — 앱 창 설정 화면과 같은 값 | M11·R25 |
| `simless skill status` · `skill install [--global] [--project <폴더>…]` · `skill uninstall` | 스킬 설치 위치·상태 (폴더째 — SKILL.md + `references/*.md`) | S9 |
| `simless update [--check] [--rollback]` | 새 버전 확인·업데이트·이전 버전으로 되돌리기 — **U단계, 아직 없음** | R19 |
| `simless serve` · `simless hook <에이전트> pre-tool-use` · `simless mcp` | 서버·훅·MCP 진입점 (사람이 직접 쓰지 않음) | — |

- 종료 코드: `0` 성공 · `1` 실패 · `2` 사용법 오류 · `3` 다른 세션이 사용 중(`--available` 이면 하나도 못 잡았을 때만) · `4` 서버에 연결 못 함
- `up`·`down` 은 점유가 있어야 한다. 없으면 실패하고 `simless use` 를 안내한다.
- 없앤 것: `enable`·`disable`(사용 안 함, R6), `list --all`(목록이 처음부터 전부).
- 일괄 설치·실행·딥링크(`install-app`·`launch`·`open`)는 «나중에» (L1~L3, §10). 캐시된 빌드 설치만 `simless app install` (R26).

## 13. 훅 (P3~P10)

**도구 중립 (P10)** — Simless 는 기기를 관리만 하고, 화면 조작·테스트는 프로젝트가 고른 도구(argent·Maestro·agent-device …)가 한다. 훅은 그 도구의 이름도 인자 이름도 모른다. 셸 명령과 **모든 MCP 도구 호출**을 받아 낱말·인자 글자에서 관리 디바이스의 ID 를 찾는다 — 어느 도구에 넘기든 기기 ID 는 같은 글자라서다. 새 도구를 써도 Simless 를 고칠 필요가 없다.

- matcher 는 셸 + 모든 MCP(`src/shared/hook-scope.ts` 의 `HOOK_MATCHERS` — 설치와 훅이 같이 쓰므로 `shared`). Simless 자신의 MCP(`mcp__simless__*`)는 점유 요청에 기기 ID 가 들어가므로 보지 않는다
- 훅 설치 상태는 명령과 **matcher 까지** 비교한다 — 보는 범위가 바뀌면 «예전 것» 으로 보이고, Claude Code 는 `simless doctor --fix`, 다른 에이전트는 설정 창의 «업데이트» 로 고친다
- 비용: MCP 호출마다 훅 프로세스가 떠 30~40ms(2026-10-13 실측 — 기기 ID 가 없으면 소켓을 열지 않는다)
- 잃는 것: 기기를 안 준 호출(도구가 켜진 기기를 스스로 고름)과 구동 도구로 켜기는 알 수 없다 — 규칙·스킬이 «기기를 늘 지정, 켜기는 Simless» 로 다룬다

**에이전트 어댑터**: 실행 직전 훅은 에이전트마다 지원 여부·설정 위치·입력 형식이 다르다. `simless hook <에이전트> <이벤트>` 로 나누고, 어댑터는 입력을 공통 형식 `{tool, input, agentSessionId?}` 로 바꾼 뒤 같은 판정을 쓴다.

| 에이전트 | 상태 |
| --- | --- |
| Claude Code | **먼저 만든다** — `~/.claude/settings.json` PreToolUse, matcher `Bash\|mcp__.*`, 명령 `simless hook claude pre-tool-use` |
| Copilot CLI | `~/.copilot/hooks/simless.json`(simless 파일 하나, Claude 식 `PreToolUse`, matcher `Bash\|.+-.+` — MCP 도구 이름에만 «-» 가 있다) → `simless hook copilot pre-tool-use`. MCP 이름 `<서버>-<도구>` 를 첫 «-» 에서 나눠 `mcp__<서버>__<도구>` 로 바꿔 판단, 막는 출력은 Claude 와 같다 |
| Codex | `~/.codex/hooks.json` 의 `PreToolUse` 에 Simless 항목 하나(matcher `^Bash$\|^mcp__.*`) → `simless hook codex pre-tool-use`. 입력·출력이 Claude 와 같다. 새 훅은 사용자가 Codex 의 `/hooks` 에서 한 번 승인해야 돈다 |
| Cursor | `~/.cursor/hooks.json` 의 `beforeShellExecution`·`beforeMCPExecution` 에 하나씩 → `simless hook cursor before-shell`·`before-mcp`. MCP 는 모든 서버(`mcp_server_name`), `tool_input` 은 JSON 문자열. 막을 때 `{permission: deny, user_message, agent_message}`, 통과도 늘 `{permission: allow}`(빈 출력은 막힘). Cursor 가 가져오는 Claude 훅(입력에 `cursor_version`)은 통과시킨다 — Cursor 용 훅이 판단 |
| Gemini CLI | `~/.gemini/settings.json` 의 `BeforeTool` 에 Simless 항목(name `simless`, matcher `^run_shell_command$\|^mcp_`, timeout 밀리초) → `simless hook gemini before-tool`. MCP 는 `mcp_context.server_name`, 막을 때 `{decision: deny, reason}`. 신뢰한 폴더에서만 돈다 |

**다른 에이전트 설치** (`src/install/agents.ts`) — 보호 = 훅 + 규칙. 규칙은 전역 지시 파일에 `<!-- simless:start … -->` 블록 하나(Codex `~/.codex/AGENTS.md`, Copilot `~/.copilot/copilot-instructions.md`, Gemini `~/.gemini/GEMINI.md`), Cursor 는 `~/.cursor/rules/simless.mdc`. MCP 는 Copilot `~/.copilot/mcp-config.json`·Cursor `~/.cursor/mcp.json`·Gemini `~/.gemini/settings.json` 을 직접 고치고(Gemini 명령은 로그인 창을 열 수 있음), Codex 는 `codex mcp add`(TOML 이라). Simless 항목만 넣고 빼며 고치기 전에 `.simless-backup`, 못 읽는 파일(주석 든 JSON 등)은 건드리지 않고 오류를 낸다. 설정 창 «에이전트 연결» 의 «다른 에이전트», `simless install --hook --mcp --agents codex,copilot,…` 로 넣고, `simless uninstall` 은 모두 뺀다. 실제 에이전트로는 아직 확인하지 않았다.

**흐름**
1. 어댑터가 stdin 입력을 공통 형식으로 바꾼다. 세션은 §7 방식(훅 프로세스의 부모 체인)으로 찾고, 입력에 세션 ID 가 있으면 보조로 쓴다. 입력의 `cwd`(절대 경로)는 세션의 작업 폴더로 쓴다(§7 «작업 폴더»).
2. **빠른 통과**: 낱말·인자 글자에 기기 ID 로 보이는 것 — 관리 디바이스의 AVD ID·UDID·마지막 시리얼(`managed-index.json`), UDID 모양, `emulator-<포트>` — 이 없고 플랫폼 도구(`adb`·`simctl`·`emulator`·`simslim`·`avdslim`)도 없으면 바로 통과한다(소켓 안 엶). `main.ts` 는 이 경로에서 서버·웹 코드를 불러오지 않는다.
3. 대상(`src/hook/targets.ts` — 순수 함수)을 뽑아 서버에 `hook.check` → 허용/차단 + 사유. 대상은 **Simless 목록의 디바이스**만(P1) — AVD ID·UDID·지금 시리얼로 잇는다(simless ID 는 흔한 낱말과 겹칠 수 있어 빼고). 켜짐 상태(시리얼)를 읽는 데 0.5초쯤 걸려 서버가 10초 기억하고, 상태를 바꾸는 요청이 오면 버린다. 허용이면 서버가 같은 요청으로 `lastUsedAt` 을 갱신한다. 실측: 빠른 통과 약 20ms, 판정 약 30ms(기억이 없을 때 0.6초).
4. **서버가 꺼져 있으면** `managed-index.json` 으로 이 Mac 의 디바이스인지만 본다. 맞으면(또는 시리얼을 판정 못 하면) 차단하고 «`simless status` 로 서버를 켜세요» 를 알려 준다 (P9).
5. 차단은 `permissionDecision: "deny"` JSON 으로 돌려주고, 사유에 **누가 쓰는 중인지와 점유 방법**(`simless use …`)을 넣는다 (P5). 서버가 이상한 답(모르는 메서드 등)을 하면 막지 않는다 — 훅 때문에 에이전트가 멈추지 않게.

**대상 판정**

| 호출 | 대상 |
| --- | --- |
| MCP 도구(어느 서버든 — Simless 자신은 빼고)의 인자 글자 안에 디바이스 식별자가 보임 | 그 디바이스 — 인자 이름(`udid`·`device_id`·`serial` …)은 보지 않고 모든 글자를 낱말로 나눠 본다(깊이 8·글자 2000개까지). 기기를 가리키지 않는 도구(목록 등)는 통과 (P6) |
| 구동 도구에 기기를 안 줌(`maestro test`·세션 기기를 쓰는 agent-device 명령·기기 없는 argent flow) · 구동 도구로 켜기(argent `boot-device`) | 알 수 없다 → 통과. 켜기는 기기 ID 를 주므로 점유만 확인한다. 규칙·스킬이 «기기를 늘 지정, 켜기는 Simless» 로 다룬다 (P10) |
| Bash `simctl boot`·`emulator -avd …` 로 디바이스 켜기 | 점유와 상관없이 **차단** → `simless up` 안내 (S6 «켜기는 Simless 로») |
| Bash 명령 문자열 안에 디바이스 식별자(UDID·AVD ID·현재 시리얼)가 보임 | 그 디바이스 — 어떤 명령이든(`maestro --device …`·`npx agent-device … --serial …`) 파싱하지 않고 **문자열 포함**으로 본다. `&&`·`$(…)`·변수 등으로 우회되기 어렵다. 예외: heredoc 을 여는 줄에 셸·인터프리터·명령 실행 도구(`sh`·`bash`·`python`·`node`·`bun`·`osascript`·`eval`·`xargs`·`adb` …)가 없으면 그 본문은 글이라 지우고 본다(`stripDataHeredocs`) — 파일에 쓰는 스크립트·커밋 메시지에 기기 이름과 `adb` 가 같이 들어 있어 막히던 오탐. 실행기는 **heredoc 이 붙은 명령부터 줄 끝까지**에서만 찾는다(`commandStart` — 따옴표 밖의 `;`·`&&`·`||` 로 나눔, 파이프·`2>&1` 은 나누지 않음, 따옴표가 안 닫혔으면 줄 전체). 앞에서 끝난 명령은 본문을 받지 못해서다 — `bun run check; git commit -F - <<EOF` 의 커밋 메시지를 `bun` 때문에 검사하던 오탐(2026-10-12). 뒤의 명령은 본다(`cat <<EOF > a.sh; bash a.sh`) |
| `adb` 를 기기 지정 없이 기기 명령에 씀(`adb shell` 등, `ANDROID_SERIAL` 미지정) | 켜진 Android 전부 |
| `simctl … booted` | 켜진 iOS 전부 |
| `adb devices`·`emulator -list-avds`·`simctl list` 등 목록 조회 | 없음 → 통과 (P6) |

**규칙 (P2)** — `integrations/rules/simless.md` 를 `simless install` 이 `~/.claude/rules/simless.md` 로 따로 설치한다(다른 도구의 규칙 파일에 붙이면 그 도구의 업데이트가 덮어쓴다). 특정 도구 이름을 쓰지 않는다(P10). 다른 에이전트의 전역 규칙 위치는 조사 후.

**설치** — 첫 실행 설정 창(M14)의 «보호» 또는 `simless install --hook` 이 `~/.claude/settings.json` 의 `hooks.PreToolUse` 에 matcher `Bash|mcp__.*`, 명령 `<simless 절대 경로> hook claude pre-tool-use` 한 줄을 넣는다. 다른 설정·훅은 그대로 두고, 예전 Simless 훅(명령이 ` hook claude pre-tool-use` 로 끝남)은 바꾸며, 쓰기 전에 `settings.json.simless-backup` 을 남긴다. 기본으로는 넣지 않는다 — 다른 세션이 Simless 없이 쓰는 기기가 목록에 있으면 그 세션까지 막으므로 사람이 고른다. `simless uninstall` 이 지운다. `simless doctor` 가 훅·규칙을 점검하고, `--fix` 는 이미 넣은 것이 예전 것(명령·matcher 가 다름)일 때만 고친다.

> Simless 목록(`simless list`)의 시뮬레이터·에뮬레이터는 어느 도구로든 `simless use` 로 점유한 뒤에만 조작한다(스크린샷·접근성 트리 포함). 기기를 늘 지정한다. 켜기·끄기는 도구의 명령이 아니라 `simless use`·`simless down` 으로 한다. 끝나면 해제를 권한다. 전문은 `integrations/rules/simless.md`(영어).

## 14. 앱 창·웹 화면 (R11·M1~M17)

**앱 창** — `Simless.app` 이 자기 창(NSWindow + WKWebView)에 웹 화면(`http://127.0.0.1:<포트>/#token=…`)을 띄운다. 메뉴바 «대시보드 열기»·앱 다시 열기·Dock 클릭이 이 창을 연다. 창이 열려 있는 동안만 Dock 아이콘을 보이고(`setActivationPolicy(.regular)`), 닫으면 메뉴바 앱으로 돌아간다. 창 크기·위치를 기억하고 ⌘W·⌘Q 가 앱처럼 동작한다. 같은 화면을 브라우저로도 연다(`simless ui`) — 개발 중엔 argent(Chromium)로 화면을 눌러 확인한다.

**왼쪽 메뉴** (M9) — 디바이스 · 그룹 · 세션, 아래쪽에 설정(새 창 — 앱에서는 `window.webkit.messageHandlers.simless` 로 Swift 에 알려 별도 NSWindow, 브라우저에서는 `window.open`)과 서버 상태(«서버 연결됨», 그 밑에 `v0.1.0`). 서버가 다시 켜지면 열린 화면이 페이지를 새로 받는다(SSE `hello` 의 `startedAt`, §11).

**세션 화면** (M13) — `status.sessions`(지금 점유·대기)와 `lease.history`(기록)를 세션 키로 묶어 «지금 쓰는 세션 / 지난 세션» 카드로 보인다. 카드에 에이전트 아이콘(이름으로 종류를 가림 — 각 도구의 대표 색에 단순한 기호, 실제 로고는 쓰지 않음)·세션 ID(에이전트가 주는 `agentSessionId` 와 Simless 세션 키)·작업 폴더·마지막 활동·기록 수. 지금 쓰는 세션은 점유한 디바이스(사람은 강제 해제)와 대기. 카드를 누르면 `?window=session&key=…` 를 새 창(앱은 Swift 별도 창, 브라우저는 `window.open`)으로 — 그 세션의 기록을 시간순 타임라인으로. 기록은 LeaseManager 가 점유·대기·해제가 일어날 때마다 남기는 사건(acquired·queued·granted·released·forced·ended·idle·deadlock, `agentSessionId` 포함)을 서버가 `…/Simless/history.db`(SQLite)에 덧붙이고 90일 보관한다. 세션 목록은 서버가 세션마다 묶어 준다(`lease.sessions`). CLI `simless history`.

**메인 화면** (M5·M9)
- Simless 목록 — 위에 **All · Android · iOS 탭**(마지막 탭 기억)과 그룹 거르기, 검색.
- 한 줄에 `폭 · 이름 · 슬림 · 켜짐 · 태그(기본 Android/iOS, 그룹들) · 사용 중인 세션`. «슬림» 칸은 슬림된 기기에만 `SLIM ↗` 버튼 — 누르면 «슬림 내역» 창(대화 상자, M16).
- 정렬: 켜진 것 → 기본 → 플랫폼 → 폭.
- `SLIM` 배지에 마우스를 올리면 꺼진 항목 수·메모리·슬림 전후(«7.8GB → 1.6GB (−79%)», M10). 재적용 실패는 `SLIM ⚠` + 이유. 꺼진 기기는 마지막으로 본 수치와 «마지막 확인» 시각, Simless 밖에서 한 슬림이면 배지가 흐리다(M6).
- 켜기·끄기는 점유 없이(사람), 다른 세션이 쓰는 중이면 막는다. SSE 로 바로 반영된다.

**생성(+)** (M1·M4) — 위에 «새로 만들기 · 이 Mac 의 디바이스» 탭. «이 Mac 의 디바이스» 는 Simless 목록에 없는 기기(`device.available`)를 플랫폼·검색으로 거르고 «추가»(`device.add`). «새로 만들기» 는 번호 붙은 네 단계(구분선으로 나눔, «만들기» 버튼은 아래에 고정): ① 플랫폼 → ② 기종(iOS 기기 종류 / Android 기기 정의(Android Studio + 대표 프로필)·직접 입력) → ③ OS·이름(런타임·시스템 이미지는 기본값을 미리 골라 둠, 이름 기본값 `simless <기종>` 또는 `<기종>`, 겹치면 번호) → ④ **슬림**(«슬림 안 함 · UI(전체 슬림, 기본) · Custom» 세 카드 중 하나 — 방식 이름은 device-slim 과 같게 번역하지 않는다. UI 는 «꺼지는 것 보기» 로 펼치고, Custom 은 플랫폼마다 다른 항목에서 **남길 것**을 체크한다 — Android 는 앱·서비스 묶음 / 기기 설정 / 에뮬레이터 하드웨어로 나눠 보인다, M15)과 슬림 전 기준값 측정. «만들기» 를 누르면 창을 바로 닫고 토스트 «만드는 중» 을 띄운다 — 목록에는 서버가 `creating` 으로 알린 줄이 «만드는 중…»(작은 도는 원)으로 생기고(그 전까지는 화면이 임시 줄을 둔다), 그 줄은 켜기·⋯ 메뉴가 꺼져 있다. 진행은 작업 기록에 한 줄씩, 끝나면 토스트 «만들었습니다»(실패하면 오류 토스트). 같은 크기가 이미 있어도 막지 않는다(M3). 앱은 설치하지 않는다(N4).

**더보기(⋯) 메뉴** (M7·M8) — 그룹에 넣기/빼기 · 기본 디바이스로 · 슬림 내역(꺼진 것·켜진 것 창, M16) · 슬림 설정…(슬림 안 함·UI·Custom 을 고르는 창 — 에이전트가 App 으로 슬림한 기기는 App 카드도 보이고, 항목을 바꾸면 Custom. 바꾸면 다시 맞춤 — simless 가 만든 것만) · 점유 강제 해제(다른 세션이 쓰는 중일 때, 사람만) · 목록에서 빼기(이 Mac 에서 추가한 것) · 삭제(simless 가 만든 것만, 확인 창. 기본 디바이스·켜짐·사용 중이면 이유와 함께 막음). 바깥을 누르거나 Esc 로 닫힌다.

**그룹 화면** (M9·R21) — 그룹 목록(이름·설명·디바이스 수·마지막으로 고친 사람/에이전트), 만들기·고치기(이름·설명·디바이스 고르기 — 목록에서 체크), 삭제. 없는 디바이스(밖에서 지워짐)는 표시하고 빼게 한다.

**시작 애니메이션** (M17) — 메뉴바 앱이 켜진 뒤 대시보드를 처음 불러올 때만 주소에 `launch=1` 을 붙인다(불러오기에 성공하면 뗌). 화면은 그 값을 읽자마자 지우고(`history.replaceState`), 첫 실행 설정을 할 필요가 없으면 `LaunchSplash` 를 덮어 보여 준다 — «Sim·ulator» «Seam·less» 에서 0.2초 멈춤 → 0.7초 버릴 글자 흐리게 → 0.8초 접으며 붙이기 → 로고(0.5초) → 2.4초부터 0.5초 동안 사라진다(2.9초). 그동안 뒤에서 목록을 읽는다. 누르거나 키를 누르면 끝, `prefers-reduced-motion` 이면 움직임 없이 0.7초.

**설정** (M11, 새 창) — 맨 위 «버전 정보»(버전·설정 파일 위치) · 첫 실행 설정 다시 열기(M14) · 언어(시스템 따름·한국어·English, R25) · 자동 해제 시간·기록 보관 기간 · Android RAM · simslim 프로필 · 저장 버튼 · 맨 아래 «Simless 제거»(S12 — 지울 것을 보여 주고 «데이터까지» 를 고르게 한 뒤 `setup.uninstall`). `config.json` 에 쓰고 서버가 바로 반영한다.

**첫 실행 설정 창** (M14) — `?window=setup`, 앱에서는 Swift 별도 창(처음 뜰 때 서버가 아직 안 떴으면 2초 간격으로 다시 물어본다). 단계 표시 + 단계마다 한 화면, 아래에 이전·다음(창 아래에 붙음). 생성 창(M1)을 그 창 안에서 연다. «완료» → 앱이면 Swift 에 `{open:"dashboard"}`·`{close:"setup"}`, 브라우저면 `/` 로.

**디자인** (M12) — 귀엽지 않고 단정하게. 촘촘한 표 형태 목록, 시스템 글꼴, 숫자(폭·해상도·메모리)는 고정폭, 강조색 하나. 읽는 중에는 글자만 두지 않는다 — 창·화면은 도는 원 + «읽는 중…»(`Loading`), 목록은 줄 모양 자리 표시(`SkeletonRows`, 세션), 시간이 걸리는 버튼은 누른 버튼 안에 작은 도는 원(`.spinner-small`, 글자 색을 따라감). 0.15초 뒤에 나타나 짧은 읽기에는 깜빡이지 않고, «동작 줄이기» 면 움직이지 않는다. **CLI 로고**(`src/cli/banner.ts`) — 같은 폰 얼굴 + `SIMLESS` 블록 글자 + 슬로건·버전, 민트색(24비트 색을 알리는 터미널은 `#5EEAC0`, 아니면 256색 79). `install` 을 사람이 터미널에서 실행할 때만(설치 파일·`update` 도 안에서 `install` 을 부른다) — 터미널이 아니거나 `--json`·`TERM=dumb` 이면 없음, `NO_COLOR` 면 색 없이, 60칸보다 좁으면 한 줄. `--help` 맨 위에는 색 없는 한 줄 제목만(에이전트도 읽는다). 아이콘은 폰 하나에 점 눈·작은 미소만 넣은 모양(입 밑 홈 표시줄 같은 다른 선은 없음) — 앱 아이콘·탭 아이콘·화면 로고·메뉴바가 모두 같은 모양이고(옆 막대 «디바이스» 메뉴는 단순한 폰 선 아이콘), `src/web/icon.svg` 하나가 정본이고, 앱 아이콘(`scripts/icon.sh` → `assets/simless.icns`, 잉크 바탕 + 민트, 바탕 바깥은 투명 — `scripts/icon-render.swift` 가 AppKit 으로 그린다. qlmanage 는 투명한 곳을 흰색으로 채워 흰 테두리가 생겼다)·웹 로고·탭 아이콘(`ui.tsx` 의 `Logo` 가 `icon.svg` 를 그대로 보여 준다)·메뉴바 템플릿(Swift `devicesTemplate`, 같은 모양을 단색으로 — 18px 에서도 보이게 눈·입 위치와 굵기를 살짝 조정)이 같은 경로를 쓴다. **구현 전에 시안을 보고 정한다.**

**메뉴바** — 아이콘(단색 템플릿, 숫자 없음) → 메뉴: 서버 상태 · 스킬 업데이트가 있으면 «업데이트» · «대시보드 열기»(앱 창) · «설정 열기» · 서버가 꺼져 있으면 «서버 켜기» · 종료. 켜진 디바이스 목록은 넣지 않는다(대시보드에서 본다, 2026-10-06 사용자 결정). «설정 열기» 에는 ⌘, 단축키를 달지 않고 자기 동작을 쓴다 — 표준 설정 항목으로 보이면 macOS 26 이 톱니 아이콘을 자동으로 붙인다(메뉴바 메뉴는 글자만). 문구는 설정 언어를 따른다(Swift 안의 작은 사전, 언어는 `status` 응답으로 받음). 서버 HTTP API(토큰은 파일에서)만 읽고 로직은 없다. 로그인 시 뜨게 등록한다(launchd `simless.menubar`, `open -a`).

**macOS 알림** (M18) — 메뉴바 앱이 `UserNotifications` 로 띄운다(처음 한 번 macOS 가 허락을 묻는다). 15초마다 `status` 를 읽어 ① 1분 넘게 연결하지 못하면 «Simless 서버가 꺼져 있습니다» 한 번(누르면 서버 켜기 — 서버는 KeepAlive 라 실제로 꺼져 있는 건 launchd 에서 내려간 때이므로, `kickstart` 가 실패하면 plist 를 다시 `bootstrap` 한다. 다시 연결되면 알림을 거둔다) ② `skillUpdate` 이고 `skillHash` 가 지난번에 알린 것과 다르면 «스킬 업데이트가 있습니다» 한 번(누르면 대시보드, 알린 지문은 UserDefaults 에). 앱이 앞에 있어도 배너로 보인다.

나중에 **스크린샷 모아 보기**(R10)를 같은 화면에 탭으로 붙인다.

## 15. 스킬 (S1~S11)

`integrations/skill/simless/SKILL.md` 와 참고 파일 — 이 저장소의 `references/slim.md`(슬림 방식 고르기·`.device-slim.json` 다시 쓰기·기능 → 슬림 항목 표)·`references/troubleshooting.md`(문제가 생길 때), agent-skills 저장소 device-slim 의 «앱 기능 찾기» `references/find-features-*.md`(의존성으로 태그 고정, M15) — 를 빌드에 넣어 폴더째 → 기본 `~/.claude/skills/simless`, 고르면 프로젝트 `<폴더>/.claude/skills/simless`(작업 트리마다, `git worktree list` 로 찾음 — git 공용 폴더의 `info/exclude` 에 `/.claude/skills/simless/` 를 적어 저장소에는 안 보이게) (S9). 넣은 곳은 `…/Simless/skills.json` 에 기억하고, `simless install`·`simless skill install`·설정 창이 모든 곳을 같이 고친다. 위치를 바꾸면 빠진 곳의 스킬은 지운다. 서버는 켤 때·10분마다·설치를 바꿀 때 넣어 둔 곳을 다시 보고, 예전 스킬이 있으면 `status.skillUpdate` 를 켠다 → 대시보드 위 띠 «Simless 스킬 업데이트가 있습니다 [업데이트]», 메뉴바 «스킬 업데이트 있음 — 업데이트». 누르면 `setup.apply { item: "skill" }` 로 모든 곳을 고친다. 새로 시작하는 에이전트 세션부터 새 스킬을 읽는다. **영어로 쓴다**(R25 — 읽는 쪽이 에이전트). 형식은 Anthropic 스킬 작성 가이드를 따른다 — description 은 3인칭 «무엇을 하는지 → 언제 쓰는지» 로 1024자 아래, 본문은 500줄 아래에 진행 체크리스트, 필요할 때만 읽는 것은 `references/` 로 빼고(Agent Skills 사양이 권장하는 이름 — 예전 `reference/` 는 설치할 때 지운다) 참고 파일끼리는 링크하지 않는다(본문에서 한 단계만). 스킬 형식을 읽는 다른 에이전트(Codex 등)는 `simless install --agents <이름,…>` 으로 그 에이전트 위치에도 설치한다.

- description 에 S3 의 반응 프롬프트(디바이스가 필요한 작업 전부), S4 의 비반응(디바이스를 쓰지 않는 작업)을 넣는다. 테스트하는 앱의 «그룹» 기능과 헷갈리지 않게 «device group» 이라고 쓴다.
- 본문 순서(S5): `simless status` → **용도 고르기**: `simless group list --json`(설명)·`simless list --json`(슬림 내역 `slimOff` — S13)을 보고 맞는 그룹, 없으면 `--default` → `simless use … [--available] [--wait]` — 일부가 사용 중이면 R23 기준(그룹 설명의 «모두 필요», 작업에 몇 대가 꼭 필요한지)으로 판단, 애매하면 사용자에게 묻기(S7) → `simless list --json` 으로 기기별 `targetId`·`label` 받기 → React Native 면 자기 Metro(S11)·기기마다 설치(캐시 먼저)·실행 → **프로젝트의 도구에 넘기기**: 기기 ID·플랫폼·Metro 포트·라벨, 기기를 늘 지정, 켜기·끄기는 Simless, 도구의 기기 세션은 해제 전에 닫기(S6·P10) → 크기 라벨을 붙여 보고 → **해제 권하기**(S8) → 끌지 묻기.
- 그룹 만들기·고치기(S10): 사용자가 요청할 때만 `simless group create|edit`. 요청 없이 남이 만든 그룹을 바꾸지 않는다.
- 오류는 `code` 로 판단한다(`BUSY`·`DEADLOCK`·`NO_DEFAULT` …). `DEADLOCK` 이면 쥔 것으로 진행할지 놓을지 정한다.
- 설치·연결 문제는 `simless doctor` 결과를 따른다 (S1·S2).
- `simless status --json` 에 `update` 가 있으면 사용자에게 알리기만 하고 **직접 업데이트하지 않는다** (R19).

## 16. 단계

각 단계는 끝나면 실제로 쓸 수 있는 상태가 된다.

| 단계 | 내용 | 끝나면 |
| --- | --- | --- |
| 0 ✅ | 저장소 뼈대 — `package.json`·`tsconfig`·Biome·`mise.toml`, `bin/simless.ts`·`main.ts` 서브커맨드 틀, `scripts/build.ts`, 검사 통과. **컴파일한 바이너리에서 파일 포함·훅 시작 시간 확인** | `bun link` 와 `dist/simless` 양쪽에서 `simless --version` 이 돈다 |
| 1 ✅ | 서버 + CLI 코어 — 레지스트리, Android·iOS 드라이버(생성·목록·이름·사용 안 함·삭제·켜기·끄기·슬림), 점유·대기·자동 해제, 소켓, launchd, `protocol.md`. **실제 디바이스로 확인**: iOS 생성+슬림 2분 22초, Android·iOS 동시 켜기 29초. 남은 확인은 §17 | CLI 로 크기별 디바이스를 만들고 점유해서 켠다 |
| 2 ✅ | `doctor` + 스킬 — 설치·연결 점검(S1·S2), 스킬(S3~S8 — 앱 설치·실행·화면 이동은 argent 로 안내, 2026-10-13 프로젝트 도구로 넘기기로 바꿈), `simless install` 이 스킬도 설치. **남은 확인**: 실제 앱으로 «심리스로 확인해 줘» 흐름을 처음부터 끝까지 돌려 보기 | «심리스로 확인해 줘» 로 주 흐름(R15)이 돈다 |
| 3 ✅ | 웹 UI + `Simless.app` (앞당김 — 사람이 직접 보고 확인하려고) — HTTP API·SSE·토큰, 메인 목록(All·Android·iOS 탭), 생성(+)(iOS 시뮬레이터·Android 대표 프로필·직접 입력), 슬림 수치와 슬림 전후 비교, 메뉴바 앱(단색 아이콘·«대시보드 열기»), `simless ui` | 사람이 메뉴바·브라우저로 전부 관리한다 |
| 4 ✅ | **사양 변경 (2026-10-05)** — ① 시안(디자인 M12)으로 화면 확정 (사용자 요청으로 건너뛰고 A안 — 라이트 그래파이트 + 파랑, 다크 잉크 + 민트 — 으로 바로 구현) ② 이 Mac 디바이스 전부 목록·레지스트리 재구성(R20, 사용 안 함 제거) ③ 생성: 기종 + OS, 슬림 선택·ⓘ(M1·M4) ④ 메모·기본 디바이스·그룹(R21·R22·R24) ⑤ 그룹 점유 모드·교착(R23, §8) ⑥ 슬림 자동 재적용·`SLIM` 배지(M6) ⑦ 오류 코드·현지화·설정(R25·M11) ⑧ 앱 창(WKWebView, R11) ⑨ 스킬 영어로 다시 쓰기. 항목마다 커밋 | 용도별 그룹·기본 디바이스로 요청하고, 앱 창에서 전부 관리한다 |
| 5 ✅ | 보호 — Claude Code 훅(`simless hook claude pre-tool-use`), 규칙(`~/.claude/rules/simless.md`), 서버 꺼짐 처리, `simless install`·`doctor` 연동. 대상은 Simless 목록의 디바이스(P1). 설치는 사용자가 고른다 — 첫 실행 설정 창 또는 `--hook`(이 Mac 의 Claude Code 에는 켜져 있음). 다른 에이전트(Copilot·Codex·Cursor·Gemini) 어댑터도 만들었다 — 실제 에이전트로는 아직 확인 안 함(Q16) | 다른 세션이 남의 디바이스를 못 건드린다 |
| 5.5 ✅ | 첫 실행 설정 창 (M14, 2026-10-05) — 앱을 처음 열면 점검 → 에이전트 연결(스킬·보호·MCP) → 기본 디바이스를 차례로. 서버 `setup.*`, `simless install` 은 보호·MCP 를 기본으로 넣지 않음(`--hook`·`--mcp`) | 터미널 없이 앱에서 설정을 끝낸다 |
| 6 ✅ | MCP 래퍼 — `simless mcp`(stdio). 도구: `simless_status`·`simless_use`(디바이스·그룹·기본, all·available, 기다리기는 45초씩 나눠 «STILL_QUEUED → 다시 호출»)·`simless_release`·`simless_down`·`simless_catalog`·`simless_create`(`slimKeep`·`slimMode`)·`simless_slim`(남길 항목 바꾸기·해제, M15)·`simless_group_save`. 오류는 코드부터(`BUSY: …`). 세션은 CLI 처럼 프로세스 트리, 서버가 꺼져 있으면 켠다. **등록은 사용자 결정** — 첫 실행 설정 창의 «MCP 도구» 또는 `simless install --mcp` | 에이전트가 사용법 없이 바로 쓴다 |
| 6.5 ✅ | 쓰면서 더한 것 (2026-10-05~06) — 네이티브 빌드 캐시(`simless app`, R26), 보안 문서(`SECURITY.md`), 제거(`simless uninstall [--purge]`·설정 창 «Simless 제거», S12), 버전 표기·앱 창 새로 고침, 보안 약한 점 정리(다른 세션 작업 폴더 감추기·토큰 비교·파일 권한·앱 창 이동 제한), 훅 heredoc 오탐, 요구사항 «확인» 칸과 요구사항↔테스트 검사, Metro 연결 순서(스킬 — argent 의 «8081 하나» 덮어쓰기·dev client 스킴·`--android`·앱에서 확인), 메뉴바 메뉴 줄이기 | 빌드를 건너뛰고, 깔끔하게 지울 수 있다. 앱이 자기 Metro 에 붙는다 |
| U | 업데이트 — `scripts/release.ts`, 확인·알림, `simless update`·되돌리기 (§19). **첫 Release 를 낸 뒤**(리모트는 2026-10-07 연결), 5단계 이후 아무 때나 | 새 버전을 알림 받고 명령 한 번으로 올린다 |
| 나중 | 스크린샷 모아 보기 (화면 탭) · 일괄 설치·실행·딥링크 (L1~L3 — 캐시된 빌드 설치는 R26 으로 들어감) · 슬림된 디바이스 복제 (L4) — 필요하면 | — |

## 17. 구현 전에 실측할 것

| 항목 | 왜 | 언제 |
| --- | --- | --- |
| 에이전트별 프로세스 트리 — codex·gemini·cursor-agent·opencode·copilot 이 명령·MCP 를 자식 프로세스로 실행하는지, `AI_AGENT` 같은 표시 변수를 주는지 (각 에이전트에 `ps` 를 실행시켜 확인 — 그 에이전트 사용량이 든다) | §7 판정표·호스트 목록 | 1단계 |
| ✅ Claude 어댑터 — CLI 의 `CLAUDE_CODE_SESSION_ID` 와 훅 입력 `session_id` 가 같은 값인지 — **같다**(2026-10-05: 세션 화면의 ID 와 대화 기록 파일 이름이 같음). `/clear`·`--resume` 때 바뀌는지는 아직 | §7 보조 세션 ID | 1단계 |
| ✅ avdslim — 1.0.15 설치·확인(2단계 전). 명령: `tune-avd <avd>`(호스트 설정, config.ini 를 다시 씀 — AvdId·크기·이름은 유지됨)·`on <serial>`·`off <serial>`·`profiles`. **상태 조회 명령이 없어** 슬림 확인은 «기기에 설치된 프로필 패키지 중 꺼진 비율 ≥ 50%» 로 한다(표준 프리셋이 Chrome·Play 스토어 등은 남겨 실측 52개 중 49개). 풀림 → 켤 때 재적용까지 실제로 확인 | §9 Android 슬림·M6 | 2단계 전 |
| simslim 0.8 → 0.11 변경점. 0.8 에서 확인함: `on --preserve-boot-state` 로 꺼진 기기도 슬림화(잠시 켬), `verify` 는 켜진 기기만, `list --json` 의 `managedDisabled` 는 켜진 기기만 나온다. **0.12.0**(2026-10-09 이 Mac 에서 확인): `profiles` 의 묶음 ID 15개는 그대로, `apps` 에 «Always on: com.apple.gamed»(Game Center 는 슬림되지 않음 — `parseSimslimProfiles` 가 이미 읽는다), `list` 글자 출력에 플랫폼 열이 생겼지만 simless 는 `list --json` 만 읽어 상관없음, tvOS·watchOS·visionOS 도 슬림하지만 simless 는 iPhone·iPad 만 만든다 | M6 | 업데이트 시 |
| ✅ 컴파일한 바이너리에 웹 UI·파일이 잘 들어가는지, 훅 경로 시작 시간 — **확인됨(0단계)**: `with { type: "file" }` 는 `/$bunfs/root/…` 경로로 들어가 `Bun.file` 로 읽히고, HTML import 는 TSX 까지 번들돼 `Bun.serve` 로 서빙된다(`--bytecode` 포함, 다른 폴더로 옮겨도 동작). 훅 경로 약 21ms | §2·§3·§13 | 0단계 |
| ✅ launchd 로 띄운 서버가 `emulator`·`xcrun` 을 PATH·권한 문제 없이 실행하는지 — **확인됨(2단계 전)**: `simless install` 로 등록한 서버가 Android·iOS 를 만들고 함께 켰다(1분 16초, 슬림 없이). 등록하면 macOS 가 «백그라운드 항목 추가됨» 알림을 띄우고, 로그인 항목에 실행 파일 서명자 이름(개발 모드는 bun 의 «Jarred Sumner»)이 보인다 | launchd 는 로그인 셸 환경을 안 받는다 | 2단계 전 |
| 에이전트별 MCP 서버의 부모가 에이전트 프로세스인지 (Claude Code 는 확인됨) | §7 | 6단계 |
| argent 여러 버전(homebrew 0.17.0 이 PATH 우선, mise 의 node 마다 0.25.1·0.27.0 — 2026-10-07 확인. 10-12 에 셋 다 0.28.0 으로 맞춤 — 깔린 곳이 여럿인 것은 그대로) 정리 | ~~훅이 보는 argent 도구 인자가 버전마다 다를 수 있다~~ — 2026-10-13 훅이 도구 인자 이름을 보지 않게 되어(P10) Simless 와 상관없어짐 | — |
| 다른 에이전트의 실행 직전 훅 지원 여부·설정 위치·입력 형식, 전역 규칙·스킬 위치 | §13 어댑터·P2·S9 | 5단계 전 |
| avdslim·simslim 이 끄는 항목을 사람이 읽을 이름으로 묶는 방법 (`avdslim profiles`·simslim 프로필 JSON) | M4 | 4단계 ③ 전 |
| `simctl list devicetypes`·`runtimes` 의 지원 관계(`supportedDeviceTypes`) | M1 iOS 기종·OS 고르기 | 4단계 ③ 전 |

## 18. 미결정 질문(Q)에 대한 설계 쪽 제안

| Q | 제안 |
| --- | --- |
| Q16 훅 없는 에이전트 | 규칙 + CLI 의 BUSY 응답으로 보호. 훅을 지원하면 어댑터를 붙인다(§13). **조사 결과(2026-10-05)** `docs/agent-integrations.md` — Copilot CLI·Codex·Cursor 는 실행 직전 막기가 되고, Gemini CLI 는 설치본(0.16.0)이 너무 오래돼 안 된다. 네 에이전트(Copilot CLI·Codex·Cursor·Gemini CLI)에 붙였다(2026-10-05). 실제 에이전트로 다듬지 않아 첫 실행 설정에 «실험적» 으로 표시한다(2026-10-08 사용자 결정 — 연결은 계속 제공) |

## 19. 설치·업데이트 (R19·R27)

**설치 파일** (`scripts/build.ts`, 2026-10-08) — `bun run build` 가 `dist/simless`(단일 실행 파일) 다음에 `dist/simless-<버전>-install.sh` 를 만든다. 실행 파일을 gzip·base64 로 넣은 bash 스크립트 하나(약 33MB)로, 머리에 `# simless-installer`·`SIMLESS_VERSION=`·`SIMLESS_SHA256=`(gzip 의 sha256)이 있다. 하는 일: Apple Silicon 인지 확인 → 임시 폴더에 꺼냄 → sha256 확인(다르면 «손상됨») → `<꺼낸 파일> install "$@"` → 임시 폴더 지움.
- 서명이 없어도 막히지 않는 이유: Gatekeeper 는 «다운로드한 파일» 표시가 붙은 실행 파일을 실행할 때 막는다. `bash <파일>` 은 bash 가 스크립트를 읽는 것이라 막지 않고, 스크립트가 쓴 파일에는 표시가 없다(2026-10-08 확인 — 표시를 붙인 설치 파일로 설치·실행됨, 같은 표시를 붙인 실행 파일은 종료 137).
- sha256 은 받다가 깨진 것을 잡을 뿐, 누가 바꾼 파일은 막지 못한다 — 받은 곳을 믿는 것이다(SECURITY.md §2).

**설치 위치** (`src/install/self.ts`)
- `simless install` 이 단일 실행 파일로 돌면 자기를 `~/.local/share/simless/versions/<버전>/simless` 에 복사하고(옆에 쓰고 이름 바꾸기), 격리 표시를 지우고, `~/.local/bin/simless` 링크를 바꾼다(역시 옆에 만들고 이름 바꾸기). 바로 전에 링크가 가리키던 파일은 `~/.local/share/simless/previous` 에 적는다.
- 서버(launchd)·훅·MCP·앱(메뉴바를 못 만들 때의 대신 스크립트)에는 `selfCommand()` 가 주는 경로를 적는데, 설치돼 있으면 **링크**다. 그래서 받은 파일을 지워도 되고, 버전이 바뀌어도 적어 둔 경로는 그대로다.
- 이미 넣어 둔 훅·MCP(Claude Code·Codex·Copilot·Cursor·Gemini)가 다른 경로면 새 경로로 고친다 — `--hook`·`--mcp` 로 고른 에이전트가 아니어도 모두. 넣어 두지 않은 것은 넣지 않는다. 에이전트마다 따로 시도해 하나가 실패해도 설치는 이어 간다(2026-10-08 — 설치 방식을 바꿨을 때 고르지 않은 에이전트의 MCP 가 예전 경로에 남던 것을 고침).
- 버전 폴더는 큰 버전부터 3개 + 지금·바로 전 것. 링크 폴더가 PATH 에 없으면 `~/.zshrc` 에 넣을 줄을 알려 준다.
- 경로는 테스트를 위해 `SIMLESS_INSTALL_DIR`·`SIMLESS_BIN_LINK` 로 바꿀 수 있다.

**업데이트 — `simless update`** (`src/cli/commands/update.ts`)
- `simless update` — 지금 버전, 설치된 버전, 되돌릴 수 있는 버전, 업데이트 방법.
- `simless update <설치 파일>` — 설치 파일 머리(표시·버전)를 보고, 지금보다 새것이면(`--force` 면 상관없이) `bash <파일>` 을 실행한다. 사람이 그 파일을 직접 `bash` 로 돌리는 것과 같다.
- `simless update --rollback` — `previous` 에 적힌 실행 파일로 `install` 한다. 그 버전이 링크를 되찾고 서버·앱·스킬을 맞춘다.
- 서버 재시작은 `install` 의 launchd 다시 등록(bootout → bootstrap)이 한다. 점유·대기열은 파일에 있어 유지된다.
- 개발 중(`bun link`)에는 파일·되돌리기를 거절한다 — 저장소에서 `git pull`.

**새 버전 확인 (R27, 미구현)** — 팀원이 받을 수 있는 주소가 정해지면 더한다. 계획: 서버가 시작할 때와 하루 한 번 최신 버전을 묻고(GitHub Release 면 로그인된 `gh` 로), 사람에게는 macOS 알림 한 번(메뉴바 앱의 M18 알림에 더함)·앱 창 배너, CLI 는 하루 한 번 stderr 한 줄, 에이전트에게는 `status`·MCP 의 `update: {current, latest}`. 받은 설치 파일은 sha256 을 확인한다. 외부 요청이 처음 생기는 것이라 그때 SECURITY.md §3 «네트워크 요청» 을 고친다.

**배포 쪽 — `scripts/release.ts`** — 작업 트리·검사·테스트 확인 → `package.json` 버전 → `CHANGELOG.md` 의 «아직 내지 않은 것» 을 새 버전 절로 → `chore(release): vX.Y.Z` 커밋 + `vX.Y.Z` 태그 → **`bun run build` 로 설치 파일**. 그 파일을 팀원에게 보낸다.

**참고 — Claude Code 의 설치·업데이트 구조** (이 Mac 에서 확인, 2026-10-08). simless 의 버전 폴더·링크는 이것을 본떴다.

| | Claude Code | simless (지금) |
| --- | --- | --- |
| 설치 | `curl -fsSL https://claude.ai/install.sh \| bash` — 작은 스크립트가 실행 파일을 Anthropic 서버에서 **따로 받는다** | `bash simless-<버전>-install.sh` — 실행 파일이 스크립트 **안에** 있다(받을 주소가 없어서, 약 33MB) |
| 두는 곳 | `~/.local/share/claude/versions/<버전>` + `~/.local/bin/claude` 링크 | `~/.local/share/simless/versions/<버전>/simless` + `~/.local/bin/simless` 링크 |
| 남기는 버전 | 최근 몇 개(이 Mac: 2.1.292·293·294, 각 약 235MB, 합 675MB) | 최근 3개 + 지금·바로 전 것(각 약 70MB) |
| 새 버전 확인·받기 | **자동** — 쓰는 중에 확인하고 뒤에서 받는다(이 Mac 에 하루 한두 번씩 들어옴: 10-07 04:14, 10-08 03:35·14:19). `claude update` 로 직접도 | 없음 — 설치 파일을 사람이 나눈다(R27 에서) |
| 교체 | 링크만 바꾼다 — 이미 돌던 세션은 그대로, **다음 실행부터** 새 버전 | 링크를 바꾸고 서버·앱·스킬을 **바로** 다시 맞춘다(`install`) |
| 되돌리기 | 남겨 둔 버전 | `simless update --rollback` |
| 실행되는 것 | 늘 링크가 가리키는 하나 | 같음 — 사용자에게 버전 폴더는 보이지 않는다(`~/.local` 은 숨김 폴더) |
| Gatekeeper | `curl` 로 받은 파일에는 «다운로드한 파일» 표시가 없다 | `bash` 가 꺼낸 파일에는 표시가 없다 |

버전 폴더를 남기는 이유는 **자동으로 받아 사용자 손에 예전 파일이 없기 때문**이다. 설치 파일을 사람이 나누는 동안에는 예전 설치 파일이 되돌리기 역할을 하므로 덮어쓰기(파일 하나)로도 충분하다 — 어느 쪽으로 할지는 Q18.

**앞으로 적용할 것** (정해지면)
1. **새 버전 확인 (R27, Q19)** — 팀원이 받을 수 있는 주소가 정해지면 `simless update` 가 «확인 → 받기(sha256 확인) → 설치» 를 한 번에 하고, 서버가 하루 한 번 확인해 macOS 알림·앱 창 배너·CLI 한 줄·에이전트(`status`·MCP 의 `update`)로 알린다. 주소 후보: GitHub Release(팀원 저장소 읽기 권한 + `gh` 로그인 — 원래 설계), 회사 GitHub 조직(멤버가 저장소를 만들 수 없으면 조직 관리자가 만들어야 함), 사내에서만 열리는 웹·파일 서버(GitHub 권한 불필요). 공개 주소는 실행 파일이 공개되므로 쓰지 않는다. 그때는 Claude Code 처럼 «작은 설치 스크립트 + 실행 파일 따로 받기» 로 바꿀 수 있고, 설치 위치·교체·되돌리기 코어는 그대로 쓴다. 외부 요청이 처음 생기므로 SECURITY.md §3 «네트워크 요청» 을 같이 고친다.
2. **설치 위치 방식 (Q18)** — 버전 폴더 유지 / 덮어쓰기(`~/.local/bin/simless` 파일 하나, 옆에 쓰고 이름 바꾸기로 교체, `--rollback` 대신 예전 설치 파일을 `--force` 로) 중 하나. 자동 업데이트(1)를 붙이면 버전 폴더가 다시 쓸모 있다.
3. **제거 고치기 (S12)** — 지금 `simless uninstall` 은 «`simless` 명령 자체는 남긴다» 는 예전 규칙대로라, 설치 파일로 설치했으면 `~/.local/bin/simless` 링크와 `~/.local/share/simless`(버전마다 약 70MB)가 남고 안내 문구(«`which simless` 가 가리키는 파일을 지우세요»)도 이 구조와 맞지 않는다. 설치 파일로 설치한 simless 는 제거 때 이 둘도 지우게 고친다(실행 중인 파일을 지우는 것은 괜찮다 — 프로세스는 끝날 때까지 옛 내용을 쓴다). 그때까지는 `rm ~/.local/bin/simless && rm -rf ~/.local/share/simless`.
4. **실제 서버를 낀 업데이트·되돌리기 확인** — 지금까지는 임시 홈에서 서버 없이 확인했다. 다음 버전 설치 파일로 이 Mac 에서 확인한다.

**나중에 다른 배포 방식** — Homebrew tap·서명된 DMG 를 더해도 위의 설치 위치·업데이트 코어는 그대로 쓴다. 다른 것은 받는 방법과, Homebrew 면 복사하지 않고 Homebrew 가 둔 곳을 쓰는 것, DMG 면 앱 안의 실행 파일을 쓰고 `install` 이 앱을 다시 만들지 않는 것뿐이다.

**1단계부터 지킬 것**: 버전은 semver 로 관리하고, 요청·응답에 실린 클라이언트·서버 버전을 비교해 다르면 알려 준다(업데이트 후 서버가 아직 옛 버전인 경우를 잡는다) — 1단계에서 구현함.

## 설계 결정 기록

> 구조 수준의 결정(앱 창·웹 화면 · TS · 단일 실행 파일 · `Simless.app` · 그룹 · 현지화)은 `requirements.md` «결정 기록» 에 있다. 여기에는 구현 수준의 결정만 둔다.

| 결정 | 이유 | 버린 대안 |
| --- | --- | --- |
| **상태를 바꾸는 요청은 Unix 소켓으로만**, HTTP 는 웹 화면·메뉴바용 | 소켓은 파일 권한(0600)으로 이 사용자만 접근한다. localhost HTTP 는 브라우저를 통한 공격 경로가 있어 토큰·Origin 검사를 따로 둔다 | HTTP 하나로 통일 (훅·CLI 까지 웹 공격면에 노출) |
| **대기 항목은 세션에 붙인다** | CLI 는 Bash 시간 제한(최대 10분)에 끊길 수 있고, MCP 는 호출 시간 제한 때문에 «다시 호출» 해야 한다. 연결에 붙이면 끊길 때마다 순번을 잃는다 | 연결 기준 대기 (끊기면 순번 잃음) |
| **훅은 명령 파싱 대신 식별자 문자열 포함으로 판정** | 셸 문법(`&&`·`$(…)`·변수)을 다 파싱할 수 없고, 파싱 누락이 곧 보호 구멍이다. 디바이스 식별자(UDID·AVD ID·시리얼)는 충분히 고유하다. **2026-10-06 보완**: 실행되지 않는 heredoc 본문(여는 줄에 셸·인터프리터가 없는 것)은 뺀다 — 파일에 쓰는 스크립트·커밋 메시지·문서 본문이 막히는 오탐이 실제로 났다. 셸 파싱으로 돌아간 것이 아니라 본문을 가리는 규칙 하나뿐이고, 여는 줄에 실행 도구가 하나라도 보이면 그대로 본다. 그렇게 쓴 파일을 다음 호출에서 실행하는 것은 원래부터 훅이 안을 볼 수 없어 새 구멍이 아니다(보호는 보안 경계가 아님 — `SECURITY.md` §2) | 셸 파서로 `-s` 인자 추출 (우회 쉬움), heredoc 본문을 늘 무시 (`bash <<EOF` 로 우회됨) |
| **Android 시리얼은 `-port` 로 서버가 정한다** | 시리얼이 켤 때마다 바뀌는 문제를 대부분 없앤다. 밖에서 켠 경우만 역조회 | 매번 `adb devices` + 역조회 (느리고 훅에서 부담) |
| **`main.ts` 에서 서브커맨드별 동적 import** | 훅은 Bash 호출마다 돈다. 서버·웹 코드를 불러오지 않아야 빠르다 | 진입점에서 전부 import |
| **패키지 하나** (모노레포 아님) | 결과물이 실행 파일 하나다. 경계는 폴더와 import 규칙(§3)으로 지킨다 | workspaces 로 shared·server·cli·web 분리 (설정만 늘어남) |
| **공용 호스트 아래에서는 터미널 탭(셸) 단위로 세션을 나눈다** (§7) | IDE·터미널 앱·tmux 는 여러 사람·에이전트 작업이 한 프로세스 아래 모인다. 호스트를 세션으로 보면 서로 다른 작업이 한 세션이 된다 | 호스트 프로세스를 세션으로 (전부 한 세션), 바로 위 셸을 세션으로 (에이전트가 명령마다 새 셸을 띄우면 매번 다른 세션) |
| **업데이트 확인에 `gh` 인증을 그대로 쓴다** (§19) | 저장소가 프라이빗이라 인증이 필요한데, 토큰을 따로 받아 저장하면 관리할 비밀이 생긴다. 개발자 Mac 에는 `gh` 가 이미 로그인돼 있다 | Simless 전용 토큰 저장 (비밀 관리 부담), 공개 저장소 (프라이빗 요구와 충돌) |
| **디바이스 목록은 드라이버에서 그때그때 읽고, 레지스트리엔 Simless 가 붙인 정보만** (R20·§6) | Xcode·Android Studio 에서 기기가 바뀌어도 바로 맞는다. 붙인 정보(메모·그룹·기본·슬림)는 `native`(UDID·AVD ID)로 잇는다. 기기가 사라져도 정보는 남겨 두었다가 다시 보이면 되살린다 | 기기 목록을 레지스트리에 저장 (밖의 변경과 맞추는 일이 생김) |
| **그룹 점유 모드는 `all` 기본 + `--available`, 교착은 대기열에 넣을 때 막는다** (§8·R23) | 판단은 에이전트가 하되(R23), 기본은 가장 안전한 «전부 아니면 전무». 일부를 쥔 채 기다릴 때만 순환이 생길 수 있으므로, 대기열에 넣는 순간 순환을 검사하면 교착이 아예 생기지 않는다 | 대기열만 (쥔 채 기다리는 두 세션의 교착을 못 막음), 일부 점유 + 대기 금지 (레이아웃 체크에서 나머지를 기다릴 수 없음), 생긴 뒤 감지 (이미 둘 다 멈춘 뒤라 한쪽을 깨워야 함) |
| **서버·CLI·화면이 같은 설정 언어·같은 사전으로 문장을 만든다, 에이전트는 오류 코드로** (§11·R25) | 언어 설정이 하나(`config.json`)라 창구마다 언어가 달라질 일이 없다. 서버가 문장을 만들면 드라이버 깊은 곳의 오류도 한 곳에서 번역된다. 에이전트는 문장이 아니라 `code` 로 판단하므로 언어와 상관없다 | 오류를 키 + 값으로 보내고 창구가 번역 (모든 오류 경로에 키·값을 실어야 해 복잡하고, 언어 설정이 하나라 얻는 게 없음) |
| **앱 창은 Swift 껍데기 + WKWebView, 화면은 웹 하나** (§14·R11) | 화면을 한 번만 만들고 브라우저·argent 로 확인한다. Dock 아이콘은 창이 열린 동안만 보여 메뉴바 앱의 가벼움을 유지한다 | SwiftUI 로 화면 다시 작성 (두 벌 유지), 창을 늘 띄우는 일반 앱 (메뉴바 앱과 역할이 겹침) |
| **버전: SemVer, 0.1.0 부터, CHANGELOG 는 커밋에서 초안 + 사람이 다듬기** (R19, 2026-10-05) | 업데이트 알림이 semver 비교를 전제로 한다. 커밋이 이미 `feat`·`fix` 형식의 한국어 요약이라 그대로 초안이 되고, 커밋마다 CHANGELOG 를 고치면 빠뜨리기 쉽고 커밋이 지저분해진다. 버전은 `package.json` 한 곳에서만, 스크립트로만 올린다 | 날짜 버전(호환 여부가 안 드러남), 커밋마다 CHANGELOG 고치기(빠뜨림), 커밋 목록을 그대로 CHANGELOG 로(사용자가 읽기 어려움) |
