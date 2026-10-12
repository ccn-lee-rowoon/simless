import type { Lang } from "./i18n.ts";
import type { Defaults, Device, Group } from "./model.ts";
import type { SessionInfo } from "./protocol.ts";
import type { SlimChoice } from "./slim-mode.ts";

// 메서드별 결과 형식 — 서버와 CLI(나중에 MCP·웹 UI)가 같이 쓴다. 상세는 docs/protocol.md

export interface HolderView {
  sessionKey: string;
  agent: string;
  cwd: string;
  human: boolean;
  /** 점유(또는 대기) 시작 시각 (ms) */
  since: number;
  reason: "held" | "queued";
}

/** 얼마나 슬림화됐는지 — 켜진 디바이스만 (M6) */
export interface SlimStats {
  /** 꺼진 항목 수 / 대상 수 — iOS 는 launchd 데몬, Android 는 avdslim 프로필 패키지 */
  disabled: number;
  total: number;
  unit: "daemons" | "packages";
  /** 지금 쓰는 메모리 — iOS 는 시뮬레이터 프로세스 합, Android 는 에뮬레이터의 Activity Monitor 메모리 */
  memoryBytes?: number;
  processes?: number;
  measuredAt: number;
}

export interface DeviceView extends Omit<Device, "slimMode"> {
  /**
   * 슬림 방식 (M15) — 저장된 출처(`app`·`custom`)를 상태와 함께 본 값. 슬림하지 않았으면 none,
   * 남긴 것이 없으면 ui. 저장된 값은 레지스트리에만 있다
   */
  slimMode: SlimChoice;
  /** 만드는 중 — 목록에는 올라갔지만 기준값 측정·슬림이 아직 (M4). 그동안 켜기·슬림·삭제는 BUSY */
  creating?: boolean;
  /** 예: `Android 360dp` */
  label: string;
  layoutWidth: number;
  layoutHeight: number;
  booted: boolean;
  /** argent·adb 에 넘길 ID — 켜져 있을 때만 */
  targetId?: string;
  holder?: HolderView;
  slimStats?: SlimStats;
  /**
   * 꺼진 슬림 항목 ID (M16) — 켜져 있을 때 실제로 읽은 것(`slimOffObserved`), 아직 못 읽었으면
   * Simless 가 슬림한 내용(남긴 항목 빼고 전부)으로 계산한 것. 슬림이 아니면 없다
   */
  slimOff?: string[];
  slimOffObserved?: boolean;
  /** 이 세션이 점유 중 */
  mine: boolean;
  /** 이 플랫폼의 기본 디바이스 (R22) */
  default: boolean;
  /** 든 그룹 ID (R21) */
  groups: string[];
}

/** 세션 화면 한 줄 (M13) */
export interface SessionView {
  sessionKey: string;
  /** 에이전트가 주는 세션 ID */
  agentSessionId?: string;
  agent: string;
  cwd: string;
  human: boolean;
  lastUsedAt: number;
  held: { deviceId: string; since: number }[];
  /** 대기열에서 기다리는 디바이스 */
  queued: string[];
  queuePosition?: number;
}

/** 설정 화면 (M11) */
export interface SettingsResult {
  /** 설정값 — system·ko·en */
  language: "system" | Lang;
  idleReleaseMinutes: number;
  /** 점유 기록 보관 기간 (M13) */
  historyRetentionDays: number;
  androidRamMb: number;
  simslimProfile?: string;
}

export interface StatusResult {
  serverVersion: string;
  /** 지금 쓰는 언어 — 설정이 system 이면 서버가 macOS 언어 설정으로 정한 값 (R25) */
  language: Lang;
  /** 설정이 system 일 때 쓸 언어 — 설정 화면의 «시스템 설정 따르기 (지금: …)» */
  systemLanguage: Lang;
  session: SessionInfo;
  held: string[];
  queuePosition?: number;
  devices: DeviceView[];
  groups: Group[];
  defaults: Defaults;
  /** 세션마다 점유·대기 (M13) */
  sessions: SessionView[];
  /** 첫 실행 설정을 아직 안 끝냄 — 앱이 설정 창을 띄운다 (M14) */
  setupNeeded: boolean;
  /** 넣어 둔 스킬이 이 simless 의 것과 다른 곳이 있다 — 앱이 «스킬 업데이트» 를 알린다 (S9) */
  skillUpdate: boolean;
  /** 들어 있는 스킬(SKILL.md·참고 파일)의 지문 — 메뉴바 앱이 스킬 버전마다 한 번만 알림을 띄운다 (M18) */
  skillHash: string;
  queue: { sessionKey: string; agent: string; deviceIds: string[]; enqueuedAt: number }[];
}

/** 요청한 디바이스마다 지금 상태 — 에이전트가 이걸 보고 판단한다 (R23) */
export interface LeaseItem {
  deviceId: string;
  name: string;
  /**
   * held = 이 세션이 잡음, queued = 대기열에서 기다리는 중, busy = 다른 세션이 쓰는 중(기다리지 않음),
   * free = 비어 있음(전부 아니면 아무것도 — 다른 것 때문에 못 잡았을 때)
   */
  state: "held" | "queued" | "busy" | "free";
  /** queued·busy 일 때 막고 있는 쪽 */
  holder?: HolderView;
}

