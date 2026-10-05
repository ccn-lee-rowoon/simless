import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { Command } from "commander";
import {
  installSkillAt,
  loadSkillLocations,
  locationStatus,
  locationText,
  sameLocation,
  saveSkillLocations,
  uninstallSkillAt,
} from "../../install/skill.ts";
import type { SkillLocation } from "../../shared/api.ts";
import { ExitCode } from "../../shared/exit-codes.ts";
import { t } from "../../shared/i18n.ts";
import { CliError, output, type Run } from "../context.ts";

// simless skill — 스킬을 넣는 곳(전역·프로젝트)과 상태 (S9). 서버 없이 돈다.

function projectLocation(path: string): SkillLocation {
  const absolute = resolve(path.replace(/^~(?=\/|$)/, homedir()));
  if (!existsSync(absolute) || !statSync(absolute).isDirectory())
    throw new CliError(t("setup.noFolder", { path }), ExitCode.usage, "INVALID");
  return { kind: "project", path: absolute };
}

export function registerSkill(program: Command, run: Run) {
  const skill = program.command("skill").description(t("cli.skill"));

  skill
    .command("status")
    .description(t("cli.skill.status"))
    .action(
      run(async (ctx) => {
        const views = await Promise.all(
          loadSkillLocations(ctx.paths.skills).map((l) => locationStatus(l)),
        );
        output(ctx, views, () =>
          views
            .map(
              (v) =>
                `${locationText(v.location)} — ${t(`web.setup.state.${v.state}`)}${v.location.kind === "project" ? ` (${t("cli.skill.worktrees", { count: v.targets })})` : ""}`,
            )
            .join("\n"),
        );
      }),
    );

  skill
    .command("install")
    .description(t("cli.skill.install"))
    .option("--project <dir...>", t("cli.skill.project"))
    .option("--global", t("cli.skill.global"))
    .action(
      run(async (ctx, o: { project?: string[]; global?: boolean }) => {
        const old = loadSkillLocations(ctx.paths.skills);
        const next: SkillLocation[] = o.project
          ? o.project.map(projectLocation)
          : o.global
            ? [{ kind: "global" }]
            : old;
        for (const l of old) if (!next.some((n) => sameLocation(n, l))) await uninstallSkillAt(l);
        const files: string[] = [];
        for (const l of next) files.push(...(await installSkillAt(l)));
        saveSkillLocations(ctx.paths.skills, next);
        output(ctx, { files }, () =>
          files.map((f) => t("cli.install.done", { what: "skill", path: f })).join("\n"),
        );
      }),
    );

  skill
    .command("uninstall")
    .description(t("cli.skill.uninstall"))
    .action(
      run(async (ctx) => {
        for (const l of loadSkillLocations(ctx.paths.skills)) await uninstallSkillAt(l);
        output(ctx, { removed: true }, () => t("cli.skill.removed"));
      }),
    );
}
