# 보안 (SECURITY)

Simless 가 지키는 것, 지키지 않는 것, 코드를 고칠 때 깨면 안 되는 규칙을 적는다. 사람과 에이전트 모두 보안에 닿는 곳(아래 §3 표)을 고치기 전에 이 문서를 본다. 마지막 점검: 2026-10-06 (0.1.0).

## 1. 지키는 것

Simless 는 **한 사용자의 Mac 안에서만** 도는 도구다. 기본 약속은 셋이다.

1. **외부로 데이터를 보내지 않는다.** 사용 통계·오류 보고·원격 설정이 없다. 네트워크를 쓰는 것은 사용자가 설정 창에서 누른 설치 명령(brew·npx)과 앱이 여는 링크(`open`)뿐이다.
2. **이 Mac 의 다른 사용자와 웹사이트는 Simless 를 조작할 수 없다.** 소켓·토큰·상태 파일은 그 사용자만 읽고 쓰며, HTTP 는 루프백에만 열고 토큰·Host·Origin 을 확인한다.
3. **정해 둔 일만 실행한다.** 웹 화면·소켓으로 들어온 값이 셸 명령이 되지 않는다. 외부 명령은 인자 배열로만 실행한다.

## 2. 지키지 않는 것 (위협 모델 밖)

- **같은 사용자 계정의 프로세스.** 같은 사용자로 도는 프로그램은 원래 그 사용자의 파일을 다 읽고 쓸 수 있다. 소켓·토큰도 마찬가지다.
- **보호(훅·규칙)는 보안 경계가 아니다.** 세션끼리 기기를 실수로 건드리지 않게 하는 협조 장치다.
  - 서버가 이상한 답을 하면 에이전트가 멈추지 않도록 통과시킨다.
  - «사람인지» 는 프로세스로 판단하므로 일부러 속이면 우회할 수 있다.
- **사용자가 설치를 고른 외부 도구.** simslim(`mobai-app/tap`)·avdslim(개인 저장소 `kdbhalala/avdslim`, `brew trust`)·argent(`npx @swmansion/argent@latest`, 버전 고정 없음)는 그 출처를 믿는 것이다.
- **앱 프로젝트의 코드.**
  - `simless app` 은 앱 프로젝트의 `node_modules/.bin/fingerprint` 를 실행한다(`npm run` 과 같은 신뢰).
  - 에이전트가 하는 빌드(`npx expo run:*`)도 마찬가지다.
- **AI 서비스로 넘어가는 대화.**
  - 에이전트가 실행한 `simless` 출력은 대화에 들어가 AI 제공사로 간다.
  - 그 출력에는 기기 이름과 다른 세션의 에이전트 이름이 들어 있다. 다른 세션의 작업 폴더는 마지막 폴더 이름만 보인다(경로에 든 사용자 이름 등은 감춘다).
  - 비밀은 들어가지 않게 한다(§3).

## 3. 고칠 때 지킬 규칙