export type AcquireResult =
  | { status: "granted"; deviceIds: string[]; devices: LeaseItem[] }
  /** available 모드 — 비어 있던 것만 잡았다. queued 면 나머지는 빌 때마다 서버가 잡아 준다 */
  | { status: "partial"; deviceIds: string[]; devices: LeaseItem[]; queued: boolean }
  | {
      status: "queued";
      position: number;
      holders: (HolderView & { deviceId: string })[];
      devices: LeaseItem[];
    };

/** BUSY·DEADLOCK 오류의 data */
export interface BusyData {
  holders: (HolderView & { deviceId: string })[];
  devices?: LeaseItem[];
  /** DEADLOCK — 서로 기다리게 되는 세션들의 에이전트 이름 */
  cycle?: string[];
}

/** 만들 수 있는 기종 하나 — iOS 기기 종류, Android 대표 프로필 (M1) */
export interface CatalogModel {
  /** iOS 기기 종류 ID(`com.apple.CoreSimulator.SimDeviceType.iPhone-17`), Android 프로필 ID(`medium-phone`) */
  id: string;
  name: string;
  /** phone·tablet — 목록을 나눠 보여 준다 */
  form: "phone" | "tablet";
  /** RN 레이아웃이 받는 폭·높이 — Android dp, iOS pt (M2) */
  layoutWidth: number;
  layoutHeight: number;
  /** 보조 표시 — 해상도·밀도 */
  detail: string;
  /** 이 기종을 만들 수 있는 OS ID — iOS 만 (런타임마다 지원 기종이 다르다). 없으면 전부 */
  os?: string[];
}

/** 고를 수 있는 OS 하나 — iOS 런타임, Android 시스템 이미지 */
export interface CatalogOs {
  id: string;
  name: string;
  /** 기본값 — iOS 최신, Android 4KB 페이지·API 높은 순 */
  recommended: boolean;
}

/** 슬림화하면 꺼지는 것 한 묶음 (M4·M15) — simslim·avdslim 이 알려 주는 그대로 */
export interface SlimCategory {
  /** 남길 때 주는 ID (M15) — iOS 는 simslim 묶음 ID, Android 는 묶음 이름에서 만든 ID·설정·하드웨어 이름 */
  id: string;
  /** Android 만 — packages: 패키지 묶음, settings: 기기 설정, host: 에뮬레이터 하드웨어 */
  kind?: "packages" | "settings" | "host";
  name: string;
  /** 꺼지면 안 되는 것 — iOS 는 simslim 의 «When disabled: …» 설명 */
  detail?: string;
  /** 꺼지는 항목 수 — Android 는 패키지 수 */
  count?: number;
}

export interface PlatformCatalog {
  platform: "android" | "ios";
  models: CatalogModel[];
  os: CatalogOs[];
  /** 폭·높이·밀도를 직접 넣을 수 있다 — Android 만 */
  custom: boolean;
  /** 슬림화하면 꺼지는 것 — 커스텀 슬림의 항목이기도 하다 (M4·M15) */
  slimOff: SlimCategory[];
  /** 슬림화해도 남는 것 */
  slimKeeps: string[];
}

export interface CatalogResult {
  platforms: PlatformCatalog[];
  /** 플랫폼별로 빠진 도구·오류 */
  problems: { platform: "android" | "ios"; message: string }[];
}

export interface DeviceOpResult {
  id: string;
  name: string;
  ok: boolean;
  error?: string;
}

