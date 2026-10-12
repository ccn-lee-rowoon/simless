# 개발 가이드

simless 를 고치는 사람(사람·에이전트)이 «무엇을 바꾸려면 어디를 고치나» 를 바로 찾게 하는 문서다.
요구사항은 `requirements.md`, 설계는 `docs/design.md`(저장소 구조는 §3), 메시지는 `docs/protocol.md`,
작업·커밋 규칙은 `AGENTS.md` 가 정본이다(`CLAUDE.md` 는 그것을 불러온다).

## 1. 준비와 매일 쓰는 명령

처음 한 번: `mise install`(Bun 1.3.6) → `bun install` → `bun link`(`simless` 가 이 저장소를 가리킨다). `bun install` 은 비공개 저장소 `agent-skills`(주소는 `package.json`)를 SSH 로 받는다 — GitHub SSH 키가 있어야 한다(`ssh -T git@github.com` 로 확인).

| 명령 | 하는 일 |
| --- | --- |
| `bun run check` | Biome(린트·포맷) + `tsc --noEmit` — 커밋 전에 반드시 |
| `bun run test` | 모든 테스트. 한 파일만: `bun test test/leases.test.ts` |
| `bun run test:watch` | 고칠 때마다 다시 |
| `bun run trace` | 요구사항 ID 마다 확인 방법·테스트·코드에서 몇 번 가리키나, 끝에 확인 방법별 수. `--missing` 은 확인이 `테스트` 인데 테스트가 없는 것만 |
| `bun run format` | 포맷·import 정리를 고쳐 쓴다 |
| `bun run build` | `dist/simless` 단일 실행 파일과 팀원에게 줄 설치 파일 `dist/simless-<버전>-install.sh` — 진입점·묶음 파일(`with { type: "file" }`)·설치 흐름을 바꿨을 때 |

커밋마다 `check`·`test` 가 통과해야 한다. 종료 코드로 확인한다 — 출력을 `grep` 에 넘기면 실패해도 성공으로 보일 수 있다.

## 2. 큰 그림

```
에이전트 ─ CLI·MCP·훅 ─┐            ┌─ 드라이버 ─ simctl·emulator·adb·simslim·avdslim
                      ├─ 소켓 ─ 서버 ┤
사람 ─ Simless.app·웹 ───┘   (HTTP)    └─ 상태 파일 ─ registry·leases(JSON), history(SQLite)
```

- **상태는 서버 하나만** 갖는다. CLI·MCP·훅·웹·메뉴바는 요청을 보내는 창구다.
- 서버 메서드는 `src/server/*.ts` 의 `registerXMethods(server)` 가 `server.addMethod(이름, 함수)` 로 붙인다.
- 폴더 사이 import 규칙은 설계 §3 표, `test/architecture.test.ts` 가 지킨다.
- 네이티브 빌드 캐시(`src/builds/`, R26)는 CLI 쪽이다 — 지문을 호출한 셸의 환경으로 계산해야 해서. 기기에 설치만 서버(`device.install`)가 한다.

## 3. 자주 하는 변경

### 서버 메서드 하나 더하기

1. 매개변수·결과 모양 — 결과 타입은 `src/shared/api.ts`, 매개변수는 그 메서드 파일의 zod 스키마 + `parse()`(`server/params.ts`)
2. 등록 — 알맞은 `server/*.ts` 의 `registerXMethods` 안에서 `server.addMethod("묶음.이름", …)`. 새 묶음이면 파일을 만들고 `app.ts` 생성자에서 부른다
3. 읽기만 하면 `app.ts` 의 `READ_ONLY` 에 — 아니면 끝날 때 화면에 «바뀜» 을 알린다
4. 웹 화면이 부르면 `server/http.ts` 의 `WEB_METHODS` 에
5. 오류는 `HandlerError(코드, t("err.…"), data)` — 에이전트는 코드로 판단한다
6. `docs/protocol.md` «메서드» 표에 한 줄
7. 쓰는 쪽 — CLI(`src/cli/commands/*.ts`), MCP 도구(`src/mcp/index.ts`, 에이전트가 쓸 때만), 웹(`call("…")`)
8. 테스트 — `testServers()` 로 서버를 띄워 시나리오로(§4)

### 오류 코드 하나 더하기

