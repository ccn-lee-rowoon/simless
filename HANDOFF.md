# 인계 — Corgi (크기별 디바이스 레이아웃 확인 도구)

> 2026-10-01~02, xb3-client(NOVA) 세션에서 정리한 내용. 이 폴더에서 새 세션을 시작할 때 **이 파일과 `requirements.md` 를 먼저 읽는다.**

## 이 폴더

| 파일 | 내용 |
| --- | --- |
| `requirements.md` | 요구사항 정본 (기능 R · 앱 화면 M · 스킬 S · 보호 P · 미결정 Q · **결정 기록**) |
| `reference-design-draft.md` | 요구사항 정리 **전** 첫 설계 초안 — **확정 아님, 참고용**. `requirements.md` 와 충돌하면 그쪽이 이긴다 |
| `HANDOFF.md` | 이 파일 — 배경, 실측으로 확인한 사실, 지금 머신 상태, 시작 프롬프트 |
| `docs/design.md` | 설계안 — 저장소 구조·기술 선택·점유·훅·CLI·단계 (**v0.2 검토 중**) |
| `CLAUDE.md` | 작업 규칙 — 읽는 순서, 문서 규칙, **커밋 규칙** |

## 진행 상태

- 요구사항 정리 **완료**. 설계 전에 정할 것은 없다 (남은 Q 는 만들면서 정해도 됨)
- 설계안 v0.2 작성(`docs/design.md`)
- **0단계(저장소 뼈대) 완료** — `bun link` 로 `corgi` 등록됨(`~/.bun/bin/corgi` → 이 저장소). 다음은 1단계(서버 + CLI 코어), 세션 구분은 에이전트 무관(프로세스 트리) — 에이전트별 실측 항목은 `docs/design.md` §17
- **1단계(서버 + CLI 코어) 완료** — `corgi serve`·`install`·`status`·`catalog`·`create`·`list`·`use`·`up`·`down`·`acquire`·`release`·`who` 등. 실제 Android·iOS 디바이스로 만들기·켜기·점유를 확인하고 시험 디바이스는 지웠다. 남은 확인(에이전트별 프로세스 트리)은 `docs/design.md` §17
- 구조 확정: TypeScript(Bun) 상주 서버 + CLI + 웹 UI(메뉴바는 나중에 선택), 단일 실행 파일 배포(개발은 `bun link`), `Corgi.app` 은 설치 때 그 Mac 에서 생성 — 이유는 `requirements.md` «결정 기록»
- 범용 도구 → NOVA 레포(xb3-client)와 분리해 별도 프로젝트로 만든다

## 실측으로 확인한 사실 (이 머신)

**환경**
- Apple M4 Pro · 메모리 48GB. iOS 시뮬레이터 2대만 켜도 약 19GB 사용(가장 무거움). Android 에뮬레이터는 대당 약 1GB
- Android SDK `~/Library/Android/sdk` — `emulator`·`adb` 있음, **cmdline-tools(`avdmanager`) 없음**
- 시스템 이미지: `android-37.1/google_apis_playstore_ps16k/arm64-v8a`, `android-36/google_apis_playstore`
- iOS 런타임: 18.6 · 26.0 · 26.2 · 26.5
- 설치됨: simslim **0.8.0**(최신 0.11.0) · scrcpy 4.1 · Bun · argent 0.26.0 · simfleet 0.1.1(안 쓰기로 함)
- **avdslim 1.0.15 설치됨** (2026-10-02) — `brew install kdbhalala/avdslim/avdslim` 가 `brew trust` 없이 설치됐다(전에는 비공식 tap 이라 거부한다고 봤음 — brew 버전에 따라 다를 수 있어 `corgi doctor` 는 둘 다 안내)
- baguette 미설치 (iOS 화면 스트리밍용, 지금 범위 밖)

**AVD 직접 생성** (`avdmanager` 없이 동작 확인)
- `~/.android/avd/<ID>.ini` + `<ID>.avd/config.ini` 두 파일을 쓰면 `emulator -list-avds` 에 바로 뜬다
- 핵심 키: `AvdId`, `avd.ini.displayname`(표시 이름, 공백 가능), `hw.lcd.width/height/density`, `image.sysdir.1`, `hw.ramSize`, `abi.type`, `target`
- 폭(dp) = 픽셀 폭 ÷ (dpi / 160). 예) 720px @320 → 360dp
- 이름: AVD ID(실행에 쓰는 값, 영문·숫자·`._-`)와 표시 이름이 따로다 → 바뀌지 않는 ID 로 기억하고 표시 이름만 바꾸면 된다
- 동시 부팅 3대 확인. 부팅 직후 adb 가 잠깐 `offline` 이었다가 붙는다 — `sys.boot_completed == 1` 까지 기다린다

