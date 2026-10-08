import { closeSync, existsSync, openSync, readSync } from "node:fs";
import { resolve } from "node:path";
import type { Command } from "commander";
import {
  compareVersions,
  currentBinary,
  installedVersions,
  isCompiled,
  linkPointsIntoVersions,
  previousBinary,
  versionOf,
} from "../../install/self.ts";
import { ExitCode } from "../../shared/exit-codes.ts";
import { t } from "../../shared/i18n.ts";
import { VERSION } from "../../shared/version.ts";
import { CliError, output, type Run } from "../context.ts";

// simless update — 설치 파일로 업데이트하고, 바로 전 버전으로 되돌린다 (R19). 서버 없이 돈다.
// 새 버전을 스스로 찾지는 않는다 — 확인할 곳이 정해지면 R27 로 더한다.

/** 설치 파일 머리 — scripts/build.ts 가 쓰는 줄과 같아야 한다 */
export const INSTALLER_MARK = "# simless-installer";

/** 설치 파일의 버전 — 설치 파일이 아니면 undefined */
export function installerVersion(path: string): string | undefined {
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(4096);
    const size = readSync(fd, buffer, 0, buffer.length, 0);
    const head = buffer.subarray(0, size).toString("utf8");
    if (!head.split("\n").slice(0, 3).includes(INSTALLER_MARK)) return undefined;
    return /^SIMLESS_VERSION=(\d+\.\d+\.\d+)$/m.exec(head)?.[1];
  } finally {
    closeSync(fd);
  }
}

/** 받은 출력을 그대로 보여 주며 실행하고 종료 코드를 돌려준다 — 인자 배열로만 (SECURITY.md §3) */
async function runVisible(command: string[]): Promise<number> {
  const proc = Bun.spawn(command, { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  return await proc.exited;
}

export function registerUpdate(program: Command, run: Run) {
  program
    .command("update")
    .description(t("cli.update"))
    .argument("[file]", t("cli.update.file"))
    .option("--rollback", t("cli.update.rollback"))
    .option("--force", t("cli.update.force"))
    .action(
      run(async (ctx, file: string | undefined, o: { rollback?: boolean; force?: boolean }) => {
        const installed = isCompiled() && linkPointsIntoVersions(ctx.paths);
        const previous = previousBinary(ctx.paths);
        if (!file && !o.rollback) {
          const data = {
            current: VERSION,
            installed,
            binary: installed ? currentBinary(ctx.paths) : undefined,
            versions: installedVersions(ctx.paths),
            previous: previous ? versionOf(ctx.paths, previous) : undefined,
          };
          output(ctx, data, () =>
            [
              t("cli.update.current", { version: VERSION }),
              installed
                ? t("cli.update.versions", { versions: data.versions.join(", ") })
                : t("cli.update.devMode"),
              data.previous ? t("cli.update.previous", { version: data.previous }) : "",
              t("cli.update.how"),
            ]
              .filter(Boolean)
              .join("\n"),
          );
          return;
        }
        if (!installed) throw new CliError(t("cli.update.devMode"), ExitCode.usage, "INVALID");

        if (o.rollback) {
          if (!previous)
            throw new CliError(t("cli.update.noPrevious"), ExitCode.failed, "NOT_FOUND");
          // 바로 전 버전으로 `install` 하면 그 버전이 링크를 되찾고 서버·앱·스킬을 맞춘다
          const code = await runVisible([previous, "install"]);
          if (code !== 0)
            throw new CliError(t("cli.update.failed", { code }), ExitCode.failed, "FAILED");
          return;
        }

        const path = resolve(file ?? "");
        if (!existsSync(path))
          throw new CliError(t("cli.update.noFile", { file: path }), ExitCode.usage, "INVALID");
        const version = installerVersion(path);
        if (!version)
          throw new CliError(
            t("cli.update.notInstaller", { file: path }),
            ExitCode.usage,
            "INVALID",
          );
        if (compareVersions(version, VERSION) <= 0 && !o.force)
          throw new CliError(
            t("cli.update.notNewer", { version, current: VERSION }),
            ExitCode.usage,
            "INVALID",
          );
        // 설치 파일이 안의 실행 파일을 확인(체크섬)하고 꺼내 `install` 한다 — 사람이 받은 파일을 bash 로 돌리는 것과 같다
        const code = await runVisible(["bash", path]);
        if (code !== 0)
          throw new CliError(t("cli.update.failed", { code }), ExitCode.failed, "FAILED");
      }),
    );
}
