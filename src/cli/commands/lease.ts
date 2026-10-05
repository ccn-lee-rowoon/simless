import type { Command } from "commander";
import type { AcquireResult, BusyData, HistoryEvent, LeaseItem } from "../../shared/api.ts";
import { ExitCode } from "../../shared/exit-codes.ts";
import { language, t } from "../../shared/i18n.ts";
import { CliError, type Context, output, type Run, request } from "../context.ts";
import { formatHolder } from "../format.ts";

function parseDuration(text: string): number {
  const match = /^(\d+)(ms|s|m|h)?$/.exec(text.trim());
  if (!match) throw new CliError(t("cli.badDuration", { text }), ExitCode.usage);
  const value = Number(match[1]);
  const unit = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[
    (match[2] ?? "s") as "ms" | "s" | "m" | "h"
  ];
  return value * unit;
}

export interface AcquireOptions {
  group?: string;
  /** commander: 값 없이 주면 true */
  default?: string | boolean;
  available?: boolean;
  /** 기본 디바이스를 달라는데 그 플랫폼에 디바이스가 없으면 만든다 */
  create?: boolean;
  wait?: boolean;
  timeout?: string;
}

/** acquire·use 공통 옵션 */
export function acquireOptions(command: Command): Command {
  return command
    .option("--group <group>", t("cli.opt.group"))
    .option("--default [platform]", t("cli.opt.default"))
    .option("--available", t("cli.opt.available"))
    .option("--create", t("cli.opt.create"))
    .option("--wait", t("cli.opt.wait"))
    .option("--timeout <duration>", t("cli.opt.timeout"));
}

function itemLine(item: LeaseItem): string {
  const state = t(`cli.lease.${item.state}`);
  const who = item.holder ? ` — ${formatHolder(item.holder)}` : "";
  return `  ${item.deviceId} ${item.name}: ${state}${who}`;
}

/**
 * 점유 — 바쁘면 바로 실패(3), --wait 면 차례가 올 때까지 기다린다 (R14).
 * --available 이면 비어 있는 것만 잡고(일부만이면 종료 코드 0), 하나도 못 잡으면 3.
 */
export async function acquire(
  ctx: Context,
  devices: string[],
  options: AcquireOptions,
): Promise<AcquireResult & { status: "granted" | "partial" }> {
  const result = await request<AcquireResult>(
    ctx,
    "lease.acquire",
    {
      devices,
      group: options.group,
      default:
        options.default === undefined
          ? undefined
          : options.default === true
            ? "both"
            : options.default,
      mode: options.available ? "available" : "all",
      create: options.create ?? false,
      wait: options.wait ?? false,
      timeoutMs: options.timeout ? parseDuration(options.timeout) : undefined,
    },
    (event, data) => {
      if (event === "progress" && !ctx.json)
        console.error(`… ${(data as { message: string }).message}`);
      if (event === "queued" && !ctx.json) {
        const { position, holders } = data as { position: number } & BusyData;
        console.error(
          `${t("cli.queued", { position })}\n${holders.map((h) => `  ${formatHolder(h)}`).join("\n")}`,
        );
      }
    },
  );
  if (result.status === "queued") {
    throw new CliError(
      t("cli.stillQueued", { position: result.position }),
      ExitCode.busy,
      "QUEUED",
      result,
    );
  }
  if (result.status === "partial" && !ctx.json) {
    const rest = result.queued ? t("cli.partial.queued") : t("cli.partial.busy");
    console.error(`${t("cli.partial", { rest })}\n${result.devices.map(itemLine).join("\n")}`);
  }
  return result;
}

export function registerLease(program: Command, run: Run) {
  const acquireCommand = program
    .command("acquire")
    .description(t("cli.acquire"))
    .argument("[devices...]", t("cli.arg.devices"));
  acquireOptions(acquireCommand).action(
    run(async (ctx: Context, devices: string[], options: AcquireOptions) => {
      const result = await acquire(ctx, devices, options);
      output(ctx, result, () => t("cli.acquired", { ids: result.deviceIds.join(", ") }));
    }),
  );

  program
    .command("release")
    .description(t("cli.release"))
    .argument("[devices...]", t("cli.arg.devices"))
    .action(
      run(async (ctx: Context, devices: string[]) => {
        const result = await request<{ released: string[] }>(ctx, "lease.release", {
          devices: devices.length > 0 ? devices : undefined,
        });
        output(ctx, result, () =>
          result.released.length > 0
            ? t("cli.released", { ids: result.released.join(", ") })
            : t("cli.nothingToRelease"),
        );
      }),
    );

  program
    .command("history")
    .description(t("cli.history"))
    .option("--session <key>", t("cli.history.session"))
    .option("--limit <n>", t("cli.history.limit"), "50")
    .action(
      run(async (ctx: Context, o: { session?: string; limit: string }) => {
        const events = await request<HistoryEvent[]>(ctx, "lease.history", {
          session: o.session,
          limit: Math.min(500, Math.max(1, Number(o.limit) || 50)),
        });
        output(ctx, events, () =>
          events.length === 0
            ? t("cli.history.empty")
            : events
                .map(
                  (e) =>
                    `${new Date(e.at).toLocaleString(language() === "ko" ? "ko-KR" : "en-US")}  ${e.human ? t("common.human") : e.agent} (${e.sessionKey})  ${t(`web.history.${e.kind}`)}: ${e.deviceIds.join(", ")}`,
                )
                .join("\n"),
        );
      }),
    );

  program
    .command("who")
    .description(t("cli.who"))
    .argument("[target]", t("cli.who.target"))
    .action(
      run(async (ctx: Context, target: string | undefined) => {
        const rows = await request<
          { deviceId: string; name: string; holder?: Parameters<typeof formatHolder>[0] }[]
        >(ctx, "lease.who", { target });
        output(ctx, rows, () =>
          rows
            .map(
              (r) =>
                `${r.deviceId} ${r.name}: ${r.holder ? formatHolder(r.holder) : t("cli.who.free")}`,
            )
            .join("\n"),
        );
      }),
    );
}