/** 슬림 전후 메모리 비교 — «7.8GB → 1.6GB (−79%)». 둘 중 하나라도 없으면 undefined */
export function memoryChange(before?: number, after?: number): string | undefined {
  if (!before || !after) return undefined;
  const gb = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)}GB`;
  const percent = Math.round(((after - before) / before) * 100);
  return `${gb(before)} → ${gb(after)} (${percent <= 0 ? "−" : "+"}${Math.abs(percent)}%)`;
}

/**
 * Simless 가 슬림하지 않았지만 슬림돼 있는 것으로 보이는 기기 (M6) — simslim·avdslim 을 직접 썼거나
 * 다른 도구로 슬림한 것. 켜져 있으면 지금 읽은 값, 꺼져 있으면 마지막으로 본 값(`seenAt`)으로 판단한다
 */
export function observedSlim(
  device: DeviceView,
): { disabled: number; total: number; unit: SlimStats["unit"]; seenAt?: string } | undefined {
  if (device.slim !== "none") return undefined;
  const stats = device.booted ? device.slimStats : device.slimSeen;
  return stats && looksSlim(stats) ? stats : undefined;
}

/**
 * 슬림돼 보이는지 — iOS 는 simslim 이 끈 데몬이 하나라도 있으면, Android 는 avdslim 프로필 패키지가
 * 절반 이상 꺼져 있으면(슬림 안 한 기기에도 몇 개는 꺼져 있을 수 있다 — docs/design.md §9 와 같은 기준)
 */
function looksSlim(stats: Pick<SlimStats, "disabled" | "total" | "unit">): boolean {
  if (stats.unit === "daemons") return stats.disabled > 0;
  return stats.total > 0 && stats.disabled * 2 >= stats.total;
}

/** 점유 기록 한 줄 (M13) — 세션 화면의 «기록» */
export type HistoryKind =
  /** 바로 점유 */
  | "acquired"
  /** 대기열에 넣음 */
  | "queued"
  /** 기다리다 점유 */
  | "granted"
  /** 스스로 놓음 */
  | "released"
  /** 사람이 강제로 풂 */
  | "forced"
  /** 세션 프로세스가 끝나 풀림 (R17 ①) */
  | "ended"
  /** 오래 안 쓰고 기다리는 세션이 있어 풀림 (R17 ②) */
  | "idle"
  /** 교착이 생겨 대기열에 넣지 않음 */
  | "deadlock";

export interface HistoryEvent {
  at: number;
  kind: HistoryKind;
  sessionKey: string;
  /** 에이전트가 주는 세션 ID (Claude Code 의 CLAUDE_CODE_SESSION_ID 등) */
  agentSessionId?: string;
  agent: string;
  cwd: string;
  human: boolean;
  deviceIds: string[];
}

/** 기록에 남은 세션 하나 — 세션 화면의 «지난 세션» (M13) */
export interface HistorySession {
  sessionKey: string;
  agentSessionId?: string;
  agent: string;
  cwd: string;
  human: boolean;
  /** 마지막 기록 시각 */
  lastAt: number;
  /** 기록 수 */
  events: number;
}

/** 점검 항목 — simless doctor 와 첫 실행 설정 창이 같이 쓴다 (S1·S2·M14) */
export type CheckId =
  | "server"
  | "launchd"
  | "androidSdk"
  | "images"
  | "avdslim"
  | "xcode"
  | "simslim"
  | "argent"
  | "skill"
  | "hook"
  | "rule"
  | "app";

export interface CheckView {
  id: CheckId;
  group: string;
  name: string;
  status: "ok" | "warn" | "fail";
  detail: string;
  /** 고치는 방법 — 사람이 실행할 명령 */
  fix?: string;
  /** simless doctor --fix 가 고칠 수 있는 것 */
  autofix?: "launchd" | "skill" | "app" | "hook";
  /** 설정 창에서 바로 고치는 버튼 (M14) — install·update 는 명령 실행, open 은 앱·페이지 열기 */
  action?: { fix: FixId; kind: "install" | "update" | "open" };
}

/** 설정 창이 서버에 실행을 부탁할 수 있는 것 — 서버는 정해 둔 명령만 실행한다 (install/fixes.ts) */
export type FixId =
  | "simslim.install"
  | "simslim.upgrade"
  | "avdslim.install"
  | "avdslim.upgrade"
  | "argent.install"
  | "xcode.open"
  | "androidStudio.open";

/** 실행 중이거나 끝난 설치 한 건 — 출력은 SSE «output» 으로 한 줄씩 온다 */
export interface JobView {
  id: string;
  fix: FixId;
  status: "running" | "done" | "failed" | "canceled";
  /** 지금까지의 출력 (최근 400줄) */
  lines: string[];
  /** 실행한 명령 — 화면에 «$ …» 로 */
  command: string;
  startedAt: number;
  endedAt?: number;
  exitCode?: number;
}

/** 설치 상태 — missing = 없음, outdated = 들어 있는 것과 다름, current = 같음 */
export type InstallState = "missing" | "outdated" | "current";

/** 스킬을 넣는 곳 (S9) — 전역 또는 프로젝트 폴더 */
export type SkillLocation = { kind: "global" } | { kind: "project"; path: string };

export interface SkillLocationView {
  location: SkillLocation;
  state: InstallState;
  /** 설치 대상 수 — 프로젝트면 작업 트리 수 */
  targets: number;
}

/** Claude Code 말고 연결할 수 있는 에이전트 (Q16) */
export type OtherAgent = "copilot" | "codex" | "cursor" | "gemini";

export interface OtherAgentView {
  agent: OtherAgent;
  label: string;
  /** 이 Mac 에 설치돼 있는지 */
  installed: boolean;
  /** 보호 = 훅 + 규칙 */
  hook: InstallState;
  rule: InstallState;
  mcp: InstallState;
}

/** 에이전트 연결 — 첫 실행 설정 창에서 켜고 끈다 (M14) */
export interface SetupAgents {
  /** claude 명령이 있는지 — 없으면 MCP 등록을 못 한다 */
  claude: boolean;
  /** 모든 위치를 합친 상태 */
  skill: InstallState;
  skillLocations: SkillLocationView[];
  mcp: InstallState;
  /** 보호 = 훅 + 규칙 (P2·P3) */
  hook: InstallState;
  rule: InstallState;
  /** 다른 에이전트 — 스킬은 위의 것을 같이 쓴다(~/.agents/skills) */
  others: OtherAgentView[];
}

export interface SetupStatus {
  needed: boolean;
  finishedAt?: number;
  checks: CheckView[];
  agents: SetupAgents;
}

export type SetupItem = "skill" | "mcp" | "protection";
