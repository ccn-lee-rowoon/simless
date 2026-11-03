import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { Runner } from "../shared/exec.ts";
import type { Platform } from "../shared/model.ts";

// 네이티브 빌드 캐시 (R26) — 시뮬레이터·에뮬레이터용 빌드(.app·.apk)를 «네이티브 지문» 으로 보관하고 다시 쓴다.
// 지문은 앱 프로젝트에 이미 든 Expo 지문 도구(@expo/fingerprint)로 계산한다 — 앱 저장소는 고치지 않는다.
// 네이티브에 영향을 주는 입력(설정·플러그인·네이티브 모듈·패치·RN 버전…)이 같으면 같은 지문이라
// JS 만 다른 작업 트리·세션은 빌드 하나를 같이 쓴다. 캐시는 DerivedData 바깥이라 그것을 지워도 남는다.
// 지문은 빌드할 때와 같은 환경 변수로 계산해야 한다(앱 설정이 환경에 따라 바뀌면 지문도 바뀐다).
//
// 빌드는 node_modules 안에 파일을 만든다 — iOS 는 pod install 이 패키지 폴더에 미리 빌드된 라이브러리를
// 복사하고, Android 는 Gradle 이 패키지의 하위 모듈 폴더에 산출물을 쓴다. 그래서 빌드 전(app install)과
// 빌드 후(app save)의 지문이 달라, 빌드 후 지문으로만 보관하면 늘 빌드 전 상태인 새 작업 트리가 못 찾는다.
// Gradle 산출물은 지문에서 빼고, 나머지는 빌드 전 지문을 기억했다가 «node_modules 안에 새로 생긴 파일만»
// 다르면 빌드 전 지문으로도 찾게 한다. 이미 있던 파일이 바뀌었거나 바깥이 바뀌었으면 하지 않는다 —
// 틀린 빌드를 주느니 다시 빌드하게 둔다.

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
  /** 빌드 전 지문 — 빌드가 node_modules 에 파일만 더해 지문이 바뀐 경우 이 지문으로도 찾는다 */
  aliases?: string[];
}

export interface Fingerprint {
  hash: string;
  /** 지문에 든 파일마다 해시(프로젝트 기준 경로) + 설정 같은 내용(`contents:<id>`) */
  files: Record<string, string>;
}

/**
 * 지문에서 뺄 것 — 패키지 안 Gradle 하위 모듈(`android/<모듈>/`)의 산출물. Expo 는 `android/build` 바로
 * 아래만 뺀다. 소스 안의 `build` 폴더(`android/src/main/java/…/build`)는 빼지 않게 모듈 한 단계만
 */
export const FINGERPRINT_IGNORES = [
  "**/node_modules/**/android/*/build/**/*",
  "**/node_modules/**/android/*/.cxx/**/*",
  "**/node_modules/**/android/*/.gradle/**/*",
];

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

interface DebugNode {
  path?: string;
  hash?: string | null;
  children?: DebugNode[];
}

interface Source {
  type: string;
  id?: string;
  hash?: string | null;
  debugInfo?: DebugNode;
}

function leaves(node: DebugNode | undefined, files: Record<string, string>): void {
  if (!node) return;
  if (node.children) {
    for (const child of node.children) leaves(child, files);
  } else if (node.path && node.hash) {
    files[node.path] = node.hash;
  }
}

