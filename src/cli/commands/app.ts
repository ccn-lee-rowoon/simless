import { existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { Command } from "commander";
import {
  BuildCacheError,
  type BuildMeta,
  cacheRoot,
  computeFingerprint,
  type Fingerprint,
  findCached,
  findLatestBuild,
  forgetMiss,
  listBuilds,
  logEvent,
  nodeModulesLink,
  onlyBuildOutputs,
  projectKey,
  pruneBuilds,
  readEvents,
  rememberMiss,
  saveBuild,
  takeMiss,
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

async function fingerprint(
  ctx: Context,
  project: string,
  platform: Platform,
): Promise<Fingerprint> {
  if (!ctx.json) console.error(`… ${t("cli.app.fingerprinting", { platform })}`);
  try {
    return await computeFingerprint(project, platform, defaultRun);
  } catch (error) {
    if (error instanceof BuildCacheError)
      throw new CliError(error.message, ExitCode.failed, error.code);
    throw error;
  }
}

/** node_modules 가 링크면 알린다 — 다른 작업 트리와 캐시를 나눠 쓰지 못한다 */
function warnLink(ctx: Context, project: string): string | undefined {
  const link = nodeModulesLink(project);
  if (link && !ctx.json) console.error(`! ${t("cli.app.linked", { target: link })}`);
  return link;
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
        const link = warnLink(ctx, project);
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
          const cached = findCached(cacheRoot(), key, platform, fp.hash);
          // 빌드 전 지문 — 빌드한 뒤 app save 가 이 지문으로도 보관하게
          if (!cached) rememberMiss(cacheRoot(), key, platform, project, fp);
          logEvent(cacheRoot(), {
            project: key,
            platform,
            event: cached ? "hit" : "miss",
            fingerprint: fp.hash,
            worktree: basename(project),
          });
          const entry: InstallEntry = {
            platform,
            fingerprint: fp.hash,
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

        const result = { project, key, entries, ...(link ? { nodeModulesLink: link } : {}) };
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
        const link = warnLink(ctx, project);
        const source = o.path ? resolve(o.path) : findLatestBuild(project, platform);
        if (!source || !existsSync(source))
          throw new CliError(
            t("cli.app.noBuild", { platform, path: source ?? project }),
            ExitCode.failed,
            "NOT_FOUND",
          );
        const fp = await fingerprint(ctx, project, platform);
        const root = cacheRoot();
        const key = projectKey(project);
        // app install 이 못 찾았을 때의 지문 — 빌드가 node_modules 에 파일만 더했으면 그 지문으로도
        const before = takeMiss(root, key, platform, project);
        const changed = before !== undefined && before.hash !== fp.hash;
        const aliased = changed && onlyBuildOutputs(before, fp);
        const meta = saveBuild(root, key, platform, fp.hash, source, {
          aliases: aliased ? [before.hash] : [],
        });
        forgetMiss(root, key, platform, project);
        logEvent(root, {
          project: key,
          platform,
          event: "save",
          fingerprint: fp.hash,
          aliased,
          worktree: basename(project),
        });
        const removed = pruneBuilds(root, KEEP);
        const beforeBuild = changed ? { fingerprint: before.hash, aliased } : undefined;
        const saved = {
          saved: meta,
          removed,
          beforeBuild,
          ...(link ? { nodeModulesLink: link } : {}),
        };
        output(ctx, saved, () =>
          [
            t("cli.app.saved", {
              platform,
              fingerprint: short(fp.hash),
              size: size(meta.bytes),
              source,
            }),
            ...(beforeBuild
              ? [
                  t(aliased ? "cli.app.aliased" : "cli.app.notAliased", {
                    fingerprint: short(beforeBuild.fingerprint),
                  }),
                ]
              : []),
          ].join("\n"),
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
    .command("stats")
    .description(t("cli.app.stats"))
    .option("--days <n>", t("cli.app.days"), "30")
    .action(
      run(async (ctx, o: { days: string }) => {
        const days = Math.max(1, Number(o.days) || 30);
        const since = Date.now() - days * 86_400_000;
        const rows = new Map<
          string,
          {
            project: string;
            platform: Platform;
            hit: number;
            miss: number;
            saved: number;
            aliased: number;
          }
        >();
        for (const e of readEvents(cacheRoot())) {
          if (Date.parse(e.at) < since) continue;
          const id = `${e.project}/${e.platform}`;
          const row = rows.get(id) ?? {
            project: e.project,
            platform: e.platform,
            hit: 0,
            miss: 0,
            saved: 0,
            aliased: 0,
          };
          if (e.event === "hit") row.hit++;
          else if (e.event === "miss") row.miss++;
          else {
            row.saved++;
            if (e.aliased) row.aliased++;
          }
          rows.set(id, row);
        }
        const stats = [...rows.values()];
        output(ctx, { days, stats }, () =>
          stats.length === 0
            ? t("cli.app.noStats", { days })
            : stats
                .map((r) =>
                  t("cli.app.statsRow", {
                    project: r.project,
                    platform: r.platform.padEnd(7),
                    hit: r.hit,
                    miss: r.miss,
                    rate:
                      r.hit + r.miss === 0
                        ? "-"
                        : `${Math.round((100 * r.hit) / (r.hit + r.miss))}%`,
                    saved: r.saved,
                    aliased: r.aliased,
                  }),
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
