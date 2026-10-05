import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { run } from "../shared/exec.ts";
import type { Paths } from "../shared/paths.ts";
import { AGENT_INTEGRATIONS } from "./agents.ts";
import { installHook, installRule } from "./claude-hook.ts";
import { claudeBinary, installMcp } from "./claude-mcp.ts";
import { installSkillAt, loadSkillLocations, projectRoots } from "./skill.ts";

// 예전 이름(Corgi)으로 설치된 것을 simless 로 옮긴다 (2026-10-05 이름 변경, requirements «결정 기록»).
// simless install 이 맨 처음 부른다. 사용자가 켜 둔 것만 새 이름으로 다시 넣고, 예전 것은 지운다.
// 데이터 폴더는 새 폴더가 없을 때만 통째로 옮긴다 — 기기 정보·그룹·기록·설정이 그대로 남는다.
// 이 파일만 예전 이름을 글자 그대로 쓴다(이름을 바꿔도 옛 설치를 찾을 수 있게).

const OLD = {
  name: "Corgi",
  slug: "corgi",
  launch: "corgi.server",
  menubar: "corgi.menubar",
  bundle: "local.corgi.app",
};

function domain(): string {
  return `gui/${process.getuid?.() ?? 501}`;
}

/** 서버가 켜지기 전에도 부른다 — 새 폴더가 없고 예전 폴더가 있으면 옮긴다 */
export function migrateLegacyDirs(paths: Paths, env: NodeJS.ProcessEnv = process.env): string[] {
  const home = env.HOME ?? homedir();
  const moved: string[] = [];
  const pairs: [string, string][] = [
    [join(home, "Library", "Application Support", OLD.name), paths.stateDir],
    [join(home, ".config", OLD.slug), paths.configDir],
    [join(home, "Library", "Logs", OLD.name), paths.logDir],
  ];
  for (const [from, to] of pairs) {
    if (!existsSync(from) || existsSync(to)) continue;
    renameSync(from, to);
    moved.push(`${from} → ${to}`);
  }
  // 예전 소켓은 예전 서버의 것 — 새 서버가 새 이름으로 만든다
  rmSync(join(paths.stateDir, `${OLD.slug}.sock`), { force: true });
  return moved;
}

/**
 * 예전 이름의 서버·메뉴바·앱을 내리고, 켜 둔 연결(스킬·규칙·훅·MCP)을 새 이름으로 다시 넣는다.
 * 돌려주는 것은 한 일 — 설치 결과에 보인다.
 */
