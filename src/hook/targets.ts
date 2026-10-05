// 도구 호출에서 «어느 디바이스를 건드리는지» 를 뽑는다 (docs/design.md §13 «대상 판정», P4~P6).
// 순수 함수 — 서버·파일을 읽지 않는다. 어느 것이 관리 디바이스인지는 서버(또는 managed-index)가 가린다.

/** 훅이 서버에 묻는 대상 */
export interface Targets {
  /** 디바이스를 가리킬 수 있는 문자열 — UDID·AVD ID·시리얼·Corgi ID. 관리 디바이스가 아닌 것은 서버가 버린다 */
  ids: string[];
  /** 켜려는 디바이스 — 켜기는 Corgi 로 해야 한다 (S6) */
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

/** argent 도구 인자 중 기기를 가리키는 것 */
const ARGENT_DEVICE_KEYS = ["udid", "device_id", "deviceId", "serial", "avdName"] as const;

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

function bashTargets(command: string): Targets | undefined {
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
  const ids = ARGENT_DEVICE_KEYS.map((key) => input[key]).filter(
    (v): v is string => typeof v === "string" && v.length > 0,
  );
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
