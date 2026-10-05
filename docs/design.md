# Corgi 설계안 (v0.3 — 2026-10-05 사양 변경 반영)

> `requirements.md` 가 «무엇을», 이 문서가 «어떻게» 다. 둘이 충돌하면 `requirements.md` 가 이긴다.
> 설계를 바꾸면 이 문서를 고치고, 이유가 있는 결정은 맨 아래 «설계 결정 기록» 에 남긴다.
> 요구사항 ID(R·M·S·P·Q)는 `requirements.md` 를 가리킨다.

## 1. 한눈에 보기

```
 에이전트 A (Claude·Codex…) ── corgi <명령> ──────────┐
 에이전트 B ───────────────── corgi mcp ─────────────┤ Unix 소켓 (JSON Lines) — 상태를 바꾸는 요청은 여기로만
 에이전트의 실행 전 훅 ───── corgi hook <에이전트> ──┤
                                                     ▼
                  corgi serve  (launchd 가 띄우고, 죽으면 다시 살림)
                  ├─ 디바이스 목록 (이 Mac 전부 — 드라이버에서 읽음) + 레지스트리 (Corgi 가 붙인 정보)
                  ├─ 그룹·기본 디바이스
                  ├─ 점유·대기 관리
                  ├─ 드라이버 — Android: emulator·adb·avdslim / iOS: simctl·simslim
                  └─ HTTP 127.0.0.1 ── 웹 화면 (Corgi.app 창 · 브라우저) · 메뉴바
                                   ▼
                  에뮬레이터 · 시뮬레이터  ◀── 화면 안 조작·스크린샷은 argent (S6)
```

- 실행 파일은 **`corgi` 하나**다. `serve`·`hook`·`mcp`·나머지 CLI 명령이 모두 서브커맨드고, 사람이 여는 `Corgi.app` 도 같은 파일을 담은 껍데기다(§4).
- 상태는 **서버 하나만** 갖는다. 나머지는 요청을 보내는 창구라 상태가 없다(구조 전제).
- 같은 구조(Bun 서버 + 웹 대시보드 + 얇은 Swift 메뉴바)를 simfleet 이 쓰고 있고, 이 Mac 에서 동작을 확인했다.

## 2. 기술 선택

| 항목 | 선택 | 메모 |
| --- | --- | --- |
| 언어·런타임 | TypeScript · Bun | 개발·빌드용 Bun 버전은 `mise.toml` 로 고정 (현재 1.3.6). 받는 Mac 에는 Bun 이 필요 없다 |
| 배포 | `bun build --compile --minify --bytecode` **단일 실행 파일** (`darwin-arm64`, `bun run build` → `dist/corgi`). 개발 중에는 `bun link` 로 `.ts` 를 바로 실행 | 약 55MB. 훅 경로 시작 약 21ms(0단계 실측, `--bytecode` 없이 약 26ms). 새 바이너리의 첫 실행만 macOS 검사로 약 1초. **`--bytecode` 는 CJS 만 지원 → 최상위 `await` 를 쓰지 않는다** |
| CLI 인자 | `commander` | 서브커맨드·`--help` 정리 |
| 검증·타입 | `zod` 4 | 설정·소켓 메시지·저장 파일 스키마를 한 곳에서 정의하고 타입도 뽑는다. MCP SDK 도 쓴다 |
| 프로세스 정보 | `bun:ffi` 로 macOS libproc(`proc_pidinfo`·`proc_pidpath`) 호출 | 세션 찾기(§7)·종료 감지. `ps` 는 한 번에 20~80ms, FFI 는 약 3ms(실측) — 훅이 Bash 마다 돌기 때문 |
| MCP | `@modelcontextprotocol/sdk` (6단계) | stdio. zod 4 를 그대로 받는다. 단일 실행 파일이 약 3.4MB 커졌다(65→68MB) |
| 웹 화면 | React + Bun 내장 번들러(HTML import) | Vite 없이 `Bun.serve` 가 서빙. `Corgi.app` 창(WKWebView)과 브라우저가 같은 화면을 연다 |
| 플랫폼 로고 | `simple-icons` (CC0) | 애플·안드로이드 로고 경로 두 개만 쓴다(번들에도 그 둘만 들어간다). 손으로 그리면 모양이 어긋난다 |
| 현지화 | 의존 없이 `src/shared/i18n/` 의 사전(`ko`·`en`) | 웹 화면·CLI 가 같은 사전을 쓴다. 메뉴바(Swift)는 문구가 적어 Swift 안에 따로 둔다 |
| 테스트 | `bun test` | |
| 포맷·린트·타입 | Biome · `tsc --noEmit` | |
| 메뉴바·앱 창 | Swift 소스(AppKit + WKWebView)를 바이너리에 넣고 `corgi install` 때 `xcrun swiftc` 로 컴파일해 `Corgi.app` 에 넣는다 | 서명·공증 불필요 |

외부 의존은 위 목록으로 제한하고, 늘릴 때는 이 표에 이유를 적는다.

## 3. 저장소 구조

결과물이 실행 파일 하나라 **패키지도 하나**다(모노레포로 나누지 않는다).