`src/shared/protocol.ts` 의 `ErrorCode` → `docs/protocol.md` «오류 코드» 표(종료 코드 포함) → CLI 종료 코드가 다르면 `src/cli/context.ts` → 스킬이 판단해야 하면 `integrations/skill/simless/SKILL.md`.

### 설정 하나 더하기

`src/shared/config.ts`(`Config` 기본값·`SettingsPatch`·`saveSettings`) → `src/server/settings.ts`(`SettingsParams`·읽기·반영) → `SettingsResult`(`shared/api.ts`) → 설정 창(`web/SettingsView.tsx`) → `simless config` 키(`cli/commands/config.ts`) → 문구(i18n) → `docs/protocol.md` 의 `settings.*`. 테스트는 `test/i18n.test.ts` 의 설정 테스트를 본뜬다.

### 문구 하나 더하기 (i18n, R25)

- 키는 `src/shared/i18n/ko.ts` 가 정본이다. `en.ts`·`ja.ts` 는 `Record<keyof typeof ko, string>` 이라 빠뜨리면 타입 오류가 난다. 자리 표시자(`{name}`)도 같아야 한다(`test/i18n.test.ts`).
- 키 이름은 `묶음.뜻` — `err.*`(오류) · `cli.*` · `web.*` · `doctor.*` · `hint.*` · `setup.*` …
- 메뉴바(Swift)는 따로 작은 사전(`tray/SimlessTray.swift` 의 `Strings` — 한 줄에 한국어·영어·일본어)이 있다.
- 스킬·규칙은 영어로 쓴다(읽는 쪽이 에이전트).

### 웹 화면·창 하나 더하기

- 화면 — `src/web/*View.tsx`, 공용 조각은 `ui.tsx`·`icons.tsx`, 스타일은 `styles.css`(색은 `:root` 변수 — 라이트·다크 둘 다)
- 새 창 — `main.tsx` 의 `?window=…` 분기 + `bridge.ts` 의 `AppMessage` + Swift `AppController`(`makeAuxWindow` 로 창, `userContentController` 에서 메시지 받기). 브라우저에서는 `window.open` 으로 대신한다
- 웹이 부르는 메서드는 `WEB_METHODS` 에 넣어야 한다(403)

### 드라이버 바꾸기 (Android·iOS)

`src/server/drivers/types.ts` 의 `Driver` 가 계약이다. 메서드를 더하면 `test/helpers.ts` 의 `fakeDriver` 도 같이 고친다. 외부 명령은 `runner` 로 받아서 테스트가 가짜 명령으로 바꾼다(`test/*-driver.test.ts`).

### 스킬·규칙 고치기

- `integrations/skill/simless/SKILL.md`·`integrations/rules/simless.md` — 커밋 type 은 `docs`
- 요구사항(S1~S12)을 담은 문장은 `test/skill.test.ts` 가 검사한다 — 바꾸면 테스트도 같이
- 이 Mac 에 반영: `simless skill install`(넣어 둔 모든 곳). 서버는 10분마다 예전 스킬을 찾아 앱에 알린다
- 스킬은 폴더째 설치된다 — `SKILL.md` + `references/`. `references/slim.md`·`troubleshooting.md` 는 이 저장소(`integrations/skill/simless/references/`)에서 고친다. 본문에는 흐름만 두고, 필요할 때만 읽는 긴 안내는 참고 파일로 뺀다 — 참고 파일을 더하면 `src/install/skill.ts` 의 `REFERENCES` 에 넣고 SKILL.md 에서 바로 링크한다(참고 파일끼리 링크하지 않는다, `test/skill.test.ts` 가 검사). `references/find-features-*.md`(앱에 필요한 기기 기능 찾기, M15)의 정본은 agent-skills 저장소의 `skills/device-slim/references/` 다. 거기서 고친 것을 가져오려면 agent-skills 에서 `device-slim-vX.Y.Z` 태그를 낸 뒤 `package.json` 의 `agent-skills` 태그를 올리고 `bun install` → 바뀐 파일을 읽어 보고 커밋. **device-slim 을 낼 때마다 함께 올린다** — `find-features-*.md` 가 그대로여도 «simless 는 device-slim 최신을 쓴다» 가 늘 맞게. 파일을 더하거나 빼면 `src/install/skill.ts` 의 `REFERENCES` 와 스킬의 링크도 고친다. 새 태그를 올렸는데 `bun install` 이 «no commit matching» 으로 못 찾으면 Bun 이 저장소를 캐시한 채 태그를 새로 받지 않은 것이다 — `~/.bun/install/cache/` 에서 `remote.origin.url` 이 agent-skills 인 `<hash>.git` 폴더를 찾아 `git -C <그 폴더> fetch --tags origin` 한 뒤 다시 `bun install`.

