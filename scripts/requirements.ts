// requirements.md 와 테스트 이름을 읽는다 — `bun run trace` 와 test/requirements.test.ts 가 같이 쓴다.
//
// 요구사항 표 한 줄: «| R4 | 내용 | 확인 |». 확인 칸은 어떻게 확인하는지다.
//   테스트  자동 테스트 — 테스트(describe·test) 이름에 ID 를 넣는다
//   화면    앱 창을 띄워 눈으로 (docs/development.md §5)
//   실사용  실제 에이전트 세션으로
//   argent  Simless 밖에서 argent 가 한다 — 스킬이 안내만
//   미구현  아직 만들지 않음
//   —       확인할 것 없음 (없앰·보류·막을 수 없음)
// 나중(L)·하지 않음(N)·미결정(Q) 표에는 확인 칸이 없다.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export const ROOT = join(import.meta.dir, "..");
export const ID = /\b([RMSPLNQ]\d{1,2})\b/g;
export const CHECKS = ["테스트", "화면", "실사용", "argent", "미구현", "—"] as const;
export type CheckKind = (typeof CHECKS)[number];

export interface Requirement {
  id: string;
  section: string;
  title: string;
  /** 확인 칸 — 나중·하지 않음·미결정 표는 undefined */
  check?: CheckKind;
}

export function readRequirements(text = readFileSync(join(ROOT, "requirements.md"), "utf8")) {
  const rows: Requirement[] = [];
  let section = "";
  for (const line of text.split("\n")) {
    if (line.startsWith("## ")) section = line.slice(3).trim();
    const cells = /^\| ([RMSPLNQ]\d{1,2}) \|/.test(line)
      ? line
          .split(/(?<!\\)\|/)
          .slice(1, -1)
          .map((c) => c.trim())
      : undefined;
    if (!cells?.[0] || cells[1] === undefined) continue;
    const title = cells[1]
      .replace(/\*\*|~~/g, "")
      .replace(/\s+—.*$/, "")
      .slice(0, 48);
    const last = cells.at(-1);
    const check =
      cells.length >= 3 && CHECKS.includes(last as CheckKind) ? (last as CheckKind) : undefined;
    rows.push({ id: cells[0], section, title, check });
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

/** 테스트 파일마다 describe·test 이름 — 본문의 우연한 글자는 세지 않는다 */
export function testNames(): { file: string; name: string }[] {
  return files(join(ROOT, "test"), /\.test\.ts$/).flatMap((file) =>
    [...readFileSync(file, "utf8").matchAll(/\b(?:describe|test)\(\s*(["'`])(.*?)\1/g)].map(
      (m) => ({ file: file.slice(ROOT.length + 1), name: m[2] ?? "" }),
    ),
  );
}

/** ID 마다 몇 번 나오나 */
export function countIds(chunks: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const chunk of chunks)
    for (const [, id] of chunk.matchAll(ID)) counts.set(id ?? "", (counts.get(id ?? "") ?? 0) + 1);
  return counts;
}

/** 코드(src·integrations)에서 ID 를 가리키는 횟수 */
export function codeIdCounts(): Map<string, number> {
  return countIds(
    [...files(join(ROOT, "src"), /\.(ts|tsx)$/), ...files(join(ROOT, "integrations"), /\.md$/)].map(
      (path) => readFileSync(path, "utf8"),
    ),
  );
}
