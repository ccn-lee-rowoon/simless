import type { Lang } from "./i18n.ts";
import type { Defaults, Device, Group } from "./model.ts";
import type { SessionInfo } from "./protocol.ts";

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

export interface DeviceView extends Device {
  /** 예: `Android 360dp` */
  label: string;
  layoutWidth: number;
  layoutHeight: number;
  booted: boolean;
  /** argent·adb 에 넘길 ID — 켜져 있을 때만 */
  targetId?: string;
  holder?: HolderView;
  slimStats?: SlimStats;
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

/** 슬림화하면 꺼지는 것 한 묶음 (M4 ⓘ) — simslim·avdslim 이 알려 주는 그대로 */
export interface SlimCategory {
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
  /** 슬림화하면 꺼지는 것 (M4 ⓘ) */
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
