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

/** 만든 디바이스 1대 — registry 에 저장 (docs/design.md §6) */
export const Device = z.object({
  /** Corgi 가 붙이는 ID. 절대 안 바뀐다 (R4) */
  id: z.string(),
  /** 표시 이름. 바꿀 수 있다 (R3) */
  name: z.string(),
  /** Android AVD ID(`corgi_<id>`) 또는 iOS UDID — 이름을 바꿔도 그대로 */
  native: z.string(),
  spec: DeviceSpec,
  /** false = 사용 안 함, 일괄 동작에서 빠진다 (R6) */
  enabled: z.boolean(),
  slim: SlimState,
  slimError: z.string().optional(),
  createdAt: z.string(),
});
export type Device = z.infer<typeof Device>;

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
