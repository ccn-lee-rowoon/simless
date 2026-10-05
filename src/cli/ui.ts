import { existsSync, readFileSync } from "node:fs";
import { run } from "../shared/exec.ts";
import { ExitCode } from "../shared/exit-codes.ts";
import { t } from "../shared/i18n.ts";
import { CliError, type Context, request } from "./context.ts";

/** 서버를 깨우고(필요하면 launchd 로 켬) 토큰을 붙인 웹 UI 주소를 연다 */
export async function openUi(ctx: Context, options: { open: boolean }): Promise<string> {
  await request(ctx, "status", {});
  // 서버가 처음 켜질 때 토큰을 만든다 — 잠깐 기다린다
  for (let i = 0; i < 20 && !existsSync(ctx.paths.webToken); i++) await Bun.sleep(100);
  if (!existsSync(ctx.paths.webToken)) {
    throw new CliError(t("cli.ui.noToken", { path: ctx.paths.webToken }), ExitCode.failed);
  }
  const token = readFileSync(ctx.paths.webToken, "utf8").trim();
  const url = `http://127.0.0.1:${ctx.config.httpPort}/#token=${token}`;
  if (options.open) {
    const opened = await run(["open", url]);
    if (opened.code !== 0)
      throw new CliError(t("cli.ui.openFailed", { error: opened.stderr.trim() }), ExitCode.failed);
  }
  return url;
}
