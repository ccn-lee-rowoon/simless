import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Command } from "commander";
import {
  BuildCacheError,
  type BuildMeta,
  cacheRoot,
  computeFingerprint,
  findCached,
  findLatestBuild,
  listBuilds,
  projectKey,
  pruneBuilds,
  saveBuild,
} from "../../builds/cache.ts";
import type { DeviceOpResult, DeviceView } from "../../shared/api.ts";
import { run as defaultRun } from "../../shared/exec.ts";
import { ExitCode } from "../../shared/exit-codes.ts";
import { t } from "../../shared/i18n.ts";
import type { Platform } from "../../shared/model.ts";
import { when } from "../../shared/time.ts";
import { CliError, type Context, output, type Run, request } from "../context.ts";

// simless app — 네이티브 빌드 캐시 (R26). 지문 계산·보관은 CLI 가(호출한 셸의 환경 변수·작업 트리로),
// 기기에 설치는 서버가(이 세션이 점유한 기기인지 확인하고) 한다.

const KEEP = 5;

/** 지문 도구가 있는 가장 가까운 상위 폴더 — 앱 저장소 안 어디서 불러도 된다 */
function findProject(start: string): string {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, "node_modules", ".bin", "fingerprint"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new CliError(t("cli.app.noProject", { dir: start }), ExitCode.failed, "TOOL_MISSING");
}

function platformOf(value: string | undefined): Platform | undefined {
  if (value === undefined) return undefined;
  if (value === "ios" || value === "android") return value;
  throw new CliError(t("cli.badPlatform", { platform: value }), ExitCode.usage, "INVALID");
}

async function fingerprint(ctx: Context, project: string, platform: Platform): Promise<string> {
  if (!ctx.json) console.error(`… ${t("cli.app.fingerprinting", { platform })}`);
  try {
    return await computeFingerprint(project, platform, defaultRun);
  } catch (error) {
    if (error instanceof BuildCacheError)
      throw new CliError(error.message, ExitCode.failed, error.code);
    throw error;
  }
}

const short = (fp: string) => fp.slice(0, 12);
const size = (bytes: number) => `${(bytes / 1024 ** 2).toFixed(0)}MB`;
const at = (iso: string) => when(Date.parse(iso));

interface InstallEntry {
  platform: Platform;
  fingerprint: string;
  hit: boolean;
  /** 캐시에 있던 빌드 */
  build?: string;
  devices: { id: string; name: string; targetId?: string }[];
  results?: DeviceOpResult[];
}

