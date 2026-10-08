// 버전 내기 — `bun run release <patch|minor|major|x.y.z> [--dry-run]`
//   1. 작업 트리가 깨끗하고 check·test 가 통과하는지 본다
//   2. package.json 의 version 을 올린다 (버전은 여기 한 곳 — 앱·CLI·서버가 이 값을 읽는다)
//   3. CHANGELOG.md 의 «아직 내지 않은 것» 을 새 버전 절로 옮긴다. 비어 있으면 지난 태그 이후 커밋에서
//      초안을 만든다(feat → 추가, fix → 고침, perf → 바뀜 — 사용자에게 안 보이는 type 은 뺀다)
//   4. `chore(release): vX.Y.Z` 로 커밋하고 `vX.Y.Z` 태그를 붙인다
// `bun run release draft` — 커밋에서 만든 초안을 «아직 내지 않은 것» 에 넣기만 한다(다듬은 뒤 release)
// GitHub Release 올리기·체크섬은 리모트가 생긴 뒤(U단계, docs/design.md §19)

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const CHANGELOG = join(ROOT, "CHANGELOG.md");
const PACKAGE = join(ROOT, "package.json");
const UNRELEASED = "## 아직 내지 않은 것";

const SECTIONS: Record<string, string> = { feat: "추가", fix: "고침", perf: "바뀜" };

function sh(command: string[], quiet = false): string {
  const result = Bun.spawnSync(command, { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) {
    const out = `${result.stdout.toString()}${result.stderr.toString()}`.trim();
    throw new Error(`${command.join(" ")} 실패\n${quiet ? "" : out}`);
  }
  return result.stdout.toString();
}

function lastTag(): string | undefined {
  try {
    return (
      sh(["git", "describe", "--tags", "--abbrev=0", "--match", "v*"], true).trim() || undefined
    );
  } catch {
    return undefined;
  }
}

/** 지난 태그 이후 커밋 → 절마다 줄 */
function draftFromCommits(): string {
  const tag = lastTag();
  const range = tag ? [`${tag}..HEAD`] : [];
  const log = sh(["git", "log", ...range, "--no-merges", "--pretty=%s"]);
  const groups = new Map<string, string[]>();
  for (const subject of log.split("\n").filter(Boolean).reverse()) {
    const m = /^(\w+)(?:\(([^)]+)\))?!?: (.+)$/.exec(subject);
    if (!m) continue;
    const [, type = "", scope, text = ""] = m;
    const section = SECTIONS[type];
    if (!section || subject.startsWith("chore(release)")) continue;
    const list = groups.get(section) ?? [];
    list.push(`- ${text}${scope ? ` (${scope})` : ""}`);
    groups.set(section, list);
  }
  return Object.values(SECTIONS)
    .filter((section) => groups.has(section))
    .map((section) => `### ${section}\n\n${groups.get(section)?.join("\n")}`)
    .join("\n\n");
}

function readChangelog(): { head: string; unreleased: string; rest: string } {
  const text = readFileSync(CHANGELOG, "utf8");
  const start = text.indexOf(UNRELEASED);
  if (start < 0) throw new Error(`CHANGELOG.md 에 «${UNRELEASED}» 절이 없습니다`);
  const after = start + UNRELEASED.length;
  const next = text.indexOf("\n## ", after);
  return {
    head: text.slice(0, after),
    unreleased: text.slice(after, next < 0 ? undefined : next).trim(),
    rest: next < 0 ? "" : text.slice(next + 1),
  };
}

function nextVersion(current: string, bump: string): string {
  if (/^\d+\.\d+\.\d+$/.test(bump)) return bump;
  const [major = 0, minor = 0, patch = 0] = current.split(".").map(Number);
  if (bump === "major") return `${major + 1}.0.0`;
  if (bump === "minor") return `${major}.${minor + 1}.0`;
  if (bump === "patch") return `${major}.${minor}.${patch + 1}`;
  throw new Error("사용법: bun run release <patch|minor|major|x.y.z|draft> [--dry-run]");
}

const [bump = "", ...flags] = process.argv.slice(2);
const dryRun = flags.includes("--dry-run");

if (bump === "draft") {
  const { head, unreleased, rest } = readChangelog();
  const draft = draftFromCommits();
  writeFileSync(
    CHANGELOG,
    `${head}\n\n${[unreleased, draft].filter(Boolean).join("\n\n")}\n\n${rest}`,
  );
  console.log(
    "CHANGELOG.md «아직 내지 않은 것» 에 초안을 넣었습니다 — 다듬은 뒤 bun run release <버전>",
  );
  process.exit(0);
}

const pkg = JSON.parse(readFileSync(PACKAGE, "utf8")) as { version: string };
const version = nextVersion(pkg.version, bump);
if (sh(["git", "status", "--porcelain"]).trim())
  throw new Error("작업 트리에 커밋하지 않은 변경이 있습니다");
console.log(`${pkg.version} → ${version}`);

const { head, unreleased, rest } = readChangelog();
const notes = unreleased || draftFromCommits();
if (!notes) throw new Error("내보낼 변경이 없습니다 (사용자에게 보이는 feat·fix·perf 커밋이 없음)");
const date = new Date().toISOString().slice(0, 10);
const changelog = `${head}\n\n## [${version}] — ${date}\n\n${notes}\n\n${rest}`.replace(
  /\n{3,}/g,
  "\n\n",
);

if (dryRun) {
  console.log(`\n## [${version}] — ${date}\n\n${notes}\n`);
  process.exit(0);
}

console.log("검사·테스트…");
sh(["bun", "run", "check"]);
sh(["bun", "test"]);
pkg.version = version;
writeFileSync(PACKAGE, `${JSON.stringify(pkg, null, 2)}\n`);
writeFileSync(CHANGELOG, changelog.endsWith("\n") ? changelog : `${changelog}\n`);
sh(["git", "add", "package.json", "CHANGELOG.md"]);
sh([
  "git",
  "commit",
  "-q",
  "-m",
  `chore(release): v${version}\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`,
]);
sh(["git", "tag", "-a", `v${version}`, "-m", `simless ${version}`]);
console.log(`v${version} — 커밋하고 태그를 붙였습니다`);
// 팀원에게 줄 설치 파일 — 이 파일 하나를 메신저·드라이브로 보낸다 (R19)
sh(["bun", "run", "build"]);
console.log(`설치 파일: dist/simless-${version}-install.sh — bash 로 실행하면 설치·업데이트`);
