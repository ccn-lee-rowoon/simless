# Corgi 설계안 (v0.2 — 검토 중)

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
                  ├─ 디바이스 레지스트리 (만든 것만)
                  ├─ 점유·대기 관리
                  ├─ 드라이버 — Android: emulator·adb·avdslim / iOS: simctl·simslim
                  └─ HTTP 127.0.0.1 ── 웹 UI (브라우저) · (나중) 메뉴바 아이콘
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
| MCP | `@modelcontextprotocol/sdk` (5단계) | stdio |
| 웹 UI | React + Bun 내장 번들러(HTML import) | Vite 없이 `Bun.serve` 가 서빙 |
| 테스트 | `bun test` | |
| 포맷·린트·타입 | Biome · `tsc --noEmit` | |
| 메뉴바 (6단계, 선택) | Swift 소스 1개를 바이너리에 넣고 `corgi install` 때 `xcrun swiftc` 로 컴파일해 `Corgi.app` 에 넣는다 | 서명·공증 불필요 |

외부 의존은 위 목록으로 제한하고, 늘릴 때는 이 표에 이유를 적는다.

## 3. 저장소 구조

결과물이 실행 파일 하나라 **패키지도 하나**다(모노레포로 나누지 않는다).

```
corgi/
├── package.json · bun.lock · tsconfig.json · biome.json · mise.toml
├── bin/corgi.ts             `#!/usr/bin/env bun` — 개발용 진입점(`bun link` 가 가리킴), src/main.ts 로
├── src/
│   ├── main.ts              진입점 — 서브커맨드별로 필요한 모듈만 동적 import (훅이 빨리 끝나게)
│   ├── shared/              모델·메시지 스키마(zod)·경로·설정 로딩·소켓 클라이언트
│   ├── server/
│   │   ├── index.ts         corgi serve — 소켓·HTTP 서버 시작
│   │   ├── registry.ts      만든 디바이스 목록
│   │   ├── leases.ts        점유·대기·자동 해제
│   │   ├── sessions.ts      세션 식별·프로세스 감시
│   │   ├── drivers/android.ts · drivers/ios.ts
│   │   ├── socket.ts · http.ts
│   │   └── launchd.ts       LaunchAgent 등록·재시작
│   ├── cli/                 명령마다 파일 하나 (use.ts, create.ts …)
│   ├── hook/                훅 — 대상 추출(순수 함수) + 판정 + 서버 꺼짐 처리
│   ├── mcp/                 (5단계) MCP 서버
│   └── web/                 웹 UI — index.html · App.tsx …
├── tray/CorgiTray.swift     (6단계) 메뉴바 아이콘
├── test/                    *.test.ts — 드라이버는 가짜로 바꿔 점유·대기·훅 판정을 검증
├── integrations/            이 Mac 의 다른 도구에 설치하는 것
│   ├── skill/corgi/SKILL.md          → ~/.claude/skills/corgi
│   ├── hooks/claude-settings.json    훅 등록 예시 (PreToolUse)
│   └── rules/argent-corgi.md         전역 argent 규칙에 붙일 문구 (P2)
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
| `corgi install` | LaunchAgent(`~/Library/LaunchAgents/corgi.server.plist`, `RunAtLoad`·`KeepAlive`) 등록 → 서버 시작. launchd 는 로그인 셸 PATH 를 안 받으므로 **`corgi`·Android SDK 경로를 절대 경로로** 적는다. 훅 명령도 절대 경로로 등록한다. `~/Applications/Corgi.app` 생성. 스킬·훅·argent 규칙 설치(각각 묻고, `--yes` 로 생략) |
| `corgi uninstall` | 위를 되돌린다. 만든 디바이스는 지우지 않는다 |
| `Corgi.app` | `Contents/MacOS/corgi`(실행 파일 링크) + `Info.plist`(`LSUIElement` — Dock 아이콘 없음) + 아이콘, ad-hoc 서명. **인자 없이 앱 번들 안에서 실행되면 앱 모드**: 서버가 꺼져 있으면 켜고 웹 UI 를 브라우저로 연 뒤 끝난다. 더블클릭·Spotlight·Launchpad 에서 연다. 6단계에서 같은 앱이 메뉴바 앱이 된다 |
| 로그인 항목 이름 | macOS 로그인 항목(«앱 백그라운드 활동»)에는 실행 파일 서명자 이름이 보인다 — 개발 모드는 bun 의 «Jarred Sumner». `Corgi.app` 을 만들 때(3단계) plist 에 `AssociatedBundleIdentifiers` 로 앱을 연결해 «Corgi» 로 보이게 한다. 사용자가 이 항목을 끄면 launchd 가 서버를 띄우지 않으므로 `corgi doctor` 가 확인한다 |
| 서버 자동 시작 (Q10) | CLI·MCP 는 소켓이 없으면 `launchctl kickstart` 로 켜고 몇 초 기다린다. 훅은 켜지 않는다 |
| 업데이트 | `corgi update` — 확인·알림·교체·되돌리기는 §19. 클라이언트·서버 버전이 다르면 `hello` 에서 알려 준다 |

