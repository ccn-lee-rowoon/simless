# 개발 가이드

simless 를 고치는 사람(사람·에이전트)이 «무엇을 바꾸려면 어디를 고치나» 를 바로 찾게 하는 문서다.
요구사항은 `requirements.md`, 설계는 `docs/design.md`(저장소 구조는 §3), 메시지는 `docs/protocol.md`,
작업·커밋 규칙은 `CLAUDE.md` 가 정본이다.

## 1. 준비와 매일 쓰는 명령

처음 한 번: `mise install`(Bun 1.3.6) → `bun install` → `bun link`(`simless` 가 이 저장소를 가리킨다).

| 명령 | 하는 일 |
| --- | --- |
| `bun run check` | Biome(린트·포맷) + `tsc --noEmit` — 커밋 전에 반드시 |
| `bun run test` | 모든 테스트. 한 파일만: `bun test test/leases.test.ts` |
| `bun run test:watch` | 고칠 때마다 다시 |
| `bun run trace` | 요구사항 ID 마다 테스트·코드에서 몇 번 가리키나. `--missing` 은 테스트가 없는 것만 |
| `bun run format` | 포맷·import 정리를 고쳐 쓴다 |
| `bun run build` | `dist/simless` 단일 실행 파일 — 진입점·묶음 파일(`with { type: "file" }`)을 바꿨을 때 |

커밋마다 `check`·`test` 가 통과해야 한다. 종료 코드로 확인한다 — 출력을 `grep` 에 넘기면 실패해도 성공으로 보일 수 있다.

## 2. 큰 그림

```
에이전트 ─ CLI·MCP·훅 ─┐            ┌─ 드라이버 ─ simctl·emulator·adb·simslim·avdslim
                      ├─ 소켓 ─ 서버 ┤
사람 ─ simless.app·웹 ───┘   (HTTP)    └─ 상태 파일 ─ registry·leases(JSON), history(SQLite)
```

- **상태는 서버 하나만** 갖는다. CLI·MCP·훅·웹·메뉴바는 요청을 보내는 창구다.
- 서버 메서드는 `src/server/*.ts` 의 `registerXMethods(server)` 가 `server.addMethod(이름, 함수)` 로 붙인다.
- 폴더 사이 import 규칙은 설계 §3 표, `test/architecture.test.ts` 가 지킨다.

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

- 키는 `src/shared/i18n/ko.ts` 가 정본이다. `en.ts` 는 `Record<keyof typeof ko, string>` 이라 빠뜨리면 타입 오류가 난다. 자리 표시자(`{name}`)도 같아야 한다(`test/i18n.test.ts`).
- 키 이름은 `묶음.뜻` — `err.*`(오류) · `cli.*` · `web.*` · `doctor.*` · `hint.*` · `setup.*` …
- 메뉴바(Swift)는 따로 작은 사전(`tray/SimlessTray.swift` 의 `Strings`)이 있다.
- 스킬·규칙은 영어로 쓴다(읽는 쪽이 에이전트).

### 웹 화면·창 하나 더하기

- 화면 — `src/web/*View.tsx`, 공용 조각은 `ui.tsx`·`icons.tsx`, 스타일은 `styles.css`(색은 `:root` 변수 — 라이트·다크 둘 다)
- 새 창 — `main.tsx` 의 `?window=…` 분기 + `bridge.ts` 의 `AppMessage` + Swift `AppController`(`makeAuxWindow` 로 창, `userContentController` 에서 메시지 받기). 브라우저에서는 `window.open` 으로 대신한다
- 웹이 부르는 메서드는 `WEB_METHODS` 에 넣어야 한다(403)

### 드라이버 바꾸기 (Android·iOS)

`src/server/drivers/types.ts` 의 `Driver` 가 계약이다. 메서드를 더하면 `test/helpers.ts` 의 `fakeDriver` 도 같이 고친다. 외부 명령은 `runner` 로 받아서 테스트가 가짜 명령으로 바꾼다(`test/*-driver.test.ts`).

### 스킬·규칙 고치기

- `integrations/skill/simless/SKILL.md`·`integrations/rules/simless.md` — 커밋 type 은 `docs`
- 요구사항(S1~S11)을 담은 문장은 `test/skill.test.ts` 가 검사한다 — 바꾸면 테스트도 같이
- 이 Mac 에 반영: `simless skill install`(넣어 둔 모든 곳). 서버는 10분마다 예전 스킬을 찾아 앱에 알린다

### 다른 에이전트 연결 (Q16)

