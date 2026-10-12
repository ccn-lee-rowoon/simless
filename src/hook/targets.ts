// 도구 호출에서 «어느 디바이스를 건드리는지» 를 뽑는다 (docs/design.md §13 «대상 판정», P4~P6).
// 순수 함수 — 서버·파일을 읽지 않는다. 어느 것이 관리 디바이스인지는 서버(또는 managed-index)가 가린다.

/** 훅이 서버에 묻는 대상 */
export interface Targets {
  /** 디바이스를 가리킬 수 있는 문자열 — UDID·AVD ID·시리얼·simless ID. 관리 디바이스가 아닌 것은 서버가 버린다 */
  ids: string[];
  /** 켜려는 디바이스 — 켜기는 simless 로 해야 한다 (S6) */
  boots: string[];
  /** 기기를 지정하지 않은 adb 기기 명령 — 켜진 Android 전부가 대상 */
  allAndroid: boolean;
  /** `simctl … booted` — 켜진 iOS 전부가 대상 */
  allIos: boolean;
}

/** 이 단어가 하나도 없으면 디바이스를 건드리지 않는 Bash 명령으로 보고 바로 통과한다 */
const DEVICE_TOOLS = /\b(adb|simctl|emulator|simslim|avdslim)\b/;

/** 기기를 지정하지 않으면 켜진 기기에 붙는 adb 명령 (목록 조회·서버 관리는 빼고) */
const ADB_DEVICE_COMMANDS = new Set([
  "shell",
  "install",
  "install-multiple",
  "uninstall",
  "push",
  "pull",
  "reverse",
  "forward",
  "logcat",
  "emu",
  "exec-out",
  "exec-in",
  "reboot",
  "root",
  "unroot",
  "remount",
  "bugreport",
  "wait-for-device",
  "get-serialno",
  "get-state",
]);

/** argent 도구 인자 중 기기를 가리키는 것 — `device` 는 flow-execute (argent 0.28.0 의 도구 인자 목록과 대조) */
const ARGENT_DEVICE_KEYS = [
  "udid",
  "device_id",
  "deviceId",
  "serial",
  "avdName",
  "device",
] as const;
/** 기기 여럿을 가리키는 인자 — stop-all-simulator-servers 의 `devices` */
const ARGENT_DEVICE_LIST_KEYS = ["devices"] as const;

