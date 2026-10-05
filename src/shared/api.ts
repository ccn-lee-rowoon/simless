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

/** 설정 화면 (M11) */
export interface SettingsResult {
  /** 설정값 — system·ko·en */
  language: "system" | Lang;
  idleReleaseMinutes: number;
  androidRamMb: number;
  simslimProfile?: string;
}

export interface StatusResult {
  serverVersion: string;
  /** 지금 쓰는 언어 — 설정이 system 이면 서버가 macOS 언어 설정으로 정한 값 (R25) */
  language: Lang;
  session: SessionInfo;
  held: string[];
  queuePosition?: number;
  devices: DeviceView[];
  groups: Group[];
  defaults: Defaults;
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