### 이 Mac 에 설치하는 것 하나 더하기 (S1·S12)

`simless install`·설정 창이 새 파일·설정 항목을 넣게 되면 **지우는 쪽도 같이** 고친다 — `src/install/uninstall.ts`(`removeIntegrations`·`dataDirs`). 안 그러면 `simless uninstall`·«Simless 제거» 뒤에 그것만 남는다. 테스트는 `test/uninstall.test.ts`. 무엇을 어디에 쓰는지는 `SECURITY.md` §3 규칙(정해 둔 위치만, Simless 항목만)을 따른다.

### 다른 에이전트 연결 (Q16)

조사는 `docs/agent-integrations.md`. 붙일 곳: 훅 어댑터(`src/hook/index.ts` 의 `adapters`, 대상 추출 `hook/targets.ts`), 셸에 주는 세션 ID(`src/shared/session.ts` 의 `AGENT_SESSION_ENV`), 설치(`src/install/`), 설정 창 «에이전트 연결»(`web/SetupView.tsx`·`server/setup.ts`).

## 4. 테스트 쓰기

- **서버 시나리오** — 파일 맨 위에서 `const start = testServers();` 한 번, 테스트마다 `const { A, B, H, server, driver } = await start({ seed })`. `A`·`B` 는 에이전트 세션, `H` 는 사람(웹). 결과와 오류(`code`·`message`·`data`)를 같은 값으로 받는다
- **준비 도구**(`test/helpers.ts`) — `tempEnv()` 임시 상태·HOME·짧은 소켓 경로, `fakeDriver()` 아무것도 켜지 않는 드라이버, `seedDevice()` 디바이스 넣기, `session()` 세션 정보
- **점검(`runChecks`, S1·S2)** — `probe: { run, which, env }` 로 가짜 명령·임시 HOME 을 준다(`test/checks.test.ts`). 진짜 `brew`·`xcrun`·`launchctl` 을 부르지 않는다
- **이 Mac 을 건드리지 않는다** — 설치·훅·MCP 를 부르는 테스트는 `deps: (env) => ({ env: { ...env.env, PATH: "" } })` 로 HOME 을 임시 폴더로 한다. **PATH 를 비워도 진짜 명령을 부를 수 있다** — `which()`(`src/shared/exec.ts`)는 PATH 다음에 `/opt/homebrew/bin`·`/usr/local/bin`·`~/.local/bin`·`~/.bun/bin`·`/usr/bin` 도 찾는다. HOME 이 임시 폴더라 진짜 설정은 안전하지만, 명령이 실패하거나 특정하게 동작해야 하는 테스트는 가짜 명령을 만든 폴더를 PATH 에 두거나(`test/self.test.ts` 의 가짜 `codex`) `probe` 로 준다. 실제 기기는 테스트에서 켜지 않는다
- **이름에 요구사항 ID** — `describe("그룹 (R21)")` 처럼. `bun run trace` 가 이걸 세고, requirements.md 에서 확인이 `테스트` 인 요구사항에 테스트가 없거나 없는 ID 를 쓰면 `test/requirements.test.ts` 가 실패한다
- **문서도 검사한다** — 스킬처럼 요구사항을 담은 문서는 꼭 있어야 할 문장을 테스트로(`test/skill.test.ts`)
- **주의** — 같은 프로세스의 소켓 서버를 부르는 promise 에 `expect(…).rejects` 를 쓰지 않는다(Bun 1.3.6 오동작). `.catch((e) => e)` 로 받아 검사한다. `afterEach` 는 helpers.ts 맨 위에 두면 파일마다 걸리지 않는다 — `testServers()` 가 부른 파일에 건다

### 테스트 파일 지도