조사는 `docs/agent-integrations.md`. 붙일 곳: 훅 어댑터(`src/hook/index.ts` 의 `adapters`, 대상 추출 `hook/targets.ts`), 셸에 주는 세션 ID(`src/shared/session.ts` 의 `AGENT_SESSION_ENV`), 설치(`src/install/`), 설정 창 «에이전트 연결»(`web/SetupView.tsx`·`server/setup.ts`).

## 4. 테스트 쓰기

- **서버 시나리오** — 파일 맨 위에서 `const start = testServers();` 한 번, 테스트마다 `const { A, B, H, server, driver } = await start({ seed })`. `A`·`B` 는 에이전트 세션, `H` 는 사람(웹). 결과와 오류(`code`·`message`·`data`)를 같은 값으로 받는다
- **준비 도구**(`test/helpers.ts`) — `tempEnv()` 임시 상태·HOME·짧은 소켓 경로, `fakeDriver()` 아무것도 켜지 않는 드라이버, `seedDevice()` 디바이스 넣기, `session()` 세션 정보
- **이 Mac 을 건드리지 않는다** — 설치·훅·MCP 를 부르는 테스트는 `deps: (env) => ({ env: { ...env.env, PATH: "" } })` 로 HOME 을 임시 폴더로, PATH 를 비워 진짜 `claude` 등을 못 쓰게 한다. 실제 기기는 테스트에서 켜지 않는다
- **이름에 요구사항 ID** — `describe("그룹 (R21)")` 처럼. `bun run trace` 가 이걸 센다
- **문서도 검사한다** — 스킬처럼 요구사항을 담은 문서는 꼭 있어야 할 문장을 테스트로(`test/skill.test.ts`)
- **주의** — 같은 프로세스의 소켓 서버를 부르는 promise 에 `expect(…).rejects` 를 쓰지 않는다(Bun 1.3.6 오동작). `.catch((e) => e)` 로 받아 검사한다. `afterEach` 는 helpers.ts 맨 위에 두면 파일마다 걸리지 않는다 — `testServers()` 가 부른 파일에 건다

## 5. 화면 직접 확인

웹 화면은 자동 테스트가 없다(`bun run trace --missing` 의 M2·M5·M7·M9). 바꾸면 눈으로 확인한다.

1. **시험 서버** — 진짜 서버(8791)·진짜 HOME 을 건드리지 않게 따로 띄운다
   ```sh
   S=<임시 폴더>
   HOME=$S/home SIMLESS_STATE_DIR=$S/state SIMLESS_CONFIG_DIR=$S/config SIMLESS_LOG_DIR=$S/logs \
     SIMLESS_SOCKET=/tmp/simless-ui-test.sock bun bin/simless.ts serve &
   ```
   `$S/config/config.json` 에 `{"httpPort": 8792}` 를 넣어 두면 포트가 겹치지 않는다. 토큰은 `$S/state/web-token`.
2. **브라우저** — Chrome 을 `--headless=new --remote-debugging-port=9222 --user-data-dir=$S/chrome` 로 `http://127.0.0.1:8792/?window=setup#token=<토큰>` 에 열고 argent(Chromium)로 누르고 스크린샷. SSE 가 계속 열려 있어 `--screenshot` 은 끝나지 않는다. CSS 를 바꿨으면 캐시 없이 다시 읽는다
3. **앱 창** — `simless install` 로 앱을 다시 만들고(아래), 창 ID 를 찾아 `screencapture -x -l<창 ID>`

## 6. 이 Mac 에 반영

| 바꾼 것 | 할 일 |
| --- | --- |
| 서버·CLI 코드 | `launchctl kickstart -k gui/$(id -u)/simless.server` (개발 중에는 `bun link` 라 다시 빌드할 필요 없다) |
| 메뉴바·앱 창(Swift)·Info.plist | `simless install` — 서버 다시 시작 + 스킬 + 앱 다시 만들기. 훅·MCP 는 넣지 않는다(`--hook`·`--mcp`) |
| 스킬 | `simless skill install` |

다른 세션이 쓰는 기기·Metro 는 건드리지 않는다. 점유가 있는지 먼저 본다(`simless status`).

## 7. 문서를 고칠 때

- 요구사항이 바뀌면 `requirements.md`, 설계가 바뀌면 `docs/design.md` 를 **같은 커밋에서**. 결정을 바꾸면 «결정 기록» 에 이유와 버린 대안을 남긴다
- 메시지·메서드가 바뀌면 `docs/protocol.md`
- 사람이 쓰는 기능이 바뀌면 `README.md`
- 진행 상태·이 Mac 의 상태는 `HANDOFF.md`