export async function migrateLegacy(
  paths: Paths,
  command: string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<string[]> {
  const home = env.HOME ?? homedir();
  const done: string[] = [];

  // 1. 예전 서버·메뉴바 — 내려야 데이터 폴더를 옮길 수 있다
  for (const label of [OLD.launch, OLD.menubar]) {
    const plist = join(home, "Library", "LaunchAgents", `${label}.plist`);
    if (!existsSync(plist)) continue;
    await run(["launchctl", "bootout", `${domain()}/${label}`]);
    rmSync(plist, { force: true });
    done.push(`launchd ${label}`);
  }
  const oldApp = join(home, "Applications", `${OLD.name}.app`);
  if (existsSync(oldApp)) {
    await run(["pkill", "-f", join(oldApp, "Contents", "MacOS")]);
    await run([
      "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister",
      "-u",
      oldApp,
    ]);
    rmSync(oldApp, { recursive: true, force: true });
    done.push(oldApp);
  }

  // 2. 데이터 폴더
  done.push(...migrateLegacyDirs(paths, env));

  // 3. 스킬 — 넣어 둔 곳마다 예전 폴더를 지우고 새 이름으로
  let anySkill = false;
  for (const location of loadSkillLocations(paths.skills)) {
    let hadSkill = false;
    const roots = location.kind === "global" ? [home] : await projectRoots(location.path);
    for (const root of roots) {
      for (const dir of [
        join(root, ".claude", "skills", OLD.slug),
        join(root, ".agents", "skills", OLD.slug),
      ]) {
        if (!existsSync(dir)) continue;
        rmSync(dir, { recursive: true, force: true });
        hadSkill = true;
      }
      if (location.kind === "project") removeOldExclude(root);
    }
    if (hadSkill) await installSkillAt(location, env);
    anySkill ||= hadSkill;
  }
  if (anySkill) done.push("skill");

  // 4. Claude Code 규칙·훅 — 훅은 명령 끝(« hook claude pre-tool-use»)으로 찾아 새 명령으로 바꾼다
  const oldRule = join(home, ".claude", "rules", `${OLD.slug}.md`);
  if (existsSync(oldRule)) {
    rmSync(oldRule, { force: true });
    await installRule(env);
    done.push("rule");
  }
  const settings = join(home, ".claude", "settings.json");
  if (
    existsSync(settings) &&
    readFileSync(settings, "utf8").includes(" hook claude pre-tool-use")
  ) {
    installHook(command, env);
    done.push("hook");
  }

  // 5. Claude Code MCP — 예전 이름으로 등록돼 있으면 빼고 새 이름으로
  const claudeJson = join(home, ".claude.json");
  const claude = claudeBinary(env);
  if (claude && existsSync(claudeJson) && hasMcp(claudeJson, OLD.slug)) {
    await run([claude, "mcp", "remove", "--scope", "user", OLD.slug], {
      env,
      cwd: home,
      timeoutMs: 30_000,
    });
    await installMcp(command, env);
    done.push("mcp");
  }

  // 6. 다른 에이전트 — 훅은 명령 끝으로 찾으니 다시 넣으면 바뀐다. 규칙 블록·MCP 이름은 바꿔 넣는다
  for (const agent of AGENT_INTEGRATIONS) {
    try {
      if ((await agent.hookState(command, env)) !== "missing") {
        await agent.installHook(command, env);
        done.push(`hook:${agent.agent}`);
      }
      if (removeOldRuleBlocks(home, agent.agent)) {
        await agent.installRule(env);
        done.push(`rule:${agent.agent}`);
      }
      if (await removeOldMcp(home, agent.agent, env)) {
        await agent.installMcp(command, env);
        done.push(`mcp:${agent.agent}`);
      }
    } catch (error) {
      done.push(`${agent.agent}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return done;
}

function hasMcp(path: string, name: string): boolean {
  try {
    const json = JSON.parse(readFileSync(path, "utf8")) as { mcpServers?: Record<string, unknown> };
    return Boolean(json.mcpServers?.[name]);
  } catch {
    return false;
  }
}

function removeOldExclude(root: string): void {
  const exclude = join(root, ".git", "info", "exclude");
  if (!existsSync(exclude)) return;
  const lines = readFileSync(exclude, "utf8").split("\n");
  const kept = lines.filter(
    (l) =>
      ![
        `/.claude/skills/${OLD.slug}/`,
        `/.agents/skills/${OLD.slug}/`,
        `# ${OLD.name} 스킬 (이 Mac 에만)`,
      ].includes(l.trim()),
  );
  if (kept.length !== lines.length) writeFileSync(exclude, kept.join("\n"));
}

/** 다른 에이전트의 예전 규칙(블록·파일)을 지운다 — 있었으면 true */
function removeOldRuleBlocks(home: string, agent: string): boolean {
  if (agent === "cursor") {
    const file = join(home, ".cursor", "rules", `${OLD.slug}.mdc`);
    if (!existsSync(file)) return false;
    rmSync(file, { force: true });
    return true;
  }
  const file = {
    codex: join(home, ".codex", "AGENTS.md"),
    copilot: join(home, ".copilot", "copilot-instructions.md"),
    gemini: join(home, ".gemini", "GEMINI.md"),
  }[agent];
  if (!file || !existsSync(file)) return false;
  const text = readFileSync(file, "utf8");
  const start = text.indexOf(`<!-- ${OLD.slug}:start`);
  const end = text.indexOf(`<!-- ${OLD.slug}:end -->`);
  if (start < 0 || end < start) return false;
  const after = (
    text.slice(0, start) + text.slice(end + `<!-- ${OLD.slug}:end -->`.length)
  ).replace(/\n{3,}/g, "\n\n");
  writeFileSync(file, after.trimEnd() ? `${after.trimEnd()}\n` : "");
  return true;
}

/** 다른 에이전트에 예전 이름으로 등록한 MCP 를 뺀다 — 있었으면 true */
async function removeOldMcp(home: string, agent: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  if (agent === "codex") {
    const config = join(home, ".codex", "config.toml");
    if (!existsSync(config) || !readFileSync(config, "utf8").includes(`[mcp_servers.${OLD.slug}]`))
      return false;
    await run(["codex", "mcp", "remove", OLD.slug], { env, cwd: home, timeoutMs: 30_000 });
    return true;
  }
  const file = {
    copilot: join(home, ".copilot", "mcp-config.json"),
    cursor: join(home, ".cursor", "mcp.json"),
    gemini: join(home, ".gemini", "settings.json"),
  }[agent];
  if (!file || !existsSync(file)) return false;
  try {
    const json = JSON.parse(readFileSync(file, "utf8")) as { mcpServers?: Record<string, unknown> };
    if (!json.mcpServers?.[OLD.slug]) return false;
    delete json.mcpServers[OLD.slug];
    writeFileSync(file, `${JSON.stringify(json, null, 2)}\n`);
    return true;
  } catch {
    return false;
  }
}
