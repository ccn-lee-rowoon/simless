import { createInterface } from "node:readline/promises";
import type { Command } from "commander";
import type { CatalogResult, DeviceOpResult, DeviceView } from "../../shared/api.ts";
import { ExitCode } from "../../shared/exit-codes.ts";
import { CliError, type Context, output, type Run, request } from "../context.ts";
import { devicesTable, table } from "../format.ts";
import { acquire } from "./lease.ts";

/** 진행 알림은 stderr 로 — stdout 은 결과(또는 JSON)만 */
function showProgress(event: string, data: unknown): void {
  if (event === "progress") console.error(`… ${(data as { message: string }).message}`);
}

function call<T>(ctx: Context, method: string, params: unknown): Promise<T> {
  return request<T>(ctx, method, params, showProgress);
}

function number(name: string) {
  return (value: string) => {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0)
      throw new CliError(`${name} 은(는) 양수여야 합니다: ${value}`, ExitCode.usage);
    return n;
  };
}

/** 여러 대 작업 결과 — 하나라도 실패하면 종료 코드 1 */
function finish(
  ctx: Context,
  result: { results: DeviceOpResult[]; devices: DeviceView[] },
  verb: string,
): void {
  output(ctx, result, () => {
    const failed = result.results.filter((r) => !r.ok);
    const lines = failed.map((r) => `실패: ${r.name} — ${r.error}`);
    return [devicesTable(result.devices), ...lines].join("\n");
  });
  if (result.results.some((r) => !r.ok)) {
    throw new CliError(
      `${verb}에 실패한 디바이스가 있습니다`,
      ExitCode.failed,
      "FAILED",
      result.results,
    );
  }
}

async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const answer = await rl.question(`${question} [y/N] `);
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