## 5. 런타임 파일 위치

| 경로 | 내용 | 쓰는 쪽 |
| --- | --- | --- |
| `~/Library/Application Support/Corgi/registry.json` | 만든 디바이스 목록 (영속) | 서버 |
| `…/Corgi/leases.json` | 점유·대기열 — 서버를 다시 켜도 복원 | 서버 |
| `…/Corgi/managed-index.json` | 관리 디바이스 식별자(UDID·AVD ID·마지막 시리얼). **서버가 꺼졌을 때 훅이 읽는다** | 서버 쓰기 / 훅 읽기 |
| `…/Corgi/corgi.sock` | 소켓 (권한 0600) | 서버 |
| `…/Corgi/web-token` | 웹 UI 요청 토큰 (0600) | 서버 |
| `…/Corgi/update.json` | 마지막 확인 시각·최신 버전·알림 보낸 버전 | 서버 |
| `~/Library/Logs/Corgi/` | 서버 로그 | 서버 |
| `~/.local/share/corgi/versions/<버전>/corgi` · `~/.local/bin/corgi`(링크) | 설치된 버전들과 지금 쓰는 버전 (§19) | `corgi update` |
| `~/.config/corgi/config.json` | 사용자 설정 — 자동 해제 시간(기본 30분), HTTP 포트, Android SDK 위치·RAM·에뮬레이터 옵션, simslim 프로필 경로 | 사람·서버 |
| `~/.config/corgi/apps/<name>.json` | 앱별 설정 (Q8) | 사람 |
| `~/.android/avd/corgi_<id>.avd` · `.ini` | Android 디바이스 본체 | 서버 |
| CoreSimulator 기본 device set | iOS 디바이스 본체 | 서버(simctl) |

## 6. 모델

**Device** (registry 에 저장)

| 필드 | 설명 |
| --- | --- |
| `id` | Corgi 가 붙이는 짧은 ID(예: `k3f9`). **절대 안 바뀐다** (R4) |
| `name` | 표시 이름. 바꿀 수 있다 (R3) |
| `platform` | `android` / `ios` |
| `native` | Android `avdId = corgi_<id>` · iOS `udid` — 둘 다 이름을 바꿔도 그대로 |
| `spec` | Android `widthDp·heightDp·density` (px 은 계산) · iOS `deviceType·runtime` + 프로필에서 읽은 `widthPt·heightPt·scale` |
| `enabled` | 사용 안 함이면 `false` — 일괄 동작에서 빠진다 (R6) |
| `slim` | `none`·`applying`·`applied`·`drifted`(풀림)·`failed` (M6) |
| `source` | 복제한 원본 — `{ name, native }` (표시용, 원본이 지워져도 상관없다) |

실행 중 값(켜짐 여부, Android 시리얼)은 저장하지 않고 서버가 들고 있다.

- 이름 변경 시 Android `avd.ini.displayname`, iOS `simctl rename` 도 같이 바꿔 에뮬레이터 창·Simulator 창에서도 알아보게 한다.
- iOS 폭(pt) = `/Library/Developer/CoreSimulator/Profiles/DeviceTypes/<종류>.simdevicetype/Contents/Resources/profile.plist` 의 `mainScreenWidth ÷ mainScreenScale` (확인: iPhone 17 → 1206 ÷ 3 = 402pt). M2 의 «폭 맨 앞» 에 쓴다.

