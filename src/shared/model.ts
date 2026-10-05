import { z } from "zod";

export const Platform = z.enum(["android", "ios"]);
export type Platform = z.infer<typeof Platform>;

/** M6 — 미적용 / 진행 중 / 적용됨 / 풀림 / 실패 */
export const SlimState = z.enum(["none", "applying", "applied", "drifted", "failed"]);
export type SlimState = z.infer<typeof SlimState>;

export const AndroidSpec = z.object({
  platform: z.literal("android"),
  widthPx: z.number().int().positive(),
  heightPx: z.number().int().positive(),
  density: z.number().int().positive(),
  /** 예: system-images/android-36/google_apis_playstore/arm64-v8a/ */
  systemImage: z.string(),
});

export const IosSpec = z.object({
  platform: z.literal("ios"),
  deviceTypeId: z.string(),
  deviceTypeName: z.string(),
  runtimeId: z.string(),
  runtimeName: z.string(),
  widthPt: z.number().positive(),
  heightPt: z.number().positive(),
  scale: z.number().positive(),
});

export const DeviceSpec = z.discriminatedUnion("platform", [AndroidSpec, IosSpec]);
export type DeviceSpec = z.infer<typeof DeviceSpec>;

/**
 * 디바이스에 Corgi 가 붙인 정보 — registry 에 저장한다 (docs/design.md §6).
 * 기기 자체(이름·크기)는 저장하지 않고 드라이버에서 그때그때 읽는다 (R20).
 */
export const DeviceMeta = z.object({
  /** Corgi 가 붙이는 ID. 절대 안 바뀐다 (R4) */
  id: z.string(),
  platform: Platform,
  /** Android AVD ID 또는 iOS UDID — 이름을 바꿔도 그대로. 기기와 이 정보를 잇는다 */
  native: z.string(),
  /** Corgi 가 만든 디바이스 — 삭제·슬림 켜고 끄기는 이것만 (M7·M8·N5) */
  createdByCorgi: z.boolean(),
  slim: SlimState,
  slimError: z.string().optional(),
  /** 슬림하기 전에 잰 기준값 — 슬림 후 메모리와 비교한다 (M10) */
  slimBaseline: z
    .object({
      memoryBytes: z.number().optional(),
      processes: z.number().optional(),
      measuredAt: z.string(),
    })
    .optional(),
  /** 디바이스 메모 — 로그인한 계정 등 (R24) */
  memo: z.string().optional(),
  /** Corgi 가 처음 본(또는 만든) 시각 */
  createdAt: z.string(),
});
export type DeviceMeta = z.infer<typeof DeviceMeta>;

/** 용도별 디바이스 묶음 (R21). 한 디바이스가 여러 그룹에 들 수 있다 */
export const Group = z.object({
  id: z.string(),
  /** 겹치지 않는다 */
  name: z.string().min(1),
  /** 사람·에이전트가 읽는 설명 — «모두 필요» 같은 힌트도 여기에 (R23) */
  description: z.string().default(""),
  deviceIds: z.array(z.string()),
  /** 마지막으로 고친 쪽 — `human` 또는 에이전트 이름 */
  updatedBy: z.string(),
  updatedAt: z.string(),
});
export type Group = z.infer<typeof Group>;

/** 플랫폼마다 기본 디바이스 하나 (R22) */
export const Defaults = z.object({ android: z.string().optional(), ios: z.string().optional() });
export type Defaults = z.infer<typeof Defaults>;

/** 이 Mac 의 디바이스 하나 — 드라이버가 읽은 기기 + Corgi 가 붙인 정보 */
export interface Device extends DeviceMeta {
  /** 표시 이름 — Android `avd.ini.displayname`, iOS 시뮬레이터 이름. 바꿀 수 있다 (R3) */
  name: string;
  spec: DeviceSpec;
}

/** RN 레이아웃이 받는 폭 — Android dp, iOS pt (M2) */
export function layoutWidth(spec: DeviceSpec): number {
  return spec.platform === "android" ? (spec.widthPx * 160) / spec.density : spec.widthPt;
}

export function layoutHeight(spec: DeviceSpec): number {
  return spec.platform === "android" ? (spec.heightPx * 160) / spec.density : spec.heightPt;
}

/** 보고서·스크린샷에 붙이는 크기 라벨. 예: `Android 360dp`, `iOS 402pt` */
export function sizeLabel(spec: DeviceSpec): string {
  const width = Math.round(layoutWidth(spec) * 100) / 100;
  return spec.platform === "android" ? `Android ${width}dp` : `iOS ${width}pt`;
}
