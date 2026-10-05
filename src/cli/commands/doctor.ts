import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Command } from "commander";
import type { StatusResult } from "../../shared/api.ts";
import { call } from "../../shared/client.ts";
import { run, which } from "../../shared/exec.ts";
import { ExitCode } from "../../shared/exit-codes.ts";
import { t } from "../../shared/i18n.ts";
import { LAUNCH_LABEL } from "../../shared/paths.ts";
import { androidSdk, installHints } from "../../shared/tools.ts";
import { VERSION } from "../../shared/version.ts";
import { isAppInstalled } from "../app-bundle.ts";
import { CliError, type Context, output, type Run } from "../context.ts";
import { isInstalled } from "../launchd.ts";
import { skillStatus } from "../skill.ts";

// 설치 안내·연결 확인 (S1·S2). 서버가 꺼져 있어도 돌아야 하므로 서버 코드 없이 직접 본다.

type Status = "ok" | "warn" | "fail";

export interface Check {
  group: string;
  name: string;
  status: Status;
  detail: string;
  /** 고치는 방법 — 사람이 실행할 명령 */
  fix?: string;
  /** corgi doctor --fix 가 고칠 수 있는 것 */
  autofix?: "launchd" | "skill" | "app";
}

const MARK: Record<Status, string> = { ok: "✓", warn: "!", fail: "✗" };

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

export async function runChecks(ctx: Context): Promise<Check[]> {
  const checks: Check[] = [];
  const add = (check: Check) => checks.push(check);

  // 서버 — 자동 시작 없이 지금 상태를 본다
  const server = await call<StatusResult>(ctx.paths.socket, "status", {}, ctx.session).then(
    (r) => r,
    (error: unknown) => error as Error,
  );
  if (server instanceof Error) {
    add({
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
    group: "Android",
    name: t("doctor.images"),
    status: images.length > 0 ? "ok" : "fail",
    detail: images.length > 0 ? images.join(", ") : t("common.none"),
    fix: images.length > 0 ? undefined : installHints().systemImage,
  });
  const avdslim = which("avdslim");
  const avdslimVersion = avdslim ? await version([avdslim, "version"]) : undefined;
  add({
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
  const skill = await skillStatus();
  add({
    group: t("doctor.group.agents"),
    name: t("doctor.skill"),
    status: skill === "current" ? "ok" : "warn",
    detail:
      skill === "current"
        ? "~/.claude/skills/corgi"
        : skill === "missing"
          ? t("doctor.skill.missing")
          : t("doctor.skill.outdated"),
    fix: skill === "current" ? undefined : "corgi install --no-launchd",
    autofix: skill === "current" ? undefined : "skill",
  });

  const app = isAppInstalled(ctx.paths);
  add({
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
          if (needs.has("skill")) await (await import("../skill.ts")).installSkill();
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
