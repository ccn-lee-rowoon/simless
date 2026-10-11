# 인계 — Simless (시뮬레이터·에뮬레이터 중개·관리 도구)

> 2026-10-01~02 에 처음 정리한 내용. 이 폴더에서 새 세션을 시작할 때 **이 파일과 `requirements.md` 를 먼저 읽는다.**

## 이 폴더

| 파일 | 내용 |
| --- | --- |
| `requirements.md` | 요구사항 정본 (기능 R · 앱 화면 M · 스킬 S · 보호 P · 미결정 Q · **결정 기록**) |
| `reference-design-draft.md` | 요구사항 정리 **전** 첫 설계 초안 — **확정 아님, 참고용**. `requirements.md` 와 충돌하면 그쪽이 이긴다 |
| `HANDOFF.md` | 이 파일 — 배경, 실측으로 확인한 사실, 지금 머신 상태, 시작 프롬프트 |
| `docs/design.md` | 설계안 — 저장소 구조·기술 선택·점유·훅·CLI·단계 (**v0.3**) |
| `SECURITY.md` | 보안 — 지키는 것·지키지 않는 것·고칠 때 지킬 규칙·알려진 약한 점 |
| `AGENTS.md` | 작업 규칙 정본 — 읽는 순서, 작업마다 확인할 것, 문서 규칙, **커밋 규칙** (`CLAUDE.md` 는 이것을 불러온다) |

## 진행 상태