function words(command: string): string[] {
  return command
    .split(/[\s"'`;|&()<>=]+/)
    .map((w) => w.trim())
    .filter(Boolean);
}

/** 명령 하나(; && || | 로 나눈 조각)씩 본다 */
function segments(command: string): string[][] {
  return command
    .split(/;|&&|\|\||\||\n/)
    .map(words)
    .filter((w) => w.length > 0);
}

/**
 * 여는 줄에 이 낱말이 있으면 heredoc 본문이 실행될 수 있다 — 셸·인터프리터·명령을 대신 실행하는 것.
 * 없으면(`cat > 파일`·`git commit -F -`·`tee` …) 본문은 글(데이터)이라 대상을 찾지 않는다.
 */
const HEREDOC_EXECUTORS =
  /(^|[\s/;|&(`$])(sh|bash|zsh|fish|dash|ksh|python[\d.]*|node|bun|bunx|deno|npx|ruby|perl|php|lua|osascript|swift|expect|tclsh|eval|source|exec|xargs|env|sudo|ssh|nohup|time|watch|adb|xcrun|simctl|emulator|simslim|avdslim)(?=$|[\s;|&)`])/;

/**
 * `line[at]` 이 든 명령이 시작하는 자리 — 따옴표 밖의 `;`·`&&`·`||` 바로 뒤. 파이프(`|`)와 리다이렉션의
 * `&`(`2>&1`)로는 나누지 않는다 — 같은 명령 줄이라 본문을 받을 수 있다. 확실하지 않으면 앞쪽(더 넓게)을 고른다
 */
function commandStart(line: string, at: number): number {
  let start = 0;
  let quote: "'" | '"' | undefined;
  for (let i = 0; i < at; i++) {
    const c = line[i];
    if (quote) {
      if (c === "\\" && quote === '"') i++;
      else if (c === quote) quote = undefined;
      continue;
    }
    if (c === "\\") i++;
    else if (c === "'" || c === '"') quote = c;
    else if (c === ";") start = i + 1;
    else if ((c === "&" || c === "|") && line[i + 1] === c) {
      start = i + 2;
      i++;
    }
  }
  // 따옴표가 닫히지 않은 채 heredoc 이 나오면(`bash -c "$(cat <<EOF`) 나눈 자리를 믿지 않는다
  return quote ? 0 : start;
}

/**
 * 실행되지 않는 heredoc 본문을 지운다 (P4, 결정 기록 «훅은 … 문자열 포함»).
 * 파일에 쓰는 스크립트·커밋 메시지·문서 본문에 기기 이름과 adb 가 같이 들어 있으면 막히던 오탐을 없앤다.
 * 그렇게 쓴 파일을 나중에 실행하는 호출은 원래부터 훅이 안을 볼 수 없으므로 새 구멍이 아니다.
 */
export function stripDataHeredocs(command: string): string {
  const lines = command.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    out.push(line);
    const opener = /<<(-?)\s*(['"]?)([A-Za-z_][\w.-]*)\2/g;
    const ends: { tag: string; dash: boolean }[] = [];
    for (const m of line.matchAll(opener)) ends.push({ dash: m[1] === "-", tag: m[3] ?? "" });
    if (ends.length === 0) continue;
    // 본문을 받을 수 있는 것은 heredoc 이 붙은 명령과 그 뒤의 명령뿐이다 — `;`·`&&`·`||` 앞에서 이미 끝난
    // 명령(`bun run check; git commit -F - <<EOF`)의 실행기 때문에 커밋 메시지까지 검사하던 오탐을 없앤다.
    // 뒤쪽은 계속 본다(`cat <<EOF > a.sh; bash a.sh`, 파이프 `cat <<EOF | sh`)
    const first = line.search(opener);
    const keep = HEREDOC_EXECUTORS.test(line.slice(commandStart(line, first)).replace(opener, " "));
    // 한 줄에 heredoc 이 여럿이면 차례로 본문이 온다
    for (const { tag, dash } of ends) {
      while (i + 1 < lines.length) {
        i++;
        const body = lines[i] ?? "";
        const done = (dash ? body.replace(/^\t+/, "") : body) === tag;
        if (keep || done) out.push(body);
        if (done) break;
      }
    }
  }
  return out.join("\n");
}

function bashTargets(full: string): Targets | undefined {
  const command = stripDataHeredocs(full);
  if (!DEVICE_TOOLS.test(command)) return undefined;
  const targets: Targets = { ids: [], boots: [], allAndroid: false, allIos: false };
  // 명령 문자열 안에 보이는 낱말은 모두 후보 — 셸 문법을 파싱하지 않는다(설계 결정 기록)
  targets.ids = [...new Set(words(command))];

  for (const seg of segments(command)) {
    const tool = seg.findIndex((w) => /(^|\/)(adb|emulator)$/.test(w) || w === "simctl");
    if (tool < 0) continue;
    const name = seg[tool]?.split("/").at(-1);
    const args = seg.slice(tool + 1);

    if (name === "adb") {
      const pinned =
        args.includes("-s") || args.includes("-t") || /\bANDROID_SERIAL\b/.test(seg.join(" "));
      const sub = args.find(
        (a, i) => !a.startsWith("-") && !["-s", "-t", "-H", "-P"].includes(args[i - 1] ?? ""),
      );
      if (!pinned && sub && ADB_DEVICE_COMMANDS.has(sub)) targets.allAndroid = true;
    } else if (name === "emulator") {
      const avd = args.indexOf("-avd");
      const value = avd >= 0 ? args[avd + 1] : args.find((a) => a.startsWith("@"))?.slice(1);
      if (value) targets.boots.push(value);
    } else if (name === "simctl") {
      if (args[0] === "boot" && args[1]) targets.boots.push(args[1]);
      if (args.includes("booted")) targets.allIos = true;
    }
  }
  return targets;
}

function argentTargets(tool: string, input: Record<string, unknown>): Targets | undefined {
  const isId = (v: unknown): v is string => typeof v === "string" && v.length > 0;
  const ids = [
    ...ARGENT_DEVICE_KEYS.map((key) => input[key]).filter(isId),
    ...ARGENT_DEVICE_LIST_KEYS.flatMap((key) => {
      const list = input[key];
      return Array.isArray(list) ? list.filter(isId) : [];
    }),
  ];
  if (ids.length === 0 && tool.endsWith("__flow-execute")) {
    // 기기를 안 주면 flow 가 켜진 기기 하나를 스스로 고른다 — 어느 것인지 몰라 켜진 것 전부로 본다
    // (기기 지정 없는 `adb shell` 과 같은 규칙, P4). chromium·vega 는 Simless 기기가 아니다
    const platform = input.platform;
    if (platform === "chromium" || platform === "vega") return undefined;
    return {
      ids: [],
      boots: [],
      allAndroid: platform !== "ios",
      allIos: platform !== "android",
    };
  }
  if (ids.length === 0) return undefined; // list-devices 처럼 기기를 지정하지 않는 도구 (P6)
  const boots = tool.endsWith("__boot-device") ? ids : [];
  return { ids, boots, allAndroid: false, allIos: false };
}

/**
 * 도구 호출 → 대상. 디바이스를 건드리지 않으면 undefined(바로 통과).
 * Claude Code 의 도구 이름 기준 — Bash, mcp__argent__<도구>.
 */
export function extractTargets(tool: string, input: unknown): Targets | undefined {
  const record = (typeof input === "object" && input !== null ? input : {}) as Record<
    string,
    unknown
  >;
  if (tool === "Bash") {
    const command = record.command;
    return typeof command === "string" ? bashTargets(command) : undefined;
  }
  if (tool.startsWith("mcp__argent__")) return argentTargets(tool, record);
  return undefined;
}
