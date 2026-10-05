import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Command } from "commander";
import type { CheckView, StatusResult } from "../../shared/api.ts";
import { call } from "../../shared/client.ts";
import { run, which } from "../../shared/exec.ts";
import { ExitCode } from "../../shared/exit-codes.ts";
import { t } from "../../shared/i18n.ts";
import { LAUNCH_LABEL } from "../../shared/paths.ts";
import { androidSdk, installHints } from "../../shared/tools.ts";
import { VERSION } from "../../shared/version.ts";
import { isAppInstalled } from "../app-bundle.ts";
import { hookStatus, ruleStatus, ruleTarget, settingsPath } from "../claude-hook.ts";
import { CliError, type Context, output, type Run } from "../context.ts";
import { isInstalled, selfCommand } from "../launchd.ts";
import { combineStates, loadSkillLocations, locationStatus } from "../skill.ts";
import { locationText } from "./skill.ts";

// 설치 안내·연결 확인 (S1·S2). 서버가 꺼져 있어도 돌아야 하므로 서버 코드 없이 직접 본다.

export type Check = CheckView;

const MARK: Record<Check["status"], string> = { ok: "✓", warn: "!", fail: "✗" };

async function version(command: string[]): Promise<string | undefined> {
  const result = await run(command, { timeoutMs: 5000 });
  return result.code === 0 ? result.stdout.trim().split("\n")[0] : undefined;
}

/** brew 로 설치한 도구 중 새 버전이 있는 것 — brew 가 없으면 빈 목록 */
async function brewOutdated(names: string[]): Promise<Map<string, string>> {
  const brew = which("brew");
  const outdated = new Map<string, string>();
  if (!brew) return outdated;
  const result = await run([brew, "outdated", "--json=v2", "--formula", ...names], {
    timeoutMs: 20_000,
  });
  try {
    const json = JSON.parse(result.stdout) as {
      formulae: { name: string; current_version: string }[];
    };
    for (const f of json.formulae)
      outdated.set(f.name.split("/").at(-1) ?? f.name, f.current_version);
  } catch {
    // 설치 안 된 이름이 섞이면 brew 가 JSON 대신 오류를 낸다 — 버전 비교만 건너뛴다
  }
  return outdated;
}

function pathDirs(): string[] {
  return (process.env.PATH ?? "").split(":").filter(Boolean);
}

/**
 * 점검 목록. 서버 안에서 부를 때(첫 실행 설정 창, M14)는 자기 소켓에 묻지 않도록 serverVersion 을 준다.
 */
