import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import skillPath from "../../integrations/skill/corgi/SKILL.md" with { type: "file" };
import type { InstallState, SkillLocation } from "../shared/api.ts";
import { run } from "../shared/exec.ts";

// 에이전트 스킬 — 단일 실행 파일 안에 넣어 두고 corgi install·설정 창이 꺼내 설치한다 (S9, docs/design.md §15).
// 설치 위치는 전역(~/.claude/skills) 또는 프로젝트(<폴더>/.claude/skills) — 어디에 넣었는지 기억해 두고
// Corgi 가 바뀌면 모든 위치를 같이 고친다. 프로젝트에 넣을 때는 그 저장소의 작업 트리마다 넣고,
// git 에는 이 Mac 에서만 무시하도록(.git/info/exclude) 적어 팀 저장소에 흔적을 남기지 않는다.

const SKILL_DIR = join(".claude", "skills", "corgi");
/** .git/info/exclude 에 넣는 줄 — 저장소 루트 기준 */
const EXCLUDE_LINE = "/.claude/skills/corgi/";
const EXCLUDE_COMMENT = "# Corgi 스킬 (이 Mac 에만)";

const LocationsFile = z.object({
  locations: z.array(
    z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("global") }),
      z.object({ kind: z.literal("project"), path: z.string().min(1) }),
    ]),
  ),
});

function home(env: NodeJS.ProcessEnv): string {
  return env.HOME ?? homedir();
}

export function skillTarget(env: NodeJS.ProcessEnv = process.env): string {
  return join(home(env), SKILL_DIR, "SKILL.md");
}

export async function bundledSkill(): Promise<string> {
  return Bun.file(skillPath).text();
}

/** 여러 파일의 상태를 하나로 — 전부 같으면 current, 전부 없으면 missing, 나머지는 outdated */
export function combineStates(states: InstallState[]): InstallState {
  if (states.length === 0 || states.every((s) => s === "missing")) return "missing";
  return states.every((s) => s === "current") ? "current" : "outdated";
}

async function fileState(file: string): Promise<InstallState> {
  if (!existsSync(file)) return "missing";
  return readFileSync(file, "utf8") === (await bundledSkill()) ? "current" : "outdated";
}

/** missing = 없음, outdated = 들어 있는 것과 다름, current = 같음 — 전역 위치 */
export async function skillStatus(env: NodeJS.ProcessEnv = process.env): Promise<InstallState> {
  return fileState(skillTarget(env));
}

export async function installSkill(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const target = skillTarget(env);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, await bundledSkill());
  return target;
}

/** 스킬 폴더째 지운다 — 전역 위치 */
export function uninstallSkill(env: NodeJS.ProcessEnv = process.env): void {
  rmSync(dirname(skillTarget(env)), { recursive: true, force: true });
}

// --- 설치 위치 ---

/** 기억해 둔 위치. 파일이 없으면 전역 하나 (예전 설치와 같은 동작) */
export function loadSkillLocations(path: string): SkillLocation[] {
  if (!existsSync(path)) return [{ kind: "global" }];
  try {
    return LocationsFile.parse(JSON.parse(readFileSync(path, "utf8"))).locations;
  } catch {
    return [{ kind: "global" }];
  }
}

export function saveSkillLocations(path: string, locations: SkillLocation[]): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ locations }, null, 2)}\n`);
}

export function sameLocation(a: SkillLocation, b: SkillLocation): boolean {
  if (a.kind === "global" || b.kind === "global") return a.kind === b.kind;
  return resolve(a.path) === resolve(b.path);
}

/** 프로젝트의 작업 트리 폴더들 — git 이 아니면 그 폴더 하나 */
export async function projectRoots(path: string): Promise<string[]> {
  const listed = await run(["git", "-C", path, "worktree", "list", "--porcelain"], {
    timeoutMs: 10_000,
  });
  if (listed.code !== 0) return [resolve(path)];
  const roots = listed.stdout
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length).trim())
    .filter((root) => existsSync(root));
  return roots.length > 0 ? roots : [resolve(path)];
}

async function targetsOf(location: SkillLocation, env: NodeJS.ProcessEnv): Promise<string[]> {
  if (location.kind === "global") return [skillTarget(env)];
  return (await projectRoots(location.path)).map((root) => join(root, SKILL_DIR, "SKILL.md"));
}

export interface LocationStatus {
  location: SkillLocation;
  state: InstallState;
  /** 설치 대상 파일 수 — 프로젝트면 작업 트리 수 */
  targets: number;
}

export async function locationStatus(
  location: SkillLocation,
  env: NodeJS.ProcessEnv = process.env,
): Promise<LocationStatus> {
  const targets = await targetsOf(location, env);
  const states = await Promise.all(targets.map(fileState));
  return { location, state: combineStates(states), targets: targets.length };
}

/** 이 Mac 에서만 무시 — 저장소의 .gitignore 는 건드리지 않는다. 작업 트리가 같이 쓰는 git 폴더에 한 번 */
async function excludePath(root: string): Promise<string | undefined> {
  const common = await run(["git", "-C", root, "rev-parse", "--git-common-dir"], {
    timeoutMs: 10_000,
  });
  if (common.code !== 0) return undefined;
  const dir = common.stdout.trim();
  return join(isAbsolute(dir) ? dir : join(root, dir), "info", "exclude");
}

async function excludeFromGit(root: string): Promise<void> {
  const exclude = await excludePath(root);
  if (!exclude) return;
  const text = existsSync(exclude) ? readFileSync(exclude, "utf8") : "";
  if (text.split("\n").some((line) => line.trim() === EXCLUDE_LINE)) return;
  mkdirSync(dirname(exclude), { recursive: true });
  appendFileSync(
    exclude,
    `${text.length > 0 && !text.endsWith("\n") ? "\n" : ""}${EXCLUDE_COMMENT}\n${EXCLUDE_LINE}\n`,
  );
}

/** excludeFromGit 이 적은 두 줄(설명·경로)만 지운다 — 사람이 적은 줄은 그대로 */
async function unexcludeFromGit(root: string): Promise<void> {
  const exclude = await excludePath(root);
  if (!exclude || !existsSync(exclude)) return;
  const lines = readFileSync(exclude, "utf8").split("\n");
  const kept = lines.filter((line) => line.trim() !== EXCLUDE_LINE && line !== EXCLUDE_COMMENT);
  if (kept.length !== lines.length) writeFileSync(exclude, kept.join("\n"));
}

/** 그 위치에 넣는다 — 넣은 파일들 */
export async function installSkillAt(
  location: SkillLocation,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string[]> {
  const text = await bundledSkill();
  const targets = await targetsOf(location, env);
  for (const target of targets) {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, text);
  }
  if (location.kind === "project") {
    for (const target of targets) await excludeFromGit(dirname(dirname(dirname(dirname(target)))));
  }
  return targets;
}

export async function uninstallSkillAt(
  location: SkillLocation,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const targets = await targetsOf(location, env);
  for (const target of targets) rmSync(dirname(target), { recursive: true, force: true });
  if (location.kind === "project") {
    for (const target of targets)
      await unexcludeFromGit(dirname(dirname(dirname(dirname(target)))));
  }
}

/** 사람에게 보일 위치 — 홈 폴더는 ~ 로 */
export function locationText(location: SkillLocation): string {
  if (location.kind === "global") return "~/.claude/skills/corgi";
  const home = homedir();
  return location.path.startsWith(home) ? `~${location.path.slice(home.length)}` : location.path;
}
