# simless — 작업 규칙 (모든 에이전트)

**Make simulator management seamless.** — 시뮬레이터·에뮬레이터 중개·관리 도구(용도별 그룹·기본 디바이스·UI 테스트용 슬림 디바이스). TypeScript(Bun) 상주 서버 + CLI + 웹 화면(`simless.app` 창) + 로컬 MCP + 스킬. 단일 실행 파일로 배포하고, 개발 중에는 `bun link` 로 쓴다.

이 파일이 작업 규칙의 정본이다. Claude Code 는 `CLAUDE.md` 가 이 파일을 불러온다. 작업을 시작할 때마다 이 파일을 다시 본다.

**기술 스택**: TypeScript 7 · Bun 1.3.6(`mise.toml`) · commander · zod 4 · React 19 · `bun:sqlite` · `bun:ffi`(libproc) · Biome · `bun test`. 메뉴바·앱 창은 Swift(`tray/SimlessTray.swift`, 설치 때 컴파일). 자세한 표는 `docs/design.md` §2, 소켓 메시지는 `docs/protocol.md`.

## 1. 먼저 읽을 것

1. `HANDOFF.md` — 진행 상태, 실측한 사실, 이 Mac 의 상태
2. `requirements.md` — 요구사항 정본(ID: R·M·S·P·L·N·Q) + 맨 아래 «결정 기록»
3. `docs/design.md` — 설계. 저장소 구조·폴더 경계는 §3
4. `docs/development.md` — «무엇을 바꾸려면 어디를 고치나», 테스트 쓰는 법, 화면 확인, 이 Mac 에 반영
5. `docs/protocol.md` — 서버 메서드·오류 코드 · `docs/agent-integrations.md` — 다른 에이전트 연결 조사
6. `reference-design-draft.md` — 요구사항 정리 전 초안(예전 이름 Corgi 시절). 참고만 한다

## 2. 작업할 때마다 확인할 것

- [ ] 바꾸려는 것의 요구사항 ID 를 찾았다 — 없으면 요구사항부터 정한다(사용자에게 묻는다)
- [ ] 고칠 곳은 `docs/development.md` §3 의 순서를 따른다(메서드·오류 코드·설정·문구·화면·드라이버·스킬·에이전트)
- [ ] 폴더 경계(설계 §3)를 지킨다 — `test/architecture.test.ts` 가 검사한다
- [ ] 문구는 `src/shared/i18n/ko.ts`(정본)와 `en.ts` 둘 다. 스킬·규칙 문서는 영어
- [ ] 요구사항·설계·메시지가 바뀌면 `requirements.md`·`docs/design.md`·`docs/protocol.md` 를 **같은 커밋에서**
- [ ] `bun run check`·`bun run test` 가 **종료 코드로** 통과했다(출력을 `grep` 에 넘기면 실패해도 성공처럼 보일 수 있다)
- [ ] 이 Mac 의 실제 설정(`~/.claude`·`~/.codex`·`~/.cursor`·`~/.gemini`·`~/.copilot`)과 다른 세션의 기기·Metro 를 건드리지 않았다
- [ ] 끝나면 바로 커밋했다(§5)

## 3. 이름

- 제품·CLI·앱·스킬·MCP 이름은 모두 소문자 **`simless`**(simulator + seamless). 슬로건 «Make simulator management seamless.»
- 예전 이름 **Corgi** 는 `src/install/legacy.ts`(예전 설치를 찾아 옮기기)와 «결정 기록» 에만 남긴다. 다른 곳에 새로 쓰지 않는다.
- 저장소 폴더 이름(`…/corgi`)은 그대로다.

## 4. 빌드·검사

처음 한 번: `mise install` (Bun 1.3.6) → `bun install` → `bun link` (`simless` 명령이 이 저장소를 가리키게 된다).

```sh
bun install
bun run check   # biome check + tsc --noEmit
bun run test    # 모든 테스트
bun run trace   # 요구사항 ID ↔ 테스트 (--missing: 테스트 없는 요구사항)
bun run build   # dist/simless 단일 실행 파일 — 진입점·파일 포함을 바꿨을 때
bun run release <patch|minor|x.y.z>  # 버전 내기 (§6)
```

**테스트에서 주의할 것**
- 서버 시나리오는 `test/helpers.ts` 의 `testServers()` 로 — 파일 맨 위에서 한 번 부른다.
- 설치·훅·MCP 를 부르는 테스트는 `deps: (env) => ({ env: { ...env.env, PATH: "" } })` 로 HOME 을 임시 폴더로 — **진짜 `~/.claude` 등을 건드리지 않는다.**
- 같은 프로세스 안의 소켓 서버를 부르는 promise 에 `expect(…).rejects` 를 쓰면 Bun 1.3.6 에서 오동작한다. `.catch((e) => e)` 로 받아서 검사한다.
- 테스트 이름에 요구사항 ID 를 넣는다(`describe("그룹 (R21)")`) — `bun run trace` 가 센다.
- 실제 디바이스를 다루는 확인은 `SIMLESS_STATE_DIR`·`SIMLESS_SOCKET` 등을 임시 경로로 바꿔 서버를 띄우고 한다. 만든 시험 디바이스는 끝나면 `simless delete --yes` 로 지운다.

## 5. 커밋 규칙

### 형식

```
<type>(<scope>): <한국어 요약>

<본문 — 왜 바꿨는지. 무엇을 바꿨는지는 diff 가 보여 준다>

관련: R4, M7
Co-Authored-By: …
```