| 곳 | 규칙 | 지금 구현 |
| --- | --- | --- |
| HTTP (`src/server/http.ts`) | `127.0.0.1` 에만 연다. `/api/*` 는 토큰 + Host(`127.0.0.1`·`localhost`) 확인, `GET` 이 아니면 Origin 확인. 웹이 부를 메서드는 `WEB_METHODS` 에 하나씩 넣는다 — 와일드카드 금지 | `checkRequest`, `WEB_METHODS` |
| 토큰 (`web-token`) | 32바이트 무작위, `0600`. 로그·화면·에이전트 출력·커밋에 찍지 않는다. 페이지에는 주소의 `#token=`(서버로 안 감)으로 넘긴다. 비교는 일정 시간 비교(`timingSafeEqual`) | `ensureToken`·`sameToken` |
| 소켓·상태·설정·로그 | 소켓·`registry`·`leases`·`history.db`·`web-token`·`config.json` 은 `0600`, 상태·설정·로그 폴더는 `0700` | `socket.ts`·`history.ts`·`store.ts`·`shared/config.ts`·`install/launchd.ts` |
| 외부 명령 | `Bun.spawn` 에 **인자 배열**로. `sh -c`·문자열 이어 붙이기 금지. 사용자 값(이름·경로)은 인자 하나로만 넘긴다 | `shared/exec.ts` |
| 설정 창의 설치 (`setup.run`·`setup.openTerminal`) | 웹은 **수정 ID** 만 보내고 서버의 `FIXES` 표에서 찾는다(`Object.hasOwn`). 웹이 보낸 명령을 실행하는 메서드를 만들지 않는다. 새 수정 항목은 출처(공식 tap·패키지)를 확인하고 `docs/development.md` 에 적는다 | `install/fixes.ts`, `isFixId` |
| 제거 (`setup.uninstall`, S12) | 사람 세션만. 지우는 곳은 코드에 정해 둔 위치뿐(스킬 위치 파일에 적힌 곳·에이전트 설정의 Simless 항목·`Paths` 의 폴더) — 웹에서 경로를 받지 않는다. 테스트는 `finishUninstall` 을 가짜로 두어 진짜 launchd·앱을 내리지 않는다 | `install/uninstall.ts` |
| AppleScript (`setup.openTerminal`) | 정해 둔 명령만, `\`·`"` 를 이스케이프해서 | `setup.ts` |
| 경로를 받는 메서드 (`device.install`·`setup.skillScope`) | 확장자·존재·폴더인지 확인하고, 그 경로로는 정해 둔 일만 한다(설치·스킬 파일 쓰기). 경로로 받은 파일을 실행하지 않는다 | `devices.ts`·`setup.ts` |
| 에이전트 설정 파일 (`~/.claude`·`~/.codex`·`~/.cursor`·`~/.gemini`·`~/.copilot`) | Simless 항목만 넣고 뺀다. 읽지 못하는 파일은 건드리지 않는다. 다른 MCP 의 `env`·`args`(토큰이 있을 수 있음)는 출력하지 않는다. 사용자가 고르기 전에는 넣지 않는다(`simless install` 기본에 훅·MCP 없음) | `install/agents.ts`·`claude-*.ts` |
| 훅 (`src/hook`) | 서버에는 **기기 ID 만** 보낸다. 에이전트의 명령 내용·도구 입력은 저장하지 않는다 | `hook.check` |
| 기록 (`history.db`) | 사건 종류·세션·에이전트·작업 폴더·기기 ID 만. 명령·환경 변수·화면 내용은 넣지 않는다. 기본 90일 뒤 지운다 | `history.ts` |
| 웹 화면 (`src/web`) | 외부 글꼴·스크립트·CDN·분석 도구를 넣지 않는다. `dangerouslySetInnerHTML` 금지(React 가 글자를 이스케이프하게) | — |
| 앱 창 (`tray/SimlessTray.swift`) | 창 안에서는 이 앱의 화면(`127.0.0.1:<포트>`)만 연다. 그 밖의 주소로는 옮겨 가지 않고, 사람이 누른 링크면 기본 브라우저로 연다 | `decidePolicyFor` |
| 에이전트에게 보이는 출력 | 다른 세션의 작업 폴더(`cwd`)는 마지막 폴더 이름만 — 출력이 AI 제공사로 넘어간다. 자기 세션과 사람(웹 화면)에게는 그대로. 서버의 응답 출구 한 곳에서 한다 — 새 메서드도 따로 할 일 없음 | `app.ts` `redactCwd` |
| 빌드 캐시 (`src/builds`) | `~/Library/Caches/Simless`(사용자만 읽음) 아래에만. 캐시의 빌드에는 앱 번들의 `EXPO_PUBLIC_*` 같은 값이 들어 있을 수 있으므로 다른 곳에 복사·업로드하지 않는다 | `cache.ts` |
| 네트워크 요청 | 새로 외부에 요청하는 코드를 넣으려면 요구사항·결정 기록에 무엇을 어디로 보내는지 먼저 적는다(업데이트 확인 R19 가 처음이 될 것 — GitHub Releases 로 버전만 묻고, 받은 파일은 체크섬 확인) | 없음 |
| 의존성 | 늘릴 때는 필요한지 먼저 본다. 설치 스크립트(postinstall)·네트워크를 쓰는 패키지는 피한다. 버전은 `bun.lock` 으로 고정 | `package.json` |
| 커밋 | 토큰·비밀·로컬 경로가 박힌 설정(`*.local.json`)·로그·`dist/` 를 커밋하지 않는다 | `.gitignore` |
| 테스트 | 진짜 `~/.claude` 등과 진짜 소켓을 건드리지 않는다 — `tempEnv()`·`PATH: ""` | `test/helpers.ts` |

## 4. 보안에 닿는 변경을 할 때

1. 위 표의 규칙을 깨지 않는지 본다. 깨야 하면 이유와 대안을 `requirements.md` «결정 기록» 에 적고 이 문서도 같은 커밋에서 고친다.
2. 막는 쪽 테스트를 넣는다(예: 토큰 없음 401, 다른 Host 403, 모르는 수정 ID INVALID). `test/http.test.ts`·`test/setup.test.ts` 가 예다.
3. 실제로 확인한다 — 서버를 띄우고 `curl` 로:
   ```sh
   curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8791/api/events                     # 401
   curl -s -o /dev/null -w "%{http_code}\n" -H "Host: evil.com" http://127.0.0.1:8791/api/events  # 403
   lsof -nP -a -p "$(pgrep -f 'simless.*serve' | head -1)" -i                                     # 127.0.0.1 만
   ```
4. 커밋 본문에 무엇을 지키려고 바꿨는지 적는다.

## 5. 알려진 약한 점 (고칠 후보)

| 내용 | 위험 | 고치는 법 |
| --- | --- | --- |
| argent 를 `@latest` 로 설치 | 중간 (공급망) | 확인한 버전으로 고정 |
| avdslim 이 개인 저장소 tap + `brew trust` | 중간 (공급망) | 설정 창에 출처를 보여 주고, 공식 배포처가 생기면 바꾼다 |
| SSE 는 토큰을 주소의 `?token=` 으로 받는다(EventSource 가 헤더를 못 붙임) | 매우 낮음 (로그에 안 남김) | 짧게 쓰는 SSE 전용 토큰 |

## 6. 문제를 찾았을 때

- 아직 리모트가 없다. 저장소 주인(이 Mac 의 사용자)에게 직접 알린다. 리모트가 생기면 비공개 보고 경로(GitHub Security Advisory)를 여기에 적는다.
- 에이전트는 문제를 찾으면 고치기 전에 사용자에게 무엇이 문제인지 먼저 말한다. 비밀이 드러났으면 그 값을 대화에 옮겨 적지 않는다.
