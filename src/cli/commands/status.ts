import type { Command } from "commander";
import { isPrimaryDevice, type StatusResult } from "../../shared/api.ts";
import { t } from "../../shared/i18n.ts";
import { output, type Run, request } from "../context.ts";
import { devicesTable } from "../format.ts";

export function registerStatus(program: Command, run: Run) {
  program
    .command("status")
    .description(t("cli.status"))
    .action(
      run(async (ctx) => {
        const status = await request<StatusResult>(ctx, "status", {});
        output(ctx, status, () => {
          const me = t("cli.status.session", {
            agent: status.session.agent,
            key: status.session.key,
          });
          const held =
            status.held.length > 0
              ? t("cli.status.held", { ids: status.held.join(", ") })
              : t("cli.status.noneHeld");
          const queued = status.queuePosition
            ? t("cli.status.queued", { position: status.queuePosition })
            : "";
          const server = t("cli.status.server", { version: status.serverVersion });
          // 이 Mac 의 기기 전부는 길다 — 먼저 볼 것만 표로, 나머지는 수만 (M5)
          const primary = status.devices.filter(isPrimaryDevice);
          const others = status.devices.length - primary.length;
          const more = others > 0 ? `\n${t("cli.status.others", { count: others })}` : "";
          return `${server}\n${me} · ${held}${queued}\n\n${devicesTable(primary)}${more}`;
        });
      }),
    );
}
