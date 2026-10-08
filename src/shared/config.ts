import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";

/** 사용자 설정 `~/.config/simless/config.json` — 없는 값은 기본값. */
export const Config = z.object({
  /** 화면·CLI 언어 — system 이면 macOS 언어 설정을 따른다 (R25) */
  language: z.enum(["system", "ko", "en"]).default("system"),
  /** 마지막 사용 후 이 시간이 지나고 기다리는 세션이 있으면 점유를 푼다 (R17) */
  idleReleaseMinutes: z.number().positive().default(30),
  /** 점유 기록을 남겨 두는 날 수 — 지난 것은 서버가 지운다 (M13) */
  historyRetentionDays: z.number().int().positive().default(90),
  httpPort: z.number().int().positive().default(8791),
  /** 슬림 전 기준값을 잴 때 켜고 나서 기다리는 시간 — 백그라운드 서비스가 다 뜰 때까지 */
  slimBaselineSettleSeconds: z.number().nonnegative().default(45),
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

/** 설정 화면·`simless config set` 이 바꾸는 값 (M11) */
export interface SettingsPatch {
  language?: Config["language"];
  idleReleaseMinutes?: number;
  historyRetentionDays?: number;
  androidRamMb?: number;
  simslimProfile?: string | null;
}

/**
 * 설정 파일에 바뀐 값만 쓴다 — 사람이 손으로 넣은 다른 키는 그대로 둔다.
 * 검증을 통과한 새 설정을 돌려준다.
 */
export function saveSettings(path: string, patch: SettingsPatch): Config {
  const raw = (existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {}) as Record<
    string,
    unknown
  >;
  const android = { ...((raw.android as Record<string, unknown>) ?? {}) };
  const ios = { ...((raw.ios as Record<string, unknown>) ?? {}) };
  if (patch.language !== undefined) raw.language = patch.language;
  if (patch.idleReleaseMinutes !== undefined) raw.idleReleaseMinutes = patch.idleReleaseMinutes;
  if (patch.historyRetentionDays !== undefined)
    raw.historyRetentionDays = patch.historyRetentionDays;
  if (patch.androidRamMb !== undefined) android.ramMb = patch.androidRamMb;
  if (patch.simslimProfile !== undefined) {
    if (patch.simslimProfile) ios.simslimProfile = patch.simslimProfile;
    else delete ios.simslimProfile;
  }
  const next = { ...raw, android, ios };
  const parsed = Config.parse(next);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  // 예전에 755·644 로 만든 것도 — 같은 그룹 사용자가 읽지 못하게
  chmodSync(dirname(path), 0o700);
  chmodSync(path, 0o600);
  return parsed;
}

export function loadConfig(path: string): Config {
  if (!existsSync(path)) return Config.parse({});
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  const parsed = Config.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`설정 파일이 잘못됐습니다 (${path}):\n${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}
