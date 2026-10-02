import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";

const AndroidPreset = z.object({
  widthDp: z.number().positive(),
  heightDp: z.number().positive(),
  density: z.number().int().positive(),
});

/** 사용자 설정 `~/.config/corgi/config.json` — 없는 값은 기본값. */
export const Config = z.object({
  /** 마지막 사용 후 이 시간이 지나고 기다리는 세션이 있으면 점유를 푼다 (R17) */
  idleReleaseMinutes: z.number().positive().default(30),
  httpPort: z.number().int().positive().default(8791),
  android: z
    .object({
      /** 비우면 ANDROID_HOME → ANDROID_SDK_ROOT → ~/Library/Android/sdk */
      sdkPath: z.string().optional(),
      /** 비우면 설치된 이미지 중 API 가 가장 높은 것 */
      systemImage: z.string().optional(),
      ramMb: z.number().int().positive().default(2048),
      emulatorArgs: z
        .array(z.string())
        .default(["-no-snapshot-save", "-no-boot-anim", "-no-audio"]),
      /** 밀도 320(2배)이면 dp 가 정수 px 로 정확히 떨어진다 (Q2) */
      presets: z.array(AndroidPreset).default([
        { widthDp: 320, heightDp: 640, density: 320 },
        { widthDp: 360, heightDp: 760, density: 320 },
        { widthDp: 412, heightDp: 892, density: 320 },
        { widthDp: 600, heightDp: 960, density: 320 },
      ]),
    })
    .prefault({}),
  ios: z
    .object({
      /** simslim `--profile` JSON 경로. 비우면 simslim 기본 프로필 */
      simslimProfile: z.string().optional(),
      /** catalog 에서 먼저 보여 줄 기기 종류 이름 (Q1) */
      presets: z
        .array(z.string())
        .default([
          "iPhone SE (3rd generation)",
          "iPhone 17",
          "iPhone 17 Pro Max",
          "iPad mini (A17 Pro)",
        ]),
    })
    .prefault({}),
  session: z
    .object({
      /** 세션을 찾을 때 건너뛸 셸·래퍼 이름 추가 (docs/design.md §7) */
      extraShells: z.array(z.string()).default([]),
      /** 공용 호스트(터미널·IDE) 이름 추가 */
      extraHosts: z.array(z.string()).default([]),
    })
    .prefault({}),
});
export type Config = z.infer<typeof Config>;

export function loadConfig(path: string): Config {
  if (!existsSync(path)) return Config.parse({});
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  const parsed = Config.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`설정 파일이 잘못됐습니다 (${path}):\n${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}
