import { describe, expect, test } from "bun:test";
import { CHECKS, countIds, ID, readRequirements, testNames } from "../scripts/requirements.ts";

// requirements.md 와 테스트가 어긋나지 않게 — 요구사항을 더하거나 테스트를 쓸 때 여기서 걸린다

const requirements = readRequirements();
const names = testNames();

describe("요구사항 ↔ 테스트", () => {
  test("요구사항 ID 는 한 번씩만 — 지운 것도 취소선으로 남겨 다시 쓰지 않는다", () => {
    const ids = requirements.map((r) => r.id);
    expect(ids.filter((id, i) => ids.indexOf(id) !== i)).toEqual([]);
  });

  test("요구사항 표(R·M·S·P)는 모두 확인 칸이 있고, 정해 둔 값만 쓴다", () => {
    const table = requirements.filter((r) => /^[RMSP]\d/.test(r.id));
    expect(table.filter((r) => !r.check).map((r) => r.id)).toEqual([]);
    const allowed: readonly string[] = CHECKS;
    for (const r of table) expect(allowed).toContain(r.check ?? "");
  });

  test("확인이 «테스트» 인 요구사항은 이름에 그 ID 가 든 테스트가 있다", () => {
    const counts = countIds(names.map((n) => n.name));
    const missing = requirements.filter((r) => r.check === "테스트" && !counts.get(r.id));
    expect(missing.map((r) => `${r.id} ${r.title}`)).toEqual([]);
  });

  test("테스트 이름의 ID 는 requirements.md 에 있다 — 오타·지운 ID", () => {
    const known = new Set(requirements.map((r) => r.id));
    const unknown = names.flatMap((n) =>
      [...n.name.matchAll(ID)]
        .map((m) => m[1] ?? "")
        .filter((id) => !known.has(id))
        .map((id) => `${n.file}: ${id} — ${n.name}`),
    );
    expect(unknown).toEqual([]);
  });

  test("표 안의 순서는 ID 순 — 찾기 쉽게", () => {
    const bySection = new Map<string, number[]>();
    for (const r of requirements) {
      const key = `${r.section}/${r.id[0]}`;
      bySection.set(key, [...(bySection.get(key) ?? []), Number(r.id.slice(1))]);
    }
    for (const [key, numbers] of bySection)
      expect({ key, numbers }).toEqual({ key, numbers: [...numbers].sort((a, b) => a - b) });
  });
});
