import type { Device } from "./model.ts";
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
  unit: "데몬" | "패키지";
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
}

export interface StatusResult {
  serverVersion: string;
  session: SessionInfo;
  held: string[];
  queuePosition?: number;
  devices: DeviceView[];
  queue: { sessionKey: string; agent: string; deviceIds: string[]; enqueuedAt: number }[];
}

export type AcquireResult =
  | { status: "granted"; deviceIds: string[] }
  | { status: "queued"; position: number; holders: (HolderView & { deviceId: string })[] };

export interface BusyData {
  holders: (HolderView & { deviceId: string })[];
}

/** 이 Mac 의 에뮬레이터·시뮬레이터 하나 — «전체 목록» 의 한 줄이자 복제 원본 (M1·M9) */
export interface SourceEntry {
  platform: "android" | "ios";
  /** device = 이 Mac 의 디바이스, profile = Corgi 내장 대표 프로필(Android) */
  kind: "device" | "profile";
  /** AVD ID 또는 UDID */
  native: string;
  name: string;
  spec: Device["spec"];
  /** 예: `Android 360dp` */
  label: string;
  layoutWidth: number;
  /** 보조 표시 — 해상도·밀도·런타임 (M2) */
  detail: string;
  booted: boolean;
  /** Corgi 가 만든 디바이스면 그 ID — 원본으로 쓰지 않는다 */
  managed?: string;
  /** 같은 크기로 이미 만든 Corgi 디바이스 ID (M3) */
  created?: string;
}

export interface SourceListResult {
  items: SourceEntry[];
  /** 플랫폼별로 빠진 도구·오류 */
  problems: { platform: "android" | "ios"; message: string }[];
  /** 대표 프로필·직접 입력에 쓸 Android 시스템 이미지 */
  androidImages: { sysdir: string; label: string; recommended: boolean }[];
}

export interface DeviceOpResult {
  id: string;
  name: string;
  ok: boolean;
  error?: string;
}
