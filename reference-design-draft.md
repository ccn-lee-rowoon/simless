> ⚠️ **확정 아님 — 참고용.** 2026-10-01 요구사항 정리 **전에** 쓴 첫 설계 초안이다. 이후 결정과 다른 부분이 있다 — 충돌하면 `requirements.md` 가 이긴다.
>
> 이후 바뀐 것: 상주 데몬 없음 → **앱이 서버**(구조 전제) · 점유 TTL 10분 → **30분 + 기다리는 세션 있을 때만**(R17) · 대기 기본 블록 → **알림 기본 + 기다리기 선택**(R14) · 훅 선택 설치 → **훅으로 강제**(P3) · 읽기 허용 → **기기 지정 읽기도 차단**(P8) · 이름 `devfleet` 은 가칭

# devfleet 사양 (초안 v0.1)

> 가칭. 레이아웃 확인용 크기별 Android 에뮬레이터·iOS 시뮬레이터를 **만들고·슬림화하고·켜고·확인**하며,
> 여러 에이전트 세션이 같은 디바이스를 동시에 건드리지 않게 **점유·대기**를 관리한다.
> 사용 경로는 셋 — CLI · MCP · 메뉴바 앱. 셋 다 같은 코어 CLI 를 부른다.

## 1. 목표 / 비목표

**목표**
- 크기 프리셋(Android dp 폭, iOS 기기 종류)으로 디바이스를 생성·이름 지정·슬림화하고 상태를 유지한다.
- 사용할 디바이스만 골라(사용 안 함 설정) 일괄로 켜고 끈다.
- 앱 일괄 설치·실행, 같은 화면(딥링크) 이동, 크기 라벨이 붙은 합본 스크린샷.
- **세션 점유**: 어느 에이전트 세션이 쓰는 중인지 기록하고, 다른 세션은 대기열에서 기다린다.

**비목표**
- 실행 중 디바이스의 크기 변경(`wm size/density`) — 앱 재시작이 필요해 쓰지 않는다.
- 탭·스와이프 등 UI 조작 — argent 가 맡는다. devfleet 은 수명주기·점유·확인만.
- 원격(네트워크) 접근, 실기기.

## 2. 용어

| 용어 | 뜻 |
| --- | --- |
| 프리셋 | 크기 정의 1건. `android-320`, `ios-se` 등 |
| 디바이스 | 프리셋으로 만든 실제 AVD/시뮬레이터 1대 |
| 그룹 | 함께 다루는 프리셋 묶음. 기본 `layout` |
| 점유(lease) | 한 세션이 디바이스를 독점 사용 중인 상태 |
| 대기열 | 점유가 풀리길 기다리는 세션 목록(FIFO) |

## 3. 설정 파일 — `~/.config/devfleet/fleet.json`

```jsonc
{
  "schemaVersion": 1,
  "presets": [
    { "id": "android-320", "platform": "android", "widthDp": 320, "heightDp": 640, "density": 420, "enabled": true },
    { "id": "android-375", "platform": "android", "widthDp": 375, "heightDp": 812, "density": 420, "enabled": true },
    { "id": "android-414", "platform": "android", "widthDp": 414, "heightDp": 896, "density": 420, "enabled": true },
    { "id": "android-600", "platform": "android", "widthDp": 600, "heightDp": 960, "density": 320, "formFactor": "tablet", "enabled": true },
    { "id": "ios-se",      "platform": "ios", "deviceType": "iPhone SE (3rd generation)", "runtime": "latest", "enabled": true },
    { "id": "ios-17",      "platform": "ios", "deviceType": "iPhone 17",                  "runtime": "latest", "enabled": true },
    { "id": "ios-promax",  "platform": "ios", "deviceType": "iPhone 17 Pro Max",          "runtime": "latest", "enabled": false },
    { "id": "ios-ipadmini","platform": "ios", "deviceType": "iPad mini (A17 Pro)",        "runtime": "latest", "enabled": false }
  ],
  "groups": { "layout": ["android-320", "android-375", "android-414", "android-600", "ios-se", "ios-17"] },
  "android": { "systemImage": "system-images/android-37.1/google_apis_playstore_ps16k/arm64-v8a/", "ramMb": 2048, "avdslimArgs": [] },
  "ios": { "simslimProfile": "~/.config/devfleet/simslim-profile.json" },
  "apps": {
    "myapp": { "androidPackage": "com.example.myapp", "iosBundleId": "com.example.myapp", "devClientScheme": "exp+myapp", "deepLinkScheme": "myapp", "metroPort": 8081 }
  }
}
```

