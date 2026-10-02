import type { Device, DeviceSpec, Platform, SlimState } from "../../shared/model.ts";

/** 켜짐 여부 — 저장하지 않고 매번 드라이버에게 묻는다 */
export interface RuntimeState {
  booted: boolean;
  /** argent·adb 에 넘기는 ID — iOS UDID, Android `emulator-<port>` */
  targetId?: string;
}

/** 만들 수 있는 항목 하나 (M1~M3) */
export interface CatalogItem {
  platform: Platform;
  spec: DeviceSpec;
  /** 기본 이름 제안 (M4) */
  suggestedName: string;
  /** 보조 표시 — 해상도·밀도·런타임 (M2) */
  detail: string;
  /** 설정의 프리셋에 있는 항목 */
  preset: boolean;
}

export type Progress = (message: string) => void;

/** CLI 가 주는 생성 조건 — 드라이버가 실제 spec 으로 바꾼다 */
export type CreateRequest =
  | {
      platform: "android";
      widthDp: number;
      heightDp?: number;
      density?: number;
      systemImage?: string;
    }
  | { platform: "ios"; deviceType: string; runtime?: string };

export interface Driver {
  readonly platform: Platform;
  /** 필요한 도구 중 없는 것 — 비어 있으면 쓸 수 있다 */
  missingTools(): Promise<string[]>;
  catalog(): Promise<CatalogItem[]>;
  resolveSpec(request: CreateRequest): Promise<DeviceSpec>;
  create(
    input: { id: string; name: string; spec: DeviceSpec },
    progress: Progress,
  ): Promise<{ native: string }>;
  rename(device: Device, name: string): Promise<void>;
  remove(device: Device): Promise<void>;
  states(devices: Device[]): Promise<Map<string, RuntimeState>>;
  boot(device: Device, progress: Progress): Promise<RuntimeState>;
  shutdown(device: Device, state: RuntimeState): Promise<void>;
  slim(device: Device, progress: Progress): Promise<void>;
  unslim(device: Device, progress: Progress): Promise<void>;
  /** 켜져 있어야 알 수 있으면 undefined */
  checkSlim(device: Device, state: RuntimeState): Promise<SlimState | undefined>;
}
