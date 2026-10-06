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
  const dir = mkdtempSync(join(tmpdir(), "simless-claude-"));
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
    expect(hookStatus(["/bin/simless"], env)).toBe("missing");
    installHook(["/bin/simless"], env);
    const settings = read(env);
    expect(settings.model).toBe("opus");
    expect(settings.hooks.PostCompact).toHaveLength(1);
    expect(settings.hooks.PreToolUse).toEqual([
      { matcher: "Write", hooks: [{ type: "command", command: "lint" }] },
      {
        matcher: HOOK_MATCHER,
        hooks: [{ type: "command", command: "/bin/simless hook claude pre-tool-use" }],
      },
    ]);
    expect(existsSync(`${settingsPath(env)}.simless-backup`)).toBe(true);
    expect(hookStatus(["/bin/simless"], env)).toBe("current");
  });

  test("다시 설치하면 예전 simless 훅을 바꾼다 — 여러 줄 생기지 않는다, 경로의 공백은 따옴표로", () => {
    const env = home();
    installHook(["/old/simless"], env);
    expect(hookStatus(["/new path/bun", "/x/simless.ts"], env)).toBe("outdated");
    installHook(["/new path/bun", "/x/simless.ts"], env);
    const hooks = read(env).hooks.PreToolUse;
    expect(hooks).toHaveLength(1);
    expect(hooks[0].hooks[0].command).toBe(hookCommand(["/new path/bun", "/x/simless.ts"]));
    expect(hooks[0].hooks[0].command).toBe(
      "'/new path/bun' /x/simless.ts hook claude pre-tool-use",
    );
  });

  test("지우면 simless 훅만 빠지고, 남은 게 없으면 PreToolUse 도 없앤다", () => {
    const env = home();
    installHook(["/bin/simless"], env);
    uninstallHook(env);
    // 다른 훅이 없었으면 빈 "hooks" 도 남기지 않는다
    expect(read(env).hooks).toBeUndefined();
    expect(hookStatus(["/bin/simless"], env)).toBe("missing");
  });

  test("규칙은 점유한 뒤에만 건드리고 켜기는 Simless 로 하라고 적는다 (P2)", async () => {
    const env = home();
    const text = readFileSync(await installRule(env), "utf8");
    // 점유한 뒤에만 — argent·adb·simctl, 읽기(스크린샷·describe)도
    expect(text).toContain("Before touching one with argent, adb, or simctl");
    expect(text).toContain("screenshots and `describe` included");
    expect(text).toContain("simless use --default ios|android");
    // 켜기·끄기는 Simless 로
    expect(text).toContain("Boot and shut down with `simless use` / `simless down`");
    expect(text).toContain("never `simless release --force`");
  });

  test("규칙 파일은 ~/.claude/rules/simless.md", async () => {
    const env = home();
    expect(await ruleStatus(env)).toBe("missing");
    const target = await installRule(env);
    expect(target).toBe(join(env.HOME, ".claude", "rules", "simless.md"));
    expect(readFileSync(target, "utf8")).toContain("simless use");
    expect(await ruleStatus(env)).toBe("current");
  });
});
