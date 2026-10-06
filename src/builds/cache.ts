import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { Runner } from "../shared/exec.ts";
import type { Platform } from "../shared/model.ts";

// 네이티브 빌드 캐시 (R26) — 시뮬레이터·에뮬레이터용 빌드(.app·.apk)를 «네이티브 지문» 으로 보관하고 다시 쓴다.
// 지문은 앱 프로젝트에 이미 든 Expo 지문 도구(@expo/fingerprint)로 계산한다 — 앱 저장소는 고치지 않는다.
// 네이티브에 영향을 주는 입력(설정·플러그인·네이티브 모듈·패치·RN 버전…)이 같으면 같은 지문이라
// JS 만 다른 작업 트리·세션은 빌드 하나를 같이 쓴다. 캐시는 DerivedData 바깥이라 그것을 지워도 남는다.
// 지문은 빌드할 때와 같은 환경 변수로 계산해야 한다(앱 설정이 환경에 따라 바뀌면 지문도 바뀐다).

export interface BuildMeta {
  /** 앱 이름 — package.json 의 name. 작업 트리가 달라도 같은 앱이면 같은 이름 */
  project: string;
  platform: Platform;
  fingerprint: string;
  /** 보관한 파일·폴더 (…/<지문>/<이름>.app 또는 .apk) */
  path: string;
  /** 어디서 가져왔나 */
  source: string;
  savedAt: string;
  bytes: number;
}

export class BuildCacheError extends Error {
  constructor(
    readonly code: "TOOL_MISSING" | "NOT_FOUND" | "FAILED",
    message: string,
  ) {
    super(message);
  }
}

export function cacheRoot(env: NodeJS.ProcessEnv = process.env): string {
  if (env.SIMLESS_BUILD_CACHE) return env.SIMLESS_BUILD_CACHE;
  return join(
    env.SIMLESS_CACHE_DIR ?? join(env.HOME ?? homedir(), "Library", "Caches", "Simless"),
    "builds",
  );
}

/** 앱 이름 — 파일 이름에 쓸 수 있게 */
export function projectKey(projectDir: string): string {
  let name = basename(projectDir);
  try {
    const pkg = JSON.parse(readFileSync(join(projectDir, "package.json"), "utf8")) as {
      name?: string;
    };
    if (pkg.name) name = pkg.name;
  } catch {
    // package.json 이 없으면 폴더 이름
  }
  return name.replace(/[^\w.-]+/g, "_");
}

/** 앱 프로젝트의 지문 도구로 네이티브 지문을 계산한다 (NOVA 기준 약 30초) */
export async function computeFingerprint(
  projectDir: string,
  platform: Platform,
  runner: Runner,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const tool = join(projectDir, "node_modules", ".bin", "fingerprint");
  if (!existsSync(tool))
    throw new BuildCacheError(
      "TOOL_MISSING",
      `${tool} — Expo 프로젝트(@expo/fingerprint 가 설치된)에서만 쓸 수 있습니다`,
    );
  const result = await runner([tool, "fingerprint:generate", "--platform", platform], {
    cwd: projectDir,
    env,
    timeoutMs: 5 * 60_000,
  });
  if (result.code !== 0) throw new BuildCacheError("FAILED", result.stderr.trim() || "fingerprint");
  try {
    const hash = (JSON.parse(result.stdout) as { hash?: string }).hash;
    if (hash) return hash;
  } catch {
    // 아래에서
  }
  throw new BuildCacheError("FAILED", "지문 도구의 출력을 읽지 못했습니다");
}

function dirOf(root: string, project: string, platform: Platform, fingerprint: string): string {
  return join(root, project, platform, fingerprint);
}

function readMeta(dir: string): BuildMeta | undefined {
  try {
    const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8")) as BuildMeta;
    return existsSync(meta.path) ? meta : undefined;
  } catch {
    return undefined;
  }
}

export function findCached(
  root: string,
  project: string,
  platform: Platform,
  fingerprint: string,
): BuildMeta | undefined {
  return readMeta(dirOf(root, project, platform, fingerprint));
}

