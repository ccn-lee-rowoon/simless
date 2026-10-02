import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Command } from "commander";
import type { StatusResult } from "../../shared/api.ts";
import { call } from "../../shared/client.ts";
import { run, which } from "../../shared/exec.ts";
import { ExitCode } from "../../shared/exit-codes.ts";
import { LAUNCH_LABEL } from "../../shared/paths.ts";
import { androidSdk, INSTALL_HINTS } from "../../shared/tools.ts";
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
      group: "서버",
      name: "서버 연결",
      status: "fail",
      detail: `연결 못 함 (${ctx.paths.socket})`,
      fix: isInstalled(ctx.paths)
        ? `launchctl kickstart gui/${process.getuid?.()}/${LAUNCH_LABEL}`
        : "corgi install",
    });
  } else {
    const same = server.serverVersion === VERSION;
    add({
      group: "서버",
      name: "서버 연결",
      status: same ? "ok" : "warn",
      detail: same
        ? `corgi ${VERSION}`
        : `서버 ${server.serverVersion} · CLI ${VERSION} — 버전이 다름`,
      fix: same ? undefined : "corgi install (서버를 새 버전으로 다시 시작)",
    });
  }
  if (!isInstalled(ctx.paths)) {
    add({
      group: "서버",
      name: "launchd 등록",
      status: "warn",
      detail: "없음 — 로그인 시 서버가 자동으로 켜지지 않는다",
      fix: "corgi install",
      autofix: "launchd",
    });
  } else {
    const printed = await run(["launchctl", "print", `gui/${process.getuid?.()}/${LAUNCH_LABEL}`]);
    const running = /state = running/.test(printed.stdout);
    add({
      group: "서버",
      name: "launchd 등록",
      status: running ? "ok" : "warn",
      detail: running
        ? ctx.paths.launchAgent
        : "등록돼 있지만 실행 중이 아님 — 시스템 설정 → 일반 → 로그인 항목 의 «앱 백그라운드 활동» 에서 꺼져 있을 수 있다",
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
    detail: sdkOk ? sdk : `adb·emulator 가 없음 (${sdk})`,
    fix: sdkOk ? undefined : INSTALL_HINTS.androidSdk,
  });
  const imagesDir = join(sdk, "system-images");
  const images = existsSync(imagesDir)
    ? readdirSync(imagesDir).filter((d) => !d.startsWith("."))
    : [];
  add({
    group: "Android",
    name: "시스템 이미지",
    status: images.length > 0 ? "ok" : "fail",
    detail: images.length > 0 ? images.join(", ") : "없음",
    fix: images.length > 0 ? undefined : INSTALL_HINTS.systemImage,
  });
  const avdslim = which("avdslim");
  const avdslimVersion = avdslim ? await version([avdslim, "version"]) : undefined;
  add({
    group: "Android",
    name: "avdslim",
    status: !avdslim ? "fail" : outdated.has("avdslim") ? "warn" : "ok",
    detail: !avdslim
      ? "없음 — Android 슬림화(R5)를 못 한다"
      : `${avdslimVersion ?? avdslim}${outdated.has("avdslim") ? ` → ${outdated.get("avdslim")} 있음` : ""}`,
    fix: !avdslim
      ? INSTALL_HINTS.avdslim
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
    detail: simctl.code === 0 ? ((await version(["xcodebuild", "-version"])) ?? "있음") : "없음",
    fix: simctl.code === 0 ? undefined : INSTALL_HINTS.xcode,
  });
  const simslim = which("simslim");
  const simslimVersion = simslim ? await version([simslim, "version"]) : undefined;
  add({
    group: "iOS",
    name: "simslim",
    status: !simslim ? "fail" : outdated.has("simslim") ? "warn" : "ok",
    detail: !simslim
      ? "없음 — iOS 슬림화(R5)를 못 한다"
      : `${simslimVersion ?? simslim}${outdated.has("simslim") ? ` → ${outdated.get("simslim")} 있음` : ""}`,
    fix: !simslim
      ? INSTALL_HINTS.simslim
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
    group: "에이전트 연동",
    name: "argent",
    status: argents.length === 0 ? "warn" : distinct.size > 1 ? "warn" : "ok",
    detail:
      argents.length === 0
        ? "없음 — 화면 조작·스크린샷을 argent 로 한다 (S6)"
        : distinct.size > 1
          ? `여러 버전이 PATH 에 있음 — 먼저 잡히는 것: ${versions.join(" · ")}`
          : (versions[0] ?? ""),
    fix:
      argents.length === 0
        ? INSTALL_HINTS.argent
        : distinct.size > 1
          ? "하나만 남기고 지우거나 PATH 순서를 정리"
          : undefined,
  });
  const skill = await skillStatus();
  add({
    group: "에이전트 연동",
    name: "Corgi 스킬",
    status: skill === "current" ? "ok" : "warn",
    detail:
      skill === "current"
        ? "~/.claude/skills/corgi"
        : skill === "missing"
          ? "설치 안 됨"
          : "이 corgi 에 든 스킬과 다름 (예전 버전)",
    fix: skill === "current" ? undefined : "corgi install --no-launchd",
    autofix: skill === "current" ? undefined : "skill",
  });

  const app = isAppInstalled(ctx.paths);
  add({
    group: "에이전트 연동",
    name: "Corgi.app",
    status: app ? "ok" : "warn",
    detail: app
      ? ctx.paths.appBundle
      : "없음 — 더블클릭·Spotlight 로 웹 UI 를 열 수 없다 (corgi ui 는 된다)",
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
  lines.push("", fails + warns === 0 ? "모두 정상입니다." : `문제 ${fails}개 · 주의 ${warns}개`);
  if (checks.some((c) => c.autofix))
    lines.push("corgi doctor --fix 로 고칠 수 있는 항목이 있습니다 (launchd 등록·스킬·Corgi.app).");
  return lines.join("\n");
}

export function registerDoctor(program: Command, run: Run) {
  program
    .command("doctor")
    .description("설치·연결을 점검하고 고치는 방법을 알려 준다 (S1·S2)")
    .option("--fix", "corgi install 로 고칠 수 있는 것(launchd 등록·스킬·Corgi.app)은 고친다")
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
          throw new CliError("고쳐야 할 항목이 있습니다", ExitCode.failed, "DOCTOR_FAILED", checks);
        }
      }),
    );
}
