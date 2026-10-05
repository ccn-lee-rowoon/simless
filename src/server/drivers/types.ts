import type { PlatformCatalog, SlimStats } from "../../shared/api.ts";
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

export type Progress = (message: string) => void;

/** 무엇을 만들지 — 기종(또는 직접 입력) + OS (M1) */
export interface ModelRequest {
  /** 기종 ID 또는 이름 */
  model?: string;
  /** 직접 입력 — Android 만 */
  custom?: { widthDp: number; heightDp: number; density: number };
  /** OS ID 또는 이름 — 비우면 기본값 */
  os?: string;
}

export interface Driver {
  readonly platform: Platform;
  /** 필요한 도구 중 없는 것 — 비어 있으면 쓸 수 있다 */
  missingTools(): Promise<string[]>;
  /** 이 Mac 의 디바이스 전부 (R20). 읽지 못하면 오류를 낸다 — 서버가 빈 목록으로 오해해 정보를 지우지 않게 */
  list(): Promise<Discovered[]>;
  /** 만들 수 있는 기종·OS 와 슬림화하면 꺼지는 것 (M1·M4) */
  catalog(): Promise<PlatformCatalog>;
  /** 기종·OS 를 크기·이미지(또는 기기 종류·런타임)로 바꾼다. 없거나 맞지 않으면 NOT_FOUND·INVALID */
  resolve(request: ModelRequest): Promise<{ spec: DeviceSpec; modelName: string }>;
  /** 앱 없이 새로 만든다 (requirements «결정 기록») */
  create(
    input: { id: string; name: string; spec: DeviceSpec },
    progress: Progress,
  ): Promise<{ native: string }>;
  rename(device: Device, name: string): Promise<void>;
  remove(device: Device): Promise<void>;
  states(devices: Device[]): Promise<Map<string, RuntimeState>>;
  boot(device: Device, progress: Progress): Promise<RuntimeState>;
  shutdown(device: Device, state: RuntimeState): Promise<void>;
  /** 켜진 디바이스에 앱을 설치한다 — iOS 는 .app, Android 는 .apk (R26) */
  install(device: Device, state: RuntimeState, path: string): Promise<void>;
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
