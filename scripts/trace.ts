// 요구사항 ↔ 테스트·코드 추적 — `bun run trace`
// requirements.md 의 요구사항 ID(R4·M7·S11 …)마다 확인 방법(확인 칸), 테스트 이름에 그 ID 가 몇 번
// 나오는지, 코드(src·integrations)에서 몇 번 가리키는지 보여 준다.
//
//   bun run trace            모든 ID
//   bun run trace --missing  확인이 «테스트» 인데 테스트가 없는 ID 만
//
// 같은 규칙을 test/requirements.test.ts 가 검사한다 — 빠지면 테스트가 실패한다.

import { codeIdCounts, countIds, readRequirements, testNames } from "./requirements.ts";

const requirements = readRequirements();
const tests = countIds(testNames().map((t) => t.name));
const code = codeIdCounts();

const missingOnly = process.argv.includes("--missing");
const rows = requirements.filter((r) => !missingOnly || (r.check === "테스트" && !tests.get(r.id)));

const pad = (text: string, width: number) => text + " ".repeat(Math.max(0, width - text.length));
console.log(`${pad("ID", 5)}${pad("확인", 8)}${pad("테스트", 7)}${pad("코드", 6)}요구사항`);
for (const r of rows) {
  const t = tests.get(r.id) ?? 0;
  const mark = r.check === "테스트" && t === 0 ? "  ← 테스트 없음" : "";
  console.log(
    `${pad(r.id, 5)}${pad(r.check ?? "(표 밖)", 8)}${pad(String(t), 7)}${pad(String(code.get(r.id) ?? 0), 6)}${r.title}${mark}`,
  );
}

if (!missingOnly) {
  const counted = new Map<string, number>();
  for (const r of requirements) if (r.check) counted.set(r.check, (counted.get(r.check) ?? 0) + 1);
  const tested = requirements.filter((r) => r.check === "테스트" && tests.get(r.id)).length;
  console.log(
    `\n확인 방법: ${[...counted].map(([k, n]) => `${k} ${n}`).join(" · ")} — 테스트 ${tested}/${counted.get("테스트") ?? 0} 개에 테스트 있음`,
  );
}