| 파일 | 다루는 것 | 요구사항 |
| --- | --- | --- |
| `requirements.test.ts` | requirements.md ↔ 테스트 이름이 맞는지 (ID 중복·확인 칸·테스트 없는 요구사항·없는 ID·ID 순서) | 전체 |
| `architecture.test.ts` | 폴더 경계(설계 §3) | — |
| `server.test.ts` | 소켓 서버 — status·점유·BUSY·기다리기·세션 종료 해제·점유 기록 | R13·R14·R17·M13 |
| `leases.test.ts` | LeaseManager 순수 로직 — 대기열·비어 있는 것만·교착·기록·작업 폴더(덜 정확한 값이 덮지 않기, `keepFolder`) | R13·R14·R17·R23·M13 |
| `devices.test.ts` | 만들기·이름(만들 때만, 밖에서 바뀐 이름 따라가기)·슬림·켜기·삭제·추가·빼기, 사람의 켜기·끄기, 슬림 수치·기준값·항목 고르기·내역, 기본 디바이스 만들어 빌려주기 | R1·R3·R4·R5·R20·R22·M1·M3·M4·M6·M8·M10·M15·M16·P1 |
| `groups.test.ts` | 그룹·기본 디바이스·그룹 점유(all·available·대기) | R21·R22·R23·R24 |
| `registry.test.ts` | 레지스트리 저장·옮기기(예전 형식) | R4·R20·R21·R22 |
| `android-driver.test.ts`·`ios-driver.test.ts` | 드라이버 — 가짜 명령으로 만들기·켜기·슬림(남길 항목·꺼진 항목 읽기)·기종 목록(Android Studio 기기 정의) | R1·R2·R4·R5·R7·M1·M4·M6·M10·M15·M16 |
| `measure.test.ts` | 슬림 전후 메모리 비교 문구 | M10 |
| `hook.test.ts` | 훅 대상 뽑기(heredoc 포함)·서버 꺼짐·점유 판정·`simless hook` 출력·훅 입력의 작업 폴더(`cwd`) | P1·P3·P4·P5·P6·P8·P9·M13 |
| `claude-hook.test.ts` | Claude Code 훅·규칙 설치 | P2·P3 |
| `session.test.ts` | 세션 = 에이전트 프로세스·에이전트 세션 ID | R18 |
| `cli.test.ts`·`cli-server.test.ts` | CLI 종료 코드·서버와 주고받기·표 출력·슬림 옵션 | R12·R13·R14·M6·M15 |
| `mcp.test.ts` | MCP 도구(`simless_slim` 포함)·roots 를 주는 클라이언트로 작업 폴더 따라가기 | R12·M13·M15 |
| `mcp-folder.test.ts` | MCP 작업 폴더 — roots 읽기·지원 안 함·실패하면 그만 묻기·퍼센트 인코딩 | M13 |
| `http.test.ts` | 웹 HTTP — 토큰·Host·Origin·웹 메서드 | R11 |
| `security.test.ts` | `SECURITY.md` 의 규칙 — 다른 세션 작업 폴더 감추기·토큰·파일 권한 | — |
| `setup.test.ts` | 첫 실행 설정 창 — 스킬·보호·MCP·스킬 위치·바로 설치, 스킬 지문 | M14·S9·R12·M18 |
| `checks.test.ts` | 점검(`simless doctor`·설정 창) — 가짜 명령으로 | S1·S2 |
| `skill.test.ts` | 스킬 문서에 꼭 있어야 할 문장, 스킬 폴더(참고 파일) 설치 | R16·S3~S13 |
| `uninstall.test.ts` | 제거 — 스킬·보호·데이터, 서버 등록은 가짜로 | S12 |
| `builds.test.ts` | 네이티브 빌드 캐시 — 지문·보관·정리·찾기·설치 | R26 |
| `history.test.ts` | 점유 기록 SQLite·보관 기간 | M13 |
| `i18n.test.ts`·`config.test.ts` | 문구 사전(키·자리 표시자)·설정 | R25·M11 |
| `time.test.ts` | 시각 표시 — 방금·N분 전·오늘·어제·날짜, 초까지, 전체 시각 | R25 |
| `launchd.test.ts`·`app-bundle.test.ts` | 서버 등록 plist·`Simless.app` 만들기·메뉴바 로그인 항목 | R11 |
| `self.test.ts` | 설치한 simless — 버전 폴더·링크·바로 전 버전·오래된 것 정리·PATH 안내, 설치 파일 알아보기 | R19 |

새 파일을 만들면 이 표에 한 줄 더한다.