**Session** — `id`(§7 세션 키), `agent`(표시용 — `claude-code`·`codex`·`gemini`·…·`human`·`unknown`), `pid`·`pidStartedAt`, `agentSessionId`(어댑터가 주면), `cwd`(표시용), `lastUsedAt`

**Lease** — `deviceId → sessionId, acquiredAt` · **대기열** — `[{sessionId, deviceIds, enqueuedAt}]` (FIFO)

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

**사람·웹 UI** — `human` 세션은 프로세스 기준 해제를 하지 않고 30분 규칙만 적용한다. 웹 UI 는 항상 `human`.

**한계** — 여러 대화가 프로세스 하나를 같이 쓰는 에이전트(IDE 안 에이전트 등)는 대화가 아니라 프로세스·터미널 단위로 구분된다. 필요하면 1번으로 보완한다.

## 8. 점유·대기 (R13·R14·R17)

- **단위는 디바이스**. 한 요청이 여러 대를 잡을 땐 **전부 아니면 전무** — 일부만 잡고 서로 기다리는 교착을 막는다.
- 같은 세션이 다시 요청하면 그대로 통과(재진입).
- **기본: 바쁘면 바로 실패**하고 누가·언제부터·어느 디바이스를 쓰는지 돌려준다 (CLI 종료 코드 3).
- **`--wait`**: 대기열에 넣고, 차례가 오면 **서버가 알아서 점유**해 준다. 대기 항목은 연결이 아니라 **세션**에 붙는다 → CLI 가 Bash 시간 제한으로 끊겨도 순번이 유지되고, 다시 `--wait` 하면 이어서 기다린다. MCP 의 «대기 중 → 다시 호출» 도 같은 방식이다.
- 대기는 **디바이스마다 먼저 온 순서** — 같은 디바이스를 먼저 기다리는 세션이 있으면, 그 디바이스가 비어 있어도 뒤에 온 세션(기다리기 없는 요청 포함)이 새치기하지 못한다. 겹치지 않는 디바이스는 대기열과 상관없이 잡는다.
- **자동 해제**
  1. 세션 프로세스 종료 → 바로. 2초 간격으로 PID 생존과 시작 시각(PID 재사용 거르기)을 확인한다. 대기열에서도 뺀다.
  2. `lastUsedAt` 후 30분(설정) 지나고 **대기열에 누가 있을 때만**.
- `lastUsedAt` 갱신: 그 세션의 CLI 요청, MCP 요청, 훅이 통과시킨 호출(argent 포함).
- **강제 해제**: 웹 UI, 또는 CLI `release --force` (확인 질문). 스킬에는 «에이전트는 쓰지 않는다» 로 적는다.

## 9. 디바이스 수명주기 (드라이버)

| 단계 | Android | iOS |
| --- | --- | --- |
| 생성 (iOS 만 원본 복제) | (Android 는 이 Mac 의 AVD 를 원본으로 쓰지 않는다 — 대표 프로필·직접 입력, 아래 줄) | 원본과 같은 기기 종류·런타임으로 `simctl create <이름> <종류> <런타임>` → UDID. `simctl clone` 은 원본의 앱·데이터가 따라오고 원본이 꺼져 있어야 해 쓰지 않는다 |
| 생성 (대표 프로필·직접 입력, Android 만) | 크기(`hw.lcd.width/height/density`)와 시스템 이미지(기본: 설치된 것 중 4KB 페이지·API 높은 순)로 `config.ini` 를 새로 쓴다. 대표 프로필은 Android Studio 의 기기 정의를 본떠 코드에 넣어 둔다(`src/server/drivers/android-profiles.ts`) | (iOS 는 기기 종류가 크기를 정해 해당 없음) |
| 슬림화 (R5) | `avdslim` — **명령 미확인**(미설치) | `simslim on <udid> --profile <공용 프로필>` |
| 슬림 확인 (M6) | `avdslim` 상태 조회 (미확인) | `simslim verify <udid> --profile` — 켜진 기기만 가능 |
| 켜기 | `emulator -avd corgi_<id> -port <빈 포트> -no-snapshot-save` 를 서버와 분리(detached)해 실행. `sys.boot_completed == 1` 까지 대기 | `simctl boot` **한 대씩 순서대로** (동시 부팅 중단 오류 회피) + `simctl bootstatus` |
| 끄기 | `adb -s <시리얼> emu kill` | `simctl shutdown` |
| 이름 변경 | `avd.ini.displayname` | `simctl rename` |
| 삭제 (M8) | 끄고 `.avd`·`.ini` 삭제 | 끄고 `simctl delete` |

