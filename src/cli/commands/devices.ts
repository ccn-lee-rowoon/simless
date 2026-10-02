import { createInterface } from "node:readline/promises";
import type { Command } from "commander";
import type { DeviceOpResult, DeviceView, SourceListResult } from "../../shared/api.ts";
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
    .description(
      "만든 디바이스 — 켜짐·슬림·점유·argent ID (M5). --all 이면 이 Mac 의 전체 목록 (M9)",
    )
    .option("--all", "이 Mac 의 모든 에뮬레이터·시뮬레이터 — 복제 원본 (M1)")
    .option("--platform <platform>", "android 또는 ios (--all 과 함께)")
    .action(
      run(async (ctx, o: { all?: boolean; platform?: "android" | "ios" }) => {
        if (!o.all) {
          const devices = await call<DeviceView[]>(ctx, "device.list", {});
          output(ctx, devices, () => devicesTable(devices));
          return;
        }
        const result = await call<SourceListResult>(ctx, "source.list", { platform: o.platform });
        output(ctx, result, () => {
          const row = (i: SourceListResult["items"][number]) => [
            i.label,
            i.name,
            i.booted ? "켜짐" : "꺼짐",
            i.managed ? `Corgi ${i.managed}` : i.created ? `만든 것 있음 (${i.created})` : "",
            i.detail,
            i.native,
          ];
          const devices = result.items.filter((i) => i.kind === "device").map(row);
          const profiles = result.items.filter((i) => i.kind === "profile").map(row);
          const problems = result.problems.map((p) => `주의(${p.platform}): ${p.message}`);
          const header = ["크기", "이름", "상태", "", "기기", "원본 ID"];
          return [
            ...(devices.length > 0 ? ["iOS 시뮬레이터 (이 Mac)", table(header, devices), ""] : []),
            ...(profiles.length > 0
              ? ["Android 대표 프로필 (Corgi 내장)", table(header, profiles), ""]
              : []),
            "만들기: corgi create <이름 또는 원본 ID>",
            "직접 입력(Android): corgi create --width <dp> --height <dp> --density <dpi> [--image <이미지>]",
            ...problems,
          ].join("\n");
        });
      }),
    );

  program
    .command("create")
    .description(
      "이 Mac 의 디바이스를 원본으로 같은 크기의 `corgi …` 복제본을 만들고 슬림화한다 — 앱은 설치하지 않는다 (R1·R5·M1·M4)",
    )
    .argument("[원본]", "원본 이름 또는 원본 ID(AVD ID·UDID·profile:…) — corgi list --all")
    .option("--width <dp>", "직접 입력(Android) — 폭 dp")
    .option("--height <dp>", "직접 입력(Android) — 높이 dp")
    .option("--density <dpi>", "직접 입력(Android) — 밀도 (예: 320, 420)")
    .option("--image <이미지>", "직접 입력(Android) — 시스템 이미지 (기본: 권장 이미지)")
    .option("--name <이름>", "표시 이름 (기본: corgi <원본 이름>)")
    .option("--no-slim", "슬림화하지 않는다")
    .option("--no-baseline", "슬림 전 기준값(메모리)을 재지 않는다 — 1~2분 빨라진다")
    .action(
      run(
        async (
          ctx,
          source: string | undefined,
          o: {
            width?: string;
            height?: string;
            density?: string;
            image?: string;
            name?: string;
            slim: boolean;
            baseline: boolean;
          },
        ) => {
          const custom = o.width || o.height || o.density;
          if (custom && source)
            throw new CliError(
              "원본과 직접 입력(--width 등)은 함께 줄 수 없습니다",
              ExitCode.usage,
            );
          if (!custom && !source)
            throw new CliError(
              "원본을 주거나 --width·--height·--density 로 직접 입력하세요",
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
            source,
            custom: custom
              ? {
                  widthDp: numbers[0],
                  heightDp: numbers[1],
                  density: numbers[2],
                  systemImage: o.image,
                }
              : undefined,
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