### 요구사항을 더하거나 바꿀 때

1. `requirements.md` 의 알맞은 표에 **ID 순서대로** 한 줄 — 마지막 칸 «확인» 에 `테스트`·`화면`·`실사용`·`argent`·`미구현`·`—` 중 하나(뜻은 requirements.md «읽는 법»)
2. `테스트` 면 테스트 이름에 그 ID 를 넣는다 — 없으면 `test/requirements.test.ts` 가 실패한다
3. 지울 때는 줄을 지우지 않고 ~~취소선~~ + 확인 `—` — ID 를 다시 쓰지 않는다
4. `bun run trace` 로 확인 방법별 수와 빠진 것을 본다

## 5. 화면 직접 확인

웹 화면은 자동 테스트가 없다 — requirements.md 에서 확인이 `화면` 인 것(M2·M5·M7·M9·M12). 바꾸면 눈으로 확인한다.

1. **시험 서버** — 진짜 서버(8791)·진짜 HOME 을 건드리지 않게 따로 띄운다
   ```sh
   S=<임시 폴더>
   HOME=$S/home SIMLESS_STATE_DIR=$S/state SIMLESS_CONFIG_DIR=$S/config SIMLESS_LOG_DIR=$S/logs \
     SIMLESS_SOCKET=/tmp/simless-ui-test.sock bun bin/simless.ts serve &
   ```
   `$S/config/config.json` 에 `{"httpPort": 8792}` 를 넣어 두면 포트가 겹치지 않는다. 토큰은 `$S/state/web-token`.
2. **브라우저** — Chrome 을 `--headless=new --remote-debugging-port=9222 --user-data-dir=$S/chrome` 로 `http://127.0.0.1:8792/?window=setup#token=<토큰>` 에 열고 argent(Chromium)로 누르고 스크린샷. SSE 가 계속 열려 있어 `--screenshot` 은 끝나지 않는다. CSS 를 바꿨으면 캐시 없이 다시 읽는다. **읽는 중 화면**은 CDP `Fetch.enable`(`urlPattern: */api/call*`)로 정한 메서드(`setup.status` 등)의 요청을 붙잡아 두면 계속 보인다 — 탭을 닫으면 붙잡은 요청이 풀려 실제로 실행되니 시험 서버(임시 HOME)에서만
3. **앱 창** — `simless install` 로 앱을 다시 만들고(아래), 창 ID 를 찾아 `screencapture -x -l<창 ID>`

## 6. 이 Mac 에 반영

| 바꾼 것 | 할 일 |
| --- | --- |
| 서버·CLI 코드 | `launchctl kickstart -k gui/$(id -u)/simless.server` (개발 중에는 `bun link` 라 다시 빌드할 필요 없다) |
| 메뉴바·앱 창(Swift)·Info.plist | `simless install` — 서버 다시 시작 + 스킬 + 앱 다시 만들기. 훅·MCP 는 넣지 않는다(`--hook`·`--mcp`) |
| 스킬 | `simless skill install` |

다른 세션이 쓰는 기기·Metro 는 건드리지 않는다. 점유가 있는지 먼저 본다(`simless status`).

**설치 파일로 확인할 때**(R19) — `bun run build` 후 임시 홈에서 서버·앱 없이: `HOME=<임시> SIMLESS_STATE_DIR=… SIMLESS_CONFIG_DIR=… SIMLESS_LOG_DIR=… SIMLESS_SOCKET=/tmp/… bash dist/simless-<버전>-install.sh --no-launchd --no-app --no-skill`. 서버 등록(launchd)은 이름이 하나(`simless.server`)라 임시 홈에서도 이 Mac 의 진짜 등록을 바꾼다 — 서버까지 확인할 때는 이 Mac 의 개발 설치를 내리고 하거나 다른 사용자 계정에서 한다.

## 7. 문서를 고칠 때

- 요구사항이 바뀌면 `requirements.md`, 설계가 바뀌면 `docs/design.md` 를 **같은 커밋에서**. 결정을 바꾸면 «결정 기록» 에 이유와 버린 대안을 남긴다
- 메시지·메서드가 바뀌면 `docs/protocol.md`
- 사람이 쓰는 기능이 바뀌면 `README.md`
- 진행 상태·이 Mac 의 상태는 `HANDOFF.md`
