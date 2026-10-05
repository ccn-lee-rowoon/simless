import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

// 폴더 사이 경계 (docs/design.md §3) — 새 코드가 경계를 넘으면 여기서 걸린다.
//   shared  모두가 쓴다. 아무 폴더도 import 하지 않는다
//   install 설치·점검 — shared 만
//   server  shared·install
//   cli     shared·install (서버와는 소켓으로만)
//   hook·mcp·web  shared (mcp 는 서버를 켜려고 install/launchd 도)
// 예외는 EXCEPTIONS 에 이유와 함께 적는다.

const SRC = join(import.meta.dir, "..", "src");
const ALLOWED: Record<string, string[]> = {
  shared: ["shared"],
  install: ["shared", "install"],
  server: ["shared", "install", "server"],
  cli: ["shared", "install", "cli"],
  hook: ["shared", "hook"],
  mcp: ["shared", "install", "mcp"],
  web: ["shared", "web"],
};

/** 정해 둔 예외 — 서버가 웹 화면 묶음을 내보내고, `corgi serve` 가 서버를 켠다 */
const EXCEPTIONS = new Set(["server/http.ts → web/index.html", "cli/index.ts → server/index.ts"]);

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

describe("폴더 경계", () => {
  test("각 폴더는 허락된 폴더만 import 한다", () => {
    const broken: string[] = [];
    for (const file of sources(SRC)) {
      const [layer] = relative(SRC, file).split("/");
      const allowed = layer ? ALLOWED[layer] : undefined;
      if (!allowed) continue; // main.ts·types.d.ts — 진입점
      const text = readFileSync(file, "utf8");
      for (const [, spec] of text.matchAll(/(?:from|import\()\s*"(\.[^"]+)"/g)) {
        const target = relative(SRC, join(file, "..", spec ?? ""));
        if (target.startsWith("..")) continue; // integrations·tray·assets 같은 묶음 파일
        const [targetLayer] = target.split("/");
        const link = `${relative(SRC, file)} → ${target}`;
        if (
          targetLayer &&
          ALLOWED[targetLayer] &&
          !allowed.includes(targetLayer) &&
          !EXCEPTIONS.has(link)
        )
          broken.push(link);
      }
    }
    expect(broken).toEqual([]);
  });
});
