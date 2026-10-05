import { createInterface } from "node:readline/promises";
import type { Command } from "commander";
import type { CatalogResult, DeviceOpResult, DeviceView } from "../../shared/api.ts";
import { ExitCode } from "../../shared/exit-codes.ts";
import { CliError, type Context, output, type Run, request } from "../context.ts";
import { catalogText, devicesTable } from "../format.ts";
import { acquire } from "./lease.ts";

/** 진행 알림은 stderr 로 — stdout 은 결과(또는 JSON)만 */
function showProgress(event: string, data: unknown): void {
  if (event === "progress") console.error(`… ${(data as { message: string }).message}`);
}

function call<T>(ctx: Context, method: string, params: unknown): Promise<T> {
  return request<T>(ctx, method, params, showProgress);
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
    .command("list")
    .description("이 Mac 의 디바이스 전부 — 켜짐·슬림·점유·argent ID (M5·R20)")
    .option("--platform <platform>", "android 또는 ios")
    .option("--created", "Corgi 가 만든 디바이스만")
    .action(
      run(async (ctx, o: { platform?: "android" | "ios"; created?: boolean }) => {
        const devices = (await call<DeviceView[]>(ctx, "device.list", {})).filter(
          (d) => (!o.platform || d.platform === o.platform) && (!o.created || d.createdByCorgi),
        );
        output(ctx, devices, () => devicesTable(devices));
      }),
    );

  program
    .command("catalog")
    .description("만들 수 있는 기종·OS 와 슬림화하면 꺼지는 것 (M1·M4)")
    .option("--platform <platform>", "android 또는 ios")
    .action(
      run(async (ctx, o: { platform?: "android" | "ios" }) => {
        const result = await call<CatalogResult>(ctx, "catalog", { platform: o.platform });
        output(ctx, result, () => catalogText(result));
      }),
    );

  program
    .command("create")
    .description(
      "기종 + OS 로 새 디바이스를 만든다 — 슬림이면 `corgi …` 이름, 앱은 설치하지 않는다 (R1·R5·M1·M4)",
    )
    .argument("[기종]", "기종 이름 또는 ID — corgi catalog")
    .option("--platform <platform>", "android 또는 ios (같은 이름의 기종이 양쪽에 있을 때)")
    .option("--os <os>", "iOS 런타임·Android 시스템 이미지 (기본: 최신·추천)")
    .option("--width <dp>", "직접 입력(Android) — 폭 dp")
    .option("--height <dp>", "직접 입력(Android) — 높이 dp")
    .option("--density <dpi>", "직접 입력(Android) — 밀도 (예: 320, 420)")
    .option("--name <이름>", "표시 이름 (기본: 슬림이면 corgi <기종>, 아니면 <기종>)")
    .option("--no-slim", "슬림화하지 않는다 — 일반 디바이스")
    .option("--no-baseline", "슬림 전 기준값(메모리)을 재지 않는다 — 1~2분 빨라진다")
    .action(
      run(
        async (
          ctx,
          model: string | undefined,
          o: {
            platform?: "android" | "ios";
            os?: string;
            width?: string;
            height?: string;
            density?: string;
            name?: string;
            slim: boolean;
            baseline: boolean;
          },
        ) => {
          const custom = o.width || o.height || o.density;
          if (custom && model)
            throw new CliError(
              "기종과 직접 입력(--width 등)은 함께 줄 수 없습니다",
              ExitCode.usage,
            );
          if (!custom && !model)
            throw new CliError(
              "기종을 주거나 --width·--height·--density 로 직접 입력하세요 — corgi catalog",
              ExitCode.usage,
            );
          const numbers = [o.width, o.height, o.density].map(Number);
          if (custom && numbers.some((n) => !Number.isFinite(n) || n <= 0)) {
            throw new CliError(
              "직접 입력은 --width·--height·--density 를 모두 양수로 주세요",
              ExitCode.usage,
            );
          }
          const device = await call<DeviceView>(ctx, "device.create", {
            platform: o.platform,
            model,
            custom: custom
              ? { widthDp: numbers[0], heightDp: numbers[1], density: numbers[2] }
              : undefined,
            os: o.os,
            name: o.name,
            slim: o.slim,
            baseline: o.baseline,
          });
          output(ctx, device, () => devicesTable([device]));
        },
      ),
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

  program
    .command("delete")
    .description(
      "Corgi 가 만든 디바이스를 지운다 — 켜져 있으면 끄고, 다른 세션이 쓰는 중이면 막는다 (M8)",
    )
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
    .argument("[devices...]", "디바이스 ID 또는 이름 (기본: Corgi 가 만든 것 전부)")
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
    .argument("<devices...>", "디바이스 ID 또는 이름")
    .option("--wait", "다른 세션이 쓰는 중이면 풀릴 때까지 기다린다")
    .option("--timeout <시간>", "기다리기 최대 시간 (예: 90s, 10m — 기본 10m)")
    .action(
      run(async (ctx, devices: string[], o: { wait?: boolean; timeout?: string }) => {
        const ids = await acquire(ctx, devices, o);
        finish(ctx, await call(ctx, "device.up", { devices: ids }), "켜기");
      }),
    );
}