export function registerDevices(program: Command, run: Run) {
  program
    .command("catalog")
    .description("만들 수 있는 목록 — 폭 순, 이미 만든 것은 «생성됨» (M1~M3)")
    .option("--platform <platform>", "android 또는 ios")
    .option("--all", "iOS 기기 종류를 프리셋 밖까지 모두 보기")
    .action(
      run(async (ctx, options: { platform?: "android" | "ios"; all?: boolean }) => {
        const result = await call<CatalogResult>(ctx, "catalog.list", {
          platform: options.platform,
        });
        const items = options.all
          ? result.items
          : result.items.filter((i) => i.preset || i.created);
        output(ctx, { ...result, items }, () => {
          const rows = items.map((i) => [
            i.label,
            i.suggestedName,
            i.detail,
            i.created ? `생성됨 (${i.created})` : "",
          ]);
          const problems = result.problems.map((p) => `주의(${p.platform}): ${p.message}`);
          const hint = options.all ? [] : ["", "iOS 기기 종류 전체: corgi catalog --all"];
          return [table(["크기", "이름 제안", "해상도", ""], rows), ...hint, ...problems].join(
            "\n",
          );
        });
      }),
    );

  const create = program
    .command("create")
    .description("디바이스를 만든다 — 기본으로 슬림화까지 (R1~R5, M4)");
  create
    .command("android")
    .description("Android 에뮬레이터 — 폭(dp)으로")
    .requiredOption("--width <dp>", "폭 (dp)", number("--width"))
    .option("--height <dp>", "높이 (dp, 기본: 프리셋 또는 폭 × 2.1)", number("--height"))
    .option("--density <dpi>", "밀도 (기본 320)", number("--density"))
    .option("--image <이미지>", "시스템 이미지 (예: android-36)")
    .option("--name <이름>", "표시 이름")
    .option("--no-slim", "슬림화하지 않는다")
    .action(
      run(
        async (
          ctx,
          o: {
            width: number;
            height?: number;
            density?: number;
            image?: string;
            name?: string;
            slim: boolean;
          },
        ) => {
          const device = await call<DeviceView>(ctx, "device.create", {
            request: {
              platform: "android",
              widthDp: o.width,
              heightDp: o.height,
              density: o.density,
              systemImage: o.image,
            },
            name: o.name,
            slim: o.slim,
          });
          output(ctx, device, () => devicesTable([device]));
        },
      ),
    );
  create
    .command("ios")
    .description("iOS 시뮬레이터 — 기기 종류로 (크기는 기기 종류가 정한다)")
    .requiredOption("--type <기기 종류>", '예: "iPhone 17" — corgi catalog --platform ios')
    .option("--runtime <버전>", "예: 26.5 (기본: 지원하는 가장 새 런타임)")
    .option("--name <이름>", "표시 이름")
    .option("--no-slim", "슬림화하지 않는다")
    .action(
      run(async (ctx, o: { type: string; runtime?: string; name?: string; slim: boolean }) => {
        const device = await call<DeviceView>(ctx, "device.create", {
          request: { platform: "ios", deviceType: o.type, runtime: o.runtime },
          name: o.name,
          slim: o.slim,
        });
        output(ctx, device, () => devicesTable([device]));
      }),
    );

  program
    .command("list")
    .description("만든 디바이스 — 켜짐·슬림·점유·argent ID (M5)")
    .action(
      run(async (ctx) => {
        const devices = await call<DeviceView[]>(ctx, "device.list", {});
        output(ctx, devices, () => devicesTable(devices));
      }),
    );

  program
    .command("rename")
    .description("이름을 바꾼다 — ID 는 그대로라 같은 디바이스로 실행된다 (R4)")
    .argument("<device>", "디바이스 ID 또는 이름")
    .argument("<name>", "새 이름")
    .action(
      run(async (ctx, device: string, name: string) => {
        const result = await call<DeviceView>(ctx, "device.rename", { device, name });
        output(ctx, result, () => devicesTable([result]));
      }),
    );

  for (const [command, enabled, description] of [
    ["enable", true, "다시 사용한다"],
    ["disable", false, "사용 안 함 — 일괄 동작에서 뺀다 (R6)"],
  ] as const) {
    program
      .command(command)
      .description(description)
      .argument("<device>", "디바이스 ID 또는 이름")
      .action(
        run(async (ctx, device: string) => {
          const result = await call<DeviceView>(ctx, "device.setEnabled", { device, enabled });
          output(ctx, result, () => devicesTable([result]));
        }),
      );
  }

  program
    .command("delete")
    .description("디바이스를 지운다 — 켜져 있으면 끄고, 다른 세션이 쓰는 중이면 막는다 (M8)")
    .argument("<device>", "디바이스 ID 또는 이름")
    .option("-y, --yes", "확인 없이 지운다")
    .action(
      run(async (ctx, device: string, o: { yes?: boolean }) => {
        if (!o.yes && !(await confirm(`${device} 를 지울까요? 되돌릴 수 없습니다.`))) {
          throw new CliError("지우지 않았습니다 (확인 없이 지우려면 --yes)", ExitCode.usage);
        }
        const result = await call<{ deleted: string }>(ctx, "device.delete", { device });
        output(ctx, result, () => `지웠습니다: ${result.deleted}`);
      }),
    );

  program
    .command("slim")
    .description("슬림화 — 적용(기본)·해제(--off)·확인(--check) (R5, M6)")
    .argument("[devices...]", "디바이스 ID 또는 이름 (기본: 전부)")
    .option("--off", "슬림 해제")
    .option("--check", "슬림 상태만 확인")
    .action(
      run(async (ctx, devices: string[], o: { off?: boolean; check?: boolean }) => {
        const mode = o.check ? "check" : o.off ? "off" : "on";
        finish(ctx, await call(ctx, "device.slim", { devices, mode }), "슬림");
      }),
    );

  program
    .command("up")
    .description("점유한 디바이스를 켠다 (R7)")
    .argument("[devices...]", "디바이스 ID 또는 이름 (기본: 이 세션이 점유한 것 전부)")
    .action(
      run(async (ctx, devices: string[]) =>
        finish(ctx, await call(ctx, "device.up", { devices }), "켜기"),
      ),
    );

  program
    .command("down")
    .description("점유한 디바이스를 끈다")
    .argument("[devices...]", "디바이스 ID 또는 이름 (기본: 이 세션이 점유한 것 전부)")
    .action(
      run(async (ctx, devices: string[]) =>
        finish(ctx, await call(ctx, "device.down", { devices }), "끄기"),
      ),
    );

  program
    .command("use")
    .description("점유하고 켠다 — 주 흐름의 첫 단계 (R15)")
    .argument("[devices...]", "디바이스 ID 또는 이름 (기본: 사용 중인 디바이스 전부)")
    .option("--wait", "다른 세션이 쓰는 중이면 풀릴 때까지 기다린다")
    .option("--timeout <시간>", "기다리기 최대 시간 (예: 90s, 10m — 기본 10m)")
    .action(
      run(async (ctx, devices: string[], o: { wait?: boolean; timeout?: string }) => {
        const ids = await acquire(ctx, devices, o);
        finish(ctx, await call(ctx, "device.up", { devices: ids }), "켜기");
      }),
    );
}
