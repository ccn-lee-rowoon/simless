import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { CheckView, StatusResult } from "../shared/api.ts";
import { call } from "../shared/client.ts";
import type { Config } from "../shared/config.ts";
import { run as defaultRun, which as defaultWhich, type Runner } from "../shared/exec.ts";
import { t } from "../shared/i18n.ts";
import { LAUNCH_LABEL, type Paths } from "../shared/paths.ts";
import type { SessionInfo } from "../shared/protocol.ts";
import { androidSdk, installHints } from "../shared/tools.ts";
import { VERSION } from "../shared/version.ts";
import { isAppInstalled } from "./app-bundle.ts";
import { hookStatus, ruleStatus, ruleTarget, settingsPath } from "./claude-hook.ts";
import { isInstalled, selfCommand } from "./launchd.ts";
import { combineStates, loadSkillLocations, locationStatus, locationText } from "./skill.ts";

// 설치·연결 점검 (S1·S2) — `simless doctor` 와 첫 실행 설정 창(M14)이 같이 쓴다.
// 서버가 꺼져 있어도 돌아야 하므로 서버 코드 없이 직접 본다. 서버 안에서 부를 때는 serverVersion 을 준다.

export type Check = CheckView;

/** 이 Mac 을 보는 방법 — 테스트는 가짜 명령·HOME 으로 바꾼다 */
export interface Probe {
  run: Runner;
  which: (name: string) => string | undefined;
  env: NodeJS.ProcessEnv;
}

async function version(probe: Probe, command: string[]): Promise<string | undefined> {
  const result = await probe.run(command, { timeoutMs: 5000 });
  return result.code === 0 ? result.stdout.trim().split("\n")[0] : undefined;
}

/** brew 로 설치한 도구 중 새 버전이 있는 것 — brew 가 없으면 빈 목록 */
async function brewOutdated(probe: Probe, names: string[]): Promise<Map<string, string>> {
  const { run, which } = probe;
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

function pathDirs(env: NodeJS.ProcessEnv): string[] {
  return (env.PATH ?? "").split(":").filter(Boolean);
}

/**
 * 점검 목록. 서버 안에서 부를 때(첫 실행 설정 창, M14)는 자기 소켓에 묻지 않도록 serverVersion 을 준다.
 */
export async function runChecks(
  ctx: { paths: Paths; config: Config; session: SessionInfo },
  options: { serverVersion?: string; probe?: Partial<Probe> } = {},
): Promise<Check[]> {
  const env = options.probe?.env ?? process.env;
  const probe: Probe = {
    run: options.probe?.run ?? defaultRun,
    which: options.probe?.which ?? ((name) => defaultWhich(name, env)),
    env,
  };
  const { run, which } = probe;
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
        : "simless install",
    });
  } else {
    const same = server.serverVersion === VERSION;
    add({
      id: "server",
      group: t("doctor.group.server"),
      name: t("doctor.server"),
      status: same ? "ok" : "warn",
      detail: same
        ? `simless ${VERSION}`
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
      fix: "simless install",
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
      fix: running ? undefined : "simless install",
      autofix: running ? undefined : "launchd",
    });
  }

  const outdated = await brewOutdated(probe, ["avdslim", "simslim"]);

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
    action: sdkOk ? undefined : { fix: "androidStudio.open", kind: "open" },
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
    action: images.length > 0 ? undefined : { fix: "androidStudio.open", kind: "open" },
  });
  const avdslim = which("avdslim");
  const avdslimVersion = avdslim ? await version(probe, [avdslim, "version"]) : undefined;
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
    action: !avdslim
      ? { fix: "avdslim.install", kind: "install" }
      : outdated.has("avdslim")
        ? { fix: "avdslim.upgrade", kind: "update" }
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
        ? ((await version(probe, ["xcodebuild", "-version"])) ?? t("doctor.present"))
        : t("common.none"),
    fix: simctl.code === 0 ? undefined : installHints().xcode,
    action: simctl.code === 0 ? undefined : { fix: "xcode.open", kind: "open" },
  });
  const simslim = which("simslim");
  const simslimVersion = simslim ? await version(probe, [simslim, "version"]) : undefined;
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
    action: !simslim
      ? { fix: "simslim.install", kind: "install" }
      : outdated.has("simslim")
        ? { fix: "simslim.upgrade", kind: "update" }
        : undefined,
  });

  // 에이전트 연동
  const argents = [
    ...new Set(
      pathDirs(env)
        .map((d) => join(d, "argent"))
        .filter((p) => existsSync(p)),
    ),
  ];
  const versions = await Promise.all(
    argents.map(async (p) => `${p} (${(await version(probe, [p, "--version"])) ?? "?"})`),
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
    action: argents.length === 0 ? { fix: "argent.install", kind: "install" } : undefined,
  });
  const skillViews = await Promise.all(
    loadSkillLocations(ctx.paths.skills).map((l) => locationStatus(l, env)),
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
    fix: skill === "current" ? undefined : "simless skill install",
    autofix: skill === "current" ? undefined : "skill",
  });

  const hook = hookStatus(selfCommand(), env);
  add({
    id: "hook",
    group: t("doctor.group.agents"),
    name: t("doctor.hook"),
    status: hook === "current" ? "ok" : "warn",
    detail:
      hook === "current"
        ? settingsPath(env)
        : hook === "missing"
          ? t("doctor.hook.missing")
          : t("doctor.hook.outdated"),
    // 보호는 고르는 것이다 (M14) — 없으면 안내만, 예전 것이면 고친다
    fix: hook === "current" ? undefined : "simless install --no-launchd --no-app --hook",
    autofix: hook === "outdated" ? "hook" : undefined,
  });
  const rule = await ruleStatus(env);
  add({
    id: "rule",
    group: t("doctor.group.agents"),
    name: t("doctor.rule"),
    status: rule === "current" ? "ok" : "warn",
    detail:
      rule === "current"
        ? ruleTarget(env)
        : rule === "missing"
          ? t("doctor.skill.missing")
          : t("doctor.skill.outdated"),
    fix: rule === "current" ? undefined : "simless install --no-launchd --no-app --hook",
    autofix: rule === "outdated" ? "hook" : undefined,
  });

  const app = isAppInstalled(ctx.paths);
  add({
    id: "app",
    group: t("doctor.group.agents"),
    name: "Simless.app",
    status: app ? "ok" : "warn",
    detail: app ? ctx.paths.appBundle : t("doctor.app.missing"),
    fix: app ? undefined : "simless install",
    autofix: app ? undefined : "app",
  });

  return checks;
}