export function registerApp(program: Command, run: Run) {
  const app = program.command("app").description(t("cli.app"));

  app
    .command("install")
    .description(t("cli.app.install"))
    .argument("[devices...]", t("cli.arg.devices"))
    .option("--platform <platform>", t("cli.opt.platform"))
    .option("--project <dir>", t("cli.app.project"))
    .action(
      run(async (ctx, refs: string[], o: { platform?: string; project?: string }) => {
        const wanted = platformOf(o.platform);
        const project = findProject(o.project ?? process.cwd());
        const key = projectKey(project);
        const mine = (await request<DeviceView[]>(ctx, "device.list", {})).filter(
          (d) =>
            d.mine &&
            d.booted &&
            (!wanted || d.platform === wanted) &&
            (refs.length === 0 ||
              refs.some((r) => r === d.id || r === d.targetId || r === d.native || r === d.name)),
        );
        if (mine.length === 0)
          throw new CliError(t("cli.app.noDevice"), ExitCode.failed, "NOT_HELD");

        const entries: InstallEntry[] = [];
        for (const platform of [...new Set(mine.map((d) => d.platform))]) {
          const devices = mine.filter((d) => d.platform === platform);
          const fp = await fingerprint(ctx, project, platform);
          const cached = findCached(cacheRoot(), key, platform, fp);
          const entry: InstallEntry = {
            platform,
            fingerprint: fp,
            hit: cached !== undefined,
            build: cached?.path,
            devices: devices.map((d) => ({ id: d.id, name: d.name, targetId: d.targetId })),
          };
          if (cached) {
            const { results } = await request<{ results: DeviceOpResult[] }>(
              ctx,
              "device.install",
              { devices: devices.map((d) => d.id), path: cached.path },
              (event, data) => {
                if (event === "progress" && !ctx.json)
                  console.error(`… ${(data as { message: string }).message}`);
              },
            );
            entry.results = results;
          }
          entries.push(entry);
        }

        const result = { project, key, entries };
        output(ctx, result, () =>
          entries
            .flatMap((e) => {
              if (!e.hit) {
                const target = e.devices[0]?.targetId ?? "<targetId>";
                return [
                  t("cli.app.miss", { platform: e.platform, fingerprint: short(e.fingerprint) }),
                  `  npx expo run:${e.platform} --device ${target}`,
                  `  simless app save --platform ${e.platform}`,
                ];
              }
              return (e.results ?? []).map((r) =>
                r.ok
                  ? t("cli.app.installed", { name: r.name, fingerprint: short(e.fingerprint) })
                  : t("cli.failedFor", { name: r.name, error: r.error ?? "" }),
              );
            })
            .join("\n"),
        );
        if (entries.some((e) => e.results?.some((r) => !r.ok)))
          throw new CliError(
            t("cli.someFailed", { verb: t("cli.app.verb") }),
            ExitCode.failed,
            "FAILED",
            result,
          );
      }),
    );

  app
    .command("save")
    .description(t("cli.app.save"))
    .option("--platform <platform>", t("cli.opt.platform"))
    .option("--path <build>", t("cli.app.path"))
    .option("--project <dir>", t("cli.app.project"))
    .action(
      run(async (ctx, o: { platform?: string; path?: string; project?: string }) => {
        const fromPath = o.path?.endsWith(".apk")
          ? "android"
          : o.path?.replace(/\/$/, "").endsWith(".app")
            ? "ios"
            : undefined;
        const platform = platformOf(o.platform) ?? fromPath;
        if (!platform) throw new CliError(t("cli.app.needPlatform"), ExitCode.usage, "INVALID");
        const project = findProject(o.project ?? process.cwd());
        const source = o.path ? resolve(o.path) : findLatestBuild(project, platform);
        if (!source || !existsSync(source))
          throw new CliError(
            t("cli.app.noBuild", { platform, path: source ?? project }),
            ExitCode.failed,
            "NOT_FOUND",
          );
        const fp = await fingerprint(ctx, project, platform);
        const root = cacheRoot();
        const meta = saveBuild(root, projectKey(project), platform, fp, source);
        const removed = pruneBuilds(root, KEEP);
        output(ctx, { saved: meta, removed }, () =>
          t("cli.app.saved", {
            platform,
            fingerprint: short(fp),
            size: size(meta.bytes),
            source,
          }),
        );
      }),
    );

  app
    .command("list")
    .description(t("cli.app.list"))
    .option("--project <dir>", t("cli.app.project"))
    .action(
      run(async (ctx, o: { project?: string }) => {
        const builds: BuildMeta[] = listBuilds(
          cacheRoot(),
          o.project ? projectKey(findProject(o.project)) : undefined,
        );
        output(ctx, builds, () =>
          builds.length === 0
            ? t("cli.app.empty", { root: cacheRoot() })
            : builds
                .map(
                  (b) =>
                    `${b.project}  ${b.platform.padEnd(7)}  ${short(b.fingerprint)}  ${size(b.bytes).padStart(6)}  ${at(b.savedAt)}`,
                )
                .join("\n"),
        );
      }),
    );

  app
    .command("prune")
    .description(t("cli.app.prune"))
    .option("--keep <n>", t("cli.app.keep"), String(KEEP))
    .action(
      run(async (ctx, o: { keep: string }) => {
        const keep = Math.max(0, Number(o.keep) || 0);
        const removed = pruneBuilds(cacheRoot(), keep);
        output(ctx, { removed }, () => t("cli.app.pruned", { count: removed.length }));
      }),
    );
}
