import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import skillPath from "../../integrations/skill/corgi/SKILL.md" with { type: "file" };

// 에이전트 스킬 — 단일 실행 파일 안에 넣어 두고 corgi install 이 꺼내 설치한다 (S9, docs/design.md §15).

export function skillTarget(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.HOME ?? homedir(), ".claude", "skills", "corgi", "SKILL.md");
}

export async function bundledSkill(): Promise<string> {
  return Bun.file(skillPath).text();
}

/** missing = 없음, outdated = 들어 있는 것과 다름, current = 같음 */
export async function skillStatus(
  env: NodeJS.ProcessEnv = process.env,
): Promise<"missing" | "outdated" | "current"> {
  const target = skillTarget(env);
  if (!existsSync(target)) return "missing";
  return readFileSync(target, "utf8") === (await bundledSkill()) ? "current" : "outdated";
}

export async function installSkill(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const target = skillTarget(env);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, await bundledSkill());
  return target;
}

/** 스킬 폴더째 지운다 — 첫 실행 설정 창에서 끌 때 (M14) */
export function uninstallSkill(env: NodeJS.ProcessEnv = process.env): void {
  rmSync(dirname(skillTarget(env)), { recursive: true, force: true });
}