**iOS**
- 화면 크기는 기기 종류로 정해지고 바꿀 수 없다
- `xcrun simctl create / clone / rename` 이 기본 기능. `simctl clone` 은 **슬림 설정이 따라오지 않는다**, `simslim clone` 은 따라온다
- simslim 은 `on <udid> --profile <json>` 으로 적용, `verify --profile` 로 풀렸는지 확인. 설정은 시뮬레이터별로 저장돼 재부팅해도 유지 (iOS 18.5+)
- argent `boot-device` 로 iOS 2대를 **동시에** 켜면 중단(abort) 오류 — 부팅 자체는 됐다

**`wm size/density` 를 안 쓰는 이유 (실측)**
- NOVA MainActivity 가 `resizeableActivity="false"` + 세로 고정이라, 실행 중 바꾸면 호환 모드(«Tap to restart this app») 로 떨어지고 앱을 재시작해야 반영된다
- 바꾼 값은 재부팅해도 남는다(`wm … reset` 전까지)

**화면 확인 관련**
- NOVA 는 `FLAG_SECURE` 가 켜진 화면이 있어 scrcpy·녹화 스트림에 검게 나온다. `adb exec-out screencap` 도 막힐 수 있음 — 스크린샷 방식은 앱마다 확인 필요
- scrcpy 4.x 는 3.x 와 스트림 헤더가 달라 3.x 기준 파서는 깨진다(simfleet 에서 겪음). 스트리밍을 만들게 되면 버전 확인

**세션 구분**
- Claude Code 는 Bash 환경에 `CLAUDE_CODE_SESSION_ID` 를 준다 (확인됨)
- PreToolUse 훅은 입력 JSON 에 `session_id` 를 받는다
- 로컬 MCP 프로세스가 세션 ID 를 받는지는 **미확인**

**simfleet 을 안 쓰는 이유**
- 0.1.1 기준 크기별 생성·일괄 설치·같은 화면 이동이 없고, lane 하나가 워크트리 하나를 독점해 같은 브랜치를 여러 기기에 못 띄운다. 로드맵·이슈에도 없음
- 점유(claim)는 기록일 뿐 입력을 막지 않는다

## 지금 머신에 남아 있는 것 (정리 필요)

| 항목 | 상태 | 정리 방법 |
| --- | --- | --- |
| Android 에뮬레이터 3대 | 켜져 있음 (`Size_Small_360dp`·`Size_Large_412dp`·`Size_Tablet_800dp`) | `adb -s <serial> emu kill` |
| AVD 3개 | `~/.android/avd/Size_*.avd` + `.ini` (약 7GB) | 필요 없으면 폴더·ini 삭제 |
| `simfleet serve` | 실행 중 (127.0.0.1:8790) | `pkill -f "simfleet serve"`, 필요 없으면 `bun remove -g simfleet` |
| simfleet 상태 | `~/Library/Application Support/nova-size-check Sim Fleet` | 삭제 |
| scrcpy 4.1 | brew 설치 | 필요 없으면 `brew uninstall scrcpy` |
| brew tap · avdslim | `kdbhalala/avdslim` tap + avdslim 1.0.15 설치됨 | Corgi 가 쓰므로 유지 |
| Corgi launchd 등록 | `~/Library/LaunchAgents/corgi.server.plist` (개발 모드: bun + 이 저장소의 `bin/corgi.ts`) | Corgi 를 쓰는 동안 유지. 지우려면 `corgi uninstall` |
| `corgi` 명령 | `~/.bun/bin/corgi` → 이 저장소 (`bun link`) | 유지 |
| 기존 `Pixel_6a` AVD·기존 iOS 시뮬레이터 | 건드리지 않음 | — |
| NOVA alpha APK | 위 3대 AVD 에 설치됨 | AVD 삭제 시 함께 사라짐 |

## 시험용 앱 설정 예시 (NOVA)

범용 도구의 «앱별 설정» 첫 예시로 쓴다.

```jsonc
{
  "name": "nova",
  "androidPackage": "com.ensapia.nova.alpha",
  "androidApk": "<xb3-client>/rn/android/app/build/outputs/apk/debug/app-debug.apk",
  "devClientScheme": "exp+novadeva",   // dev client 실행: exp+novadeva://expo-development-client/?url=http%3A%2F%2F127.0.0.1%3A8081
  "deepLinkScheme": "novaa",           // 앱 화면 딥링크
  "metroPort": 8081                    // adb reverse tcp:8081 tcp:8081 필요
}
```

- iOS 번들 ID 는 미확인 (alpha dev 앱 이름 `NOVADEVA`)
- Metro 는 도구가 띄우지 않는다. NOVA 쪽 세션이 띄운 Metro 를 같이 쓴다

## 새 세션 시작 프롬프트

`~/Projects/ccn-lee-rowoon/corgi` 에서:

```
HANDOFF.md 와 requirements.md(맨 아래 «결정 기록» 포함)를 먼저 읽어줘. reference-design-draft.md 는 확정 아닌 참고용이야.
크기별 디바이스 레이아웃 확인 도구(TS 상주 서버 + CLI + 웹 UI + 로컬 MCP + 스킬)를 만들려고 해.
요구사항 정리는 끝났으니, 저장소 구조와 설계안부터 같이 잡자. 아직 구현은 하지 마.
```
