import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";

/** 사용자 설정 `~/.config/corgi/config.json` — 없는 값은 기본값. */
export const Config = z.object({
  /** 마지막 사용 후 이 시간이 지나고 기다리는 세션이 있으면 점유를 푼다 (R17) */
  idleReleaseMinutes: z.number().positive().default(30),
  httpPort: z.number().int().positive().default(8791),
  android: z
    .object({
      /** 비우면 ANDROID_HOME → ANDROID_SDK_ROOT → ~/Library/Android/sdk */
      sdkPath: z.string().optional(),
      ramMb: z.number().int().positive().default(2048),
      emulatorArgs: z
        .array(z.string())
        .default(["-no-snapshot-save", "-no-boot-anim", "-no-audio"]),
    })
    .prefault({}),
  ios: z
    .object({
      /** simslim `--profile` JSON 경로. 비우면 simslim 기본 프로필 */
      simslimProfile: z.string().optional(),
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
