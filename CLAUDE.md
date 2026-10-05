# simless — 작업 규칙

시뮬레이터·에뮬레이터 중개·관리 도구(용도별 그룹·기본 디바이스·UI 테스트용 슬림 디바이스) — TypeScript(Bun) 상주 서버 + CLI + 웹 화면(`simless.app` 창) + 로컬 MCP + 스킬. 단일 실행 파일로 배포하고, 개발 중에는 `bun link` 로 쓴다.

**기술 스택**: TypeScript 7 · Bun 1.3.6(`mise.toml`) · commander · zod 4 · `bun:ffi`(libproc) · Biome · `bun test`. 배포는 `bun build --compile` 단일 실행 파일. 자세한 표는 `docs/design.md` §2, 소켓 메시지는 `docs/protocol.md`.

## 먼저 읽을 것

1. `HANDOFF.md` — 배경, 실측한 사실, 머신 상태
2. `requirements.md` — 요구사항 정본(맨 아래 «결정 기록» 포함)
3. `docs/design.md` — 설계안 (저장소 구조·폴더 경계는 §3)
4. `docs/development.md` — 개발 가이드: «무엇을 바꾸려면 어디를 고치나», 테스트 쓰는 법, 화면 확인, 이 Mac 에 반영
5. `reference-design-draft.md` — 요구사항 정리 전 초안. 참고만 한다

## 문서 규칙

- 요구사항이 바뀌면 `requirements.md`, 설계가 바뀌면 `docs/design.md` 를 **같은 커밋에서** 고친다.
- 결정을 뒤집을 때는 해당 «결정 기록» 의 «버린 대안» 의 단점을 해결했는지 먼저 확인하고, 기록도 고친다.
- 코드와 문서에서 요구사항을 가리킬 때는 ID(R4·M7·P8 …)를 쓴다.

## 빌드·검사

처음 한 번: `mise install` (Bun 1.3.6) → `bun install` → `bun link` (`simless` 명령이 이 저장소를 가리키게 된다).

```sh
bun install
bun run check   # biome check + tsc --noEmit
bun run test    # 모든 테스트
bun run trace   # 요구사항 ID ↔ 테스트 (--missing: 테스트 없는 요구사항)
bun run build   # dist/simless 단일 실행 파일 — 진입점·파일 포함을 바꿨을 때
```

**테스트에서 주의할 것**
- 같은 프로세스 안의 소켓 서버를 부르는 promise 에 `expect(…).rejects` 를 쓰면 Bun 1.3.6 에서 오동작한다(응답 전에 연결이 끊긴 것처럼 보임). `.catch((e) => e)` 로 받아서 검사한다.
- 실제 디바이스를 다루는 확인은 `SIMLESS_STATE_DIR`·`SIMLESS_SOCKET` 등을 임시 경로로 바꿔 서버를 띄우고 한다. 만든 시험 디바이스는 끝나면 `simless delete --yes` 로 지운다.

## 커밋 규칙

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
- **작업 단위가 끝나면 바로 커밋한다** — `docs/design.md` §16 단계 안의 한 항목(예: «Android 드라이버 생성·삭제») 정도. 여러 단위를 모아 한 번에 커밋하지 않는다.
- 커밋마다 **빌드·검사가 통과하는 상태**여야 한다(위 «빌드·검사»). 실패한 채 커밋하지 않는다.
- 코드와 함께 바뀐 문서·테스트는 같은 커밋에 넣는다.

### 하지 않는 것

- 생성물(`node_modules/`, `dist/`, 컴파일된 메뉴바 바이너리, 로그)·비밀·로컬 경로가 박힌 설정(`*.local.json`) 커밋
- `--no-verify` 로 검사 건너뛰기
- 리모트에 올린 커밋의 `--amend`·리베이스·강제 푸시

### 브랜치

- 리모트가 생기기 전까지는 `main` 에 직접 커밋한다.
- 리모트를 연결하면 작업 브랜치 → PR → `main` 으로 바꾸고 이 절을 고친다.

## 디바이스를 다룰 때

- 이 Mac 에는 다른 세션이 쓰는 에뮬레이터·시뮬레이터·Metro 가 있을 수 있다. **이 작업이 만든 것이 아니면 건드리지 않는다.**
- 시험용 디바이스는 `simless_` 로 시작하는 이름으로 만들고, 작업이 끝나면 무엇을 남겼는지 알린다.
