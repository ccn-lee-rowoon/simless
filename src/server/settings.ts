import { z } from "zod";
import type { SettingsResult } from "../shared/api.ts";
import { saveSettings } from "../shared/config.ts";
import type { SimlessServer } from "./app.ts";
import { parse } from "./params.ts";

// 설정 메서드 (M11·R25) — 설정 창·`simless config` 가 부른다. config.json 에 바뀐 값만 쓰고 바로 반영한다.
// 설정을 하나 더하려면: config.ts 의 Config·SettingsPatch·saveSettings → 여기의 SettingsParams·settings·apply
// → SettingsResult(api.ts) → 설정 창(SettingsView)·`simless config` 키(config.ts) (docs/development.md)

const SettingsParams = z.object({
  language: z.enum(["system", "ko", "en"]).optional(),
  idleReleaseMinutes: z
    .number()
    .positive()
    .max(24 * 60)
    .optional(),
  historyRetentionDays: z.number().int().min(1).max(3650).optional(),
  androidRamMb: z.number().int().min(1024).max(16384).optional(),
  simslimProfile: z.string().nullable().optional(),
});

export function registerSettingsMethods(server: SimlessServer): void {
  const settings = (): SettingsResult => {
    const { config } = server;
    return {
      language: config.language,
      idleReleaseMinutes: config.idleReleaseMinutes,
      historyRetentionDays: config.historyRetentionDays,
      androidRamMb: config.android.ramMb,
      simslimProfile: config.ios.simslimProfile,
    };
  };

  server.addMethod("settings.get", async () => settings());

  /** 설정 파일에 쓰고 바로 반영한다 — 드라이버는 같은 설정 객체를 보므로 값만 바꾼다 */
  server.addMethod("settings.set", async (p) => {
    const next = saveSettings(server.paths.config, parse(SettingsParams, p));
    const { config } = server;
    config.language = next.language;
    config.idleReleaseMinutes = next.idleReleaseMinutes;
    config.historyRetentionDays = next.historyRetentionDays;
    config.android.ramMb = next.android.ramMb;
    config.ios.simslimProfile = next.ios.simslimProfile;
    server.leases.setIdleMs(next.idleReleaseMinutes * 60_000);
    server.history.setRetentionDays(next.historyRetentionDays);
    server.applyLanguage();
    return settings();
  });
}
