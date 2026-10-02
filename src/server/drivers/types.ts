import type { SlimStats } from "../../shared/api.ts";
import type { Device, DeviceSpec, Platform, SlimState } from "../../shared/model.ts";

/** 켜짐 여부 — 저장하지 않고 매번 드라이버에게 묻는다 */
export interface RuntimeState {
  booted: boolean;
  /** argent·adb 에 넘기는 ID — iOS UDID, Android `emulator-<port>` */
  targetId?: string;
}

/** 이 Mac 의 디바이스 하나 — 복제 원본 후보 (M1) */
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

export interface Driver {
  readonly platform: Platform;
  /** 필요한 도구 중 없는 것 — 비어 있으면 쓸 수 있다 */
  missingTools(): Promise<string[]>;
  /** 이 Mac 의 디바이스 전부 — Corgi 가 만든 것도 포함 (서버가 가린다) */
  sources(): Promise<SourceDevice[]>;
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
  /** 켜진 디바이스가 얼마나 슬림화됐는지 — 화면 표시용, 느릴 수 있어 서버가 뒤에서 읽어 둔다 */
  slimStats(devices: Device[], states: Map<string, RuntimeState>): Promise<Map<string, SlimStats>>;
  /** 켜져 있어야 알 수 있으면 undefined */
  checkSlim(device: Device, state: RuntimeState): Promise<SlimState | undefined>;
}
