---
name: corgi
description: 여러 화면 크기(폭)의 Android 에뮬레이터·iOS 시뮬레이터에서 앱 레이아웃을 한 번에 확인할 때 쓴다. Corgi(`corgi` CLI)로 레이아웃 체크용 디바이스를 점유·켜기·목록 받기를 하고, 화면 조작·스크린샷은 argent 로 기기마다 한다. 트리거 — "여러 해상도로 확인", "레이아웃 크기별로 봐 줘", "320·375·414 에서 확인", "작은 폰에서 깨지는지", "태블릿에서도 봐 줘", "해상도별로 레이아웃 체크해 줘", "코기로 확인해 줘", "check layout on multiple screen sizes". 기기 한 대만 조작하거나 단순 스크린샷 한 장이면 쓰지 않는다 — 기존 argent 스킬(argent-device-interact 등)로 넘긴다.
---

# Corgi — 크기별 레이아웃 확인

Corgi 는 **레이아웃 체크용 디바이스를 만들고·관리하고·중개**한다. 앱 설치·실행·화면 이동·스크린샷은 **argent 로 기기마다** 한다.

| 하는 쪽 | 일 |
| --- | --- |
| Corgi (`corgi`) | 디바이스 생성·슬림화·켜기·끄기, **점유**(다른 세션과 겹치지 않게), 기기별 argent ID·크기 라벨 목록 |
| argent | 앱 설치(`reinstall-app`)·실행(`launch-app`)·딥링크(`open-url`)·탭·스크린샷 |

**지킬 것**
- Corgi 디바이스는 **점유한 뒤에만** argent·adb·simctl 로 건드린다. 읽기(스크린샷·describe)도 마찬가지.
- 켜기·끄기는 argent `boot-device` 가 아니라 **`corgi use`·`corgi down`** 으로.
- 다른 세션의 디바이스·Metro 는 건드리지 않는다. Metro 는 띄우지 않고, 앱 쪽 세션이 띄운 것을 같이 쓴다.
- `corgi release --force` 는 쓰지 않는다 (사람만).

## 순서

### 1. 상태 확인

```sh
corgi --json status
```

- 종료 코드 4(서버에 연결 못 함)이거나 이상하면 `corgi doctor` 를 실행하고 안내대로 고친다. 고칠 수 없으면 사용자에게 알린다.
- 디바이스가 없거나 원하는 크기가 없으면 `corgi list --all` 로 만들 수 있는 목록을 보고, 무엇으로 만들지 **사용자에게 물은 뒤** 만든다. `corgi …` 디바이스가 생기고 슬림화된다(앱은 설치되지 않음). 같은 크기로 여러 대 만들어도 된다(이름만 겹치지 않으면 됨).
  - **iOS**: 이 Mac 의 시뮬레이터를 원본으로 — 같은 기기 종류·런타임으로 만든다. 슬림에 2~3분 걸린다.
  - **Android**: Corgi 내장 **대표 프로필** 또는 **직접 입력**.
  ```sh
  corgi create "iPhone 17"                                   # iOS — 원본 이름 또는 UDID
  corgi create profile:medium-phone                          # Android 대표 프로필
  corgi create --width 375 --height 812 --density 420        # Android 직접 입력
  ```
  iOS 에서 원하는 크기의 원본이 없으면 사용자에게 Xcode 에서 먼저 만들어 달라고 한다.

### 2. 점유하고 켜기

```sh
corgi --json use              # 사용 중인 디바이스 전부. 일부만: corgi --json use <ID|이름>...
```

- **종료 코드 3 = 다른 세션이 사용 중.** 출력의 `holders`(누가·어느 폴더·언제부터)를 사용자에게 보여 주고 **기다릴지 묻는다.** 기다리라고 하면:
  ```sh
  corgi --json use --wait --timeout 9m
  ```
  Bash 시간 제한 안에서 끝나지 않으면 «아직 대기 중» 으로 끝나지만 **순번은 남는다** — 같은 명령을 다시 실행하면 이어서 기다린다. 차례가 오면 Corgi 가 알아서 점유해 준다.
- 성공하면 결과의 `devices[]` 에서 기기마다 **`targetId`**(argent 의 `udid`/`device_id` — iOS UDID, Android `emulator-<포트>`)와 **`label`**(예: `Android 360dp`, `iOS 402pt`)을 기억한다. 언제든 `corgi --json list` 로 다시 볼 수 있다.

### 3. 기기마다 argent 로

`targetId` 를 argent 도구의 기기 인자로 넘겨 기기마다 반복한다. argent 스킬(argent-device-interact 등)의 규칙을 따른다.

1. **앱 설치** (필요할 때) — `reinstall-app`
2. **앱 실행** — `launch-app`. Expo dev client 라면 Android 는 먼저 Metro 를 잇는다:
   ```sh
   adb -s <targetId> reverse tcp:8081 tcp:8081
   ```
   그다음 dev client 주소(예: `exp+<스킴>://expo-development-client/?url=http%3A%2F%2F127.0.0.1%3A8081`)를 `open-url` 로 연다. iOS 시뮬레이터는 Mac 의 localhost 를 그대로 쓴다.
3. **같은 화면으로** — 딥링크가 있으면 `open-url <딥링크>`, 없으면 argent 흐름(`flow-execute`)을 기기마다 재생한다. 좌표 탭은 크기마다 달라 쓰지 않는다.
4. **스크린샷** — `screenshot`. 기기마다 `label` 을 붙여 둔다.

### 4. 보고

크기(`label`)별로 무엇이 깨졌는지(잘림·겹침·넘침·줄바꿈 등)와 스크린샷을 정리해 보고한다. 문제가 없던 크기도 «정상» 으로 적는다.

### 5. 정리

```sh
corgi release
```

- 결과 보고가 끝나면 점유를 푼다. 사용자 답을 기다리거나 재빌드할 동안은 풀지 않아도 된다 — 오래 안 쓰면(30분) 기다리는 세션이 있을 때만 자동으로 풀린다.
- 디바이스를 끌지 **사용자에게 묻는다.** 끄라고 하면 `release` 전에 `corgi down`.

## 명령 요약

| 명령 | 하는 일 |
| --- | --- |
| `corgi --json status` | 서버·디바이스·점유 한눈에 |
| `corgi list --all [--platform android\|ios]` | 만들 수 있는 목록 — iOS 시뮬레이터·Android 대표 프로필 (폭 순) |
| `corgi create <원본>` / `create --width --height --density` | 원본(또는 대표 프로필)과 같은 크기로 복제 + 슬림화 / Android 직접 입력 |
| `corgi --json use [<디바이스>...] [--wait --timeout 9m]` | 점유 + 켜기 |
| `corgi --json list` | 만든 디바이스 — 기기별 `targetId`·`label`·켜짐·점유 |
| `corgi who [<udid·시리얼>]` | 누가 쓰는 중인지 |
| `corgi down` / `corgi release` | 끄기 / 점유 풀기 |
| `corgi doctor` | 설치·연결 점검과 고치는 방법 |

종료 코드: `0` 성공 · `1` 실패 · `2` 사용법 오류 · `3` 다른 세션이 사용 중(또는 아직 대기 중) · `4` 서버에 연결 못 함. `--json` 이면 오류도 `{"error": {code, message, data}}` 로 stdout 에 나온다.
