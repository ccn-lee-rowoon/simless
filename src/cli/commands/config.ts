import type { Command } from "commander";
import type { SettingsResult } from "../../shared/api.ts";
import { ExitCode } from "../../shared/exit-codes.ts";
import { t } from "../../shared/i18n.ts";
import { CliError, output, type Run, request } from "../context.ts";

/** CLI 이름 → settings.set 매개변수. 값은 문자열로 받아 바꾼다 */
const KEYS = {
  language: (v: string) => {
    if (v !== "system" && v !== "ko" && v !== "en") throw new Error("system | ko | en");
    return { language: v };
  },
  idleReleaseMinutes: (v: string) => ({ idleReleaseMinutes: Number(v) }),
  "android.ramMb": (v: string) => ({ androidRamMb: Number(v) }),
  "ios.simslimProfile": (v: string) => ({ simslimProfile: v === "" ? null : v }),
} as const;

function rows(settings: SettingsResult): string {
  return [
    `language = ${settings.language}`,
    `idleReleaseMinutes = ${settings.idleReleaseMinutes}`,
    `android.ramMb = ${settings.androidRamMb}`,
    `ios.simslimProfile = ${settings.simslimProfile ?? ""}`,
  ].join("\n");
}

export function registerConfig(program: Command, run: Run) {
  program
    .command("config")
    .description(t("cli.config"))
    .argument("[key]", t("cli.config.key"))
    .argument("[value]", t("cli.config.value"))
    .action(
      run(async (ctx, key: string | undefined, value: string | undefined) => {
        if (key === undefined) {
          const settings = await request<SettingsResult>(ctx, "settings.get", {});
          output(ctx, settings, () => rows(settings));
          return;
        }
        const parse = KEYS[key as keyof typeof KEYS];
        if (!parse)
          throw new CliError(`${key}: ${Object.keys(KEYS).join(" | ")}`, ExitCode.usage, "INVALID");
        if (value === undefined) {
          const settings = await request<SettingsResult>(ctx, "settings.get", {});
          const line = rows(settings)
            .split("\n")
            .find((l) => l.startsWith(`${key} =`));
          output(ctx, settings, () => line ?? "");
          return;
        }
        let patch: object;
        try {
          patch = parse(value);
        } catch (error) {
          throw new CliError(`${key}: ${(error as Error).message}`, ExitCode.usage, "INVALID");
        }
        const settings = await request<SettingsResult>(ctx, "settings.set", patch);
        output(ctx, settings, () => t("cli.config.set", { key, value }));
      }),
    );
}