- 디바이스 이름은 `Fleet_<presetId>` 로 고정(AVD ID 규칙: 영문·숫자·`._-`). 표시 이름은 `Fleet 320dp` 처럼.
- Android 해상도 = `widthDp × density / 160` (px). `formFactor: tablet` 은 태블릿 하드웨어 프로필로 생성.
- **관리 대상은 devfleet 이 만든 디바이스만** (`Fleet_` 접두사 + 상태 파일 등록). 기존 시뮬레이터·AVD 는 목록에도 안 나오고 건드리지 않는다.
- `enabled: false` = 지우지 않고 일괄 동작(`up`·`install`·`shot` 등)에서만 뺀다.

## 4. 수명주기

| 단계 | Android | iOS |
| --- | --- | --- |
| 생성 | `~/.android/avd/Fleet_<id>.avd` + `config.ini` 작성 | `simctl create Fleet_<id> <deviceType> <runtime>` |
| 슬림화 | 부팅 후 `avdslim on <serial>` (+`tune-avd`) | `simslim on <udid> --profile <공용 프로필>` |
| 검증 | avdslim 상태 조회 | `simslim verify --profile` — 어긋나면 재적용 |
| 켜기 | `emulator -avd Fleet_<id> -lowram -no-snapshot-save` | `simslim boot <udid>` |
| 끄기 | `adb emu kill` / `avdslim stop` | `simslim shutdown <udid>` |
| 제거 | AVD 폴더·ini 삭제 | `simctl delete` |

- 슬림화는 디바이스별로 저장돼 재부팅해도 유지된다. 새로 만들면 다시 슬림화해야 한다.
- 생성·슬림화는 멱등. 이미 맞으면 아무것도 안 한다.

## 5. 세션 점유·대기

### 5.1 세션 식별
- 우선순위: `--session` 인자 → `CLAUDE_CODE_SESSION_ID` → `DEVFLEET_SESSION_ID` → 부모 프로세스 체인에서 찾은 에이전트 PID.
- 기록 필드: `sessionId`, `agent`(claude/codex/human), `pid`(살아 있는지 판정용), `cwd`·브랜치(표시용), `acquiredAt`, `heartbeatAt`.

### 5.2 점유 규칙
- 단위는 **디바이스**. `acquire <그룹|프리셋…>` 은 요청한 디바이스를 **전부 아니면 전무**로 잡는다(부분 점유로 교착 방지). 잡는 순서는 프리셋 ID 정렬 고정.
- 같은 세션의 재요청은 통과(재진입).
- 점유가 풀리는 경우: ① `release` ② 점유 PID 소멸 ③ 하트비트가 TTL(기본 10분) 동안 없음. ②·③ 은 다음 조회 때 정리한다.
- 강제 해제 `release --force <디바이스>` 는 사람만(CLI 확인 프롬프트, MCP 에선 미노출).

### 5.3 대기
- 점유 중이면 대기열(FIFO)에 등록하고 **누가·언제부터·무엇을** 쓰는지 알려 준다.
- CLI `acquire --wait [--timeout 30m]` 은 풀릴 때까지 블록. MCP 는 호출 시간 제한이 있어 `acquire(wait_seconds ≤ 50)` → 못 잡으면 `{ queued: true, position, holder }` 를 돌려주고, 에이전트가 다시 호출한다(대기열 순번 유지).
- 대기 중 세션이 사라지면(PID 소멸) 대기열에서 뺀다.