function sizeOf(path: string): number {
  const stat = statSync(path);
  if (!stat.isDirectory()) return stat.size;
  return readdirSync(path).reduce((sum, name) => sum + sizeOf(join(path, name)), 0);
}

/** 빌드를 보관한다 — .app 은 폴더째, .apk 는 파일 하나 */
export function saveBuild(
  root: string,
  project: string,
  platform: Platform,
  fingerprint: string,
  source: string,
  now = new Date(),
): BuildMeta {
  if (!existsSync(source)) throw new BuildCacheError("NOT_FOUND", source);
  const dir = dirOf(root, project, platform, fingerprint);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const path = join(dir, basename(source));
  cpSync(source, path, { recursive: true, verbatimSymlinks: true });
  const meta: BuildMeta = {
    project,
    platform,
    fingerprint,
    path,
    source,
    savedAt: now.toISOString(),
    bytes: sizeOf(path),
  };
  writeFileSync(join(dir, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`);
  return meta;
}

export function listBuilds(root: string, project?: string): BuildMeta[] {
  if (!existsSync(root)) return [];
  const projects = project ? [project] : readdirSync(root);
  const builds: BuildMeta[] = [];
  for (const p of projects) {
    for (const platform of ["ios", "android"] as const) {
      const base = join(root, p, platform);
      if (!existsSync(base)) continue;
      for (const fp of readdirSync(base)) {
        const meta = readMeta(join(base, fp));
        if (meta) builds.push(meta);
      }
    }
  }
  return builds.sort((a, b) => b.savedAt.localeCompare(a.savedAt));
}

/** 앱·플랫폼마다 최근 keep 개만 남긴다 — 빌드 하나가 수백 MB 다. 지운 것 */
export function pruneBuilds(root: string, keep = 5): BuildMeta[] {
  const removed: BuildMeta[] = [];
  const groups = new Map<string, BuildMeta[]>();
  for (const b of listBuilds(root)) {
    const key = `${b.project}/${b.platform}`;
    groups.set(key, [...(groups.get(key) ?? []), b]);
  }
  for (const list of groups.values()) {
    for (const old of list.slice(keep)) {
      rmSync(dirOf(root, old.project, old.platform, old.fingerprint), {
        recursive: true,
        force: true,
      });
      removed.push(old);
    }
  }
  return removed;
}

function newest(paths: string[]): string | undefined {
  return paths
    .filter((p) => existsSync(p))
    .map((p) => ({ p, t: statSync(p).mtimeMs }))
    .sort((a, b) => b.t - a.t)[0]?.p;
}

/**
 * 방금 빌드한 결과를 찾는다 — 시뮬레이터·에뮬레이터용 디버그 빌드.
 * iOS: DerivedData/<워크스페이스 이름>-<해시>/Build/Products/Debug-iphonesimulator 의 .app, 또는 ios/build 아래
 * Android: android/app/build/outputs/apk/debug/*.apk
 */
export function findLatestBuild(
  projectDir: string,
  platform: Platform,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (platform === "android") {
    const dir = join(projectDir, "android", "app", "build", "outputs", "apk", "debug");
    if (!existsSync(dir)) return undefined;
    return newest(
      readdirSync(dir)
        .filter((n) => n.endsWith(".apk"))
        .map((n) => join(dir, n)),
    );
  }
  const ios = join(projectDir, "ios");
  const workspace = existsSync(ios)
    ? readdirSync(ios)
        .find((n) => n.endsWith(".xcworkspace"))
        ?.replace(/\.xcworkspace$/, "")
    : undefined;
  const products: string[] = [join(ios, "build", "Build", "Products", "Debug-iphonesimulator")];
  const derived = join(env.HOME ?? homedir(), "Library", "Developer", "Xcode", "DerivedData");
  if (workspace && existsSync(derived)) {
    for (const d of readdirSync(derived)) {
      if (d.startsWith(`${workspace}-`))
        products.push(join(derived, d, "Build", "Products", "Debug-iphonesimulator"));
    }
  }
  const apps = products
    .filter((p) => existsSync(p))
    .flatMap((p) =>
      readdirSync(p)
        .filter((n) => n.endsWith(".app"))
        .map((n) => join(p, n)),
    );
  return newest(apps);
}
