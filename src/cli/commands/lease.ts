import type { Command } from "commander";
import type { AcquireResult, BusyData, LeaseItem } from "../../shared/api.ts";
import { ExitCode } from "../../shared/exit-codes.ts";
import { CliError, type Context, output, type Run, request } from "../context.ts";
import { formatHolder } from "../format.ts";

function parseDuration(text: string): number {
  const match = /^(\d+)(ms|s|m|h)?$/.exec(text.trim());
  if (!match)
    throw new CliError(`시간 형식이 잘못됐습니다: ${text} (예: 90s, 10m)`, ExitCode.usage);
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
  wait?: boolean;
  timeout?: string;
}

/** acquire·use 공통 옵션 */
export function acquireOptions(command: Command): Command {
  return command
    .option("--group <group>", "그룹의 디바이스 전부 (R21)")
    .option("--default [platform]", "기본 디바이스 — android·ios, 안 주면 둘 다 (R22)")
    .option("--available", "비어 있는 것만 잡는다 — 바쁜 것은 상태만 알려 준다 (R23)")
    .option(
      "--wait",
      "다른 세션이 쓰는 중이면 풀릴 때까지 기다린다 (--available 과 함께면 나머지만)",
    )
    .option("--timeout <시간>", "기다리기 최대 시간 (예: 90s, 10m — 기본 10m)");
}

function itemLine(item: LeaseItem): string {
  const state = { held: "점유함", queued: "대기 중", busy: "사용 중", free: "비어 있음" }[
    item.state
  ];
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
      wait: options.wait ?? false,
      timeoutMs: options.timeout ? parseDuration(options.timeout) : undefined,
    },
    (event, data) => {
      if (event === "queued" && !ctx.json) {
        const { position, holders } = data as { position: number } & BusyData;
        console.error(
          `대기 중 — ${position}번째\n${holders.map((h) => `  ${formatHolder(h)}`).join("\n")}`,
        );
      }
    },
  );
  if (result.status === "queued") {
    throw new CliError(
      `아직 대기 중입니다 (${result.position}번째). 순번은 유지됩니다 — 다시 --wait 로 이어서 기다리세요`,
      ExitCode.busy,
      "QUEUED",
      result,
    );
  }
  if (result.status === "partial" && !ctx.json) {
    const rest = result.queued
      ? "나머지는 빌 때마다 서버가 잡아 줍니다 — corgi status 로 확인, 잡히면 corgi up"
      : "나머지는 다른 세션이 쓰는 중입니다";
    console.error(`일부만 점유했습니다. ${rest}\n${result.devices.map(itemLine).join("\n")}`);
  }
  return result;
}

export function registerLease(program: Command, run: Run) {
  const acquireCommand = program
    .command("acquire")
    .description("디바이스를 점유한다 — 디바이스·그룹·기본 디바이스로")
    .argument("[devices...]", "디바이스 ID 또는 이름");
  acquireOptions(acquireCommand).action(
    run(async (ctx: Context, devices: string[], options: AcquireOptions) => {
      const result = await acquire(ctx, devices, options);
      output(ctx, result, () => `점유했습니다: ${result.deviceIds.join(", ")}`);
    }),
  );

  program
    .command("release")
    .description("점유를 푼다 (지정하지 않으면 이 세션의 점유·대기 전부)")
    .argument("[devices...]", "디바이스 ID 또는 이름")
    .action(
      run(async (ctx: Context, devices: string[]) => {
        const result = await request<{ released: string[] }>(ctx, "lease.release", {
          devices: devices.length > 0 ? devices : undefined,
        });
        output(ctx, result, () =>
          result.released.length > 0
            ? `풀었습니다: ${result.released.join(", ")}`
            : "풀 점유가 없습니다",
        );
      }),
    );

  program
    .command("who")
    .description("누가 쓰는 중인지 본다")
    .argument("[target]", "디바이스 ID·이름·UDID·시리얼")
    .action(
      run(async (ctx: Context, target: string | undefined) => {
        const rows = await request<
          { deviceId: string; name: string; holder?: Parameters<typeof formatHolder>[0] }[]
        >(ctx, "lease.who", { target });
        output(ctx, rows, () =>
          rows
            .map(
              (r) => `${r.deviceId} ${r.name}: ${r.holder ? formatHolder(r.holder) : "비어 있음"}`,
            )
            .join("\n"),
        );
      }),
    );
}