- **Android 시리얼을 서버가 정한다**: `-port` 로 켜면 시리얼이 `emulator-<port>` 로 정해진다. 밖에서 켠 경우는 `adb -s <시리얼> emu avd name` 으로 역조회한다.
- 에뮬레이터·시뮬레이터는 서버의 자식으로 묶지 않는다 — 서버가 재시작해도 디바이스는 계속 돈다.
- 슬림 확인 시점: 서버 시작(켜진 기기만), 디바이스 켤 때(항상). 풀림이면 다시 적용한다.
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
- 점유한 디바이스만 argent 로 다룬다 — 3단계 훅이 지킨다 (P1·P8).

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
- 메서드: `status` · `source.list` · `device.create|list|rename|setEnabled|slim|delete|up|down` · `lease.acquire|release|who` · `hook.check`
- 오류 코드: `BUSY` · `NOT_HELD` · `NOT_FOUND` · `INVALID` · `TOOL_MISSING`(avdslim 등 없음) · `FAILED` · (클라이언트 쪽) `SERVER_DOWN`

**HTTP** — 웹 UI·메뉴바

- `127.0.0.1:<포트>`(기본 8791, 설정)에만 연다.
- `GET /api/status`, `GET /api/events`(SSE — 점유·켜짐·슬림 변화), 웹 UI 의 조작은 `POST /api/…` 가 소켓과 같은 메서드를 부른다(세션은 `human`).
- 보안(다른 웹사이트가 localhost 로 요청하는 공격 대비): `Host` 가 `127.0.0.1`·`localhost` 가 아니면 거부(DNS rebinding), `POST` 는 `Origin` 검사 + `web-token` 헤더 필수. 토큰은 `corgi ui` 가 여는 URL 로 전달한다.

## 12. CLI

모든 명령에 `--json`. 디바이스는 ID 나 이름으로 가리킨다. 지정하지 않으면 «사용 중인 디바이스 전부».

| 명령 | 하는 일 | 요구사항 |
| --- | --- | --- |
| `corgi status` | 서버 연결, 디바이스, 점유·대기 한눈에 | S2·R13 |
| `corgi doctor [--fix]` | 서버·launchd·Android SDK·시스템 이미지·avdslim·Xcode·simslim·argent(여러 버전)·스킬 점검과 고치는 방법. `--fix` 는 launchd·스킬만 고친다. 훅 점검은 3단계 | S1·S2 |
| `corgi install [--no-launchd] [--no-skill]` · `uninstall` | launchd 등록 + 스킬 설치 (§4) | S1 |
| `corgi ui` | 웹 UI 를 브라우저로 연다 | R11 |
| `corgi list --all [--platform]` | **전체 목록** — 이 Mac 의 모든 에뮬레이터·시뮬레이터(원본). 폭 먼저, Corgi 것·«생성됨» 표시 | M1~M3·M9 |
| `corgi create <원본> [--name] [--no-slim]` | 원본(이름·UDID·AVD ID)과 같은 크기로 `corgi …` 복제본을 만들고 슬림화 | R1~R3·R5·M4 |
| `corgi list` | 만든 디바이스 — 켜짐·슬림·점유 세션·사용 안 함·argent ID | M5 |
| `corgi rename <dev> <name>` · `enable` · `disable` · `delete` | 관리 | M7·M8·R6 |
| `corgi slim [<dev>…] [--off] [--check]` | 슬림 적용·해제·확인 | M6·M7 |
| `corgi acquire [<dev>…] [--wait] [--timeout 10m]` | 점유 | R14 |
| `corgi release [<dev>…] [--force]` | 점유 해제 | R17·S8 |
| `corgi who [<udid·시리얼·dev>]` | 누가 쓰는지 | R13 |
| `corgi up` · `corgi down` | 점유한 디바이스 켜기·끄기 | R7 |
| **`corgi use [<dev>…] [--wait]`** | **acquire + up 한 번에** — 주 흐름의 첫 단계 | R15 |
| `corgi update [--check] [--rollback]` | 새 버전 확인·업데이트·이전 버전으로 되돌리기 | R19 |
| `corgi serve` · `corgi hook <에이전트> pre-tool-use` · `corgi mcp` | 서버·훅·MCP 진입점 (사람이 직접 쓰지 않음) | — |

