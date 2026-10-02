import type { Command } from "commander";
import type { StatusResult } from "../../shared/api.ts";
import { output, type Run, request } from "../context.ts";
import { devicesTable } from "../format.ts";

export function registerStatus(program: Command, run: Run) {
  program
    .command("status")
    .description("서버 연결·디바이스·점유를 한눈에 본다")
    .action(
      run(async (ctx) => {
        const status = await request<StatusResult>(ctx, "status", {});
        output(ctx, status, () => {
          const me = `이 세션: ${status.session.agent} (${status.session.key})`;
          const held = status.held.length > 0 ? `점유: ${status.held.join(", ")}` : "점유 없음";
          const queued = status.queuePosition ? ` · 대기 ${status.queuePosition}번째` : "";
          return `corgi 서버 ${status.serverVersion}\n${me} · ${held}${queued}\n\n${devicesTable(status.devices)}`;
        });
      }),
    );
}