/** 앱 프로젝트의 지문 도구로 네이티브 지문을 계산한다 (큰 앱 기준 약 30초) */
export async function computeFingerprint(
  projectDir: string,
  platform: Platform,
  runner: Runner,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Fingerprint> {
  const tool = join(projectDir, "node_modules", ".bin", "fingerprint");
  if (!existsSync(tool))
    throw new BuildCacheError(
      "TOOL_MISSING",
      `${tool} — Expo 프로젝트(@expo/fingerprint 가 설치된)에서만 쓸 수 있습니다`,
    );
  const ignores = FINGERPRINT_IGNORES.flatMap((p) => ["--ignore-path", p]);
  const result = await runner(
    [tool, "fingerprint:generate", "--platform", platform, "--debug", ...ignores],
    { cwd: projectDir, env, timeoutMs: 5 * 60_000 },
  );
  if (result.code !== 0) throw new BuildCacheError("FAILED", result.stderr.trim() || "fingerprint");
  try {
    const out = JSON.parse(result.stdout) as { hash?: string; sources?: Source[] };
    if (out.hash) {
      const files: Record<string, string> = {};
      for (const source of out.sources ?? []) {
        if (source.type === "contents" && source.id && source.hash)
          files[`contents:${source.id}`] = source.hash;
        else leaves(source.debugInfo, files);
      }
      return { hash: out.hash, files };
    }
  } catch {
    // 아래에서
  }
  throw new BuildCacheError("FAILED", "지문 도구의 출력을 읽지 못했습니다");
}

/**
 * 빌드 전 지문 대신 쓸 수 있나 — 빌드 후 지문과의 차이가 node_modules 안에 새로 생긴 파일뿐일 때만.
 * 있던 파일이 바뀌거나 사라졌거나, 바깥(앱 설정·패치·네이티브 폴더)이 바뀌었으면 아니다
 */
export function onlyBuildOutputs(before: Fingerprint, after: Fingerprint): boolean {
  for (const [path, hash] of Object.entries(before.files)) {
    if (after.files[path] !== hash) return false;
  }
  return Object.keys(after.files).every(
    (path) => path in before.files || path.startsWith("node_modules/"),
  );
}

/** 이 작업 트리·플랫폼에서 캐시를 못 찾았을 때의 지문 — app save 가 빌드 전 지문으로도 보관하게 */
function pendingPath(
  root: string,
  project: string,
  platform: Platform,
  projectDir: string,
): string {
  const id = createHash("sha256").update(real(projectDir)).digest("hex").slice(0, 16);
  return join(root, project, platform, ".pending", `${id}.json`);
}

export function rememberMiss(
  root: string,
  project: string,
  platform: Platform,
  projectDir: string,
  fingerprint: Fingerprint,
): void {
  const path = pendingPath(root, project, platform, projectDir);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(fingerprint), { mode: 0o600 });
}

export function takeMiss(
  root: string,
  project: string,
  platform: Platform,
  projectDir: string,
): Fingerprint | undefined {
  const path = pendingPath(root, project, platform, projectDir);
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Fingerprint;
    return value.hash && value.files ? value : undefined;
  } catch {
    return undefined;
  }
}

export function forgetMiss(
  root: string,
  project: string,
  platform: Platform,
  projectDir: string,
): void {
  rmSync(pendingPath(root, project, platform, projectDir), { force: true });
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
  return (
    readMeta(dirOf(root, project, platform, fingerprint)) ??
    listBuilds(root, project).find(
      (b) => b.platform === platform && b.aliases?.includes(fingerprint),
    )
  );
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
  options: { aliases?: string[]; now?: Date } = {},
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
    savedAt: (options.now ?? new Date()).toISOString(),
    bytes: sizeOf(path),
    ...(options.aliases?.length ? { aliases: options.aliases } : {}),
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

/** DerivedData 폴더가 어느 워크스페이스의 빌드인지 — info.plist 의 WorkspacePath */
function workspaceOf(derivedDir: string): string | undefined {
  try {
    const plist = readFileSync(join(derivedDir, "info.plist"), "utf8");
    return /<key>WorkspacePath<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)?.[1];
  } catch {
    return undefined;
  }
}

function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * 방금 빌드한 결과를 찾는다 — 시뮬레이터·에뮬레이터용 디버그 빌드.
 * iOS: DerivedData/<워크스페이스 이름>-<해시>/Build/Products/Debug-iphonesimulator 의 .app, 또는 ios/build 아래.
 *   DerivedData 는 작업 트리마다 따로 생기지만 이름이 같다 — info.plist 의 WorkspacePath 로 이 작업 트리 것만
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
    const mine = real(ios);
    for (const d of readdirSync(derived)) {
      if (!d.startsWith(`${workspace}-`)) continue;
      const path = workspaceOf(join(derived, d));
      if (path && real(dirname(path)) === mine)
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
