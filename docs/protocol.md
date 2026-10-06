# Simless 소켓 프로토콜 (v1)

> CLI·훅·(나중의) MCP 가 상주 서버(`simless serve`)에 요청하는 형식이다. 타입의 정본은 코드다 — 메시지 `src/shared/protocol.ts`, 결과 `src/shared/api.ts`, 매개변수 검증 `src/server/app.ts`·`src/server/devices.ts`.

## 연결

- **Unix 도메인 소켓**: `~/Library/Application Support/simless/simless.sock` (권한 0600, `SIMLESS_SOCKET` 으로 바꿀 수 있음).
- **연결 하나에 요청 하나.** 클라이언트가 요청 한 줄을 보내고, 서버는 진행 알림(0개 이상) 뒤에 응답 한 줄을 보내고 연결을 닫는다.
- 한 줄에 JSON 하나(UTF-8, `\n` 으로 끝). 오류·진행 문장은 서버의 설정 언어(R25)다 — 판단은 `code` 로 한다. 큰 응답은 여러 조각으로 오므로 스트리밍 디코더로 이어 붙인다.
- 서버가 없으면 클라이언트는 `SERVER_DOWN`(CLI 종료 코드 4)으로 끝낸다. CLI 는 launchd 에 등록돼 있으면 먼저 서버를 켜고 한 번 더 보낸다.

## 메시지

**요청**

```json
{
  "v": 1,
  "id": "1f0c…",
  "clientVersion": "0.1.0",
  "method": "lease.acquire",
  "session": {
    "key": "p46194-1790914992",
    "pid": 46194,
    "pidStartedAt": 1790914992,
    "agent": "claude-code",
    "agentSessionId": "8e92…",
    "cwd": "/Users/me/Projects/app",
    "human": false
  },
  "params": { "devices": ["Small"], "wait": true }
}
```

- `session` 은 클라이언트가 프로세스 트리에서 찾는다 (`docs/design.md` §7). 서버는 이 값으로 점유자를 구분하고, 요청이 올 때마다 그 세션의 마지막 사용 시각을 갱신한다(R17).
- 웹 화면·메뉴바는 HTTP(`127.0.0.1`, 토큰)로 같은 메서드를 부른다 — `POST /api/call { method, params }`(웹이 부를 수 있는 메서드만, `WEB_METHODS`), 변화는 `GET /api/events`(SSE)로 받는다. SSE 이벤트: `hello { version, startedAt }`(연결할 때 — `startedAt` 은 서버가 뜬 시각, 다시 연결했는데 다르면 화면이 페이지를 새로 받는다) · `changed`(다시 읽어라) · `progress { message }` · `output { job, line }`·`job { job }`(설정 창의 설치, M14)
- 버전 확인: 요청마다 `clientVersion` 을, 응답마다 `serverVersion` 을 싣는다. 다르면 CLI 가 «서버를 다시 시작하세요» 를 한 번 알린다. (설계안의 별도 `hello` 대신 이 방식으로 했다.)

**진행 알림** — 응답 전에 여러 번 올 수 있다

```json
{ "id": "1f0c…", "event": "progress", "data": { "message": "부팅: Android 360dp (emulator-5554)" } }
{ "id": "1f0c…", "event": "queued", "data": { "position": 1, "holders": [ … ] } }
```

**응답**

```json
{ "id": "1f0c…", "serverVersion": "0.1.0", "ok": true, "result": { … } }
{ "id": "1f0c…", "serverVersion": "0.1.0", "ok": false, "error": { "code": "BUSY", "message": "다른 세션이 사용 중입니다", "data": { "holders": [ … ] } } }
```

## 오류 코드

| 코드 | 뜻 | CLI 종료 코드 |
| --- | --- | --- |
| `BUSY` | 다른 세션이 사용 중(또는 같은 디바이스를 먼저 기다리는 중). `data.holders` 에 누가·언제부터 | 3 |
| `DEADLOCK` | 기다리면 서로를 기다리게 됨 — 대기열에 넣지 않았다. `data.cycle` 에 엮인 세션의 에이전트 이름 (§8) | 3 |
| `NO_DEFAULT` | 기본 디바이스가 없음 — data `{ missing: [{ platform, devices }] }`(그 플랫폼의 디바이스 대수, 0 이면 `create` 로 만들 수 있다) | 1 |
| `NOT_HELD` | 이 세션이 점유하지 않은 디바이스를 켜거나 끄려 함 | 1 |
| `NOT_FOUND` | 없는 디바이스·기종·런타임·시스템 이미지 | 1 |
| `INVALID` | 잘못된 매개변수, 이미 쓰는 이름, 이름이 같은 디바이스가 여럿(ID 로 고르게 함) | 2 |
| `NOT_ALLOWED` | 이 Mac 에 원래 있던 디바이스를 지우거나 슬림 설정하려 함 (M8·N5) | 1 |
| `TOOL_MISSING` | avdslim·simslim·SDK 등 필요한 도구가 없음 | 1 |
| `FAILED` | 그 밖의 실패 (외부 명령 오류 등) | 1 |
| (클라이언트) `SERVER_DOWN` | 서버에 연결 못 함 | 4 |
| (클라이언트) `QUEUED` | 기다리기 시간이 지남 — 순번은 남아 있음 | 3 |

