import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { run } from "../shared/exec.ts";
import type { Paths } from "../shared/paths.ts";

// 설치한 simless 를 버전 폴더에 두고 링크로 가리킨다 (R19, docs/design.md §19).
// 받은 파일(설치 파일이 임시 폴더에 꺼낸 것 등)이 어디 있든 `<versionsDir>/<버전>/simless` 로 복사하고
// `binLink`(~/.local/bin/simless)가 그것을 가리키게 한다. 서버(launchd)·훅·MCP 는 링크 경로를 쓰므로
// 받은 파일을 지워도 되고, 업데이트할 때는 링크만 바꾸면 된다.

/** 버전 폴더를 몇 개 남기나 — 지금 것과 바로 전 것은 늘 남긴다 */
export const KEEP_VERSIONS = 3;

/** 단일 실행 파일로 도는가 — 개발 중(`bun link`)이면 false */
export function isCompiled(): boolean {
  return Bun.main.startsWith("/$bunfs/");
}

/** «x.y.z» 비교 — a 가 크면 양수 */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

export function versionBinary(paths: Paths, version: string): string {
  return join(paths.versionsDir, version, "simless");
}

/** 링크가 지금 가리키는 실행 파일 — 없거나 깨졌으면 undefined */
export function currentBinary(paths: Paths): string | undefined {
  try {
    const target = realpathSync(paths.binLink);
    return existsSync(target) ? target : undefined;
  } catch {
    return undefined;
  }
}

/** 설치돼 있는 버전들 — 큰 것부터 */
export function installedVersions(paths: Paths): string[] {
  if (!existsSync(paths.versionsDir)) return [];
  return readdirSync(paths.versionsDir)
    .filter((v) => /^\d+\.\d+\.\d+/.test(v) && existsSync(versionBinary(paths, v)))
    .sort((a, b) => compareVersions(b, a));
}

/** 되돌릴 때 쓸 바로 전 버전의 실행 파일 */
export function previousBinary(paths: Paths): string | undefined {
  if (!existsSync(paths.previousVersion)) return undefined;
  const path = readFileSync(paths.previousVersion, "utf8").trim();
  return path && existsSync(path) ? path : undefined;
}

/** 실행 파일 경로에서 버전 — `<versionsDir>/<버전>/simless` */
export function versionOf(paths: Paths, binary: string): string | undefined {
  const dir = dirname(realpathOrSelf(binary));
  const root = realpathOrSelf(paths.versionsDir);
  return dirname(dir) === root ? dir.slice(root.length + 1) : undefined;
}

export interface SelfInstall {
  version: string;
  /** 버전 폴더의 실행 파일 */
  binary: string;
  link: string;
  /** 이 설치 전에 쓰던 실행 파일 — 처음 설치면 없음 */
  previous?: string;
  /** 링크가 있는 폴더가 PATH 에 없으면 그 폴더 */
  notOnPath?: string;
  /** 지운 오래된 버전 */
  pruned: string[];
}

/**
 * source(보통 지금 실행 중인 파일)를 버전 폴더에 넣고 링크를 바꾼다.
 * 같은 파일이면 복사하지 않고 링크만 맞춘다 — 되돌리기·다시 설치.
 */
export async function installSelf(
  paths: Paths,
  version: string,
  source: string = process.execPath,
  env: NodeJS.ProcessEnv = process.env,
): Promise<SelfInstall> {
  const binary = versionBinary(paths, version);
  const before = currentBinary(paths);
  if (realpathOrSelf(source) !== realpathOrSelf(binary)) {
    mkdirSync(dirname(binary), { recursive: true });
    // 쓰는 중에 링크가 가리키지 않게 — 옆에 쓰고 이름을 바꾼다
    const temp = `${binary}.new-${process.pid}`;
    copyFileSync(source, temp);
    chmodSync(temp, 0o755);
    renameSync(temp, binary);
  }
  // 받은 파일이면 «다운로드한 파일» 표시가 따라올 수 있다 — 있으면 Gatekeeper 가 실행을 막는다
  await run(["xattr", "-d", "com.apple.quarantine", binary]);

  mkdirSync(dirname(paths.binLink), { recursive: true });
  const tempLink = `${paths.binLink}.new-${process.pid}`;
  rmSync(tempLink, { force: true });
  symlinkSync(binary, tempLink);
  renameSync(tempLink, paths.binLink);

  const previous = before && before !== realpathOrSelf(binary) ? before : undefined;
  if (previous) writeFileSync(paths.previousVersion, `${previous}\n`, { mode: 0o600 });
  const pruned = prune(paths, [binary, previousBinary(paths)]);
  const linkDir = dirname(paths.binLink);
  const onPath = (env.PATH ?? "").split(":").some((p) => p === linkDir);
  return {
    version,
    binary,
    link: paths.binLink,
    previous,
    notOnPath: onPath ? undefined : linkDir,
    pruned,
  };
}

/** 오래된 버전 폴더를 지운다 — 큰 버전부터 KEEP_VERSIONS 개, 그리고 keep 에 든 것은 남긴다 */
function prune(paths: Paths, keep: (string | undefined)[]): string[] {
  const protectedDirs = new Set(
    keep.filter((p): p is string => !!p).map((p) => dirname(realpathOrSelf(p))),
  );
  const removed: string[] = [];
  installedVersions(paths).forEach((version, i) => {
    const dir = join(paths.versionsDir, version);
    if (i < KEEP_VERSIONS || protectedDirs.has(realpathOrSelf(dir))) return;
    rmSync(dir, { recursive: true, force: true });
    removed.push(version);
  });
  return removed;
}

function realpathOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** 링크가 버전 폴더를 가리키는가 — 설치 파일로 설치했는지 (개발 중 `bun link` 와 가른다) */
export function linkPointsIntoVersions(paths: Paths): boolean {
  try {
    return dirname(dirname(readlinkSync(paths.binLink))) === paths.versionsDir;
  } catch {
    return false;
  }
}