- 종료 코드: `0` 성공 · `1` 실패 · `2` 사용법 오류 · `3` 다른 세션이 사용 중 · `4` 서버에 연결 못 함
- `up`·`down` 은 점유가 있어야 한다. 없으면 실패하고 `corgi use` 를 안내한다.
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
3. 대상 디바이스를 뽑아 서버에 `hook.check` → 허용/차단 + 사유. 허용이면 서버가 같은 요청으로 `lastUsedAt` 을 갱신한다.
4. **서버가 꺼져 있으면** `managed-index.json` 으로 관리 디바이스인지만 본다. 맞으면(또는 시리얼을 판정 못 하면) 차단하고 «`corgi status` 로 서버를 켜세요» 를 알려 준다 (P9).
5. 차단은 `permissionDecision: "deny"` JSON 으로 돌려주고, 사유에 **누가 쓰는 중인지와 점유 방법**(`corgi use …`)을 넣는다 (P5).

**대상 판정**

| 호출 | 대상 |
| --- | --- |
| argent 도구의 `udid`·`device_id`·`avdName` 인자 | 그 값 |
| argent `list-devices` 등 기기 인자 없는 도구 | 없음 → 통과 (P6) |
| argent `boot-device` · Bash `emulator -avd corgi_…` 로 관리 디바이스 켜기 | 점유와 상관없이 **차단** → `corgi up` 안내 (S6 «켜기는 Corgi 로») |
| Bash 명령 문자열 안에 관리 디바이스 식별자(UDID·AVD ID·현재 시리얼)가 보임 | 그 디바이스 — 명령을 파싱하지 않고 **문자열 포함**으로 본다. `&&`·`$(…)`·변수 등으로 우회되기 어렵다 |
| `adb` 를 기기 지정 없이 기기 명령에 씀(`adb shell` 등, `ANDROID_SERIAL` 미지정) | 켜진 관리 Android 전부 |
| `simctl … booted` | 켜진 관리 iOS 전부 |
| `adb devices`·`emulator -list-avds`·`simctl list` 등 목록 조회 | 없음 → 통과 (P6) |

**argent 규칙에 붙일 문구 (P2)** — `integrations/rules/argent-corgi.md`. `corgi install` 이 에이전트별 전역 규칙 위치(Claude Code `~/.claude/rules/argent.md`, 다른 에이전트는 조사)에 붙인다.

> Corgi 가 관리하는 레이아웃 체크용 디바이스(`corgi list` 에 있는 것, AVD 는 `corgi_` 로 시작)는 `corgi use` 로 점유한 뒤에만 조작한다. 켜기·끄기는 argent `boot-device` 가 아니라 `corgi up`·`corgi down` 으로 한다.

## 14. 웹 UI (M1~M8)

- **메인 화면** (M9): 만든 디바이스 목록 하나 — 위에 **All · Android · iOS 탭**(마지막에 고른 탭을 기억). 한 줄에 `폭 · 이름 · 켜짐 · 슬림 상태(꺼진 항목 수·메모리) · 사용 중인 세션 · 사용 안 함`. 켜기·끄기는 점유 없이(사람), 다른 세션이 쓰는 중이면 막는다. SSE 로 바로 반영된다.
- **생성(+)** (M1~M4): iOS 는 이 Mac 의 시뮬레이터, Android 는 대표 프로필(폭 순, 보조로 해상도·밀도·런타임). Android 는 «직접 입력…»(폭·높이·밀도·이미지)도 있다. 같은 크기로 만든 것이 있으면 «만든 것 있음» 으로 알려만 주고 막지 않는다. 하나 고르면 이름 기본값 `corgi <원본 이름>`(겹치면 번호) → 만들기 + 슬림화 진행 표시. 앱은 설치하지 않는다.
- **행 메뉴** (M7·M8): 이름 변경 · 사용 안 함 · 슬림 해제/다시 적용 · 점유 강제 해제 · 삭제(확인 창, 다른 세션이 쓰는 중이면 막고 누가 쓰는지 표시, 켜져 있으면 끄고 지움).
- **설정**: 자동 해제 시간, Android 시스템 이미지·RAM, simslim 프로필.
- 나중에 **스크린샷 모아 보기**(R10)를 같은 화면에 탭으로 붙인다.

