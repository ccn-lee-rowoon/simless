# 바뀐 것 (CHANGELOG)

simless 의 버전마다 사용자에게 보이는 변화를 적는다. 형식은 [Keep a Changelog](https://keepachangelog.com/ko/1.1.0/), 버전은 [SemVer](https://semver.org/lang/ko/).

- 1.0 전에는 기능이 늘거나 동작이 바뀌면 minor(0.**x**.0), 고치기만 하면 patch(0.1.**x**).
- 버전은 `bun run release <patch|minor|x.y.z>` 로만 올린다. 아래 «아직 내지 않은 것» 이 그 버전의 절이 된다(비어 있으면 커밋에서 초안을 만든다 — `bun run release draft`).

## 아직 내지 않은 것

### 추가

- **슬림 항목 고르기** — 전체 슬림(UI 확인용) 말고 남길 항목을 골라 슬림할 수 있다. iOS 는 simslim 묶음, Android 는 avdslim 패키지 묶음·기기 설정(위치 등)·카메라·소리. 기기마다 기억해 풀렸을 때 같은 내용으로 다시 적용하고, 만든 뒤에도 바꿀 수 있다
- 지원 범위를 적었다 — 앱은 **React Native (Expo)** 하나(스킬의 Metro·dev client·빌드 캐시가 이것을 전제로 한다), 에이전트는 Claude Code·Copilot CLI·Codex·Cursor·Gemini CLI.
- **Simless 제거** — 설정 창의 «Simless 제거» 와 `simless uninstall` 이 스킬(모든 위치)·훅·규칙·MCP·앱·서버 등록을 한 번에 지운다. `--purge`(창에서는 체크)로 데이터·기록·로그·빌드 캐시까지

### 바뀜

- 에이전트에게 보이는 출력(`status`·`who`·`history`·대기 알림)에서 다른 세션의 작업 폴더는 마지막 폴더 이름만 보인다 — 출력이 AI 제공사로 넘어가므로
- 설정 파일·로그 폴더를 나만 읽게(`0600`·`0700`), 웹 토큰은 일정 시간 비교, 앱 창은 이 앱의 화면 밖으로 이동하지 않는다
- 버전 표기를 옆 막대의 «서버 연결됨» 밑과 설정 맨 위 «버전 정보» 로 옮겼다
- 메뉴바 메뉴를 줄였다 — 켜진 디바이스 목록을 빼고(대시보드에서 본다), «설정 열기» 는 아이콘 없이 글자만

### 고침

- simslim·avdslim 을 직접 쓰거나 다른 도구로 슬림한 기기가 목록에서 슬림이 아닌 것처럼 보이던 것 — 켜진 기기는 모두 15초마다 슬림 상태를 읽어 `SLIM` 으로 보이고, 꺼진 뒤에는 마지막으로 본 값을 «마지막 확인» 시각과 함께 흐리게 보여 준다(앱 창·`simless list`·MCP). 다시 적용은 Simless 가 한 슬림만
- 스킬 — Android 안내 두 가지가 틀렸던 것(Expo CLI 코드로 확인): `expo start --android` 는 `ANDROID_SERIAL` 을 무시하고 첫 기기에 열고 모든 에뮬레이터에 `adb reverse` 를 걸므로, 켜진 에뮬레이터가 내 것 하나일 때만 쓴다. `expo run:android --device` 는 시리얼이 아니라 AVD 이름(`simless list` 의 `native`). Android 빌드도 iOS 처럼 `--port` 로 자기 Metro 를 다시 쓰고 127.0.0.1 로 연다
- 스킬 — iOS 빌드·첫 실행이 오래 걸리던 것: `expo run:ios` 는 `--port <포트>` 로 이미 띄운 자기 Metro 를 다시 쓰고 `REACT_NATIVE_PACKAGER_HOSTNAME=127.0.0.1` 로 자기 포트에서 열게(`--no-bundler` 는 LAN IP :8081 — 다른 세션의 Metro 로 열려 금지), 빌드하는 동안 매니페스트의 번들 주소로 첫 번들을 미리 만들고, 고정 sleep 대신 Metro 로그의 «iOS Bundled» 를 기다린다
- 스킬 Android 보충(실제 세션에서 겪은 것) — Expo 는 `ANDROID_SERIAL` 로 고정한 `expo start --android` 로 연결·실행, 연결은 앱의 Dev 메뉴 «Connected to» 로 확인, 딥링크가 앱을 재기동하면 기본 서버로 돌아감, `adb reverse` 가 사라지는 때, `simless use` 는 따로 호출, 점유가 쉬는 사이 풀렸을 때, argent 제스처·iOS 샌드박스·`logicalDeviceId` 문제 해결, `--json` 을 jq 로 읽을 때 stderr 버리기, 스크린샷이 검게 나오면(캡처 차단) `describe` 로
- 앱이 다른 세션의 Metro 에 붙거나 Metro 를 못 찾던 것 — 스킬이 argent 의 «8081 Metro 하나» 안내 대신 IPv4 로 자기 포트에 띄우고, 준비를 기다리고, Android 는 자기 포트와 8081 을 모두 내 Metro 로, 앱은 포트를 넣은 주소로 실행하고 붙었는지 확인하게 했다. dev client 스킴은 slug 로 만들지 않고 앱이 등록한 것(`exp+…`)을 찾는다(Android 가 dev client 첫 화면에서 멈추던 것). 전역 규칙에도 한 줄
- 서버를 다시 켜도 열린 앱 창이 옛 화면을 보이던 것
- 보호(훅)가 파일에 쓰는 스크립트·커밋 메시지 같은 heredoc 본문에 기기 이름과 `adb` 가 같이 있으면 막던 것 — 셸·인터프리터로 들어가는 본문은 그대로 본다

## [0.1.0] — 2026-10-05

### 추가

- 시뮬레이터·에뮬레이터를 여러 AI 에이전트 세션과 사람이 나눠 쓰게 하는 상주 서버 + `simless` CLI + `Simless.app`(메뉴바·앱 창) + MCP(`simless mcp`) + 에이전트 스킬
- 디바이스 만들기 — iOS 기기 종류 × 런타임, Android 대표 프로필·직접 입력 × 시스템 이미지. UI 테스트용 **슬림**(simslim·avdslim)을 기본으로, 슬림 전후 메모리 비교, 풀리면 켤 때 다시 적용
- Simless 목록 — 만든 것과 이 Mac 에서 추가한 것만 관리·점유. 이름 바꾸기·목록에서 빼기·삭제(만든 것만)
- **그룹**(용도별 기기 묶음)과 플랫폼마다 **기본 디바이스**. 기본 디바이스를 달라는데 기기가 없으면 만들어서 빌려준다(`--create`)
- 점유·대기열 — 전부 아니면 아무것도 / 비어 있는 것부터, 차례대로 기다리기, 교착은 미리 거절, 세션이 끝나거나 오래 안 쓰면 자동 해제
- 세션 화면과 점유 기록(SQLite, 90일 보관)
- **보호**(선택) — 점유하지 않은 세션이 argent·adb·simctl 로 기기를 건드리면 실행 직전에 막는 훅과 규칙. Claude Code·Copilot CLI·Codex·Cursor·Gemini CLI
- **첫 실행 설정 창** «Simless 시작하기» — 이 Mac 점검(빠진 도구는 창에서 바로 설치·업데이트, 출력을 실시간으로) → 에이전트 연결(스킬·보호·MCP) → 기본 디바이스
- 스킬 설치 범위(전역 기본, 프로젝트 선택)와 스킬 업데이트 알림(대시보드 띠·메뉴바)
- 한국어·영어(설정에서 선택), `simless doctor` 점검, 에이전트용 도움말(JSON·종료 코드·오류 코드·예)
- **네이티브 빌드 캐시**(`simless app`) — Expo 앱의 시뮬레이터·에뮬레이터용 빌드를 네이티브 지문으로 보관하고, 지문이 같으면 빌드 없이 점유한 기기에 설치한다. DerivedData 를 지워도 남고, 앱 저장소는 고치지 않는다

