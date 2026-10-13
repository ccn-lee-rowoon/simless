// 도구 호출에서 «어느 디바이스를 건드리는지» 를 뽑는다 (docs/design.md §13 «대상 판정», P4~P6·P10).
// 순수 함수 — 서버·파일을 읽지 않는다. 어느 것이 관리 디바이스인지는 서버(또는 managed-index)가 가린다.
// 화면 조작·테스트 도구(argent·Maestro …)의 이름은 모른다(P10) — 셸 명령의 낱말과 MCP 인자의 글자에서
// 기기 ID 로 보이는 것을 찾는다. 기기를 직접 다루는 플랫폼 도구(adb·simctl·emulator)만 읽는 법을 안다.

import { SELF_MCP_SERVER } from "../shared/hook-scope.ts";

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

/** 기기를 직접 다루는 플랫폼 도구 — 이 낱말이 있는 명령은 낱말을 모두 서버에 묻는다(예전 그대로) */
const DEVICE_TOOLS = /(?<![\w-])(adb|simctl|emulator|simslim|avdslim)(?![\w-])/;

/** 관리 디바이스의 AVD ID·UDID·마지막 시리얼(managed-index) — 필요할 때만 읽는다 */
export type Known = () => ReadonlySet<string>;

/** 기기 ID 모양 — iOS UDID·Android 에뮬레이터 시리얼. 붙은 인자(`id=<UDID>,arch=…`·`ios:<UDID>`) 안에서도 찾는다 */
const UDID_IN = /[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}/gi;
const SERIAL_IN = /emulator-\d+/g;
/**
 * 모양이 없는 이름(AVD ID) 후보 — `_`·숫자가 든 4자 이상 낱말만 관리 목록과 대조한다.
 * `test`·`main` 같은 흔한 낱말로 이름 지은 AVD 가 관계없는 명령(`bun run test`·`git checkout main`)을 막지 않게
 */
const NAME_LIKE = /^(?=.{4,})(?=.*[_\d])[\w.-]+$/;
/** MCP 인자에서 이보다 긴 글은 보지 않는다 — 기기 인자는 짧고, 긴 글은 문서·이슈 본문이다(P10) */
const MAX_MCP_STRING = 512;

/** 글 안의 기기 ID — UDID 는 대문자로 맞춘다(서버가 글자 그대로 비교하고 simctl 은 대문자로 준다) */
function deviceIds(text: string, known: Known): string[] {
  const shaped = [
    ...[...text.matchAll(UDID_IN)].map((m) => m[0].toUpperCase()),
    ...[...text.matchAll(SERIAL_IN)].map((m) => m[0]),
  ];
  const names = text.split(/[\s"'`;|&()<>=,:/]+/).filter((w) => NAME_LIKE.test(w));
  const named = names.length > 0 ? names.filter((w) => known().has(w)) : [];
  return [...new Set([...shaped, ...named])];
}

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

/** Simless 자신의 명령 조각을 뺀다 — `simless use <UDID>` 는 점유하려는 것이다(MCP 의 simless 도구처럼) */
function withoutSimless(command: string): string {
  return command
    .split(/;|&&|\|\||\||\n/)
    .filter((seg) => (words(seg)[0] ?? "").split("/").at(-1) !== "simless")
    .join("\n");
}

function bashTargets(full: string, known: Known): Targets | undefined {
  const command = withoutSimless(stripDataHeredocs(full));
  // 명령 문자열 안의 기기 ID 는 모두 후보 — 셸 문법을 파싱하지 않는다(설계 결정 기록).
  // 어떤 도구든(maestro --device …·agent-device --udid …·npx 뒤 …) 기기 ID 를 넘기면 걸린다
  if (!DEVICE_TOOLS.test(command)) {
    const ids = deviceIds(command, known);
    return ids.length > 0 ? { ids, boots: [], allAndroid: false, allIos: false } : undefined;
  }
  // 플랫폼 도구가 든 명령은 낱말을 모두 묻는다 — AVD 이름이 관리 목록 파일에 아직 없어도 맞게
  const ids = [...new Set([...words(command), ...deviceIds(command, () => new Set())])];
  const targets: Targets = { ids, boots: [], allAndroid: false, allIos: false };

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

/** MCP 인자 안의 짧은 글을 모두 — 깊이·개수·길이에 끝을 둔다(큰 문서를 넘기는 도구도 훅이 빨리 끝나게) */
function strings(value: unknown, out: string[] = [], depth = 0): string[] {
  if (out.length >= 2000 || depth > 8) return out;
  if (typeof value === "string") {
    if (value.length <= MAX_MCP_STRING) out.push(value);
  } else if (Array.isArray(value)) for (const v of value) strings(v, out, depth + 1);
  else if (typeof value === "object" && value !== null)
    for (const v of Object.values(value)) strings(v, out, depth + 1);
  return out;
}

/**
 * MCP 도구 호출 — 어느 서버의 어느 도구든 인자 글자에서 기기 ID 를 찾는다(P10). 인자 이름(`udid`·`device_id`·
 * `serial` …)은 도구마다 달라 보지 않는다. 기기를 안 준 호출(도구가 켜진 기기를 스스로 고름)은 알 수 없어 통과한다 —
 * 규칙·스킬이 «기기를 늘 지정한다» 로 다룬다. 이름이 켜기처럼 보이는 도구(`boot`·`start-device` …)는 켜기다 —
 * 켜기는 Simless 로 한다(S6)
 */
function mcpTargets(tool: string, input: unknown, known: Known): Targets | undefined {
  const ids = [...new Set(strings(input).flatMap((text) => deviceIds(text, known)))];
  if (ids.length === 0) return undefined;
  const boots = BOOT_TOOL.test(tool) ? ids : [];
  return { ids, boots, allAndroid: false, allIos: false };
}

/** 켜기로 보는 MCP 도구 이름 — 도구마다 다르지만 이름에 드러난다(`boot-device`·`boot`·`start_device` …) */
const BOOT_TOOL = /(^|[-_])(boot|start[-_]?(device|simulator|emulator))([-_]|$)/i;

/**
 * 도구 호출 → 대상. 디바이스를 건드리지 않으면 undefined(바로 통과).
 * Claude Code 의 도구 이름 기준 — Bash, mcp__<서버>__<도구> (다른 에이전트는 adapters.ts 가 바꿔 준다).
 * `known` 은 관리 디바이스의 AVD ID·UDID·마지막 시리얼(managed-index) — 모양이 없는 AVD 이름을 알아보는 데 쓴다.
 * 이름처럼 보이는 낱말이 있을 때만 부른다(파일 읽기를 아끼려고).
 */
export function extractTargets(
  tool: string,
  input: unknown,
  known: Known = () => new Set(),
): Targets | undefined {
  const record = (typeof input === "object" && input !== null ? input : {}) as Record<
    string,
    unknown
  >;
  if (tool === "Bash") {
    const command = record.command;
    return typeof command === "string" ? bashTargets(command, known) : undefined;
  }
  if (!tool.startsWith("mcp__") || tool.startsWith(`mcp__${SELF_MCP_SERVER}__`)) return undefined;
  return mcpTargets(tool.split("__").slice(2).join("__"), input, known);
}