**메뉴바 아이콘 (6단계, 선택)**: `corgi install` 이 `tray/CorgiTray.swift` 를 컴파일해 `Corgi.app` 에 넣는다 — 앱 모드가 «웹 UI 열고 끝» 에서 «메뉴바 상주» 로 바뀌고 로그인 항목에 등록할 수 있다. `/api/events` 를 받아 아이콘 상태(누가 쓰는 중이면 표시)·메뉴(디바이스·점유자)·«웹 UI 열기» 만 한다. 로직은 넣지 않는다.

## 15. 스킬 (S1~S9)

`integrations/skill/corgi/SKILL.md` → `~/.claude/skills/corgi` (S9). 2단계에서 쓴다. 스킬 형식을 읽는 다른 에이전트(Codex 등)는 `corgi install --agent <이름>` 으로 그 에이전트 위치에도 설치한다.

- description 에 S3 의 반응 프롬프트, S4 의 비반응(기기 한 대·단순 스크린샷 → argent 스킬)을 넣는다.
- 본문 순서(S5): `corgi status` → `corgi use [--wait]` (바쁘면 사용자에게 묻기, S7) → `corgi list --json` 으로 기기별 `targetId`·`label` 받기 → 기기마다 argent: 앱 설치(`reinstall-app`)·실행(`launch-app`, Android 는 먼저 `adb reverse`)·같은 화면(`open-url` 또는 argent 흐름)·`screenshot` → 크기 라벨을 붙여 보고 → `corgi release` → 끌지 묻기(S8).
- 설치·연결 문제는 `corgi doctor` 결과를 따른다 (S1·S2).
- `corgi status --json` 에 `update` 가 있으면 사용자에게 알리기만 하고 **직접 업데이트하지 않는다** (R19).

## 16. 단계

각 단계는 끝나면 실제로 쓸 수 있는 상태가 된다.

| 단계 | 내용 | 끝나면 |
| --- | --- | --- |
| 0 ✅ | 저장소 뼈대 — `package.json`·`tsconfig`·Biome·`mise.toml`, `bin/corgi.ts`·`main.ts` 서브커맨드 틀, `scripts/build.ts`, 검사 통과. **컴파일한 바이너리에서 파일 포함·훅 시작 시간 확인** | `bun link` 와 `dist/corgi` 양쪽에서 `corgi --version` 이 돈다 |
| 1 ✅ | 서버 + CLI 코어 — 레지스트리, Android·iOS 드라이버(생성·목록·이름·사용 안 함·삭제·켜기·끄기·슬림), 점유·대기·자동 해제, 소켓, launchd, `protocol.md`. **실제 디바이스로 확인**: iOS 생성+슬림 2분 22초, Android·iOS 동시 켜기 29초. 남은 확인은 §17 | CLI 로 크기별 디바이스를 만들고 점유해서 켠다 |
| 2 ✅ | `doctor` + 스킬 — 설치·연결 점검(S1·S2), 스킬(S3~S8 — 앱 설치·실행·화면 이동은 argent 로 안내), `corgi install` 이 스킬도 설치. **남은 확인**: 실제 앱(NOVA)으로 «코기로 확인해 줘» 흐름을 처음부터 끝까지 돌려 보기 | «코기로 확인해 줘» 로 주 흐름(R15)이 돈다 |
| 3 | 보호 — 훅, argent 규칙, 서버 꺼짐 처리, `corgi install` 완성 | 다른 세션이 남의 디바이스를 못 건드린다 |
| 4 | 웹 UI (M1~M8) + HTTP API·SSE | 사람이 브라우저로 전부 관리한다 |
| 5 | MCP 래퍼 | 에이전트가 사용법 없이 바로 쓴다 |
| 6 (선택) | 메뉴바 아이콘 | 메뉴바에서 점유 상태를 본다 |
| U | 업데이트 — `scripts/release.ts`, 확인·알림, `corgi update`·되돌리기 (§19). **리모트·첫 Release 가 생긴 뒤**, 4단계 이후 아무 때나 | 새 버전을 알림 받고 명령 한 번으로 올린다 |
| 나중 | 스크린샷 모아 보기 (웹 UI 탭) · 일괄 설치·실행·딥링크 (L1~L3, 필요하면) | — |