### 5.4 저장·동시성
- 상태 디렉터리 `~/.local/state/devfleet/` — `leases/<device>.json`, `queue/<device>.jsonl`.
- 쓰기는 `flock` 으로 직렬화. 상주 데몬 없이 CLI 만으로 동작.

### 5.5 강제력
- 점유는 devfleet 경유 동작에만 걸린다. argent·adb·simctl 직접 호출은 못 막는다.
- 보완: **Claude Code PreToolUse 훅**(선택 설치)이 `mcp__argent__*`·`adb -s`·`simctl` 호출의 대상 디바이스를 보고, 다른 세션이 점유 중이면 차단하고 holder 를 알려 준다.

## 6. 앱 설치·실행·확인

| 명령 | 동작 |
| --- | --- |
| `install <앱> [--apk 경로 \| --app 경로]` | 점유한(또는 지정) 디바이스 전부에 설치. 경로 생략 시 최근 빌드 산출물 탐색 |
| `launch <앱>` | Android `adb reverse <metroPort>` → dev client 딥링크, iOS `simctl openurl` |
| `open <url>` | 전부에 같은 딥링크(`myapp://…`) 전송 — 같은 화면 이동 |
| `shot [--out 경로]` | 전부 캡처 → 크기 라벨을 붙여 한 장으로 합본(PNG) + 개별 파일 |

- Metro 는 띄우지 않는다. 지정 포트에 없으면 오류로 알려 준다(다른 세션 Metro 보호).
- 딥링크가 없는 화면은 자동 이동 범위 밖.

## 7. 인터페이스

### 7.1 CLI (모든 명령 `--json` 지원)
```
devfleet presets | create [<id…>|--group] | slim | verify | remove
devfleet enable <id> | disable <id>
devfleet up [--group layout] | down | status
devfleet acquire <id…|--group> [--wait] [--timeout] | release [<id…>] | heartbeat | who
devfleet install | launch | open <url> | shot
```

### 7.2 MCP
- CLI 명령 1:1 tool: `fleet_status`, `fleet_up`, `fleet_down`, `fleet_acquire`, `fleet_release`, `fleet_install`, `fleet_launch`, `fleet_open`, `fleet_shot`.
- 점유가 필요한 tool(`install`·`launch`·`open`·`shot`)은 호출 세션이 점유자가 아니면 거부하고 holder·대기 순번을 돌려준다.

### 7.3 메뉴바 앱 (SwiftUI `MenuBarExtra`)
- 디바이스 목록: 켜짐·슬림·메모리·**점유 세션**·대기 수.
- 토글: 사용/안 함, 켜기/끄기. 버튼: 그룹 일괄 켜기, 스크린샷 미리보기.
- 모든 동작은 CLI `--json` 호출. 앱에만 있는 로직 없음.

## 8. 의존성

| 도구 | 용도 | 상태 |
| --- | --- | --- |
| Android SDK `emulator`·`adb` | 생성·실행 | 설치됨 |
| avdslim | Android 슬림화 | 미설치 — `brew trust kdbhalala/avdslim` 필요 |
| simslim | iOS 슬림화·boot | 0.8.0 설치됨 (최신 0.11.0) |
| Bun | CLI·MCP | 설치됨 |

## 9. 단계

1. **CLI 코어** — 설정·생성·슬림화·enable/disable·up/down·status·**점유/대기**
2. **확인 기능** — install·launch·open·shot(합본)
3. **MCP 래퍼** + PreToolUse 훅
4. **메뉴바 앱**

## 10. 미결정

- 저장소: 별도 레포(추천) vs 앱 저장소의 `tools/`
- 이름: `devfleet` 가칭
- Android 프리셋 높이·밀도 값(위는 임시), 600dp 를 태블릿 프로필로 할지
- iOS 프리셋 목록·런타임 고정 여부
- 점유 TTL·대기 타임아웃 기본값
- 훅 강제 차단을 기본으로 켤지