```
corgi/
├── package.json · bun.lock · tsconfig.json · biome.json · mise.toml
├── bin/corgi.ts             `#!/usr/bin/env bun` — 개발용 진입점(`bun link` 가 가리킴), src/main.ts 로
├── src/
│   ├── main.ts              진입점 — 서브커맨드별로 필요한 모듈만 동적 import (훅이 빨리 끝나게)
│   ├── shared/              모델·메시지 스키마(zod)·경로·설정 로딩·소켓 클라이언트·i18n(문구 사전 ko·en)
│   ├── server/
│   │   ├── index.ts         corgi serve — 소켓·HTTP 서버 시작
│   │   ├── registry.ts      디바이스에 붙인 정보(메모·슬림·만든 여부)·그룹·기본 디바이스
│   │   ├── leases.ts        점유·대기·자동 해제
│   │   ├── sessions.ts      세션 식별·프로세스 감시
│   │   ├── drivers/android.ts · drivers/ios.ts
│   │   ├── socket.ts · http.ts
│   │   └── launchd.ts       LaunchAgent 등록·재시작
│   ├── cli/                 명령마다 파일 하나 (use.ts, create.ts …)
│   ├── hook/                훅 — 대상 추출(순수 함수) + 판정 + 서버 꺼짐 처리
│   ├── mcp/                 (5단계) MCP 서버
│   └── web/                 웹 화면 — index.html · App.tsx …
├── tray/CorgiTray.swift     메뉴바 아이콘 + 앱 창(WKWebView)
├── test/                    *.test.ts — 드라이버는 가짜로 바꿔 점유·대기·훅 판정을 검증
├── integrations/            이 Mac 의 다른 도구에 설치하는 것
│   ├── skill/corgi/SKILL.md          → ~/.claude/skills/corgi
│   └── rules/corgi.md                전역 규칙 (P2) → ~/.claude/rules/corgi.md
├── scripts/build.ts         단일 실행 파일 빌드 → dist/corgi
├── examples/apps/nova.json
├── docs/
│   ├── design.md            이 문서
│   └── protocol.md          소켓·HTTP 메시지 상세 (1단계에서 작성)
├── requirements.md · HANDOFF.md · reference-design-draft.md
└── CLAUDE.md                작업 규칙 (커밋 규칙 포함)
```

- `shared` 만 모두가 import 한다. `cli`·`hook`·`mcp`·`web` 은 `server` 를 import 하지 않고 소켓·HTTP 로만 대화한다 — 경계가 코드로 지켜지게.
- `integrations/`·`tray/`·웹 UI·`Info.plist` 틀은 **실행 파일 안에 넣는다**. 코드에서 파일을 경로로 찾지 말고 `import … with { type: "file" }`·HTML import 로 불러온다 — 그래야 `bun link`(개발)와 단일 실행 파일(배포)에서 같은 코드가 돈다. `corgi install` 이 꺼내 설치한다.

## 4. 설치·실행

| 명령 | 하는 일 |
| --- | --- |
| (배포) | `dist/corgi` 를 `~/.local/share/corgi/versions/<버전>/corgi` 에 두고 `~/.local/bin/corgi` 를 그 파일로 링크한다(§19). 혼자 쓸 땐 저장소에서 `bun link`. 동료와는 **프라이빗 GitHub Release** 에 올리고, 설치 스크립트가 `gh release download`(또는 `curl`)로 받아 배치 → `corgi install` 까지 한다. 브라우저로 받으면 격리 속성 때문에 실행이 막히므로 스크립트로 받는다 |
| `corgi install` | LaunchAgent(`~/Library/LaunchAgents/corgi.server.plist`, `RunAtLoad`·`KeepAlive`) 등록 → 서버 시작. launchd 는 로그인 셸 PATH 를 안 받으므로 **`corgi`·Android SDK 경로를 절대 경로로** 적는다. 스킬 설치, `~/Applications/Corgi.app` 생성 → 앱을 띄우면 **첫 실행 설정 창**(M14)이 뜬다. 보호(훅·규칙)와 MCP 는 그 창에서 고른다 — 터미널만 쓸 때는 `--hook`·`--mcp`. 훅·MCP 명령은 절대 경로로 적는다 |
| `corgi uninstall` | 위를 되돌린다(훅·규칙·MCP 등록 포함). 만든 디바이스는 지우지 않는다 |
| 첫 실행 설정 (M14) | 앱이 뜰 때 `status.setupNeeded` 면 설정 창(`?window=setup`)을 연다 — ① 이 Mac 점검(`corgi doctor` 와 같은 점검, 빠진 도구는 설치 명령과 복사 버튼, «다시 확인») ② 에이전트 연결(스킬 권장 · 보호 권장 · MCP 선택 — 버튼 하나로 설치·제거, 서버가 한다) ③ 기본 디바이스(없으면 목록에서 고르거나 생성 창). «완료» 면 `setup.json` 을 남기고 대시보드를 연다. 끝내지 않고 닫으면 다음에 또 뜬다. 설정 창에서 다시 연다 |
| `Corgi.app` | 메뉴바 앱 + 앱 창(§14). `tray/CorgiTray.swift` 를 컴파일한 실행 파일 + `Info.plist`(`LSUIElement` — 평소엔 Dock 아이콘 없음) + 아이콘, ad-hoc 서명. 더블클릭·Spotlight·Launchpad 에서 연다. Xcode 가 없어 컴파일을 못 하면 브라우저로 웹 화면을 여는 스크립트로 대신한다 |
| 로그인 항목 이름 | macOS 로그인 항목(«앱 백그라운드 활동»)에는 실행 파일 서명자 이름이 보인다 — 개발 모드는 bun 의 «Jarred Sumner». `Corgi.app` 을 만들 때(3단계) plist 에 `AssociatedBundleIdentifiers` 로 앱을 연결해 «Corgi» 로 보이게 한다. 사용자가 이 항목을 끄면 launchd 가 서버를 띄우지 않으므로 `corgi doctor` 가 확인한다 |
| 서버 자동 시작 (Q10) | CLI·MCP 는 소켓이 없으면 `launchctl kickstart` 로 켜고 몇 초 기다린다. 훅은 켜지 않는다 |
| 업데이트 | `corgi update` — 확인·알림·교체·되돌리기는 §19. 클라이언트·서버 버전이 다르면 `hello` 에서 알려 준다 |

## 5. 런타임 파일 위치

| 경로 | 내용 | 쓰는 쪽 |
| --- | --- | --- |
| `~/Library/Application Support/Corgi/registry.json` | 디바이스에 Corgi 가 붙인 정보(메모·슬림·만든 여부·기준값), 그룹, 기본 디바이스 (영속). 기기 자체 목록은 저장하지 않는다(§6) | 서버 |
| `…/Corgi/leases.json` | 점유·대기열 — 서버를 다시 켜도 복원 | 서버 |
| `…/Corgi/history.json` | 점유 기록 — 최근 500개 (M13) | 서버 |
| `…/Corgi/managed-index.json` | 이 Mac 디바이스 식별자(UDID·AVD ID·마지막 시리얼). **서버가 꺼졌을 때 훅이 읽는다** | 서버 쓰기 / 훅 읽기 |
| `…/Corgi/corgi.sock` | 소켓 (권한 0600) | 서버 |
| `…/Corgi/web-token` | 웹 화면 요청 토큰 (0600) | 서버 |
| `…/Corgi/update.json` | 마지막 확인 시각·최신 버전·알림 보낸 버전 | 서버 |
| `~/Library/Logs/Corgi/` | 서버 로그 | 서버 |
| `~/.local/share/corgi/versions/<버전>/corgi` · `~/.local/bin/corgi`(링크) | 설치된 버전들과 지금 쓰는 버전 (§19) | `corgi update` |
| `~/.config/corgi/config.json` | 사용자 설정 — 언어(`system`·`ko`·`en`, 기본 `system`), 자동 해제 시간(기본 30분), HTTP 포트, Android SDK 위치·RAM·에뮬레이터 옵션, simslim 프로필 경로. 앱 창의 설정 화면이 고친다 | 사람·서버 |
| `~/.config/corgi/apps/<name>.json` | 앱별 설정 (Q8) | 사람 |
| `~/.android/avd/<AVD ID>.avd` · `.ini` | Android 디바이스 본체 — Corgi 가 만든 것은 `corgi_<id>` | Android Studio·서버 |
| CoreSimulator 기본 device set | iOS 디바이스 본체 | Xcode·서버(simctl) |

## 6. 모델

**디바이스 목록은 저장하지 않는다** (R20). 이 Mac 의 디바이스는 서버가 드라이버에서 그때그때 읽고(전부 — 생성 화면의 «이 Mac 의 디바이스» 에 쓴다), 메인 목록·점유·보호는 그중 `listed`(Corgi 목록)만 다룬다(Android `~/.android/avd/*.ini`, iOS `simctl list devices available`), 레지스트리에는 **Corgi 가 붙인 정보만** 둔다. Xcode·Android Studio 에서 기기를 지우거나 만들어도 바로 맞는다.

**Device** (서버가 합쳐서 보여 주는 값)

| 필드 | 출처 | 설명 |
| --- | --- | --- |
| `id` | 레지스트리 | Corgi 가 붙이는 짧은 ID(예: `k3f9`). 처음 본 기기에 붙이고 **절대 안 바뀐다** (R4). 그룹·점유·메모는 이 ID 를 가리킨다 |
| `platform` | 드라이버 | `android` / `ios` |
| `native` | 드라이버 | Android AVD ID · iOS UDID — 이름을 바꿔도 그대로. 레지스트리는 이 값으로 기기와 `id` 를 잇는다 |
| `name` | 드라이버 | 표시 이름 (Android `avd.ini.displayname`, iOS 시뮬레이터 이름) |
| `spec` | 드라이버 | Android `widthPx·heightPx·density·systemImage` · iOS `deviceType·runtime·widthPt·heightPt·scale` |
| `createdByCorgi` | 레지스트리 | Corgi 가 만든 기기 — 삭제·슬림 켜고 끄기는 이것만 (M7·M8·N5) |
| `listed` | 레지스트리 | Corgi 목록에 있는지 (R20). 만든 기기는 늘, 원래 있던 기기는 생성 화면에서 추가했을 때만. 값이 없으면(이전 형식) `createdByCorgi` 와 같다. 빼면 그룹 소속·기본 지정·점유도 푼다 |
| `slim` | 레지스트리 | `none`·`applying`·`applied`·`failed` (+ `slimError`). 풀림은 켤 때 자동 재적용하므로 따로 두지 않는다 (M6) |
| `slimBaseline` | 레지스트리 | 슬림 전 메모리 기준값 (M10) |
| `memo` | 레지스트리 | 디바이스 메모 (R24) |
| `default` | 레지스트리 | 이 플랫폼의 기본 디바이스인지 (R22) |
| `groups` | 레지스트리(그룹) | 든 그룹 ID 목록 (R21) |

- **기기가 사라지면 붙인 정보도 지운다** — Corgi 로 지웠을 때, 그리고 밖(Xcode·Android Studio)에서 지워 드라이버 목록에 없을 때 그 `id` 의 메모·슬림 정보·그룹 소속·기본 지정을 지운다. 밖에서 지운 경우는 **목록 읽기가 성공했을 때만** 지운다(`simctl` 오류로 빈 목록이 오면 지우지 않는다).
- Android AVD ID 는 Corgi 가 만든 것만 `corgi_<id>` 다. 표시 이름은 슬림이면 `corgi …` 접두사(R5), 슬림을 나중에 켜고 꺼도 이름은 그대로.
- 이름 변경 시 Android `avd.ini.displayname`, iOS `simctl rename` 을 바꿔 에뮬레이터 창·Simulator 창에서도 알아보게 한다. 원래 있던 기기의 이름도 바꿀 수 있다.
- iOS 폭(pt) = `/Library/Developer/CoreSimulator/Profiles/DeviceTypes/<종류>.simdevicetype/Contents/Resources/profile.plist` 의 `mainScreenWidth ÷ mainScreenScale` (확인: iPhone 17 → 1206 ÷ 3 = 402pt). M2 의 «폭 맨 앞» 에 쓴다.

**Group** (R21) — `id`, `name`(겹치지 않게), `description`(에이전트도 읽음, «모두 필요» 같은 힌트), `deviceIds[]`, `updatedBy`(마지막으로 고친 세션 — `human` 또는 에이전트 이름), `updatedAt`. 한 디바이스가 여러 그룹에 들 수 있다.

**기본 디바이스** (R22) — `{ android?: deviceId, ios?: deviceId }`. 그 플랫폼에 기본이 없을 때 Corgi 로 디바이스를 만들면 **그 디바이스가 자동으로 기본**이 된다. 사람·CLI 로 바꿀 수 있다. 기본이 없으면(만든 게 없거나 밖에서 지워짐) `NO_DEFAULT` 로 실패하고 만들거나 정하라고 안내한다.

실행 중 값(켜짐 여부, Android 시리얼)은 저장하지 않고 서버가 들고 있다.

**Session** — `id`(§7 세션 키), `agent`(표시용 — `claude-code`·`codex`·`gemini`·…·`human`·`unknown`), `pid`·`pidStartedAt`, `agentSessionId`(어댑터가 주면), `cwd`(표시용), `lastUsedAt`

**Lease** — `deviceId → sessionId, acquiredAt` · **대기열** — `[{sessionId, deviceIds, enqueuedAt}]` (디바이스마다 FIFO)

## 7. 세션 구분 (R13·R18)

세션 = **명령을 실행한 에이전트 프로세스**. 에이전트가 세션 ID 를 주는지와 상관없이 프로세스 트리를 거슬러 올라가 찾는다. CLI·MCP 서버·훅은 모두 에이전트가 띄운 자식이라 같은 방법으로 같은 세션이 나온다 — 에이전트 종류에 묶이지 않는다.

**찾는 순서** (`corgi` 프로세스의 부모부터 위로)

| 순서 | 조건 | 세션 |
| --- | --- | --- |
| 1 | `--session <값>` 또는 `CORGI_SESSION_ID` 가 있음 | 그 값 (스크립트·특수한 에이전트용). 프로세스 기준 해제가 필요하면 `CORGI_SESSION_PID` 도 준다 |
| 2 | 셸·래퍼(`zsh`·`bash`·`sh`·`fish`·`env`·`timeout`·`sandbox-exec` 등)를 건너뛰고 처음 만난 프로세스가 **공용 호스트가 아님** | 그 프로세스 = 에이전트 (`claude`·`codex`·`gemini`·`node …` 등) |
| 3 | 처음 만난 셸 아닌 프로세스가 **공용 호스트**(`login`·`tmux`·`screen`·터미널 앱·IDE 의 Helper — `Terminal`·`iTerm2`·`Ghostty`·`Code Helper`·`Cursor Helper`·`Orca Helper` …) | 호스트 바로 아래 셸 = 터미널 탭 하나. 에이전트 표시 변수가 있으면 에이전트, 없으면 `human` |

- 세션 키 = `pid` + 프로세스 시작 시각 (PID 재사용 구분). 셸·래퍼·호스트 목록은 설정으로 늘릴 수 있다.
- 실측(이 Mac): `corgi ← zsh ← claude ← zsh ← zsh ← login ← Orca Helper` → 2번, 세션은 `claude`. argent MCP 서버(`argent mcp`)의 부모도 `claude` 였다.

**에이전트 종류** — 표시용, 판정에는 쓰지 않는다: `AI_AGENT` 환경 변수(확인: `claude-code_2-1-287_agent`) → 에이전트별 표시 변수(`CLAUDECODE` 등) → 프로세스 이름·명령줄 → `unknown`.

**에이전트 어댑터** — 있으면 더 정확해지는 보조 정보. 없어도 위 방식만으로 동작한다.
- 보조 세션 ID: Claude Code 는 CLI 에 `CLAUDE_CODE_SESSION_ID`, 훅 입력에 `session_id` 를 준다. 기록해 두고, **같은 프로세스에서 값이 바뀌면**(`/clear` 등) 새 세션으로 보고 이전 점유를 푼다 — 새 대화는 자기가 점유했다는 걸 모르기 때문.
- 실행 직전 훅: §13.

**사람·앱 창** — `human` 세션은 프로세스 기준 해제를 하지 않고 30분 규칙만 적용한다. 앱 창·브라우저의 웹 화면은 항상 `human`.

**한계** — 여러 대화가 프로세스 하나를 같이 쓰는 에이전트(IDE 안 에이전트 등)는 대화가 아니라 프로세스·터미널 단위로 구분된다. 필요하면 1번으로 보완한다.

## 8. 점유·대기 (R13·R14·R17·R23)

- **단위는 디바이스**. 요청은 디바이스(ID·이름), 그룹(`--group`), 기본 디바이스(`--default [android|ios]`)로 한다. 그룹·기본은 서버가 디바이스 목록으로 풀어서 같은 방식으로 처리한다.
- 같은 세션이 다시 요청하면 그대로 통과(재진입).
- **응답에 기기마다 상태**를 싣는다: `held`(이 세션이 잡음) · `free` · `busy`(누가·언제부터) · `queued`(대기 순번). 에이전트는 이걸 보고 판단한다 (R23).
- **모드** — 여러 대를 요청할 때 무엇을 잡을지는 에이전트가 고른다

  | 모드 | CLI | 동작 | 쓰는 예 |
  | --- | --- | --- | --- |
  | `all` (기본) | — | 전부 비어 있을 때만 전부 잡는다. 하나라도 바쁘면 아무것도 안 잡고 실패(종료 코드 3) | DM 확인 (2대가 다 있어야 함) |
  | `available` | `--available` | 비어 있는 것만 잡고, 바쁜 것은 상태만 알려 준다 | 레이아웃 체크 (있는 것부터) |
  | `available` + 대기 | `--available --wait` | 비어 있는 것을 잡고, 나머지는 대기열에 넣어 풀리면 서버가 잡아 준다 | 레이아웃 체크 (나머지도 곧 필요) |
  | `all` + 대기 | `--wait` | 전부 빌 때까지 기다렸다가 한 번에 잡는다 | DM 확인을 기다려서라도 |

- **교착 막기 — 대기열에 넣을 때 검사**: 기다리는 요청은 모두 대기열로 받는다. 다만 대기열(먼저 온 순서)만으로는 «A 가 X 를 쥐고 Y 를 기다리고, B 가 Y 를 쥐고 X 를 기다리는» 교착을 막지 못한다 — 둘 다 이미 쥔 것을 놓지 않기 때문이다. 그래서 **대기열에 넣는 순간** «기다리는 기기의 주인이 (직간접으로) 내가 쥔 기기를 기다리는지» 를 따라가 순환이 생기면 넣지 않고 바로 `DEADLOCK`(누구와 엮였는지)을 돌려준다 — 교착이 생기기 전에 막는다. 그 세션은 쥔 것으로 진행하거나, 놓고 `all + 대기` 로 다시 요청한다. `all + 대기` 는 아무것도 쥐지 않고 기다리므로 순환을 만들지 않는다.
- **`--wait`**: 대기열에 넣고, 차례가 오면 **서버가 알아서 점유**해 준다. 대기 항목은 연결이 아니라 **세션**에 붙는다 → CLI 가 Bash 시간 제한으로 끊겨도 순번이 유지되고, 다시 `--wait` 하면 이어서 기다린다. MCP 의 «대기 중 → 다시 호출» 도 같은 방식이다.
- 대기는 **디바이스마다 먼저 온 순서** — 같은 디바이스를 먼저 기다리는 세션이 있으면, 그 디바이스가 비어 있어도 뒤에 온 세션(기다리기 없는 요청 포함)이 새치기하지 못한다. 겹치지 않는 디바이스는 대기열과 상관없이 잡는다.
- **자동 해제**
  1. 세션 프로세스 종료 → 바로. 2초 간격으로 PID 생존과 시작 시각(PID 재사용 거르기)을 확인한다. 대기열에서도 뺀다.
  2. `lastUsedAt` 후 30분(설정) 지나고 **대기열에 누가 있을 때만**.
- `lastUsedAt` 갱신: 그 세션의 CLI 요청, MCP 요청, 훅이 통과시킨 호출(argent 포함).
- **사람(앱 창)** 은 점유 없이 켜고 끈다. 다른 세션이 잡고 있으면 막는다.
- **강제 해제**: 앱 창, 또는 CLI `release --force` (확인 질문). 스킬에는 «에이전트는 쓰지 않는다» 로 적는다.

## 9. 디바이스 수명주기 (드라이버)

| 단계 | Android | iOS |
| --- | --- | --- |
| 목록 (R20) | `~/.android/avd/*.ini` + 각 `config.ini` 를 읽는다 | `simctl list devices available -j` + 기기 종류 profile.plist(폭) |
| 생성 — 고를 것 (M1) | 기종: 대표 프로필(`src/server/drivers/android-profiles.ts`, Android Studio 기기 정의를 본뜸) 또는 직접 입력(폭·높이·밀도). OS: 설치된 시스템 이미지(추천: 4KB 페이지·API 높은 순) | 기종: `simctl list devicetypes` 중 설치된 런타임이 지원하는 것. OS: 설치된 런타임(기본: 최신) |
| 생성 — 만들기 | `corgi_<id>.ini` + `.avd/config.ini` 를 새로 쓴다(`hw.lcd.width/height/density`, `image.sysdir.1`) | `simctl create <이름> <종류> <런타임>` → UDID. `simctl clone` 은 앱·데이터가 따라와 쓰지 않는다 |
| 슬림화 (R5) | `avdslim tune-avd` + 켠 뒤 `avdslim on <시리얼>` | `simslim on <udid> --preserve-boot-state` |
| 슬림화하면 안 되는 기능 (M4 ⓘ) | avdslim 프로필이 끄는 패키지 목록(`avdslim profiles`)을 사람이 읽을 이름으로 묶어 보여 준다 | simslim 프로필이 끄는 서비스 목록을 묶어 보여 준다(Siri·Spotlight·iCloud·Wallet …) |
| 슬림 확인 (M6) | 프로필 패키지 중 꺼진 비율 ≥ 50% | `simslim verify` — 켜진 기기만 가능 |
| 켜기 | `emulator -avd <AVD ID> -port <빈 포트> -no-snapshot-save` 를 서버와 분리(detached)해 실행. `sys.boot_completed == 1` 까지 대기 | `simctl boot` **한 대씩 순서대로** (동시 부팅 중단 오류 회피) + `simctl bootstatus` |
| 끄기 | `adb -s <시리얼> emu kill` | `simctl shutdown` |
| 이름 변경 | `avd.ini.displayname` | `simctl rename` |
| 삭제 (M8, Corgi 가 만든 것만) | 끄고 `.avd`·`.ini` 삭제 | 끄고 `simctl delete` |

- **Android 시리얼을 서버가 정한다**: `-port` 로 켜면 시리얼이 `emulator-<port>` 로 정해진다. 밖에서 켠 경우는 `adb -s <시리얼> emu avd name` 으로 역조회한다.
- 에뮬레이터·시뮬레이터는 서버의 자식으로 묶지 않는다 — 서버가 재시작해도 디바이스는 계속 돈다.
- **슬림 확인과 자동 재적용** (M6): 슬림한 기기를 켤 때마다(서버 시작 시엔 켜진 것) 확인하고, 풀렸으면 바로 다시 적용한다. 실패하면 `slim: failed` + 이유를 남겨 `SLIM ⚠` 로 보인다. 원래 있던 기기(`createdByCorgi: false`)는 슬림화하지 않는다 (N5).
- 생성·슬림화는 멱등 — 이미 맞으면 아무것도 안 한다.

## 10. 앱 설치·실행·같은 화면 이동 (R8·R9·R10) — argent 로

Corgi 는 하지 않는다. 에이전트가 `corgi list --json`(또는 `corgi use --json`)에서 기기마다 **argent 에 넘길 ID**(`targetId` — UDID·시리얼)와 **크기 라벨**(`label` — 예: `Android 360dp`)을 받아, argent 로 기기마다 한다 (S6, 결정 기록).

| 할 일 | argent | 비고 |
| --- | --- | --- |
| 앱 설치 | `reinstall-app` | Android APK·iOS 시뮬레이터용 .app |
| 앱 실행 | `launch-app`, dev client 는 `open-url` | Android 는 Metro 에 붙으려면 `adb -s <시리얼> reverse tcp:8081 tcp:8081` 이 필요하다 — 스킬이 안내 |
| 같은 화면 | `open-url <딥링크>`, 딥링크 없는 화면은 argent 흐름 재생 | |
| 화면 확인 | `screenshot` | 크기 라벨을 붙여 보고 |

- Metro 는 띄우지 않는다. 앱 쪽 세션이 띄운 것을 같이 쓴다 (S7).
- 점유한 디바이스만 argent 로 다룬다 — 5단계 훅이 지킨다 (P1·P8).

**나중에(L1~L3) 만들 때 참고** — 2단계에서 한 번 만들다 되돌린 내용이다.

| 동작 | Android | iOS |
| --- | --- | --- |
| 설치 | `adb -s <시리얼> install -r <apk>` (기기별 병렬, 큰 APK 는 몇 분) | `simctl install <udid> <.app>` |
| 실행 | `adb reverse tcp:<metro> tcp:<metro>` → dev client 주소 `am start -W -a android.intent.action.VIEW -d '<주소>' <패키지>`, 주소가 없으면 `monkey -p <패키지> -c android.intent.category.LAUNCHER 1` | `simctl openurl <udid> <주소>` (호스트 localhost 를 그대로 씀), 주소가 없으면 `simctl launch` |
| 딥링크 | `am start -W -a android.intent.action.VIEW -d '<딥링크>' [<패키지>]` | `simctl openurl <udid> <딥링크>` |

- `adb shell` 은 인자를 이어 붙여 기기 셸에 넘기므로 주소의 `?`·`&` 가 해석되지 않게 작은따옴표로 감싼다.
- 앱별 설정 `~/.config/corgi/apps/<이름>.json` (Q8): `android.package`·`android.apk`·`ios.bundleId`·`ios.app`·`devClientScheme`(→ `<스킴>://expo-development-client/?url=http%3A%2F%2F127.0.0.1%3A<metroPort>`)·`deepLinkScheme`(`/home` → `<스킴>://home`)·`metroPort`(기본 8081, 응답이 없으면 경고만).
- NOVA 값(2026-10-02 확인): Android `com.ensapia.nova.alpha` · APK `<xb3-client>/rn/android/app/build/outputs/apk/debug/app-debug.apk` · iOS 번들 ID `com.ensapia.nova.alpha` · `.app` 은 DerivedData 의 `NOVADEVA.app` · dev client 스킴 `exp+novadeva` · 딥링크 스킴 `novaa`.

## 11. 통신 (요약 — 상세는 `docs/protocol.md`)

**Unix 소켓** — CLI·MCP·훅

- 한 줄에 JSON 하나(JSON Lines), 연결 하나에 요청 하나. 요청마다 `clientVersion`, 응답마다 `serverVersion` 을 실어 버전을 맞춘다(별도 `hello` 대신).
- 요청 `{"v":1,"id":"r1","method":"lease.acquire","session":{…},"params":{…}}`
- 응답 `{"id":"r1","ok":true,"result":{…}}` / `{"id":"r1","ok":false,"error":{"code":"BUSY","message":"…","holder":{…}}}`
- 긴 작업(부팅·설치)은 응답 전에 `{"id":"r1","event":"progress","data":{…}}` 를 여러 번 보낸다.
- 메서드: `status` · `catalog`(생성 화면의 기종·OS 목록, 슬림화하면 안 되는 기능) · `device.create|list|rename|setMemo|setDefault|slim|delete|up|down` · `group.list|create|update|delete` · `lease.acquire|release|who` · `settings.get|set` · `hook.check`
- 오류 코드: `BUSY` · `NOT_HELD` · `NOT_FOUND` · `INVALID` · `NOT_ALLOWED`(원래 있던 기기 삭제·기본 디바이스 삭제 등) · `DEADLOCK` · `NO_DEFAULT` · `TOOL_MISSING`(avdslim 등 없음) · `FAILED` · (클라이언트 쪽) `SERVER_DOWN`
- **현지화 (R25)**: 서버·CLI·웹 화면이 **같은 설정 언어와 같은 사전**(`src/shared/i18n`, 키의 정본은 `ko.ts`, `en.ts` 는 같은 키를 다 갖춰야 컴파일된다)으로 문장을 만든다. 서버가 보내는 오류·진행 문장도 설정 언어다. 에이전트는 문장이 아니라 오류 `code` 로 판단한다. 언어 설정이 `system` 이면 macOS 언어 설정(`AppleLanguages`)을 먼저 보고 — 터미널의 `LANG` 은 macOS 언어와 다르게 잡혀 있는 경우가 많다 — 없으면 `LANG`, 그래도 없으면 영어

**HTTP** — 웹 화면(앱 창·브라우저)·메뉴바

- `127.0.0.1:<포트>`(기본 8791, 설정)에만 연다.
- `GET /api/status`, `GET /api/events`(SSE — 점유·켜짐·슬림·그룹 변화), 웹 화면의 조작은 `POST /api/…` 가 소켓과 같은 메서드를 부른다(세션은 `human`).
- 보안(다른 웹사이트가 localhost 로 요청하는 공격 대비): `Host` 가 `127.0.0.1`·`localhost` 가 아니면 거부(DNS rebinding), `POST` 는 `Origin` 검사 + `web-token` 헤더 필수. 토큰은 앱 창·`corgi ui` 가 여는 URL 로 전달한다.

## 12. CLI

모든 명령에 `--json`. 디바이스는 ID 나 이름으로 가리킨다. 지정하지 않으면 «사용 중인 디바이스 전부». 문구는 설정 언어를 따른다(R25), `--json` 은 언어와 상관없이 같다.

| 명령 | 하는 일 | 요구사항 |
| --- | --- | --- |
| `corgi status` | 서버 연결, 디바이스, 그룹, 점유·대기 한눈에 | S2·R13 |
| `corgi doctor [--fix]` | 서버·launchd·Android SDK·시스템 이미지·avdslim·Xcode·simslim·argent(여러 버전)·스킬 점검과 고치는 방법. `--fix` 는 launchd·스킬만 고친다. 훅 점검은 5단계 | S1·S2 |
| `corgi install [--no-launchd] [--no-skill] [--no-app]` · `uninstall` | launchd 등록 + 스킬 + `Corgi.app` (§4) | S1 |
| `corgi ui` | 웹 화면을 브라우저로 연다 (앱 창은 `Corgi.app`) | R11 |
| `corgi list [--platform] [--group <그룹>] [--created]` | **이 Mac 의 디바이스 전부** — 폭·이름·켜짐·SLIM·기본·그룹·메모·사용 중인 세션·argent ID | M5·R20 |
| `corgi catalog [--platform]` | 만들 수 있는 기종·OS 목록 | M1 |
| `corgi create <기종> [--os] [--name] [--no-slim] [--no-baseline]` · `corgi create --width --height --density [--os]` | 새로 만들기. 슬림이면 `corgi …` 이름 | R1~R3·R5·M4 |
| `corgi rename <dev> <name>` · `memo <dev> [<text>]` · `default <dev>` · `delete <dev>` | 관리. 삭제는 Corgi 가 만든 것만 | M7·M8·R22·R24 |
| `corgi slim [<dev>…] [--off] [--check]` | 슬림 적용·해제·확인 (Corgi 가 만든 것만) | M6·M7 |
| `corgi group list` · `show <그룹>` · `create <이름> [--desc] [<dev>…]` · `edit <그룹> [--name] [--desc] [--add <dev>…] [--remove <dev>…]` · `delete <그룹>` | 그룹 관리 — 사람·에이전트 모두 | R21·S10 |
| `corgi acquire [<dev>… \| --group <그룹> \| --default [android\|ios]] [--available] [--wait] [--timeout 10m]` | 점유 (모드는 §8) | R14·R22·R23 |
| `corgi release [<dev>…] [--force]` | 점유 해제 | R17·S8 |
| `corgi who [<udid·시리얼·dev>]` | 누가 쓰는지 | R13 |
| `corgi up` · `corgi down` | 점유한 디바이스 켜기·끄기 | R7 |
| **`corgi use [<dev>… \| --group … \| --default …] [--available] [--wait]`** | **acquire + up 한 번에** — 주 흐름의 첫 단계 | R15 |
| `corgi config [get\|set <키> <값>]` | 설정 (언어 등) — 앱 창 설정 화면과 같은 값 | M11·R25 |
| `corgi update [--check] [--rollback]` | 새 버전 확인·업데이트·이전 버전으로 되돌리기 | R19 |
| `corgi serve` · `corgi hook <에이전트> pre-tool-use` · `corgi mcp` | 서버·훅·MCP 진입점 (사람이 직접 쓰지 않음) | — |

- 종료 코드: `0` 성공 · `1` 실패 · `2` 사용법 오류 · `3` 다른 세션이 사용 중(`--available` 이면 하나도 못 잡았을 때만) · `4` 서버에 연결 못 함
- `up`·`down` 은 점유가 있어야 한다. 없으면 실패하고 `corgi use` 를 안내한다.
- 없앤 것: `enable`·`disable`(사용 안 함, R6), `list --all`(목록이 처음부터 전부).
- 일괄 설치·실행·딥링크(`install-app`·`launch`·`open`)는 «나중에» (L1~L3, §10).

## 13. 훅 (P3~P9)

**에이전트 어댑터**: 실행 직전 훅은 에이전트마다 지원 여부·설정 위치·입력 형식이 다르다. `corgi hook <에이전트> <이벤트>` 로 나누고, 어댑터는 입력을 공통 형식 `{tool, input, agentSessionId?}` 로 바꾼 뒤 같은 판정을 쓴다.

| 에이전트 | 상태 |
| --- | --- |
| Claude Code | **먼저 만든다** — `~/.claude/settings.json` PreToolUse, matcher `Bash|mcp__argent__.*`, 명령 `corgi hook claude pre-tool-use` |
| Codex · Gemini CLI · Cursor · OpenCode · Copilot CLI | 훅 지원·입력 형식을 조사해 어댑터를 붙인다(§17). 훅이 없으면 규칙 + CLI 의 BUSY 응답으로만 보호된다(Q16) |

**흐름**
1. 어댑터가 stdin 입력을 공통 형식으로 바꾼다. 세션은 §7 방식(훅 프로세스의 부모 체인)으로 찾고, 입력에 세션 ID 가 있으면 보조로 쓴다.
2. **빠른 통과**: Bash 명령에 `adb`·`simctl`·`emulator`·`simslim`·`avdslim` 이 없고, argent 도구에 기기 인자가 없으면 바로 통과한다(소켓 안 엶). `main.ts` 는 이 경로에서 서버·웹 코드를 불러오지 않는다.
3. 대상(`src/hook/targets.ts` — 순수 함수)을 뽑아 서버에 `hook.check` → 허용/차단 + 사유. 대상은 **Corgi 목록의 디바이스**만(P1) — AVD ID·UDID·지금 시리얼로 잇는다(Corgi ID 는 흔한 낱말과 겹칠 수 있어 빼고). 켜짐 상태(시리얼)를 읽는 데 0.5초쯤 걸려 서버가 10초 기억하고, 상태를 바꾸는 요청이 오면 버린다. 허용이면 서버가 같은 요청으로 `lastUsedAt` 을 갱신한다. 실측: 빠른 통과 약 20ms, 판정 약 30ms(기억이 없을 때 0.6초).
4. **서버가 꺼져 있으면** `managed-index.json` 으로 이 Mac 의 디바이스인지만 본다. 맞으면(또는 시리얼을 판정 못 하면) 차단하고 «`corgi status` 로 서버를 켜세요» 를 알려 준다 (P9).
5. 차단은 `permissionDecision: "deny"` JSON 으로 돌려주고, 사유에 **누가 쓰는 중인지와 점유 방법**(`corgi use …`)을 넣는다 (P5). 서버가 이상한 답(모르는 메서드 등)을 하면 막지 않는다 — 훅 때문에 에이전트가 멈추지 않게.

**대상 판정**

| 호출 | 대상 |
| --- | --- |
| argent 도구의 `udid`·`device_id`·`avdName` 인자 | 그 값 |
| argent `list-devices` 등 기기 인자 없는 도구 | 없음 → 통과 (P6) |
| argent `boot-device` · Bash `emulator -avd …` 로 디바이스 켜기 | 점유와 상관없이 **차단** → `corgi up` 안내 (S6 «켜기는 Corgi 로») |
| Bash 명령 문자열 안에 디바이스 식별자(UDID·AVD ID·현재 시리얼)가 보임 | 그 디바이스 — 명령을 파싱하지 않고 **문자열 포함**으로 본다. `&&`·`$(…)`·변수 등으로 우회되기 어렵다 |
| `adb` 를 기기 지정 없이 기기 명령에 씀(`adb shell` 등, `ANDROID_SERIAL` 미지정) | 켜진 Android 전부 |
| `simctl … booted` | 켜진 iOS 전부 |
| `adb devices`·`emulator -list-avds`·`simctl list` 등 목록 조회 | 없음 → 통과 (P6) |

**규칙 (P2)** — `integrations/rules/corgi.md` 를 `corgi install` 이 `~/.claude/rules/corgi.md` 로 따로 설치한다(argent 의 `argent.md` 에 붙이면 argent 업데이트가 덮어쓴다). 다른 에이전트의 전역 규칙 위치는 조사 후.

**설치** — 첫 실행 설정 창(M14)의 «보호» 또는 `corgi install --hook` 이 `~/.claude/settings.json` 의 `hooks.PreToolUse` 에 matcher `Bash|mcp__argent__.*`, 명령 `<corgi 절대 경로> hook claude pre-tool-use` 한 줄을 넣는다. 다른 설정·훅은 그대로 두고, 예전 Corgi 훅(명령이 ` hook claude pre-tool-use` 로 끝남)은 바꾸며, 쓰기 전에 `settings.json.corgi-backup` 을 남긴다. 기본으로는 넣지 않는다 — 다른 세션이 Corgi 없이 쓰는 기기가 목록에 있으면 그 세션까지 막으므로 사람이 고른다. `corgi uninstall` 이 지운다. `corgi doctor` 가 훅·규칙을 점검하고, `--fix` 는 이미 넣은 것이 예전 것일 때만 고친다.

> Corgi 목록(`corgi list`)의 시뮬레이터·에뮬레이터는 `corgi use` 로 점유한 뒤에만 조작한다(스크린샷·describe 포함). 켜기·끄기는 argent `boot-device` 가 아니라 `corgi use`·`corgi down` 으로 한다. 전문은 `integrations/rules/corgi.md`(영어).

## 14. 앱 창·웹 화면 (R11·M1~M12)

**앱 창** — `Corgi.app` 이 자기 창(NSWindow + WKWebView)에 웹 화면(`http://127.0.0.1:<포트>/#token=…`)을 띄운다. 메뉴바 «대시보드 열기»·앱 다시 열기·Dock 클릭이 이 창을 연다. 창이 열려 있는 동안만 Dock 아이콘을 보이고(`setActivationPolicy(.regular)`), 닫으면 메뉴바 앱으로 돌아간다. 창 크기·위치를 기억하고 ⌘W·⌘Q 가 앱처럼 동작한다. 같은 화면을 브라우저로도 연다(`corgi ui`) — 개발 중엔 argent(Chromium)로 화면을 눌러 확인한다.

**왼쪽 메뉴** (M9) — 디바이스 · 그룹 · 세션, 아래쪽에 설정(새 창 — 앱에서는 `window.webkit.messageHandlers.corgi` 로 Swift 에 알려 별도 NSWindow, 브라우저에서는 `window.open`)과 서버 상태.

**세션 화면** (M13) — `status.sessions`(지금 점유·대기)와 `lease.history`(기록)를 세션 키로 묶어 «지금 쓰는 세션 / 지난 세션» 카드로 보인다. 카드에 에이전트 아이콘(이름으로 종류를 가림 — 각 도구의 대표 색에 단순한 기호, 실제 로고는 쓰지 않음)·세션 ID(에이전트가 주는 `agentSessionId` 와 Corgi 세션 키)·작업 폴더·마지막 활동·기록 수. 지금 쓰는 세션은 점유한 디바이스(사람은 강제 해제)와 대기. 카드를 누르면 `?window=session&key=…` 를 새 창(앱은 Swift 별도 창, 브라우저는 `window.open`)으로 — 그 세션의 기록을 시간순 타임라인으로. 기록은 LeaseManager 가 점유·대기·해제가 일어날 때마다 남기는 사건(acquired·queued·granted·released·forced·ended·idle·deadlock, `agentSessionId` 포함)을 서버가 `…/Corgi/history.json` 에 최근 500개까지 둔다. CLI `corgi history`.

**메인 화면** (M5·M9)
- Corgi 목록 — 위에 **All · Android · iOS 탭**(마지막 탭 기억)과 그룹 거르기, 검색.
- 한 줄에 `폭 · 이름 · 켜짐 · SLIM 배지 · 태그(기본 Android/iOS, 그룹들) · 메모 · 사용 중인 세션`.
- 정렬: 켜진 것 → 기본 → 플랫폼 → 폭.
- `SLIM` 배지에 마우스를 올리면 꺼진 항목 수·메모리·슬림 전후(«7.8GB → 1.6GB (−79%)», M10). 재적용 실패는 `SLIM ⚠` + 이유.
- 켜기·끄기는 점유 없이(사람), 다른 세션이 쓰는 중이면 막는다. SSE 로 바로 반영된다.

**생성(+)** (M1·M4) — 위에 «새로 만들기 · 이 Mac 의 디바이스» 탭. «이 Mac 의 디바이스» 는 Corgi 목록에 없는 기기(`device.available`)를 플랫폼·검색으로 거르고 «추가»(`device.add`). «새로 만들기» 는 플랫폼 → 기종(iOS 기기 종류 / Android 대표 프로필·직접 입력) → OS(런타임·시스템 이미지, 기본값 미리 골라 둠) → 이름(기본값 `corgi <기종>` 또는 `<기종>`, 겹치면 번호)·**슬림**(기본 켜짐, 옆 ⓘ 에 슬림화하면 안 되는 기능)·슬림 전 기준값 측정 → 진행 표시. 같은 크기가 이미 있어도 막지 않는다(M3). 앱은 설치하지 않는다.

**더보기(⋯) 메뉴** (M7·M8) — 이름 변경(원래 있던 디바이스도) · 메모 · 그룹에 넣기/빼기 · 기본 디바이스로 · 슬림 켜기/끄기(Corgi 가 만든 것만) · 점유 강제 해제 · 삭제(Corgi 가 만든 것만, 확인 창. 기본 디바이스·켜짐·사용 중이면 이유와 함께 막음). 바깥을 누르거나 Esc 로 닫힌다.

**그룹 화면** (M9·R21) — 그룹 목록(이름·설명·디바이스 수·마지막으로 고친 사람/에이전트), 만들기·고치기(이름·설명·디바이스 고르기 — 목록에서 체크), 삭제. 없는 디바이스(밖에서 지워짐)는 표시하고 빼게 한다.

**설정** (M11, 새 창) — 첫 실행 설정 다시 열기(M14) · 언어(시스템 따름·한국어·English, R25) · 자동 해제 시간 · Android RAM·시스템 이미지 · simslim 프로필. `config.json` 에 쓰고 서버가 바로 반영한다.

**첫 실행 설정 창** (M14) — `?window=setup`, 앱에서는 Swift 별도 창(처음 뜰 때 서버가 아직 안 떴으면 2초 간격으로 다시 물어본다). 단계 표시 + 단계마다 한 화면, 아래에 이전·다음(창 아래에 붙음). 생성 창(M1)을 그 창 안에서 연다. «완료» → 앱이면 Swift 에 `{open:"dashboard"}`·`{close:"setup"}`, 브라우저면 `/` 로.

**디자인** (M12) — 귀엽지 않고 단정하게. 촘촘한 표 형태 목록, 시스템 글꼴, 숫자(폭·해상도·메모리)는 고정폭, 강조색 하나. 아이콘은 겹친 기기 프레임 같은 추상적 단색 모양(메뉴바는 템플릿 이미지). **구현 전에 시안을 보고 정한다.**

**메뉴바** — 아이콘(단색 템플릿, 숫자 없음) → 메뉴: 서버 상태 · 켜진 디바이스와 사용 중인 세션 · «대시보드 열기»(앱 창) · 서버가 꺼져 있으면 «서버 켜기» · 종료. 문구는 설정 언어를 따른다(Swift 안의 작은 사전, 언어는 `status` 응답으로 받음). 서버 HTTP API(토큰은 파일에서)만 읽고 로직은 없다. 로그인 시 뜨게 등록한다(launchd `corgi.menubar`, `open -a`).

나중에 **스크린샷 모아 보기**(R10)를 같은 화면에 탭으로 붙인다.

## 15. 스킬 (S1~S10)

`integrations/skill/corgi/SKILL.md` → `~/.claude/skills/corgi` (S9). **영어로 쓴다**(R25 — 읽는 쪽이 에이전트). 스킬 형식을 읽는 다른 에이전트(Codex 등)는 `corgi install --agent <이름>` 으로 그 에이전트 위치에도 설치한다.

- description 에 S3 의 반응 프롬프트(디바이스가 필요한 작업 전부), S4 의 비반응(디바이스를 쓰지 않는 작업)을 넣는다. 테스트하는 앱의 «그룹» 기능과 헷갈리지 않게 «device group» 이라고 쓴다.
- 본문 순서(S5): `corgi status` → **용도 고르기**: `corgi group list --json`(설명)·`corgi list --json`(메모)을 보고 맞는 그룹, 없으면 `--default` → `corgi use … [--available] [--wait]` — 일부가 사용 중이면 R23 기준(그룹 설명의 «모두 필요», 작업에 몇 대가 꼭 필요한지)으로 판단, 애매하면 사용자에게 묻기(S7) → `corgi list --json` 으로 기기별 `targetId`·`label` 받기 → 기기마다 argent: 앱 설치(`reinstall-app`)·실행(`launch-app`, Android 는 먼저 `adb reverse`)·같은 화면(`open-url` 또는 argent 흐름)·`screenshot` → 크기 라벨을 붙여 보고 → `corgi release` → 끌지 묻기(S8).
- 그룹 만들기·고치기(S10): 사용자가 요청할 때만 `corgi group create|edit`. 요청 없이 남이 만든 그룹을 바꾸지 않는다.
- 오류는 `code` 로 판단한다(`BUSY`·`DEADLOCK`·`NO_DEFAULT` …). `DEADLOCK` 이면 쥔 것으로 진행할지 놓을지 정한다.
- 설치·연결 문제는 `corgi doctor` 결과를 따른다 (S1·S2).
- `corgi status --json` 에 `update` 가 있으면 사용자에게 알리기만 하고 **직접 업데이트하지 않는다** (R19).

## 16. 단계

각 단계는 끝나면 실제로 쓸 수 있는 상태가 된다.

| 단계 | 내용 | 끝나면 |
| --- | --- | --- |
| 0 ✅ | 저장소 뼈대 — `package.json`·`tsconfig`·Biome·`mise.toml`, `bin/corgi.ts`·`main.ts` 서브커맨드 틀, `scripts/build.ts`, 검사 통과. **컴파일한 바이너리에서 파일 포함·훅 시작 시간 확인** | `bun link` 와 `dist/corgi` 양쪽에서 `corgi --version` 이 돈다 |
| 1 ✅ | 서버 + CLI 코어 — 레지스트리, Android·iOS 드라이버(생성·목록·이름·사용 안 함·삭제·켜기·끄기·슬림), 점유·대기·자동 해제, 소켓, launchd, `protocol.md`. **실제 디바이스로 확인**: iOS 생성+슬림 2분 22초, Android·iOS 동시 켜기 29초. 남은 확인은 §17 | CLI 로 크기별 디바이스를 만들고 점유해서 켠다 |
| 2 ✅ | `doctor` + 스킬 — 설치·연결 점검(S1·S2), 스킬(S3~S8 — 앱 설치·실행·화면 이동은 argent 로 안내), `corgi install` 이 스킬도 설치. **남은 확인**: 실제 앱(NOVA)으로 «코기로 확인해 줘» 흐름을 처음부터 끝까지 돌려 보기 | «코기로 확인해 줘» 로 주 흐름(R15)이 돈다 |
| 3 ✅ | 웹 UI + `Corgi.app` (앞당김 — 사람이 직접 보고 확인하려고) — HTTP API·SSE·토큰, 메인 목록(All·Android·iOS 탭), 생성(+)(iOS 시뮬레이터·Android 대표 프로필·직접 입력), 슬림 수치와 슬림 전후 비교, 메뉴바 앱(단색 아이콘·«대시보드 열기»), `corgi ui` | 사람이 메뉴바·브라우저로 전부 관리한다 |
| 4 ✅ | **사양 변경 (2026-10-05)** — ① 시안(디자인 M12)으로 화면 확정 (사용자 요청으로 건너뛰고 A안 — 라이트 그래파이트 + 파랑, 다크 잉크 + 민트 — 으로 바로 구현) ② 이 Mac 디바이스 전부 목록·레지스트리 재구성(R20, 사용 안 함 제거) ③ 생성: 기종 + OS, 슬림 선택·ⓘ(M1·M4) ④ 메모·기본 디바이스·그룹(R21·R22·R24) ⑤ 그룹 점유 모드·교착(R23, §8) ⑥ 슬림 자동 재적용·`SLIM` 배지(M6) ⑦ 오류 코드·현지화·설정(R25·M11) ⑧ 앱 창(WKWebView, R11) ⑨ 스킬 영어로 다시 쓰기. 항목마다 커밋 | 용도별 그룹·기본 디바이스로 요청하고, 앱 창에서 전부 관리한다 |
| 5 (구현) | 보호 — Claude Code 훅(`corgi hook claude pre-tool-use`), 규칙(`~/.claude/rules/corgi.md`), 서버 꺼짐 처리, `corgi install`·`doctor` 연동. 대상은 Corgi 목록의 디바이스(P1). **설치는 사용자 결정 대기** — 다른 세션이 쓰는 기기가 목록에 있으면 그 세션이 막히므로(2026-10-05 보류). 남은 것: 다른 에이전트 어댑터(조사 후, Q16) | 다른 세션이 남의 디바이스를 못 건드린다 |
| 5.5 ✅ | 첫 실행 설정 창 (M14, 2026-10-05) — 앱을 처음 열면 점검 → 에이전트 연결(스킬·보호·MCP) → 기본 디바이스를 차례로. 서버 `setup.*`, `corgi install` 은 보호·MCP 를 기본으로 넣지 않음(`--hook`·`--mcp`) | 터미널 없이 앱에서 설정을 끝낸다 |
| 6 ✅ | MCP 래퍼 — `corgi mcp`(stdio). 도구: `corgi_status`·`corgi_use`(디바이스·그룹·기본, all·available, 기다리기는 45초씩 나눠 «STILL_QUEUED → 다시 호출»)·`corgi_release`·`corgi_down`·`corgi_catalog`·`corgi_create`·`corgi_group_save`. 오류는 코드부터(`BUSY: …`). 세션은 CLI 처럼 프로세스 트리, 서버가 꺼져 있으면 켠다. **등록은 사용자 결정** — 첫 실행 설정 창의 «MCP 도구» 또는 `corgi install --mcp` | 에이전트가 사용법 없이 바로 쓴다 |
| U | 업데이트 — `scripts/release.ts`, 확인·알림, `corgi update`·되돌리기 (§19). **리모트·첫 Release 가 생긴 뒤**, 5단계 이후 아무 때나 | 새 버전을 알림 받고 명령 한 번으로 올린다 |
| 나중 | 스크린샷 모아 보기 (화면 탭) · 일괄 설치·실행·딥링크 (L1~L3) · 슬림된 디바이스 복제 (L4) · 이름 변경 (Q17) — 필요하면 | — |

## 17. 구현 전에 실측할 것

| 항목 | 왜 | 언제 |
| --- | --- | --- |
| 에이전트별 프로세스 트리 — codex·gemini·cursor-agent·opencode·copilot 이 명령·MCP 를 자식 프로세스로 실행하는지, `AI_AGENT` 같은 표시 변수를 주는지 (각 에이전트에 `ps` 를 실행시켜 확인 — 그 에이전트 사용량이 든다) | §7 판정표·호스트 목록 | 1단계 |
| ✅ Claude 어댑터 — CLI 의 `CLAUDE_CODE_SESSION_ID` 와 훅 입력 `session_id` 가 같은 값인지 — **같다**(2026-10-05: 세션 화면의 ID 와 대화 기록 파일 이름이 같음). `/clear`·`--resume` 때 바뀌는지는 아직 | §7 보조 세션 ID | 1단계 |
| ✅ avdslim — 1.0.15 설치·확인(2단계 전). 명령: `tune-avd <avd>`(호스트 설정, config.ini 를 다시 씀 — AvdId·크기·이름은 유지됨)·`on <serial>`·`off <serial>`·`profiles`. **상태 조회 명령이 없어** 슬림 확인은 «기기에 설치된 프로필 패키지 중 꺼진 비율 ≥ 50%» 로 한다(표준 프리셋이 Chrome·Play 스토어 등은 남겨 실측 52개 중 49개). 풀림 → 켤 때 재적용까지 실제로 확인 | §9 Android 슬림·M6 | 2단계 전 |
| simslim 0.8 → 0.11 변경점. 0.8 에서 확인함: `on --preserve-boot-state` 로 꺼진 기기도 슬림화(잠시 켬), `verify` 는 켜진 기기만, `list --json` 의 `managedDisabled` 는 켜진 기기만 나온다 | M6 | 업데이트 시 |
| ✅ 컴파일한 바이너리에 웹 UI·파일이 잘 들어가는지, 훅 경로 시작 시간 — **확인됨(0단계)**: `with { type: "file" }` 는 `/$bunfs/root/…` 경로로 들어가 `Bun.file` 로 읽히고, HTML import 는 TSX 까지 번들돼 `Bun.serve` 로 서빙된다(`--bytecode` 포함, 다른 폴더로 옮겨도 동작). 훅 경로 약 21ms | §2·§3·§13 | 0단계 |
| ✅ launchd 로 띄운 서버가 `emulator`·`xcrun` 을 PATH·권한 문제 없이 실행하는지 — **확인됨(2단계 전)**: `corgi install` 로 등록한 서버가 Android·iOS 를 만들고 함께 켰다(1분 16초, 슬림 없이). 등록하면 macOS 가 «백그라운드 항목 추가됨» 알림을 띄우고, 로그인 항목에 실행 파일 서명자 이름(개발 모드는 bun 의 «Jarred Sumner»)이 보인다 | launchd 는 로그인 셸 환경을 안 받는다 | 2단계 전 |
| 에이전트별 MCP 서버의 부모가 에이전트 프로세스인지 (Claude Code 는 확인됨) | §7 | 6단계 |
| argent 두 버전(homebrew 0.17.0 이 PATH 우선, mise 0.26.0) 정리 | 훅이 보는 argent 도구 인자가 버전마다 다를 수 있다 | 5단계 전 |
| 다른 에이전트의 실행 직전 훅 지원 여부·설정 위치·입력 형식, 전역 규칙·스킬 위치 | §13 어댑터·P2·S9 | 5단계 전 |
| avdslim·simslim 이 끄는 항목을 사람이 읽을 이름으로 묶는 방법 (`avdslim profiles`·simslim 프로필 JSON) | M4 ⓘ | 4단계 ③ 전 |
| `simctl list devicetypes`·`runtimes` 의 지원 관계(`supportedDeviceTypes`) | M1 iOS 기종·OS 고르기 | 4단계 ③ 전 |

## 18. 미결정 질문(Q)에 대한 설계 쪽 제안

| Q | 제안 |
| --- | --- |
| Q16 훅 없는 에이전트 | 규칙 + CLI 의 BUSY 응답으로 보호. 훅을 지원하면 어댑터를 붙인다(§13) |

## 19. 업데이트 (R19)

**확인**
- 서버가 **시작할 때와 하루 한 번** 프라이빗 GitHub Release 의 최신 버전을 본다. 인증은 이미 로그인된 `gh` 를 그대로 쓴다(`gh api repos/<owner>/corgi/releases/latest`). `gh` 가 없거나 로그인 안 돼 있으면 조용히 넘어가고 `corgi doctor` 에서만 알려 준다.
- 버전은 semver(`package.json` `version`) 로 비교한다. 개발 모드(`bun link` 로 소스 실행)에서는 확인하지 않는다.

**알림** — 사람과 에이전트를 나눈다

| 받는 쪽 | 방식 |
| --- | --- |
| 사람 | 새 버전마다 **macOS 알림 한 번**(`update.json` 에 보낸 버전 기록). 앱 창 상단 배너 + «업데이트» 버튼. 메뉴바 아이콘 표시 |
| 터미널 CLI | 하루 한 번 stderr 에 한 줄 — «corgi 0.3.0 이 있습니다 — `corgi update`». `--json` 출력에는 섞지 않는다 |
| 에이전트 | `corgi status --json`·MCP 응답의 `update: {current, latest}` 필드. 스킬은 «알리기만, 직접 업데이트하지 않음» (§15) |

**교체 — `corgi update`**
1. Release 에서 `corgi-darwin-arm64.tar.gz` 와 `SHA256SUMS` 를 받아 **체크섬을 검증**한다.
2. `~/.local/share/corgi/versions/<버전>/corgi` 에 풀고 `~/.local/bin/corgi` 링크를 바꾼다 — Claude Code 와 같은 방식(이 Mac 의 `~/.local/share/claude/versions/` 확인).
3. 서버 재시작 + `Corgi.app` 갱신(`corgi install` 과 같은 경로). 점유·대기열은 파일에 있어 유지되고, 부팅·설치가 진행 중이면 끝난 뒤 재시작한다.
4. `corgi update --rollback` — 이전 버전으로 링크를 되돌린다. 버전 폴더는 최근 3개만 남긴다.

- 자동 업데이트는 기본 꺼짐. `config.json` 의 `autoUpdate: true` 면 점유가 하나도 없을 때만 알아서 교체한다.

**배포 쪽 — `scripts/release.ts`** (리모트가 생긴 뒤): 버전 올리기 → `bun run build` → 압축·체크섬 → `gh release create`. 나중에 GitHub Actions 로 옮길 수 있다.

**1단계부터 지킬 것**: 버전은 semver 로 관리하고, 요청·응답에 실린 클라이언트·서버 버전을 비교해 다르면 알려 준다(업데이트 후 서버가 아직 옛 버전인 경우를 잡는다) — 1단계에서 구현함.

## 설계 결정 기록

> 구조 수준의 결정(앱 창·웹 화면 · TS · 단일 실행 파일 · `Corgi.app` · 그룹 · 현지화)은 `requirements.md` «결정 기록» 에 있다. 여기에는 구현 수준의 결정만 둔다.

| 결정 | 이유 | 버린 대안 |
| --- | --- | --- |
| **상태를 바꾸는 요청은 Unix 소켓으로만**, HTTP 는 웹 화면·메뉴바용 | 소켓은 파일 권한(0600)으로 이 사용자만 접근한다. localhost HTTP 는 브라우저를 통한 공격 경로가 있어 토큰·Origin 검사를 따로 둔다 | HTTP 하나로 통일 (simfleet 방식 — 훅·CLI 까지 웹 공격면에 노출) |
| **대기 항목은 세션에 붙인다** | CLI 는 Bash 시간 제한(최대 10분)에 끊길 수 있고, MCP 는 호출 시간 제한 때문에 «다시 호출» 해야 한다. 연결에 붙이면 끊길 때마다 순번을 잃는다 | 연결 기준 대기 (끊기면 순번 잃음) |
| **훅은 명령 파싱 대신 식별자 문자열 포함으로 판정** | 셸 문법(`&&`·`$(…)`·변수)을 다 파싱할 수 없고, 파싱 누락이 곧 보호 구멍이다. 디바이스 식별자(UDID·AVD ID·시리얼)는 충분히 고유하다 | 셸 파서로 `-s` 인자 추출 (우회 쉬움) |
| **Android 시리얼은 `-port` 로 서버가 정한다** | 시리얼이 켤 때마다 바뀌는 문제를 대부분 없앤다. 밖에서 켠 경우만 역조회 | 매번 `adb devices` + 역조회 (느리고 훅에서 부담) |
| **`main.ts` 에서 서브커맨드별 동적 import** | 훅은 Bash 호출마다 돈다. 서버·웹 코드를 불러오지 않아야 빠르다 | 진입점에서 전부 import |
| **패키지 하나** (모노레포 아님) | 결과물이 실행 파일 하나다. 경계는 폴더와 import 규칙(§3)으로 지킨다 | workspaces 로 shared·server·cli·web 분리 (설정만 늘어남) |
| **공용 호스트 아래에서는 터미널 탭(셸) 단위로 세션을 나눈다** (§7) | IDE·터미널 앱·tmux 는 여러 사람·에이전트 작업이 한 프로세스 아래 모인다. 호스트를 세션으로 보면 서로 다른 작업이 한 세션이 된다 | 호스트 프로세스를 세션으로 (전부 한 세션), 바로 위 셸을 세션으로 (에이전트가 명령마다 새 셸을 띄우면 매번 다른 세션) |
| **업데이트 확인에 `gh` 인증을 그대로 쓴다** (§19) | 저장소가 프라이빗이라 인증이 필요한데, 토큰을 따로 받아 저장하면 관리할 비밀이 생긴다. 개발자 Mac 에는 `gh` 가 이미 로그인돼 있다 | Corgi 전용 토큰 저장 (비밀 관리 부담), 공개 저장소 (프라이빗 요구와 충돌) |
| **디바이스 목록은 드라이버에서 그때그때 읽고, 레지스트리엔 Corgi 가 붙인 정보만** (R20·§6) | Xcode·Android Studio 에서 기기가 바뀌어도 바로 맞는다. 붙인 정보(메모·그룹·기본·슬림)는 `native`(UDID·AVD ID)로 잇는다. 기기가 사라져도 정보는 남겨 두었다가 다시 보이면 되살린다 | 기기 목록을 레지스트리에 저장 (밖의 변경과 맞추는 일이 생김) |
| **그룹 점유 모드는 `all` 기본 + `--available`, 교착은 대기열에 넣을 때 막는다** (§8·R23) | 판단은 에이전트가 하되(R23), 기본은 가장 안전한 «전부 아니면 전무». 일부를 쥔 채 기다릴 때만 순환이 생길 수 있으므로, 대기열에 넣는 순간 순환을 검사하면 교착이 아예 생기지 않는다 | 대기열만 (쥔 채 기다리는 두 세션의 교착을 못 막음), 일부 점유 + 대기 금지 (레이아웃 체크에서 나머지를 기다릴 수 없음), 생긴 뒤 감지 (이미 둘 다 멈춘 뒤라 한쪽을 깨워야 함) |
| **서버·CLI·화면이 같은 설정 언어·같은 사전으로 문장을 만든다, 에이전트는 오류 코드로** (§11·R25) | 언어 설정이 하나(`config.json`)라 창구마다 언어가 달라질 일이 없다. 서버가 문장을 만들면 드라이버 깊은 곳의 오류도 한 곳에서 번역된다. 에이전트는 문장이 아니라 `code` 로 판단하므로 언어와 상관없다 | 오류를 키 + 값으로 보내고 창구가 번역 (모든 오류 경로에 키·값을 실어야 해 복잡하고, 언어 설정이 하나라 얻는 게 없음) |
| **앱 창은 Swift 껍데기 + WKWebView, 화면은 웹 하나** (§14·R11) | 화면을 한 번만 만들고 브라우저·argent 로 확인한다. Dock 아이콘은 창이 열린 동안만 보여 메뉴바 앱의 가벼움을 유지한다 | SwiftUI 로 화면 다시 작성 (두 벌 유지), 창을 늘 띄우는 일반 앱 (메뉴바 앱과 역할이 겹침) |
