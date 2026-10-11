import type { Command } from "commander";
import type { CatalogResult, DeviceOpResult, DeviceView } from "../../shared/api.ts";
import { ExitCode } from "../../shared/exit-codes.ts";
import { t } from "../../shared/i18n.ts";
import { CliError, type Context, confirm, output, type Run, request } from "../context.ts";
import { catalogText, devicesTable } from "../format.ts";
import { type AcquireOptions, acquire, acquireOptions } from "./lease.ts";

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
    const lines = failed.map((r) => t("cli.failedFor", { name: r.name, error: r.error ?? "" }));
    return [devicesTable(result.devices), ...lines].join("\n");
  });
  if (result.results.some((r) => !r.ok)) {
    throw new CliError(t("cli.someFailed", { verb }), ExitCode.failed, "FAILED", result.results);
  }
}

export function registerDevices(program: Command, run: Run) {
  program
    .command("list")
    .description(t("cli.list"))
    .option("--platform <platform>", t("cli.opt.platform"))
    .option("--created", t("cli.opt.created"))
    .option("--available", t("cli.list.available"))
    .action(
      run(
        async (
          ctx,
          o: { platform?: "android" | "ios"; created?: boolean; available?: boolean },
        ) => {
          const method = o.available ? "device.available" : "device.list";
          const devices = (await call<DeviceView[]>(ctx, method, {})).filter(
            (d) => (!o.platform || d.platform === o.platform) && (!o.created || d.createdBySimless),
          );
          output(ctx, devices, () => devicesTable(devices));
        },
      ),
    );

  program
    .command("catalog")
    .description(t("cli.catalog"))
    .option("--platform <platform>", t("cli.opt.platform"))
    .action(
      run(async (ctx, o: { platform?: "android" | "ios" }) => {
        const result = await call<CatalogResult>(ctx, "catalog", { platform: o.platform });
        output(ctx, result, () => catalogText(result));
      }),
    );

  program
    .command("create")
    .description(t("cli.create"))
    .argument("[model]", t("cli.create.model"))
    .option("--platform <platform>", t("cli.create.platform"))
    .option("--os <os>", t("cli.create.os"))
    .option("--width <dp>", t("cli.create.width"))
    .option("--height <dp>", t("cli.create.height"))
    .option("--density <dpi>", t("cli.create.density"))
    .option("--name <name>", t("cli.create.name"))
    .option("--no-slim", t("cli.create.noSlim"))
    .option("--slim-keep <ids>", t("cli.create.slimKeep"))
    .option("--app", t("cli.slim.app"))
    .option("--no-baseline", t("cli.create.noBaseline"))
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
            slimKeep?: string;
            app?: boolean;
            baseline: boolean;
          },
        ) => {
          const custom = o.width || o.height || o.density;
          if (custom && model) throw new CliError(t("cli.create.bothGiven"), ExitCode.usage);
          if (!custom && !model) throw new CliError(t("cli.create.noneGiven"), ExitCode.usage);
          const numbers = [o.width, o.height, o.density].map(Number);
          if (custom && numbers.some((n) => !Number.isFinite(n) || n <= 0)) {
            throw new CliError(t("cli.create.badCustom"), ExitCode.usage);
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
            slimKeep: o.slimKeep !== undefined ? idList(o.slimKeep) : undefined,
            slimMode: o.app ? "app" : undefined,
            baseline: o.baseline,
          });
          output(ctx, device, () => devicesTable([device]));
        },
      ),
    );

  program
    .command("add")
    .description(t("cli.add"))
    .argument("<device>", t("cli.add.device"))
    .action(
      run(async (ctx, device: string) => {
        const result = await call<DeviceView>(ctx, "device.add", { device });
        output(ctx, result, () => devicesTable([result]));
      }),
    );

  program
    .command("unlist")
    .description(t("cli.unlist"))
    .argument("<device>", t("cli.arg.device"))
    .action(
      run(async (ctx, device: string) => {
        const result = await call<{ unlisted: string }>(ctx, "device.unlist", { device });
        output(ctx, result, () => t("cli.unlisted", { id: result.unlisted }));
      }),
    );

  program
    .command("default")
    .description(t("cli.default"))
    .argument("[device]", t("cli.arg.device"))
    .action(
      run(async (ctx, device: string | undefined) => {
        if (device) {
          const result = await call<DeviceView>(ctx, "device.setDefault", { device });
          output(ctx, result, () =>
            t("cli.default.set", { platform: result.platform, name: result.name }),
          );
          return;
        }
        const defaults = (await call<DeviceView[]>(ctx, "device.list", {})).filter(
          (d) => d.default,
        );
        output(ctx, defaults, () =>
          defaults.length > 0 ? devicesTable(defaults) : t("cli.default.none"),
        );
      }),
    );

  program
    .command("delete")
    .description(t("cli.delete"))
    .argument("<device>", t("cli.arg.device"))
    .option("-y, --yes", t("cli.delete.yes"))
    .action(
      run(async (ctx, device: string, o: { yes?: boolean }) => {
        if (!o.yes && !(await confirm(t("cli.delete.confirm", { device })))) {
          throw new CliError(t("cli.delete.cancelled"), ExitCode.usage);
        }
        const result = await call<{ deleted: string }>(ctx, "device.delete", { device });
        output(ctx, result, () => t("cli.deleted", { id: result.deleted }));
      }),
    );

  program
    .command("slim")
    .description(t("cli.slim"))
    .argument("[devices...]", t("cli.slim.devices"))
    .option("--off", t("cli.slim.off"))
    .option("--check", t("cli.slim.check"))
    .option("--keep <ids>", t("cli.slim.keep"))
    .option("--full", t("cli.slim.full"))
    .option("--app", t("cli.slim.app"))
    .action(
      run(
        async (
          ctx,
          devices: string[],
          o: { off?: boolean; check?: boolean; keep?: string; full?: boolean; app?: boolean },
        ) => {
          const mode = o.check ? "check" : o.off ? "off" : "on";
          const keep = o.full ? [] : o.keep !== undefined ? idList(o.keep) : undefined;
          const slimMode = o.app ? "app" : undefined;
          finish(
            ctx,
            await call(ctx, "device.slim", { devices, mode, keep, slimMode }),
            t("cli.verb.slim"),
          );
        },
      ),
    );

  program
    .command("up")
    .description(t("cli.up"))
    .argument("[devices...]", t("cli.upDown.devices"))
    .action(
      run(async (ctx, devices: string[]) =>
        finish(ctx, await call(ctx, "device.up", { devices }), t("cli.verb.boot")),
      ),
    );

  program
    .command("down")
    .description(t("cli.down"))
    .argument("[devices...]", t("cli.upDown.devices"))
    .action(
      run(async (ctx, devices: string[]) =>
        finish(ctx, await call(ctx, "device.down", { devices }), t("cli.verb.shutdown")),
      ),
    );

  const useCommand = program
    .command("use")
    .description(t("cli.use"))
    .argument("[devices...]", t("cli.arg.devices"));
  acquireOptions(useCommand).action(
    run(async (ctx, devices: string[], o: AcquireOptions) => {
      const result = await acquire(ctx, devices, o);
      finish(ctx, await call(ctx, "device.up", { devices: result.deviceIds }), t("cli.verb.boot"));
    }),
  );
}

/** `a,b , c` → `["a", "b", "c"]` — 남길 슬림 항목 ID (M15) */
function idList(value: string): string[] {
  return value
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
}