`holders` 항목: `{ deviceId, sessionKey, agent, cwd, human, since, reason: "held" | "queued" }` (`since` 는 ms).

**작업 폴더(`cwd`)** — 에이전트 세션이 받는 결과·오류 data·진행 알림에서 **다른 세션의** `cwd` 는 마지막 폴더 이름만 온다(예: `app`). 자기 세션과 사람(웹 화면)에게는 전체 경로. 출력이 AI 제공사로 넘어가기 때문이다(`SECURITY.md`).

## 메서드

디바이스는 Simless ID·AVD ID·UDID·이름으로 가리킨다. 목록·점유는 **Simless 목록**(만든 것 + 이 Mac 에서 추가한 것, `listed: true`)만 다룬다(R20) — Simless 가 만든 것은 `createdBySimless: true`. 목록에 없는 이 Mac 의 디바이스를 가리키면 `NOT_FOUND`(추가하라는 안내). `devices` 를 비우면 메서드마다 정한 기본값을 쓴다.

| 메서드 | params | result | 비고 |
| --- | --- | --- | --- |
| `status` | `{}` | `StatusResult` — 지금 언어 `language`(ko·en)·시스템 언어 `systemLanguage`, 첫 실행 설정을 안 끝냈는지 `setupNeeded`(M14), 넣어 둔 스킬이 예전 것인지 `skillUpdate`(S9), 이 세션, 점유·대기 순번, `DeviceView[]`(simless 목록), 그룹 `groups`, 세션마다 점유·대기 `sessions`(점유하거나 기다리는 세션만 — `{ sessionKey, agentSessionId?, agent, cwd, human, lastUsedAt, held: [{deviceId, since}], queued, queuePosition? }`, M13), 기본 디바이스 `defaults`(`{ android?, ios? }`), 대기열 | |
| `setup.status` | `{}` | `{ needed, finishedAt?, checks: CheckView[], agents: { claude, skill, skillLocations: [{ location, state, targets }], mcp, hook, rule, others: [{ agent, label, installed, hook, rule, mcp }] } }` | 첫 실행 설정 창 (M14). `checks` 는 `simless doctor` 와 같은 점검(항목마다 `id` — `server`·`launchd`·`xcode`·`simslim`·`androidSdk`·`images`·`avdslim`·`argent`·…). `agents` 는 설치 상태 `missing`·`outdated`·`current`, `claude` 는 claude 명령이 있는지. 점검에 몇 초 걸린다 |
| `setup.skillScope` | `{ kind: "global" }` · `{ kind: "project", paths: [폴더] }` | `agents` | 스킬을 넣는 곳 바꾸기 (S9) — 빠진 곳은 지우고 새 곳에 넣는다. 프로젝트는 작업 트리마다 넣고 `.git/info/exclude` 에 적는다. 없는 폴더는 `INVALID` |
| `setup.apply` | `{ item: "skill" \| "mcp" \| "protection", enabled, agent = "claude" \| "copilot" \| "codex" \| "cursor" \| "gemini" }` | `agents` (위와 같음) | 켜면 설치·끄면 제거. `protection` = 훅 + 규칙. `mcp` 는 `claude mcp add --scope user simless -- <simless> mcp` — claude 가 없으면 `TOOL_MISSING` |
| `setup.run` | `{ fix }` | `JobView` — `{ id, fix, status: running·done·failed·canceled, lines, command, startedAt, endedAt?, exitCode? }` | 바로 설치 (M14). `fix` 는 정해 둔 항목(`simslim.install`·`simslim.upgrade`·`avdslim.install`·`avdslim.upgrade`·`argent.install`·`xcode.open`·`androidStudio.open`)만, 그 밖은 `INVALID`. 바로 돌려주고 뒤에서 돈다 — 출력은 SSE `output { job, line }`, 상태는 `job { job }`. 같은 항목이 돌고 있으면 그것을 준다 |
| `setup.jobs` | `{}` | `JobView[]` | 돌고 있거나 끝난 설치 (항목마다 마지막 하나) |
| `setup.cancel` | `{ job }` | `JobView` | 돌던 것을 멈춘다 |
| `setup.openTerminal` | `{ fix }` | `{ opened }` | 입력이 필요할 때 — Terminal 앱에 같은 명령을 띄운다 |
| `setup.uninstall` | `{ purge = false }` | `{ steps: [{ what, ok, error? }], devicesLeft, purge }` | Simless 제거 (S12). 사람만(`NOT_ALLOWED`). 스킬·모든 에이전트의 훅·규칙·MCP 를 지우고 답한 뒤, 1.5초 뒤 앱·(purge 면) 데이터 폴더·서버 등록을 지운다 — 서버가 끝난다 |
| `setup.finish` | `{}` | `{ finished: true }` | `…/simless/setup.json` 에 끝낸 시각을 남긴다 — 앱이 다시 띄우지 않는다 |
| `settings.get` | `{}` | `{ language: system·ko·en, idleReleaseMinutes, historyRetentionDays, androidRamMb, simslimProfile? }` | 설정 화면·`simless config` (M11) |
| `settings.set` | 위 값 중 바꿀 것 (`simslimProfile: null` 은 지움) | 같음 | `config.json` 에 바뀐 값만 쓰고 바로 반영한다 — 언어·자동 해제 시간·기록 보관 일수(1~3650)·Android RAM·simslim 프로필 (R25) |
| `catalog` | `{ platform? }` | `{ platforms: PlatformCatalog[], problems }` | 만들 수 있는 기종(`models` — 폭·해상도, iOS 는 지원 런타임 `os`)·OS(`os` — 기본값 `recommended`)·직접 입력 가능 여부, 슬림화하면 꺼지는 것(`slimOff`)·남는 것(`slimKeeps`) (M1·M4) |
| `device.list` | `{}` | `DeviceView[]` | Simless 목록. 켜짐·argent ID(`targetId`)·점유자·메모(`memo`)·기본 여부(`default`)·든 그룹 ID(`groups`) 포함 (M5·R20) |
| `device.create` | `{ platform?, model \| custom, os?, name?, slim = true, baseline = true }` | `DeviceView` | `model` = 기종 ID·이름(`platform` 을 안 주면 두 플랫폼에서 찾고, 양쪽에 있으면 `INVALID`), `custom` = `{ widthDp, heightDp, density }`(Android). `os` 를 안 주면 기본값. 앱 없이 만들고 `slim` 이면 기준값을 잰 뒤 슬림화. 기본 이름은 슬림이면 `simless <기종>`, 아니면 `<기종>` — 겹치면 번호를 붙인다. 진행 알림 있음 |
| `device.rename` | `{ device, name }` | `DeviceView` | 원래 있던 디바이스도 된다. 다른 세션이 쓰는 중이면 `BUSY` |
| `device.available` | `{}` | `DeviceView[]` | 이 Mac 에 있지만 Simless 목록에 없는 디바이스 — 생성 화면의 «이 Mac 의 디바이스» (M1) |
| `device.add` | `{ device }` | `DeviceView` | 이 Mac 의 디바이스를 Simless 목록에 넣는다 — 만들지도 슬림화하지도 않는다. 이미 있으면 `INVALID` |
| `device.unlist` | `{ device }` | `{ unlisted }` | 추가한 디바이스를 목록에서 뺀다 — 기기는 그대로, 점유·그룹 소속·기본 지정은 풀린다. Simless 가 만든 것은 `NOT_ALLOWED`(삭제를 쓴다) |
| `device.setMemo` | `{ device, memo }` | `DeviceView` | 로그인한 계정 등 (R24). 빈 글이면 지운다. 누가 쓰는 중이어도 고칠 수 있다 |
| `device.setDefault` | `{ device }` | `DeviceView` | 그 플랫폼의 기본 디바이스로 (R22). 기본이 없는 플랫폼은 처음 만든 디바이스가 자동으로 기본이 된다 |
| `device.delete` | `{ device }` | `{ deleted }` | Simless 가 만든 것만, 기본 디바이스는 안 됨(`NOT_ALLOWED`). 메모·그룹 소속도 지운다. 켜져 있으면 끄고 지운다. 다른 세션이 쓰는 중이면 `BUSY` (M8) |
| `device.slim` | `{ devices = simless 가 만든 것 전부, mode = "on" \| "off" \| "check" }` | `{ results, devices }` | Simless 가 만든 것만(`NOT_ALLOWED`). on·off 는 다른 세션이 쓰는 중이면 `BUSY` |
| `device.up` | `{ devices = 이 세션의 점유 전부 }` | `{ results, devices }` | 점유가 있어야 함(`NOT_HELD`). 켠 뒤 슬림을 확인하고 풀렸으면 다시 적용 (M6) |
| `device.down` | 같음 | `{ results, devices }` | |
| `device.install` | `{ path, devices = 이 세션의 점유 전부 }` | `{ results }` | 네이티브 빌드 캐시 (R26). `path` 가 `.app` 이면 iOS, `.apk` 면 Android — 점유한 것 중 그 플랫폼만. 다른 확장자 `INVALID`, 파일이 없으면 `NOT_FOUND`, 그 플랫폼 점유가 없으면 `NOT_HELD`, 고른 기기에 다른 플랫폼이 섞이면 `INVALID`. 꺼진 기기는 그 기기만 실패(`results[].ok: false`) |
| `group.list` | `{}` | `Group[]` — `{ id, name, description, deviceIds, updatedBy, updatedAt }` | `updatedBy` 는 `human` 또는 에이전트 이름 (R21) |
| `group.create` | `{ name, description?, devices? }` | `Group` | 이름이 겹치면 `INVALID` |
| `group.update` | `{ group, name?, description?, devices?, add?, remove? }` | `Group` | `devices` 는 통째로 바꾸기, `add`·`remove` 는 넣고 빼기. 안 준 값은 그대로 |
| `group.delete` | `{ group }` | `{ deleted }` | 디바이스는 그대로 |
| `lease.acquire` | `{ devices?, group?, default?: "android" \| "ios" \| "both", create = false, mode = "all" \| "available", wait = false, timeoutMs = 600000 }` | `{ status: "granted", deviceIds, devices }` · `{ status: "partial", deviceIds, devices, queued }` · `{ status: "queued", position, holders, devices }` | 디바이스·그룹·기본 디바이스를 합쳐 요청한다. `devices` 는 기기마다 `{ deviceId, name, state: held·queued·busy·free, holder? }` (R23). `all` 은 전부 아니면 아무것도 — 바쁘면 `BUSY`(data 에 `devices`), `available` 은 비어 있는 것만 잡는다(하나도 없으면 `BUSY`). `wait` 면 대기열에 넣는다 — `all` 은 전부 빌 때까지 기다리고, `available` 은 비어 있던 것을 잡고 바로 돌아오며 나머지는 빌 때마다 서버가 잡아 준다(비어 있던 게 없으면 처음 잡힐 때까지 기다린다). 대기열에 넣으면 교착이 생기는 요청은 `DEADLOCK`. `create` 면 기본 디바이스를 달라는데 디바이스가 하나도 없는 플랫폼에 추천 기종을 슬림으로 만들고 점유한다(진행 알림 있음, 몇 분) |
| `lease.release` | `{ devices? }` | `{ released }` | 안 주면 이 세션의 점유·대기 전부 |
| `lease.history` | `{ limit = 100 (최대 5000), session? }` | `[{ at, kind, sessionKey, agentSessionId?, agent, cwd, human, deviceIds }]` — 최근 것부터 | `kind`: `acquired` 바로 점유 · `queued` 대기 등록 · `granted` 기다려서 점유 · `released` 스스로 해제 · `forced` 강제 해제됨 · `ended` 세션 종료로 해제 · `idle` 오래 안 써서 해제 · `deadlock` 교착이라 대기 거절 (M13) |
| `lease.sessions` | `{ limit = 200 (최대 1000) }` | `[{ sessionKey, agentSessionId?, agent, cwd, human, lastAt, events }]` — 마지막 활동이 최근인 것부터 | 기록에 남은 세션마다 묶음 — 세션 화면의 지난 세션 (M13) |
| `lease.who` | `{ target? }` | `[{ deviceId, name, holder? }]` | `target` 은 ID·이름·AVD ID·UDID·시리얼 |