- 요구사항 정리 **완료**. 설계 전에 정할 것은 없다 (남은 Q 는 만들면서 정해도 됨)
- 설계안 v0.2 작성(`docs/design.md`)
- **0단계(저장소 뼈대) 완료** — `bun link` 로 `simless` 등록됨(`~/.bun/bin/simless` → 이 저장소). 다음은 1단계(서버 + CLI 코어), 세션 구분은 에이전트 무관(프로세스 트리) — 에이전트별 실측 항목은 `docs/design.md` §17
- **1단계(서버 + CLI 코어) 완료** — `simless serve`·`install`·`status`·`catalog`·`create`·`list`·`use`·`up`·`down`·`acquire`·`release`·`who` 등. 실제 Android·iOS 디바이스로 만들기·켜기·점유를 확인하고 시험 디바이스는 지웠다. 남은 확인(에이전트별 프로세스 트리)은 `docs/design.md` §17
- **2단계(doctor + 스킬) 완료** — 앱 설치·실행·딥링크는 argent 로 하기로 하고 Simless 일괄 기능은 «나중에»(L1~L3). 스킬은 `~/.claude/skills/simless` 에 설치됨. 남은 확인: 실제 Expo 앱으로 «심리스로 확인해 줘» 처음부터 끝까지
- **3단계(웹 UI + `Simless.app`) 완료** — 순서를 앞당겼다(훅은 4단계로). 웹 UI(`simless ui`·메뉴바 «대시보드 열기»): 만든 디바이스 목록(All·Android·iOS 탭), 생성(+)은 iOS 시뮬레이터·Android 대표 프로필·직접 입력, 같은 크기 여러 대 허용(이름만 안 겹치게), 슬림 수치와 슬림 전후 비교(만들 때 기준값 측정). `Simless.app` 은 메뉴바 앱(지금 아이콘은 폰에 눈·입을 살짝 넣은 모양 — M12)
- **2026-10-05 사양 변경** — 레이아웃 확인 전용 → 이 Mac 의 디바이스 전부를 중개(R20). 용도별 **그룹**·**기본 디바이스**(Android·iOS 1대씩)·디바이스 메모, 만들 때 슬림 선택(슬림만 `simless` 접두사), 그룹 점유는 에이전트가 판단(R23), «사용 안 함» 제거, 슬림은 자동 재적용 + `SLIM` 배지, 화면은 `Simless.app` 창(WKWebView), 귀엽지 않은 디자인, 한국어·영어(설정에서 선택). 이름 변경은 나중에(Q17 — SimPool 은 bitomule/simpool 과 겹침 → 같은 날 Simless 로 정함)
- **4단계(사양 변경) 완료** — Simless 목록(만든 것 + 이 Mac 에서 추가한 것, 레지스트리 v2 — Simless 가 붙인 정보만, v1 은 읽어서 옮기고 처음 만든 것을 기본으로), 왼쪽 메뉴(디바이스·그룹·세션 — 세션은 점유·대기와 기록), 설정은 새 창, 기종 + OS 생성·슬림 선택·ⓘ, 그룹·기본 디바이스·메모, 그룹 점유(all·available·대기·교착 검사), 한국어·영어(설정), 새 화면(디바이스·그룹·설정), `Simless.app` 창(WKWebView)·새 아이콘, 영어 스킬. 실제 서버에 적용해 확인함(기존 `bakw`·`8rav` 가 그대로 기본 디바이스로)
- **5단계(보호) 완료** — `simless hook <에이전트> …`(simless 목록 디바이스를 점유하지 않은 argent·adb·simctl 호출을 막음, 서버가 꺼지면 managed-index 로 막음), 규칙 `~/.claude/rules/simless.md`. **이 Mac 의 Claude Code 에는 켜져 있다**(2026-10-05 20:16 첫 실행 설정 창에서 켠 것으로 보이고, 이름 변경 때 새 이름으로 옮김 — 사용자 확인 대기). 다른 세션이 Simless 없이 쓰는 iPhone 17 Pro(`zx7w`)가 목록·iOS 기본이라 그 세션이 막힐 수 있다
- **6단계(MCP) 완료** — `simless mcp`. 이 Mac 의 Claude Code 에 사용자 범위로 등록돼 있다(보호와 같이 확인 대기)
- **첫 실행 설정 창(M14) 완료** (2026-10-05) — 앱을 처음 열면 «Simless 시작하기» 창: 이 Mac 점검 → 에이전트 연결(스킬·보호·MCP 를 버튼으로) → 기본 디바이스. 서버 `setup.*`, 끝내면 `…/simless/setup.json`. 이 Mac 에서는 아직 «완료» 안 누름(창이 열려 있음)
- **2026-10-05 이름 변경** — Corgi → **Simless**(simulator + seamless, «Make simulator management seamless.»). 이 Mac 은 `simless install` 로 옮김: 예전 서버·메뉴바·앱 내림, 데이터 폴더 `~/Library/Application Support/simless`·`~/.config/simless`·`~/Library/Logs/simless` 로 이동, 스킬·규칙·훅·MCP 를 새 이름으로. 예전 상태 백업은 세션 스크래치패드에만 있었다. 저장소 폴더는 2026-10-06 `…/corgi` → `…/simless` 로 바꿨다(서버 등록·`bun link`·Claude Code 훅·MCP 를 새 경로로 다시 설치)
- **2026-10-05 추가** — 점유 기록 SQLite(90일 보관), 스킬: 모바일 앱 작업에서만 반응·세션마다 자기 Metro(S11)·설치 범위(기본 전역, 프로젝트 선택 — `simless skill`)·업데이트 알림(대시보드 띠·메뉴바), 기본 디바이스가 없으면 만들어서 빌려주기(`--create`)
- **다른 에이전트 연결 구현** (2026-10-05) — Copilot CLI·Codex·Cursor·Gemini CLI: 세션 ID 로 세션 묶기, 훅 어댑터, 보호·MCP 설치(설정 창 «다른 에이전트», `simless install --agents`), 스킬은 `~/.agents/skills` 에도. **실제 에이전트로는 아직 확인 안 함** — 첫 실행 설정에 «실험적» 으로 표시(2026-10-08). 이 Mac 에는 지금 네 에이전트 모두 보호·MCP 가 켜져 있다(2026-10-09 확인 — MCP(Codex·Cursor·Copilot)는 그 전부터, 네 에이전트의 훅과 Gemini MCP 는 2026-10-08 22:43 부터. 아래 «지금 머신»). 조사는 `docs/agent-integrations.md`
- **2026-10-05~06 추가** — 네이티브 빌드 캐시(`simless app install·save·list·prune`, R26 — 앱의 `@expo/fingerprint` 로 지문, `~/Library/Caches/Simless/builds`, 실제 Expo 앱의 Android APK 로 보관·목록 확인, 캐시에서 실제 기기로 설치는 아직), `SECURITY.md`, 제거(`simless uninstall [--purge]`·설정 창 «Simless 제거», S12 — 이 Mac 에서 실제로 지워 보지는 않음), 버전 표기(옆 막대 «서버 연결됨» 밑·설정 맨 위 «버전 정보»), 서버를 다시 켜면 앱 창이 새 화면을 받게. 버전은 0.1.0 그대로(태그 `v0.1.0` 은 빌드 캐시 커밋, 그 뒤는 CHANGELOG «아직 내지 않은 것»)
- **2026-10-06 추가** — 보호 훅 heredoc 오탐 고침, 보안 약한 점 넷 정리(다른 세션 작업 폴더 감추기·토큰 비교·파일 권한·앱 창 이동 제한), 요구사항 «확인» 칸 + `test/requirements.test.ts`(테스트여야 하는 48개 모두 테스트 있음), 점검(`runChecks`)을 가짜 명령으로 테스트, 기존 기기 이름 `simless …` 로, **Metro 연결 순서를 스킬에**(argent 의 «8081 하나» 덮어쓰기, IPv4, 준비 대기, Android `reverse` 내 포트+8081, dev client 스킴은 앱이 등록한 것, Expo+Android 한 대는 `ANDROID_SERIAL` 고정 `expo start --android`, 연결은 앱에서 확인 — 다른 세션의 실측 보충안 반영. 스킬은 특정 앱에 묶지 않는다), 메뉴바 메뉴 줄이기(켜진 디바이스 빼고 «설정 열기» 글자만 — 아이콘이 사라졌는지 사용자 확인 대기)
- **2026-10-07 추가** — ① Simless 밖에서 슬림한 기기도 목록에 `SLIM`(켜진 기기는 모두 15초마다 읽고 `slimSeen` 에 기억, 꺼진 기기는 마지막으로 본 값을 흐리게 — M6, PR #8) ② **슬림 항목 고르기**(M15, PR #9) — 슬림 안 함·전체(UI 확인용)·커스텀(남길 항목), 기기마다 `slimKeep` 기억, 생성 화면 세 카드·⋯ «슬림 설정…»·`create --slim-keep`·`slim --keep|--full`·MCP `simless_slim`. 생성 창은 번호 붙은 4단계로 ③ **스킬 폴더 설치**(PR #10) — «앱에 필요한 기능 찾기» 참고 파일(`reference/app-*.md`)을 agent-skills 저장소(device-slim-v0.1.0)에서 의존성으로 가져와 함께 설치 ④ **슬림 내역**(M16·S13, PR #11·#14) — 켜진 기기를 15초마다 확인해 꺼진 항목을 기록(`slimSeen.off`), 목록의 «슬림» 칸 `SLIM ↗` → «슬림 내역» 창, `slimOff`. 스킬은 레이아웃 확인이면 아무 기기나, 기능 테스트면 필요한 항목이 켜진 기기를 고름(서버가 거르는 `--needs` 는 두지 않음) ⑤ 사양 문서 정리(PR #13) ⑥ 시작 애니메이션(M17, PR #15·#17) — 앱을 켜고 대시보드를 처음 열 때 «Simulator + Seamless → Simless», 끄는 설정 없음 ⑦ 아이콘 통일·흰 테두리 제거(PR #16) ⑧ 시각 표시 — 오늘·어제·날짜(R25, PR #18) ⑨ macOS 알림(M18, PR #19) — 서버 꺼짐·스킬 업데이트만 ⑩ Android 기종을 Android Studio 기기 정의에서 전부(M1, PR #20 — 이 Mac 8 → 67개). 범용 슬림 스킬 `device-slim` 은 별도 비공개 저장소 `agent-skills`(주소는 `package.json`)
- **2026-10-08 추가** — 스킬 구조를 Anthropic 가이드에 맞춤(PR #23·#26), 시작 애니메이션 끄기 설정 뺌(#24), 스킬 참고 파일 device-slim 0.4.0(#28), **0.2.0 냄**(#27). **설치 파일 하나로 설치·업데이트**(R19, PR #29) — `bun run build`·`release` 가 `dist/simless-<버전>-install.sh`(약 33MB)를 만들고, 팀원은 어디서든 `bash <파일>`(서명 없이도 Gatekeeper 에 안 막힘 — 확인). `install` 이 자기를 `~/.local/share/simless/versions/<버전>/` 에 넣고 `~/.local/bin/simless` 링크를 서버·훅·MCP 에 적음, `simless update <파일>`·`--rollback`. 이 Mac 은 설치 파일 방식으로 한 번 다시 설치해 확인한 뒤(설치·Gatekeeper·설치 파일 지워도 동작), **개발 방식(`bun link`)으로 되돌렸다**(아래 «지금 머신»). Claude Code 의 설치·업데이트 구조와 앞으로 적용할 것은 `docs/design.md` §19, 정할 것은 Q18(버전 폴더 vs 덮어쓰기)·Q19(새 버전 확인 주소)
- **2026-10-08~09 추가** — 이 Mac 을 설치 파일 방식에서 **개발 방식(`bun link`)으로 되돌림**. `install` 이 `--hook`·`--mcp` 때 고르지 않은 에이전트의 예전 경로를 안 고치던 것·한 에이전트 실패로 설치가 멈추던 것 고침(PR #32), 첫 실행 설정의 읽는 중·누른 버튼 도는 원과 다른 에이전트 «실험적» 표시(#33), CLI 로고(`install` 을 터미널에서 실행할 때, #34), **0.3.0 냄**(#35 — 릴리스 날짜를 UTC 대신 이 Mac 날짜로, `dist/simless-0.3.0-install.sh`), 권장·선택·실험적 표시 색 구분(#36). 모르는 것: 2026-10-08 22:43 에 Codex·Cursor·Copilot·Gemini 훅과 Gemini MCP 가 생긴 이유(제거 코드는 정상, 이 세션의 명령도 아님 — 첫 실행 설정에서 켰을 가능성)
- **2026-10-09 device-slim 쪽 변경 반영** — simslim 0.12.0(이 Mac 설치본)에서 Game Center 가 늘 켜짐을 확인해 스킬 표를 고침, 스킬이 `.device-slim.json` 저장 여부를 기능 확인과 같은 질문에서 묻게(device-slim #27 과 맞춤 — 그쪽은 아직 머지·버전 전, 0.5.0 이 나오면 `package.json` 의 `agent-skills` 태그를 올린다), M15 결정 기록의 `--keep` 이유를 고침
- **2026-10-11 device-slim 0.7.0 반영** (브랜치 `feat/remove-rename` → `feat/device-slim-0.7.0`, 아직 푸시·PR 전) — ① 이름 변경 기능 뺌(⋯ «이름 변경»·`simless rename`·`device.rename` — 사용자 결정, 다른 도구가 이름으로 찾음) ② 참고 파일 device-slim 0.7.0, 스킬 폴더 `reference/` → `references/`(예전 폴더는 설치 때 지움), `find-features-*.md`, «어느 앱 폴더를 읽을지» ③ iOS 남길 항목 변경은 `simslim on` 한 번 ④ Android 추천 이미지 `google_apis` 먼저 ⑤ Android 끄기 전 `sync` + 슬림 변경 20초 안이면 대기 ⑥ 슬림 방식 이름 **UI·App·Custom**(화면·CLI·MCP·스킬, 기기마다 `slimMode`, `--app`). 시험 서버(임시 HOME·가짜 AVD)로 슬림 설정·생성 창을 확인했다. 실제 기기로는 확인 안 함(iOS `on` 한 번 변경·Android sync 대기). agent-skills 의 0.7.0 뒤 «아직 내지 않은 것»(`-lowram`·`-memory` 등)은 다음 태그 때
- 남은 것: 새 버전 자동 확인(R27 — 주소가 정해지면), 제거가 설치 파일 설치본(링크·버전 폴더)을 지우게 고치기(S12, `docs/design.md` §19), 실제 서버를 낀 업데이트·되돌리기 확인(다음 버전 설치 파일로), 다른 에이전트 실측, 실제 앱으로 주 흐름(R15)을 세션 둘로 끝까지, 차별점 후보(그룹 안 역할·결과 나란히 보기 R10·그룹에 앱·화면 정보), 병렬 개발용 «빈 기기 아무거나» 요청
- **하던 중**: 점유할 때 스킬이 오래됐으면 **사용자에게 물어보게** 하기(자동 업데이트는 안 됨 — 사용자 결정 2026-10-06). 오래된 스킬에는 이 안내가 없으므로 `simless use` 결과 메시지에 «무엇을 묻고, 원하면 `simless skill install` 뒤 스킬을 다시 읽기» 를 다 담는다. 코드는 아직 안 바꿈
- 제안만 하고 사용자 결정 대기: `simless metro`(2단계 — 스킬로 안 풀리면: 반납 때 `adb reverse` 자동 정리·`simless metro check`, 그다음 Metro 를 Simless 가 띄우기), 훅이 `simless use … && adb …` 한 줄을 막는 것(지금은 스킬이 따로 부르라고 안내 — 훅이 같은 명령의 `simless use` 를 알아보게 고칠지), `SECURITY.md` §5 남은 약한 점(argent 버전 고정 — 어느 버전으로 할지), iOS 기본 디바이스(`zx7w`, 다른 세션이 Simless 없이 쓰는 iPhone 17 Pro)를 바꿀지
- 남은 확인: Android 실기기 커스텀 슬림(`avdslim enable <패키지|설정>` 순서 — 테스트 코드로만), ⋯ «슬림 설정…» 창을 실제 기기로, 실제 기기로 그룹 점유·생성(기종 + OS)을 끝까지, 라이트 모드 화면, simslim 0.11.0 에서 슬림 적용·확인(정보 읽기는 확인함), 설정 창 바로 설치 중 avdslim·argent(simslim 업데이트는 됨), 웹 화면 자동 테스트 없음(`bun run trace --missing`)
- 구조 확정: TypeScript(Bun) 상주 서버 + CLI + 웹 UI + 메뉴바 앱(Swift, 설치 때 컴파일), 단일 실행 파일 배포(개발은 `bun link`), `Simless.app` 은 설치 때 그 Mac 에서 생성 — 이유는 `requirements.md` «결정 기록»
- 범용 도구 → 특정 앱 저장소에 넣지 않고 별도 프로젝트로 만든다

## 실측으로 확인한 사실 (이 머신)

**환경**
- Apple M4 Pro · 메모리 48GB. iOS 시뮬레이터 2대만 켜도 약 19GB 사용(가장 무거움). Android 에뮬레이터는 대당 약 1GB
- Android SDK `~/Library/Android/sdk` — `emulator`·`adb` 있음, **cmdline-tools(`avdmanager`) 없음**
- 시스템 이미지: `android-37.1/google_apis_playstore_ps16k/arm64-v8a`, `android-36/google_apis_playstore`
- iOS 런타임: 18.6 · 26.0 · 26.2 · 26.5
- 설치됨: simslim **0.11.0**(2026-10-05 설정 창에서 업데이트) · scrcpy 4.1 · Bun · argent 0.17.0(`/opt/homebrew/bin`)·mise 의 node 마다 0.25.1·0.27.0(2026-10-07 확인) 여러 벌 — `simless doctor` 주의 1개
- **avdslim 1.0.15 설치됨** (2026-10-02) — `brew install kdbhalala/avdslim/avdslim` 가 `brew trust` 없이 설치됐다(전에는 비공식 tap 이라 거부한다고 봤음 — brew 버전에 따라 다를 수 있어 `simless doctor` 는 둘 다 안내)
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
- simslim 0.11.0 커스텀 슬림 (2026-10-07, 시험 기기 `simless_keeptest` 로 확인 후 지움): `on --except store,web` → 170 중 146 꺼짐, `verify --except store,web` 통과·`verify`(전체) 실패. `--except photos` 로 바꿀 때 `off` 뒤 `on` → 162 꺼짐, 전에 남긴 `store`·`web` 도 다시 꺼짐. 한 번에 1분 남짓
- simslim·avdslim 의 슬림 상태는 **켜진 기기에서만** 읽힌다(simslim `list`·`status`·`verify`, avdslim 은 `pm list packages -d`). 슬림을 걸고 푸는 것도 켜져 있어야 하므로 꺼진 동안에는 바뀌지 않는다(꺼진 채 초기화한 경우 빼고)

**`wm size/density` 를 안 쓰는 이유 (실측)**
- `resizeableActivity="false"` + 세로 고정인 앱은 실행 중 바꾸면 호환 모드(«Tap to restart this app») 로 떨어지고 앱을 재시작해야 반영된다
- 바꾼 값은 재부팅해도 남는다(`wm … reset` 전까지)

**화면 확인 관련**
- `FLAG_SECURE` 가 켜진 화면이 있는 앱은 scrcpy·녹화 스트림에 검게 나온다. `adb exec-out screencap` 도 막힐 수 있음 — 스크린샷 방식은 앱마다 확인 필요
- scrcpy 4.x 는 3.x 와 스트림 헤더가 달라 3.x 기준 파서는 깨진다. 스트리밍을 만들게 되면 버전 확인

**세션 구분**
- Claude Code 는 Bash 환경에 `CLAUDE_CODE_SESSION_ID` 를 준다 (확인됨)
- PreToolUse 훅은 입력 JSON 에 `session_id` 를 받는다
- 로컬 MCP 프로세스가 세션 ID 를 받는지는 **미확인**

## 지금 머신에 남아 있는 것 (정리 필요)

| 항목 | 상태 | 정리 방법 |
| --- | --- | --- |
| Android 에뮬레이터 | 켜진 것 없음 (2026-10-06 확인) | — |
| AVD 3개 | `~/.android/avd/Size_*.avd` + `.ini` (약 7GB) | 필요 없으면 폴더·ini 삭제 |
| scrcpy 4.1 | brew 설치 | 필요 없으면 `brew uninstall scrcpy` |
| brew tap · avdslim | `kdbhalala/avdslim` tap + avdslim 1.0.15 설치됨 | Simless 가 쓰므로 유지 |
| Simless launchd 등록 | `~/Library/LaunchAgents/simless.server.plist` — 개발 방식: bun + 저장소의 `bin/simless.ts serve` (2026-10-08 설치 파일 방식에서 되돌림) | 유지. 지우려면 `simless uninstall` |
| `simless` 명령 | `~/.bun/bin/simless` (`bun link` — 이 저장소를 가리킨다). 설치 파일 설치본(`~/.local/bin/simless`·`~/.local/share/simless`)은 2026-10-08 지웠다 | 유지 |
| Simless.app (메뉴바 앱 + 앱 창) | `~/Applications/Simless.app` + 로그인 항목 `~/Library/LaunchAgents/simless.menubar.plist` | 유지. 지우려면 `simless uninstall`. Swift 를 고치면 `simless install --no-launchd --no-skill` |
| Simless 디바이스 | `bakw`(Android 360dp, Android 기본)·`rddv`(Android 태블릿 800dp)·`8rav`(iPhone SE) — 2026-10-06 이름 앞머리를 예전 이름에서 `simless …` 로 바꿈. Android AVD ID(`corgi_` 로 시작)는 AVD 폴더 이름이라 그대로 둔다(Simless 는 ID 로 기억하므로 동작에는 상관없음). iOS 기본은 `zx7w`(iPhone 17 Pro, 다른 세션이 씀) | 사용자가 만든 것 — 필요 없으면 화면에서 삭제(기본은 다른 기기를 기본으로 정한 뒤) |
| Simless 스킬 | `~/.claude/skills/simless/`·`~/.agents/skills/simless/` (전역, 폴더째 — `SKILL.md` + `references/*.md`, 2026-10-11 전 설치본은 `reference/`) | 유지. 스킬을 고치면 `simless skill install` |
| 에이전트 연결 | 보호(훅): Claude Code(+규칙)·Codex·Cursor·Copilot·Gemini. MCP: Claude Code·Codex·Cursor·Copilot·Gemini. 모두 개발 명령(bun + `bin/simless.ts`)을 가리킨다(2026-10-08 다시 맞춤) | 유지 — 바꾸려면 설정 창 «에이전트 연결» |
| 옛 폴더 링크 | 저장소 옆의 `corgi` → `simless` (2026-10-06 폴더 이름을 바꾼 세션이 쓰던 임시 링크) | 그 세션이 끝나면 그 링크를 지운다 |
| 빌드 캐시 | `~/Library/Caches/Simless/builds` (아직 없음 — `simless app save` 가 만든다) | `simless app prune`, 제거 때 `--purge` |
| avdslim | brew 1.0.15 | 유지 |
| 기존 `Pixel_6a` AVD·기존 iOS 시뮬레이터 | 2026-10-06 `avdslim tune-avd --help` 가 `Pixel_6a` 의 `config.ini` 를 바꾸고 스냅샷을 지움 → `config.ini.bak` 값으로 되돌림(디스크 16G 는 원래 값). 다음 부팅은 콜드 부팅일 수 있다 | — |
| 시험 앱 | 위 3대 AVD 에 설치됨 | AVD 삭제 시 함께 사라짐 |

## 새 세션 시작 프롬프트

저장소 폴더에서:

```
AGENTS.md 를 먼저 읽고, 거기 적힌 순서대로 HANDOFF.md·requirements.md(«결정 기록» 포함)·SECURITY.md 를 봐줘.
HANDOFF.md «진행 상태» 의 «남은 것»·«제안만 하고 사용자 결정 대기» 에서 이어서 하자.
```
