# Simless

**Make simulator management seamless.** — simulator + seamless

이 Mac 의 **iOS 시뮬레이터·Android 에뮬레이터를 여러 AI 에이전트 세션이 안전하게 나눠 쓰게** 하는 도구다.
에이전트는 «심리스로 확인해 줘» 한마디로 기기를 빌리고, 다 쓰면 돌려준다. 다른 세션이 쓰는 기기는 기다리거나 묻는다.

- **용도별 기기 묶음(그룹)** — «두 계정 확인»(계정 A 기기 + 계정 B 기기), «해상도별 레이아웃»(폭이 다른 세 대)처럼 묶어 두고 한 번에 빌린다
- **기본 디바이스** — 플랫폼마다 한 대. «기본 디바이스로 테스트해 줘». 기기가 하나도 없으면 만들어서 빌려준다
- **iOS 와 Android 를 함께** — 한 그룹에 iPhone 과 Android 를 섞을 수 있다
- **UI 테스트용 슬림 기기** — Siri·iCloud 같은 것을 꺼서 가볍게(예: 7.8GB → 1.6GB). 만들 때 고른다
- **차례·교착** — 먼저 온 순서대로, 서로 기다리다 멈추는 요청은 미리 거절한다
- **보호(선택)** — 점유하지 않은 세션이 argent·adb·simctl 로 기기를 건드리면 실행 직전에 막는다

화면 안 조작(탭·스크린샷·앱 실행)은 [argent](https://argent.swmansion.com) 가 하고, Simless 는 기기를 만들고·관리하고·빌려준다.

## 설치

```sh
simless install     # 서버(로그인 시 자동 실행)·에이전트 스킬·Simless.app
```

`Simless.app` 을 처음 열면 **«Simless 시작하기»** 창이 뜬다.

1. **이 Mac 점검** — Xcode·simslim·Android SDK·avdslim·argent. 빠진 것은 설치 명령을 보여 준다
2. **에이전트 연결** — 스킬(권장, 전역 또는 프로젝트) · 보호(권장) · MCP 도구(선택)
3. **기본 디바이스** — 고르거나 만든다

터미널만 쓸 때는 `simless install --hook --mcp` 로 보호·MCP 까지 넣는다. 점검은 `simless doctor`.

## 쓰는 법

**에이전트에게** (Claude Code) — 모바일 앱 프로젝트에서

> 기본 디바이스로 테스트해 줘 · 해상도별 레이아웃 그룹으로 봐 줘 · 심리스로 확인해 줘

웹 프로젝트의 반응형 확인에는 반응하지 않는다(브라우저로 한다). 시뮬레이터를 직접 말하면 반응한다.

**사람은** `Simless.app` — 디바이스(만들기·추가·이름·슬림·그룹·기본) · 그룹 · 세션(누가 무엇을 쓰는지, 기록) · 설정.

**CLI**

| 명령 | |
| --- | --- |
| `simless status` | 기기·그룹·누가 쓰는지 |
| `simless use --default ios` · `--group "two accounts"` · `<기기>…` | 빌려서 켜기 (`--available` 비어 있는 것만, `--wait` 기다리기, `--create` 없으면 만들기) |
| `simless release` · `simless down` | 돌려주기 · 끄기 |
| `simless catalog` · `simless create "iPhone 17"` | 만들 수 있는 기종 · 만들기 (`--no-slim` 일반 기기) |
| `simless group list` · `simless group create …` | 그룹 |
| `simless history` | 점유 기록 (90일 보관) |
| `simless app install` · `simless app save --platform ios` | 네이티브 빌드 캐시 — 네이티브 지문이 같은 빌드가 있으면 빌드 없이 설치 · 방금 빌드한 것 보관 (Expo 앱) |
| `simless skill status` · `simless skill install --project <폴더>` | 스킬을 넣은 곳 |
| `simless config` · `simless doctor` · `simless ui` | 설정 · 점검 · 웹 화면 |

## 지원하는 에이전트

| 에이전트 | 지금 |
| --- | --- |
| Claude Code | 스킬 · 보호(훅) · MCP |
| Copilot CLI · Codex · Cursor · Gemini CLI | 스킬 · 보호(훅) · MCP — 붙였지만 실제 에이전트로는 아직 확인 전. Codex 는 `/hooks` 승인, Gemini 는 작업 폴더 `/trust` 가 필요 |
| OpenCode | 아직 (`docs/agent-integrations.md`) |

## 보호가 막는 것과 못 막는 것

막는 것: 점유하지 않은 세션의 argent 도구 호출(스크린샷 같은 읽기 포함), 기기 ID 가 든 `adb`·`simctl`·`emulator` 명령, 기기를 지정하지 않은 `adb shell`·`simctl … booted`, Simless 밖에서 켜기.

못 막는 것: 사람이 Xcode·Simulator·Android Studio 로 직접 조작, 명령 안에서 간접으로 부르는 경우(`npx react-native run-android`·`xcodebuild`·Gradle 등), 변수로 넘긴 기기 ID, argent 가 아닌 기기 조작 MCP. 보안 경계가 아니라 **실수로 남의 기기를 건드리지 않게 하는 안전장치**다.

## 데이터

서버 하나가 저장한다 — `~/Library/Application Support/simless/`(레지스트리·점유는 JSON, 점유 기록은 SQLite), 설정 `~/.config/simless/config.json`, 로그 `~/Library/Logs/simless/`. 기기 목록 자체는 저장하지 않고 매번 이 Mac 에서 읽는다.

## 개발

```sh
mise install && bun install && bun link
bun run check && bun run test
```

- `docs/development.md` — 무엇을 바꾸려면 어디를 고치나, 테스트 쓰는 법
- `requirements.md` — 요구사항(ID)과 결정 기록 · `docs/design.md` — 설계 · `docs/protocol.md` — 메시지
- `AGENTS.md` — 작업·커밋 규칙(모든 에이전트, `CLAUDE.md` 가 불러옴) · `HANDOFF.md` — 진행 상태