- 여러 대 작업(`slim`·`up`·`down`)은 하나가 실패해도 나머지를 계속하고 `results: [{ id, name, ok, error? }]` 로 대마다 알려 준다.
- 같은 디바이스에 대한 작업은 서버가 한 번에 하나씩 처리한다.

## 기다리기 동작

- 대기 항목은 **세션**에 붙는다. 연결이 끊기거나 `timeoutMs` 가 지나도 대기열에 남고, 같은 세션이 다시 `wait` 로 요청하면 순번을 이어 간다.
- 차례가 오면 서버가 그 세션에 점유를 준다 — 기다리던 연결이 있으면 바로 `granted` 로 끝난다.
- 대기는 디바이스마다 먼저 온 순서다. 같은 디바이스를 먼저 기다리는 세션이 있으면 비어 있어도 새치기하지 못한다.
- **교착 검사**: 대기열에 넣기 전에, 기다리는 기기의 주인(또는 먼저 기다리는 세션)이 직간접으로 이 세션이 쥔 기기를 기다리는지 따라간다. 순환이 생기면 넣지 않고 `DEADLOCK` 으로 돌려준다 — 쥔 것으로 진행하거나 놓고 다시 요청한다.
- `lease.release`(디바이스 지정 없이) 또는 세션 프로세스 종료로 대기에서 빠진다.
