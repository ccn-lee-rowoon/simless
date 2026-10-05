import type { Command } from "commander";
import { type Check, runChecks } from "../../install/checks.ts";
import { selfCommand } from "../../install/launchd.ts";
import { loadSkillLocations } from "../../install/skill.ts";
import { ExitCode } from "../../shared/exit-codes.ts";
import { t } from "../../shared/i18n.ts";
import { CliError, type Context, output, type Run } from "../context.ts";

// corgi doctor (S1·S2) — 점검은 install/checks.ts, 여기서는 보여 주고 --fix 로 고친다.

const MARK: Record<Check["status"], string> = { ok: "✓", warn: "!", fail: "✗" };

function render(checks: Check[]): string {
  const lines: string[] = [];
  let group = "";
  for (const check of checks) {
    if (check.group !== group) {
      group = check.group;
      lines.push(lines.length > 0 ? `\n${group}` : group);
    }
    lines.push(`  ${MARK[check.status]} ${check.name} — ${check.detail}`);
    if (check.fix) lines.push(`      → ${check.fix}`);
  }
  const fails = checks.filter((c) => c.status === "fail").length;
  const warns = checks.filter((c) => c.status === "warn").length;
  lines.push("", fails + warns === 0 ? t("doctor.allGood") : t("doctor.summary", { fails, warns }));
  if (checks.some((c) => c.autofix)) lines.push(t("doctor.canFix"));
  return lines.join("\n");
}

export function registerDoctor(program: Command, run: Run) {
  program
    .command("doctor")
    .description(t("doctor.description"))
    .option("--fix", t("doctor.fix"))
    .action(
      run(async (ctx: Context, o: { fix?: boolean }) => {
        let checks = await runChecks(ctx);
        if (o.fix) {
          const needs = new Set(checks.flatMap((c) => (c.autofix ? [c.autofix] : [])));
          if (needs.has("launchd"))
            await (await import("../../install/launchd.ts")).install(ctx.paths);
          if (needs.has("skill")) {
            const { installSkillAt } = await import("../../install/skill.ts");
            for (const l of loadSkillLocations(ctx.paths.skills)) await installSkillAt(l);
          }
          if (needs.has("hook")) {
            const { installHook, installRule } = await import("../../install/claude-hook.ts");
            installHook(selfCommand());
            await installRule();
          }
          if (needs.has("app"))
            await (await import("../../install/app-bundle.ts")).installApp(ctx.paths, ctx.config);
          if (needs.size > 0) checks = await runChecks(ctx);
        }
        output(ctx, checks, () => render(checks));
        if (checks.some((c) => c.status === "fail")) {
          throw new CliError(t("doctor.failed"), ExitCode.failed, "DOCTOR_FAILED", checks);
        }
      }),
    );
}
