import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HOOK_MATCHER,
  hookCommand,
  hookStatus,
  installHook,
  installRule,
  ruleStatus,
  settingsPath,
  uninstallHook,
} from "../src/install/claude-hook.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function home() {
  const dir = mkdtempSync(join(tmpdir(), "corgi-claude-"));
  dirs.push(dir);
  return { HOME: dir };
}
const read = (env: { HOME: string }) => JSON.parse(readFileSync(settingsPath(env), "utf8"));

describe("Claude Code 훅 설치 (P3)", () => {
  test("다른 설정·다른 훅은 그대로 두고 PreToolUse 에 한 줄을 넣는다, 백업을 남긴다", () => {
    const env = home();
    mkdirSync(join(env.HOME, ".claude"));
    writeFileSync(
      settingsPath(env),
      JSON.stringify({
        model: "opus",
        hooks: {
          PreToolUse: [{ matcher: "Write", hooks: [{ type: "command", command: "lint" }] }],
          PostCompact: [{ hooks: [{ type: "command", command: "x" }] }],
        },
      }),
    );
    expect(hookStatus(["/bin/corgi"], env)).toBe("missing");
    installHook(["/bin/corgi"], env);
    const settings = read(env);
    expect(settings.model).toBe("opus");
    expect(settings.hooks.PostCompact).toHaveLength(1);
    expect(settings.hooks.PreToolUse).toEqual([
      { matcher: "Write", hooks: [{ type: "command", command: "lint" }] },
      {
        matcher: HOOK_MATCHER,
        hooks: [{ type: "command", command: "/bin/corgi hook claude pre-tool-use" }],
      },
    ]);
    expect(existsSync(`${settingsPath(env)}.corgi-backup`)).toBe(true);
    expect(hookStatus(["/bin/corgi"], env)).toBe("current");
  });

  test("다시 설치하면 예전 Corgi 훅을 바꾼다 — 여러 줄 생기지 않는다, 경로의 공백은 따옴표로", () => {
    const env = home();
    installHook(["/old/corgi"], env);
    expect(hookStatus(["/new path/bun", "/x/corgi.ts"], env)).toBe("outdated");
    installHook(["/new path/bun", "/x/corgi.ts"], env);
    const hooks = read(env).hooks.PreToolUse;
    expect(hooks).toHaveLength(1);
    expect(hooks[0].hooks[0].command).toBe(hookCommand(["/new path/bun", "/x/corgi.ts"]));
    expect(hooks[0].hooks[0].command).toBe("'/new path/bun' /x/corgi.ts hook claude pre-tool-use");
  });

  test("지우면 Corgi 훅만 빠지고, 남은 게 없으면 PreToolUse 도 없앤다", () => {
    const env = home();
    installHook(["/bin/corgi"], env);
    uninstallHook(env);
    expect(read(env).hooks.PreToolUse).toBeUndefined();
    expect(hookStatus(["/bin/corgi"], env)).toBe("missing");
  });

  test("규칙 파일은 ~/.claude/rules/corgi.md", async () => {
    const env = home();
    expect(await ruleStatus(env)).toBe("missing");
    const target = await installRule(env);
    expect(target).toBe(join(env.HOME, ".claude", "rules", "corgi.md"));
    expect(readFileSync(target, "utf8")).toContain("corgi use");
    expect(await ruleStatus(env)).toBe("current");
  });
});
