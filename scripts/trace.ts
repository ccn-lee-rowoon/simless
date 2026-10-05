// 요구사항 ↔ 테스트·코드 추적 — `bun run trace`
// requirements.md 의 요구사항 ID(R4·M7·S11 …)마다, 테스트 이름에 그 ID 가 몇 번 나오고
// 코드(src·integrations)에서 몇 번 가리키는지 보여 준다. 테스트가 없는 요구사항을 찾을 때 쓴다.
//
//   bun run trace            모든 ID
//   bun run trace --missing  테스트가 없는 ID 만 (나중·하지 않음·미결정 표는 뺀다)

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const ID = /\b([RMSPLNQ]\d{1,2})\b/g;

/** requirements.md 의 표 줄 «| R4 | … |» — 어느 절에 있는지도 기억한다 */
function requirements(): { id: string; section: string; title: string }[] {
  const rows: { id: string; section: string; title: string }[] = [];
  let section = "";
  for (const line of readFileSync(join(ROOT, "requirements.md"), "utf8").split("\n")) {
    if (line.startsWith("## ")) section = line.slice(3).trim();
    const match = /^\| ([RMSPLNQ]\d{1,2}) \| (.*?) \|/.exec(line);
    if (match?.[1] && match[2]) {
      const removed = match[2].startsWith("~~");
      const title = match[2].replace(/\*\*|~~/g, "").replace(/\s+—.*$/, "");
      rows.push({ id: match[1], section: removed ? "삭제" : section, title: title.slice(0, 48) });
    }
  }
  return rows;
}

function files(dir: string, ext: RegExp): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "node_modules" ? [] : files(path, ext);
    return ext.test(name) ? [path] : [];
  });
}

function count(paths: string[], pick: (text: string) => string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const path of paths) {
    for (const chunk of pick(readFileSync(path, "utf8"))) {
      for (const [, id] of chunk.matchAll(ID))
        counts.set(id ?? "", (counts.get(id ?? "") ?? 0) + 1);
    }
  }
  return counts;
}

// 테스트는 describe·test 의 이름만 본다 — 본문의 우연한 글자는 세지 않는다
const testNames = (text: string) =>
  [...text.matchAll(/\b(?:describe|test)\(\s*(["'`])(.*?)\1/g)].map((m) => m[2] ?? "");
const tests = count(files(join(ROOT, "test"), /\.test\.ts$/), testNames);
const code = count(
  [...files(join(ROOT, "src"), /\.(ts|tsx)$/), ...files(join(ROOT, "integrations"), /\.md$/)],
  (text) => [text],
);

/** 테스트가 없어도 되는 절 — 나중·하지 않음·미결정·지운 요구사항 */
const NOT_BUILT = /나중|하지 않는 것|아직 정하지 않은 것|삭제/;
const missingOnly = process.argv.includes("--missing");
const rows = requirements().filter(
  (r) => !missingOnly || (!NOT_BUILT.test(r.section) && !tests.get(r.id)),
);

const pad = (text: string, width: number) => text + " ".repeat(Math.max(0, width - text.length));
console.log(`${pad("ID", 5)}${pad("테스트", 7)}${pad("코드", 6)}요구사항`);
for (const r of rows) {
  const t = tests.get(r.id) ?? 0;
  const c = code.get(r.id) ?? 0;
  const mark = NOT_BUILT.test(r.section)
    ? " (나중·안 함·미결정)"
    : t === 0
      ? "  ← 테스트 없음"
      : "";
  console.log(`${pad(r.id, 5)}${pad(String(t), 7)}${pad(String(c), 6)}${r.title}${mark}`);
}