## 17. 구현 전에 실측할 것

| 항목 | 왜 | 언제 |
| --- | --- | --- |
| 에이전트별 프로세스 트리 — codex·gemini·cursor-agent·opencode·copilot 이 명령·MCP 를 자식 프로세스로 실행하는지, `AI_AGENT` 같은 표시 변수를 주는지 (각 에이전트에 `ps` 를 실행시켜 확인 — 그 에이전트 사용량이 든다) | §7 판정표·호스트 목록 | 1단계 |
| Claude 어댑터 — CLI 의 `CLAUDE_CODE_SESSION_ID` 와 훅 입력 `session_id` 가 같은 값인지, `/clear`·`--resume` 시 어떻게 바뀌는지 | §7 보조 세션 ID | 1단계 |
| ✅ avdslim — 1.0.15 설치·확인(2단계 전). 명령: `tune-avd <avd>`(호스트 설정, config.ini 를 다시 씀 — AvdId·크기·이름은 유지됨)·`on <serial>`·`off <serial>`·`profiles`. **상태 조회 명령이 없어** 슬림 확인은 «기기에 설치된 프로필 패키지 중 꺼진 비율 ≥ 50%» 로 한다(표준 프리셋이 Chrome·Play 스토어 등은 남겨 실측 52개 중 49개). 풀림 → 켤 때 재적용까지 실제로 확인 | §9 Android 슬림·M6 | 2단계 전 |
| simslim 0.8 → 0.11 변경점. 0.8 에서 확인함: `on --preserve-boot-state` 로 꺼진 기기도 슬림화(잠시 켬), `verify` 는 켜진 기기만, `list --json` 의 `managedDisabled` 는 켜진 기기만 나온다 | M6 | 업데이트 시 |
| ✅ 컴파일한 바이너리에 웹 UI·파일이 잘 들어가는지, 훅 경로 시작 시간 — **확인됨(0단계)**: `with { type: "file" }` 는 `/$bunfs/root/…` 경로로 들어가 `Bun.file` 로 읽히고, HTML import 는 TSX 까지 번들돼 `Bun.serve` 로 서빙된다(`--bytecode` 포함, 다른 폴더로 옮겨도 동작). 훅 경로 약 21ms | §2·§3·§13 | 0단계 |
| ✅ launchd 로 띄운 서버가 `emulator`·`xcrun` 을 PATH·권한 문제 없이 실행하는지 — **확인됨(2단계 전)**: `corgi install` 로 등록한 서버가 Android·iOS 를 만들고 함께 켰다(1분 16초, 슬림 없이). 등록하면 macOS 가 «백그라운드 항목 추가됨» 알림을 띄우고, 로그인 항목에 실행 파일 서명자 이름(개발 모드는 bun 의 «Jarred Sumner»)이 보인다 | launchd 는 로그인 셸 환경을 안 받는다 | 2단계 전 |
| 에이전트별 MCP 서버의 부모가 에이전트 프로세스인지 (Claude Code 는 확인됨) | §7 | 5단계 |
| argent 두 버전(homebrew 0.17.0 이 PATH 우선, mise 0.26.0) 정리 | 훅이 보는 argent 도구 인자가 버전마다 다를 수 있다 | 3단계 전 |
| 다른 에이전트의 실행 직전 훅 지원 여부·설정 위치·입력 형식, 전역 규칙·스킬 위치 | §13 어댑터·P2·S9 | 3단계 전 |

## 18. 미결정 질문(Q)에 대한 설계 쪽 제안

| Q | 제안 |
| --- | --- |
| Q9 묶어서 켜기 | `use`·`up` 은 플랫폼 구분 없이 지정한 것 전부. `--platform android` 로 좁힐 수 있게 |
| Q16 훅 없는 에이전트 | 규칙 + CLI 의 BUSY 응답으로 보호. 훅을 지원하면 어댑터를 붙인다(§13) |

## 19. 업데이트 (R19)