- **type** (영어 소문자)

  | type | 쓸 때 |
  | --- | --- |
  | `feat` | 기능 추가 |
  | `fix` | 버그 수정 |
  | `refactor` | 동작이 같은 구조 변경 |
  | `perf` | 성능 개선 |
  | `test` | 테스트만 추가·수정 |
  | `docs` | 문서만 (요구사항·설계·README·스킬 문서) |
  | `build` | `package.json`·`tsconfig`·`biome.json`·`mise.toml`, 의존성 |
  | `chore` | 그 밖의 잡일 (`.gitignore` 등) |

- **scope** (선택) — 바뀐 곳(`src/` 아래 폴더 기준): `shared` · `install` · `server` · `cli` · `hook` · `mcp` · `web` · `tray` · `skill`(`integrations/`). 여러 곳에 걸치면 생략한다. `docs` 는 scope 없이 쓴다.
- **요약** — 한국어, 마침표 없이, 50자 안팎. «무엇을 했다» 가 드러나게 쓴다.
- **본문** — 한국어, 한 줄 72자 안팎에서 줄바꿈. 이유가 diff 로 뻔하면 생략해도 된다.
- **`관련:`** — 해당 요구사항 ID 가 있으면 적는다.
- **AI 공동 작성 표시** — 에이전트가 커밋할 때는 시스템이 알려 주는 `Co-Authored-By` 줄을 맨 끝에 붙인다.

예:

```
feat(server): 점유 대기열과 세션 종료 시 자동 해제 추가

대기 항목을 연결이 아닌 세션에 붙여 CLI 가 시간 제한으로 끊겨도
순번이 유지되게 했다. 세션 종료는 2초 간격 PID 확인으로 감지한다.

관련: R14, R17
```

### 단위와 시점

- **한 커밋 = 한 가지 논리적 변경.** 리팩터링과 기능 추가, 포맷 정리와 로직 변경을 섞지 않는다.
- **작업 단위가 끝나면 바로 커밋한다** — `docs/design.md` §16 단계 안의 한 항목 정도. 여러 단위를 모아 한 번에 커밋하지 않는다.
- 커밋마다 **빌드·검사가 통과하는 상태**여야 한다(§4). 실패한 채 커밋하지 않는다.
- 코드와 함께 바뀐 문서·테스트는 같은 커밋에 넣는다.

### 하지 않는 것

- 생성물(`node_modules/`, `dist/`, 컴파일된 메뉴바 바이너리, 로그)·비밀·로컬 경로가 박힌 설정(`*.local.json`) 커밋
- `--no-verify` 로 검사 건너뛰기
- 리모트에 올린 커밋의 `--amend`·리베이스·강제 푸시

### 브랜치

- 리모트가 생기기 전까지는 `main` 에 직접 커밋한다.
- 리모트를 연결하면 작업 브랜치 → PR → `main` 으로 바꾸고 이 절을 고친다.

## 6. 버전과 바뀐 것 (CHANGELOG)

- 버전은 SemVer, 정본은 `package.json` 의 `version` 하나(앱·CLI·서버가 읽는다). **직접 고치지 않는다** — `bun run release <patch|minor|x.y.z>` 로만 올린다(검사·테스트 → 버전 → CHANGELOG → `chore(release): vX.Y.Z` 커밋 → `vX.Y.Z` 태그).
- 1.0 전에는 기능이 늘거나 동작이 바뀌면 minor, 고치기만 하면 patch.
- 사용자에게 보이는 변화는 `feat`·`fix`·`perf` 로 커밋한다 — CHANGELOG 초안이 여기서 나온다(`bun run release draft`). 내기 전에 «아직 내지 않은 것» 을 사람이 읽기 좋게 다듬는다.
- 소켓 프로토콜(`PROTOCOL_VERSION`)·저장 파일 형식(레지스트리 `version`)은 앱 버전과 따로, 깨질 때만 올린다.
- 리모트·GitHub Release 올리기는 아직이다(U단계, `docs/design.md` §19).

## 7. 이 Mac 에 반영할 때

| 바꾼 것 | 할 일 |
| --- | --- |
| 서버·CLI 코드 | `launchctl kickstart -k gui/$(id -u)/simless.server` (개발 중에는 `bun link` 라 다시 빌드할 필요 없다) |
| 메뉴바·앱 창(Swift)·Info.plist | `simless install` — 서버 다시 시작 + 스킬 + 앱 다시 만들기 |
| 스킬 | `simless skill install` |

- `simless install` 은 보호(훅)·MCP 를 넣지 않는다(`--hook`·`--mcp`). 사용자가 정하지 않았으면 켜지 않는다.
- 서버를 다시 켜기 전에 누가 점유 중인지 본다(`simless status`).

## 8. 디바이스를 다룰 때

- 이 Mac 에는 다른 세션이 쓰는 에뮬레이터·시뮬레이터·Metro 가 있을 수 있다. **이 작업이 만든 것이 아니면 건드리지 않는다.**
- 시험용 디바이스는 `simless_` 로 시작하는 이름으로 만들고, 작업이 끝나면 무엇을 남겼는지 알린다.
- 기기는 simless 로 점유한 뒤에만 argent·adb·simctl 로 건드린다(스크린샷 같은 읽기도). 강제 해제(`simless release --force`)는 사람만.

## 9. 사용자와 일할 때

- 답과 커밋 메시지는 한국어로. 쉬운 말로, 무엇을 했는지·무엇이 남았는지 분명히.
- 실제로 확인한 것과 확인하지 않은 것을 나눠 말한다.
- 되돌리기 어렵거나 이 Mac 의 공용 설정을 바꾸는 일(훅·MCP 등록, 다른 도구 업데이트, 다른 세션의 기기)은 먼저 묻는다.
