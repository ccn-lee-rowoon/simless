import type { SlimStats } from "../../shared/api.ts";
import type { Device, DeviceSpec, Platform, SlimState } from "../../shared/model.ts";

/** 켜짐 여부 — 저장하지 않고 매번 드라이버에게 묻는다 */
export interface RuntimeState {
  booted: boolean;
  /** argent·adb 에 넘기는 ID — iOS UDID, Android `emulator-<port>` */
  targetId?: string;
}

/** 이 Mac 의 디바이스 하나 — 드라이버가 읽은 그대로 (R20) */
export interface Discovered {
  /** AVD ID 또는 UDID */
  native: string;
  name: string;
  spec: DeviceSpec;
}

/** 만들 수 있는 것 하나 — 생성 원본 (M1) */
export interface SourceDevice {
  platform: Platform;
  /** AVD ID 또는 UDID */
  native: string;
  name: string;
  spec: DeviceSpec;
  /** 보조 표시 — 해상도·밀도·런타임 (M2) */
  detail: string;
  booted: boolean;
}

export type Progress = (message: string) => void;

export interface CustomRequest {
  widthDp: number;
  heightDp: number;
  density: number;
  /** 비우면 기본 이미지 (4KB 페이지·API 높은 순) */
  systemImage?: string;
}

export interface SystemImageInfo {
  /** config.ini 의 image.sysdir.1 — 예: system-images/android-36/google_apis_playstore/arm64-v8a/ */
  sysdir: string;
  label: string;
  recommended: boolean;
}

export interface Driver {
  readonly platform: Platform;
  /** 필요한 도구 중 없는 것 — 비어 있으면 쓸 수 있다 */
  missingTools(): Promise<string[]>;
  /** 이 Mac 의 디바이스 전부 (R20). 읽지 못하면 오류를 낸다 — 서버가 빈 목록으로 오해해 정보를 지우지 않게 */
  list(): Promise<Discovered[]>;
  /** 생성 원본으로 쓸 이 Mac 의 디바이스 — Corgi 가 만든 것도 포함 (서버가 가린다) */
  sources(): Promise<SourceDevice[]>;
  /** 내장 대표 프로필 — Android 만 (requirements M1) */
  presetSources?(): Promise<SourceDevice[]>;
  /** 직접 입력한 크기를 원본처럼 — Android 만 */
  customSource?(request: CustomRequest): Promise<SourceDevice>;
  /** 프로필·직접 입력에 쓸 시스템 이미지 — Android 만 */
  images?(): SystemImageInfo[];
  /** 원본과 같은 크기로 앱 없이 새로 만든다 (requirements «결정 기록») */
  create(
    input: { id: string; name: string; source: SourceDevice },
    progress: Progress,
  ): Promise<{ native: string }>;
  rename(device: Device, name: string): Promise<void>;
  remove(device: Device): Promise<void>;
  states(devices: Device[]): Promise<Map<string, RuntimeState>>;
  boot(device: Device, progress: Progress): Promise<RuntimeState>;
  shutdown(device: Device, state: RuntimeState): Promise<void>;
  slim(device: Device, progress: Progress): Promise<void>;
  unslim(device: Device, progress: Progress): Promise<void>;
  /** 켠 직후 할 일 — Android 는 슬림화된 기기의 기기 안 정리를 다시 한다 */
  afterBoot?(device: Device, state: RuntimeState, progress: Progress): Promise<void>;
  /** 켜진 디바이스의 지금 메모리 — 슬림 전 기준값을 잴 때 쓴다 */
  measure(
    device: Device,
    state: RuntimeState,
  ): Promise<{ memoryBytes?: number; processes?: number }>;
  /** 켜진 디바이스가 얼마나 슬림화됐는지 — 화면 표시용, 느릴 수 있어 서버가 뒤에서 읽어 둔다 */
  slimStats(devices: Device[], states: Map<string, RuntimeState>): Promise<Map<string, SlimStats>>;
  /** 켜져 있어야 알 수 있으면 undefined */
  checkSlim(device: Device, state: RuntimeState): Promise<SlimState | undefined>;
}