**확인**
- 서버가 **시작할 때와 하루 한 번** 프라이빗 GitHub Release 의 최신 버전을 본다. 인증은 이미 로그인된 `gh` 를 그대로 쓴다(`gh api repos/<owner>/corgi/releases/latest`). `gh` 가 없거나 로그인 안 돼 있으면 조용히 넘어가고 `corgi doctor` 에서만 알려 준다.
- 버전은 semver(`package.json` `version`) 로 비교한다. 개발 모드(`bun link` 로 소스 실행)에서는 확인하지 않는다.

**알림** — 사람과 에이전트를 나눈다

| 받는 쪽 | 방식 |
| --- | --- |
| 사람 | 새 버전마다 **macOS 알림 한 번**(`update.json` 에 보낸 버전 기록). 웹 UI 상단 배너 + «업데이트» 버튼. 메뉴바가 생기면 아이콘 표시 |
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

> 구조 수준의 결정(웹 UI · TS · 단일 실행 파일 · `Corgi.app` · 메뉴바 방식)은 `requirements.md` «결정 기록» 에 있다. 여기에는 구현 수준의 결정만 둔다.

| 결정 | 이유 | 버린 대안 |
| --- | --- | --- |
| **상태를 바꾸는 요청은 Unix 소켓으로만**, HTTP 는 웹 UI·메뉴바용 | 소켓은 파일 권한(0600)으로 이 사용자만 접근한다. localhost HTTP 는 브라우저를 통한 공격 경로가 있어 토큰·Origin 검사를 따로 둔다 | HTTP 하나로 통일 (simfleet 방식 — 훅·CLI 까지 웹 공격면에 노출) |
| **대기 항목은 세션에 붙인다** | CLI 는 Bash 시간 제한(최대 10분)에 끊길 수 있고, MCP 는 호출 시간 제한 때문에 «다시 호출» 해야 한다. 연결에 붙이면 끊길 때마다 순번을 잃는다 | 연결 기준 대기 (끊기면 순번 잃음) |
| **훅은 명령 파싱 대신 식별자 문자열 포함으로 판정** | 셸 문법(`&&`·`$(…)`·변수)을 다 파싱할 수 없고, 파싱 누락이 곧 보호 구멍이다. 관리 디바이스 식별자는 충분히 고유하다 | 셸 파서로 `-s` 인자 추출 (우회 쉬움) |
| **Android 시리얼은 `-port` 로 서버가 정한다** | 시리얼이 켤 때마다 바뀌는 문제를 대부분 없앤다. 밖에서 켠 경우만 역조회 | 매번 `adb devices` + 역조회 (느리고 훅에서 부담) |
| **`main.ts` 에서 서브커맨드별 동적 import** | 훅은 Bash 호출마다 돈다. 서버·웹 코드를 불러오지 않아야 빠르다 | 진입점에서 전부 import |
| **패키지 하나** (모노레포 아님) | 결과물이 실행 파일 하나다. 경계는 폴더와 import 규칙(§3)으로 지킨다 | workspaces 로 shared·server·cli·web 분리 (설정만 늘어남) |
| **공용 호스트 아래에서는 터미널 탭(셸) 단위로 세션을 나눈다** (§7) | IDE·터미널 앱·tmux 는 여러 사람·에이전트 작업이 한 프로세스 아래 모인다. 호스트를 세션으로 보면 서로 다른 작업이 한 세션이 된다 | 호스트 프로세스를 세션으로 (전부 한 세션), 바로 위 셸을 세션으로 (에이전트가 명령마다 새 셸을 띄우면 매번 다른 세션) |
| **업데이트 확인에 `gh` 인증을 그대로 쓴다** (§19) | 저장소가 프라이빗이라 인증이 필요한데, 토큰을 따로 받아 저장하면 관리할 비밀이 생긴다. 개발자 Mac 에는 `gh` 가 이미 로그인돼 있다 | Corgi 전용 토큰 저장 (비밀 관리 부담), 공개 저장소 (프라이빗 요구와 충돌) |
| **원본 목록은 서버가 그때그때 읽는다** (M1·M9) | 원본은 Corgi 가 관리하지 않는다(Q7). Xcode·Android Studio 에서 바뀌어도 바로 맞도록 저장하지 않는다. Corgi 가 만든 것(`corgi_` AVD·레지스트리의 UDID)은 «전체 목록» 에 표시만 하고 원본 후보에서는 뺀다 | 원본도 레지스트리에 등록 (관리 대상이 아닌데 상태를 맞춰야 함) |
