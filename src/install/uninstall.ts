import { existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SkillLocation } from "../shared/api.ts";
import type { Paths } from "../shared/paths.ts";
import { AGENT_INTEGRATIONS } from "./agents.ts";
import { uninstallApp } from "./app-bundle.ts";
import { uninstallHook, uninstallRule } from "./claude-hook.ts";
import { uninstallMcp } from "./claude-mcp.ts";
import { uninstall as uninstallLaunchd, uninstallSelf } from "./launchd.ts";
import { loadSkillLocations, locationText, sameLocation, uninstallSkillAt } from "./skill.ts";

// Simless 제거 (S12) — `simless uninstall` 과 설정 창의 «Simless 제거» 가 같이 쓴다.
// 순서: 에이전트 연결(스킬·훅·규칙·MCP) → 앱·메뉴바 → 데이터(--purge) → 서버 등록.
// 서버가 스스로를 지울 때는 서버 등록이 마지막이어야 한다 — 내리는 순간 이 프로세스가 끝난다.
// 지우지 않는 것: simless 가 만든 기기(이 Mac 의 일반 기기로 남는다), simless 명령 자체.

export interface UninstallStep {
  /** 무엇을 — 사람이 읽는 위치·이름 */
  what: string;
  ok: boolean;
  error?: string;
}

async function step(steps: UninstallStep[], what: string, fn: () => unknown): Promise<void> {
  try {
    await fn();
    steps.push({ what, ok: true });
  } catch (error) {
    steps.push({ what, ok: false, error: error instanceof Error ? error.message : String(error) });
  }
}

/** 지운 뒤에도 남는 데이터 폴더 — --purge 가 지운다 */
export function dataDirs(paths: Paths, env: NodeJS.ProcessEnv = process.env): string[] {
  const home = env.HOME ?? homedir();
  return [
    paths.stateDir,
    paths.logDir,
    paths.configDir,
    env.SIMLESS_CACHE_DIR ?? join(home, "Library", "Caches", "Simless"),
  ];
}

/** 스킬(넣어 둔 모든 곳 + 전역)·모든 에이전트의 훅·규칙·MCP. 읽지 못하는 설정 파일은 건드리지 않고 실패로 적는다 */
export async function removeIntegrations(
  paths: Paths,
  env: NodeJS.ProcessEnv = process.env,
): Promise<UninstallStep[]> {
  const steps: UninstallStep[] = [];
  const locations: SkillLocation[] = loadSkillLocations(paths.skills);
  if (!locations.some((l) => sameLocation(l, { kind: "global" })))
    locations.push({ kind: "global" });
  for (const location of locations)
    await step(steps, `skill: ${locationText(location)}`, () => uninstallSkillAt(location, env));
  await step(steps, "Claude Code: hook", () => uninstallHook(env));
  await step(steps, "Claude Code: rule", () => uninstallRule(env));
  await step(steps, "Claude Code: MCP", () => uninstallMcp(env));
  for (const a of AGENT_INTEGRATIONS) {
    await step(steps, `${a.label}: hook`, () => a.uninstallHook(env));
    await step(steps, `${a.label}: rule`, () => a.uninstallRule(env));
    await step(steps, `${a.label}: MCP`, () => a.uninstallMcp(env));
  }
  return steps;
}

export async function removeApp(paths: Paths): Promise<UninstallStep[]> {
  const steps: UninstallStep[] = [];
  await step(steps, paths.appBundle, () => uninstallApp(paths));
  return steps;
}

/** 데이터·기록·로그·설정·빌드 캐시 폴더째 — 정해 둔 위치만 지운다 */
export function purgeData(paths: Paths, env: NodeJS.ProcessEnv = process.env): UninstallStep[] {
  return dataDirs(paths, env)
    .filter((dir) => existsSync(dir))
    .map((dir) => {
      try {
        rmSync(dir, { recursive: true, force: true });
        return { what: dir, ok: true };
      } catch (error) {
        return { what: dir, ok: false, error: String(error) };
      }
    });
}

/** self = 서버가 스스로 부를 때 — 이 호출 뒤에는 돌아오지 않을 수 있다 */
export async function removeLaunchd(paths: Paths, self = false): Promise<UninstallStep[]> {
  const steps: UninstallStep[] = [];
  await step(steps, paths.launchAgent, () =>
    self ? uninstallSelf(paths) : uninstallLaunchd(paths),
  );
  return steps;
}