export async function runChecks(
  ctx: Pick<Context, "paths" | "config" | "session">,
  options: { serverVersion?: string } = {},
): Promise<Check[]> {
  const checks: Check[] = [];
  const add = (check: Check) => checks.push(check);

  // 서버 — 자동 시작 없이 지금 상태를 본다
  const server =
    options.serverVersion !== undefined
      ? { serverVersion: options.serverVersion }
      : await call<StatusResult>(ctx.paths.socket, "status", {}, ctx.session).then(
          (r) => r,
          (error: unknown) => error as Error,
        );
  if (server instanceof Error) {
    add({
      id: "server",
      group: t("doctor.group.server"),
      name: t("doctor.server"),
      status: "fail",
      detail: t("doctor.server.down", { path: ctx.paths.socket }),
      fix: isInstalled(ctx.paths)
        ? `launchctl kickstart gui/${process.getuid?.()}/${LAUNCH_LABEL}`
        : "corgi install",
    });
  } else {
    const same = server.serverVersion === VERSION;
    add({
      id: "server",
      group: t("doctor.group.server"),
      name: t("doctor.server"),
      status: same ? "ok" : "warn",
      detail: same
        ? `corgi ${VERSION}`
        : t("doctor.server.mismatch", { server: server.serverVersion, cli: VERSION }),
      fix: same ? undefined : t("doctor.server.restart"),
    });
  }
  if (!isInstalled(ctx.paths)) {
    add({
      id: "launchd",
      group: t("doctor.group.server"),
      name: t("doctor.launchd"),
      status: "warn",
      detail: t("doctor.launchd.missing"),
      fix: "corgi install",
      autofix: "launchd",
    });
  } else {
    const printed = await run(["launchctl", "print", `gui/${process.getuid?.()}/${LAUNCH_LABEL}`]);
    const running = /state = running/.test(printed.stdout);
    add({
      id: "launchd",
      group: t("doctor.group.server"),
      name: t("doctor.launchd"),
      status: running ? "ok" : "warn",
      detail: running ? ctx.paths.launchAgent : t("doctor.launchd.notRunning"),
      fix: running ? undefined : "corgi install",
      autofix: running ? undefined : "launchd",
    });
  }

  const outdated = await brewOutdated(["avdslim", "simslim"]);

  // Android
  const sdk = androidSdk(ctx.config);
  const sdkOk =
    existsSync(join(sdk, "platform-tools", "adb")) && existsSync(join(sdk, "emulator", "emulator"));
  add({
    id: "androidSdk",
    group: "Android",
    name: "Android SDK",
    status: sdkOk ? "ok" : "fail",
    detail: sdkOk ? sdk : t("doctor.sdk.missing", { path: sdk }),
    fix: sdkOk ? undefined : installHints().androidSdk,
  });
  const imagesDir = join(sdk, "system-images");
  const images = existsSync(imagesDir)
    ? readdirSync(imagesDir).filter((d) => !d.startsWith("."))
    : [];
  add({
    id: "images",
    group: "Android",
    name: t("doctor.images"),
    status: images.length > 0 ? "ok" : "fail",
    detail: images.length > 0 ? images.join(", ") : t("common.none"),
    fix: images.length > 0 ? undefined : installHints().systemImage,
  });
  const avdslim = which("avdslim");
  const avdslimVersion = avdslim ? await version([avdslim, "version"]) : undefined;
  add({
    id: "avdslim",
    group: "Android",
    name: "avdslim",
    status: !avdslim ? "fail" : outdated.has("avdslim") ? "warn" : "ok",
    detail: !avdslim
      ? t("doctor.avdslim.missing")
      : `${avdslimVersion ?? avdslim}${outdated.has("avdslim") ? t("doctor.newer", { version: outdated.get("avdslim") ?? "" }) : ""}`,
    fix: !avdslim
      ? installHints().avdslim
      : outdated.has("avdslim")
        ? "brew upgrade avdslim"
        : undefined,
  });

  // iOS
  const simctl = await run(["xcrun", "simctl", "help"], { timeoutMs: 10_000 });
  add({
    id: "xcode",
    group: "iOS",
    name: "Xcode simctl",
    status: simctl.code === 0 ? "ok" : "fail",
    detail:
      simctl.code === 0
        ? ((await version(["xcodebuild", "-version"])) ?? t("doctor.present"))
        : t("common.none"),
    fix: simctl.code === 0 ? undefined : installHints().xcode,
  });
  const simslim = which("simslim");
  const simslimVersion = simslim ? await version([simslim, "version"]) : undefined;
  add({
    id: "simslim",
    group: "iOS",
    name: "simslim",
    status: !simslim ? "fail" : outdated.has("simslim") ? "warn" : "ok",
    detail: !simslim
      ? t("doctor.simslim.missing")
      : `${simslimVersion ?? simslim}${outdated.has("simslim") ? t("doctor.newer", { version: outdated.get("simslim") ?? "" }) : ""}`,
    fix: !simslim
      ? installHints().simslim
      : outdated.has("simslim")
        ? "brew upgrade simslim"
        : undefined,
  });

  // 에이전트 연동
  const argents = [
    ...new Set(
      pathDirs()
        .map((d) => join(d, "argent"))
        .filter((p) => existsSync(p)),
    ),
  ];
  const versions = await Promise.all(
    argents.map(async (p) => `${p} (${(await version([p, "--version"])) ?? "?"})`),
  );
  const distinct = new Set(versions.map((v) => v.replace(/^.* \(/, "")));
  add({
    id: "argent",
    group: t("doctor.group.agents"),
    name: "argent",
    status: argents.length === 0 ? "warn" : distinct.size > 1 ? "warn" : "ok",
    detail:
      argents.length === 0
        ? t("doctor.argent.missing")
        : distinct.size > 1
          ? t("doctor.argent.many", { versions: versions.join(" · ") })
          : (versions[0] ?? ""),
    fix:
      argents.length === 0
        ? installHints().argent
        : distinct.size > 1
          ? t("doctor.argent.fix")
          : undefined,
  });
  const skillViews = await Promise.all(
    loadSkillLocations(ctx.paths.skills).map((l) => locationStatus(l)),
  );
  const skill = combineStates(skillViews.map((v) => v.state));
  add({
    id: "skill",
    group: t("doctor.group.agents"),
    name: t("doctor.skill"),
    status: skill === "current" ? "ok" : "warn",
    detail:
      skill === "current"
        ? skillViews.map((v) => locationText(v.location)).join(" · ")
        : skill === "missing"
          ? t("doctor.skill.missing")
          : t("doctor.skill.outdated"),
    fix: skill === "current" ? undefined : "corgi skill install",
    autofix: skill === "current" ? undefined : "skill",
  });

  const hook = hookStatus(selfCommand());
  add({
    id: "hook",
    group: t("doctor.group.agents"),
    name: t("doctor.hook"),
    status: hook === "current" ? "ok" : "warn",
    detail:
      hook === "current"
        ? settingsPath()
        : hook === "missing"
          ? t("doctor.hook.missing")
          : t("doctor.hook.outdated"),
    // 보호는 고르는 것이다 (M14) — 없으면 안내만, 예전 것이면 고친다
    fix: hook === "current" ? undefined : "corgi install --no-launchd --no-app --hook",
    autofix: hook === "outdated" ? "hook" : undefined,
  });
  const rule = await ruleStatus();
  add({
    id: "rule",
    group: t("doctor.group.agents"),
    name: t("doctor.rule"),
    status: rule === "current" ? "ok" : "warn",
    detail:
      rule === "current"
        ? ruleTarget()
        : rule === "missing"
          ? t("doctor.skill.missing")
          : t("doctor.skill.outdated"),
    fix: rule === "current" ? undefined : "corgi install --no-launchd --no-app --hook",
    autofix: rule === "outdated" ? "hook" : undefined,
  });

  const app = isAppInstalled(ctx.paths);
  add({
    id: "app",
    group: t("doctor.group.agents"),
    name: "Corgi.app",
    status: app ? "ok" : "warn",
    detail: app ? ctx.paths.appBundle : t("doctor.app.missing"),
    fix: app ? undefined : "corgi install",
    autofix: app ? undefined : "app",
  });

  return checks;
}

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
          if (needs.has("launchd")) await (await import("../launchd.ts")).install(ctx.paths);
          if (needs.has("skill")) {
            const { installSkillAt } = await import("../skill.ts");
            for (const l of loadSkillLocations(ctx.paths.skills)) await installSkillAt(l);
          }
          if (needs.has("hook")) {
            const { installHook, installRule } = await import("../claude-hook.ts");
            installHook(selfCommand());
            await installRule();
          }
          if (needs.has("app"))
            await (await import("../app-bundle.ts")).installApp(ctx.paths, ctx.config);
          if (needs.size > 0) checks = await runChecks(ctx);
        }
        output(ctx, checks, () => render(checks));
        if (checks.some((c) => c.status === "fail")) {
          throw new CliError(t("doctor.failed"), ExitCode.failed, "DOCTOR_FAILED", checks);
        }
      }),
    );
}
