import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bundledSkill, installSkill, skillStatus, skillTarget } from "../src/cli/skill.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function home() {
  const dir = mkdtempSync(join(tmpdir(), "corgi-skill-"));
  dirs.push(dir);
  return { HOME: dir };
}

describe("에이전트 스킬", () => {
  test("들어 있는 스킬은 corgi 스킬 문서다 (이름·트리거 포함)", async () => {
    const text = await bundledSkill();
    expect(text).toStartWith("---\nname: corgi\n");
    expect(text).toContain("코기로 확인해 줘");
  });

  test("없음 → 설치 → 같음, 내용이 바뀌면 예전 버전", async () => {
    const env = home();
    expect(await skillStatus(env)).toBe("missing");
    const target = await installSkill(env);
    expect(target).toBe(join(env.HOME, ".claude", "skills", "corgi", "SKILL.md"));
    expect(await skillStatus(env)).toBe("current");
    writeFileSync(skillTarget(env), "old");
    expect(await skillStatus(env)).toBe("outdated");
    await installSkill(env);
    expect(readFileSync(target, "utf8")).toBe(await bundledSkill());
  });
});
