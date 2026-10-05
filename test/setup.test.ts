import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mcpAddArgs, mcpStatus } from "../src/install/claude-mcp.ts";
import { CorgiServer } from "../src/server/app.ts";
import { listen } from "../src/server/socket.ts";
import type {
  CheckView,
  JobView,
  SetupAgents,
  SetupStatus,
  StatusResult,
} from "../src/shared/api.ts";
import { call } from "../src/shared/client.ts";
import { VERSION } from "../src/shared/version.ts";
import { fakeDriver, session, tempEnv, testServers } from "./helpers.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
});

const COMMAND = ["/opt/corgi/bin/corgi"];
const CHECKS: CheckView[] = [
  { id: "xcode", group: "iOS", name: "Xcode simctl", status: "ok", detail: "Xcode 26" },
  {
    id: "simslim",
    group: "iOS",
    name: "simslim",
    status: "fail",
    detail: "없음",
    fix: "brew install mobai-app/tap/simslim",
  },
];

/** 가짜 claude — 받은 인자를 남기고, add 면 ~/.claude.json 에 MCP 를 적는다 */
function fakeClaude(home: string): string {
  const bin = join(home, ".local", "bin");
  mkdirSync(bin, { recursive: true });
  const path = join(bin, "claude");
  writeFileSync(
    path,
    `#!/bin/sh
echo "$@" >> "$HOME/claude-calls.log"
if [ "$2" = "add" ]; then
  printf '{"mcpServers":{"corgi":{"type":"stdio","command":"%s","args":["mcp"]}}}' "$7" > "$HOME/.claude.json"
fi
if [ "$2" = "remove" ]; then /bin/rm -f "$HOME/.claude.json"; fi
`,
  );
  chmodSync(path, 0o755);
  return path;
}

const startServer = testServers();
const start = async (options: { claude?: boolean } = {}) => {
  const started = await startServer({
    prepare: (env) => {
      if (options.claude) fakeClaude(env.env.HOME);
    },
    // PATH 를 비워 이 Mac 의 진짜 claude 를 쓰지 않게 한다 — HOME 은 임시 폴더
    deps: (env) => ({
      env: { ...env.env, PATH: "" },
      selfCommand: COMMAND,
      setupChecks: async () => CHECKS,
    }),
  });
  return { ...started, home: started.env.env.HOME, paths: started.env.paths };
};

describe("첫 실행 설정 (M14)", () => {
  test("처음에는 설정이 필요하고, 점검과 에이전트 연결 상태를 준다", async () => {
    const { H } = await start();
    expect(((await H("status")) as StatusResult).setupNeeded).toBe(true);
    const setup = (await H("setup.status")) as SetupStatus;
    expect(setup.needed).toBe(true);
    expect(setup.checks.map((c) => c.id)).toEqual(["xcode", "simslim"]);
    expect(setup.agents).toEqual({
      claude: false,
      skill: "missing",
      skillLocations: [{ location: { kind: "global" }, state: "missing", targets: 1 }],
      mcp: "missing",
      hook: "missing",
      rule: "missing",
    });
  });

  test("스킬·보호를 켜고 끄면 그 HOME 에 넣고 지운다", async () => {
    const { H, home } = await start();
    let agents = (await H("setup.apply", { item: "skill", enabled: true })) as SetupAgents;
    expect(agents.skill).toBe("current");
    expect(existsSync(join(home, ".claude", "skills", "corgi", "SKILL.md"))).toBe(true);

    agents = (await H("setup.apply", { item: "protection", enabled: true })) as SetupAgents;
    expect(agents.hook).toBe("current");
    expect(agents.rule).toBe("current");
    const settings = readFileSync(join(home, ".claude", "settings.json"), "utf8");
    expect(settings).toContain("/opt/corgi/bin/corgi hook claude pre-tool-use");

    agents = (await H("setup.apply", { item: "protection", enabled: false })) as SetupAgents;
    expect(agents.hook).toBe("missing");
    expect(agents.rule).toBe("missing");
    agents = (await H("setup.apply", { item: "skill", enabled: false })) as SetupAgents;
    expect(agents.skill).toBe("missing");
  });

  test("스킬을 프로젝트로 옮기면 전역에서 빼고, 작업 트리마다 넣고, git 에서는 이 Mac 에서만 무시한다 (S9)", async () => {
    const { H, home } = await start();
    await H("setup.apply", { item: "skill", enabled: true });
    const repo = join(home, "app");
    mkdirSync(repo);
    const git = (...args: string[]) =>
      Bun.spawnSync(["git", "-C", repo, ...args], { env: { ...process.env, HOME: home } });
    git("init", "-q");
    git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init");
    git("worktree", "add", "-q", join(home, "app-wt"));

    const agents = (await H("setup.skillScope", { kind: "project", paths: [repo] })) as SetupAgents;
    expect(agents.skill).toBe("current");
    expect(agents.skillLocations).toEqual([
      { location: { kind: "project", path: repo }, state: "current", targets: 2 },
    ]);
    expect(existsSync(join(home, ".claude", "skills", "corgi"))).toBe(false);
    expect(existsSync(join(repo, ".claude", "skills", "corgi", "SKILL.md"))).toBe(true);
    expect(existsSync(join(home, "app-wt", ".claude", "skills", "corgi", "SKILL.md"))).toBe(true);
    expect(readFileSync(join(repo, ".git", "info", "exclude"), "utf8")).toContain(
      "/.claude/skills/corgi/",
    );
    // 저장소에는 새 파일로 보이지 않는다
    expect(new TextDecoder().decode(git("status", "--porcelain").stdout).trim()).toBe("");

    // 다시 전역으로
    const back = (await H("setup.skillScope", { kind: "global" })) as SetupAgents;
    expect(back.skillLocations.map((l) => l.location)).toEqual([{ kind: "global" }]);
    expect(existsSync(join(repo, ".claude", "skills", "corgi"))).toBe(false);
  });

  test("넣어 둔 스킬이 예전 것이면 status 가 알리고, 업데이트하면 꺼진다 (S9)", async () => {
    const env = tempEnv();
    mkdirSync(join(env.env.HOME, ".claude", "skills", "corgi"), { recursive: true });
    writeFileSync(join(env.env.HOME, ".claude", "skills", "corgi", "SKILL.md"), "old");
    const server = new CorgiServer({
      ...env,
      drivers: [fakeDriver()],
      env: { ...env.env, PATH: "" },
      selfCommand: COMMAND,
      setupChecks: async () => CHECKS,
    });
    const listener = await listen(env.paths.socket, VERSION, server.handle);
    cleanups.push(() => listener.stop(), env.cleanup);
    // biome-ignore lint/suspicious/noExplicitAny: 테스트 편의
    const H = (method: string, params: unknown = {}): Promise<any> =>
      call(env.paths.socket, method, params, session("web", { human: true })).then((r) => r.result);
    await Bun.sleep(50); // 켤 때 확인이 끝나기를
    expect(((await H("status")) as StatusResult).skillUpdate).toBe(true);
    await H("setup.apply", { item: "skill", enabled: true });
    expect(((await H("status")) as StatusResult).skillUpdate).toBe(false);
  });

  test("없는 폴더는 INVALID", async () => {
    const { H } = await start();
    const error = await H("setup.skillScope", { kind: "project", paths: ["/no/such/dir"] });
    expect(error.code).toBe("INVALID");
  });

  test("claude 가 없으면 MCP 등록은 TOOL_MISSING", async () => {
    const { H } = await start();
    const error = await H("setup.apply", { item: "mcp", enabled: true });
    expect(error.code).toBe("TOOL_MISSING");
  });

  test("MCP 는 claude mcp 명령으로 사용자 범위에 넣고 뺀다", async () => {
    const { H, home } = await start({ claude: true });
    let agents = (await H("setup.apply", { item: "mcp", enabled: true })) as SetupAgents;
    expect(agents.claude).toBe(true);
    expect(agents.mcp).toBe("current");
    const calls = readFileSync(join(home, "claude-calls.log"), "utf8");
    expect(calls).toContain("mcp add --scope user corgi -- /opt/corgi/bin/corgi mcp");

    agents = (await H("setup.apply", { item: "mcp", enabled: false })) as SetupAgents;
    expect(agents.mcp).toBe("missing");
  });

  test("끝내면 다시 묻지 않는다", async () => {
    const { H, paths } = await start();
    expect(await H("setup.finish")).toEqual({ finished: true });
    expect(existsSync(paths.setup)).toBe(true);
    expect(((await H("status")) as StatusResult).setupNeeded).toBe(false);
    expect(((await H("setup.status")) as SetupStatus).needed).toBe(false);
  });
});

describe("Claude Code MCP 등록", () => {
  test("등록 인자 — 사용자 범위, corgi 명령 뒤에 mcp", () => {
    expect(mcpAddArgs(["/usr/local/bin/bun", "/src/main.ts"])).toEqual([
      "mcp",
      "add",
      "--scope",
      "user",
      "corgi",
      "--",
      "/usr/local/bin/bun",
      "/src/main.ts",
      "mcp",
    ]);
  });

  test("~/.claude.json 의 명령이 같으면 current, 다르면 outdated", () => {
    const env = tempEnv();
    cleanups.push(env.cleanup);
    const home = env.env.HOME;
    const write = (command: string, args: string[]) =>
      writeFileSync(
        join(home, ".claude.json"),
        JSON.stringify({ mcpServers: { corgi: { type: "stdio", command, args } } }),
      );
    expect(mcpStatus(COMMAND, env.env)).toBe("missing");
    write("/opt/corgi/bin/corgi", ["mcp"]);
    expect(mcpStatus(COMMAND, env.env)).toBe("current");
    write("/old/corgi", ["mcp"]);
    expect(mcpStatus(COMMAND, env.env)).toBe("outdated");
  });
});

describe("설정 창에서 바로 설치 (M14)", () => {
  const startJobs = testServers();
  const sh = (script: string) => ["/bin/sh", "-c", script];
  const start = () =>
    startJobs({
      deps: (env) => ({
        env: { ...env.env, PATH: "/usr/bin:/bin" },
        setupChecks: async () => CHECKS,
        fixes: {
          "simslim.install": {
            id: "simslim.install",
            kind: "run",
            steps: [{ command: sh("echo one; echo two 1>&2") }, { command: sh("echo three") }],
          },
          // 처음에는 «trust» 를 요구하고, 믿는다고 하면 된다 — avdslim tap 과 같은 모양
          "avdslim.install": {
            id: "avdslim.install",
            kind: "run",
            steps: [
              {
                command: sh(
                  '[ -f "$HOME/trusted" ] && echo installed || { echo "please trust"; exit 1; }',
                ),
                retryWhen: /trust/,
                retry: sh('touch "$HOME/trusted"'),
              },
            ],
          },
          "argent.install": {
            id: "argent.install",
            kind: "run",
            steps: [{ command: sh("echo slow; sleep 5") }],
          },
          "simslim.upgrade": {
            id: "simslim.upgrade",
            kind: "run",
            steps: [{ command: sh("exit 3") }],
          },
        },
      }),
    });

  /** 끝날 때까지 기다린다 */
  async function finished(H: (m: string, p?: unknown) => Promise<JobView[]>, fix: string) {
    for (let i = 0; i < 100; i++) {
      const job = (await H("setup.jobs")).find((j) => j.fix === fix);
      if (job && job.status !== "running") return job;
      await Bun.sleep(20);
    }
    throw new Error(`${fix} 이 끝나지 않음`);
  }

  test("정해 둔 명령을 단계대로 돌리고 출력을 줄마다 남긴다", async () => {
    const { H, server } = await start();
    const events: string[] = [];
    server.subscribe((e) => {
      if (e.type === "output") events.push(e.line);
    });
    const started = (await H("setup.run", { fix: "simslim.install" })) as JobView;
    expect(started.status).toBe("running");
    const job = await finished(H, "simslim.install");
    expect(job.status).toBe("done");
    expect(job.exitCode).toBe(0);
    expect(job.lines).toEqual([
      "$ /bin/sh -c echo one; echo two 1>&2",
      "one",
      "two",
      "$ /bin/sh -c echo three",
      "three",
    ]);
    expect(events).toEqual(job.lines);
  });

  test("출력에 정해 둔 글이 있으면 고치는 명령을 돌리고 한 번 더 한다", async () => {
    const { H } = await start();
    await H("setup.run", { fix: "avdslim.install" });
    const job = await finished(H, "avdslim.install");
    expect(job.status).toBe("done");
    expect(job.lines).toContain("please trust");
    expect(job.lines.at(-1)).toBe("installed");
  });

  test("실패하면 종료 코드, 돌던 것은 취소할 수 있다", async () => {
    const { H } = await start();
    await H("setup.run", { fix: "simslim.upgrade" });
    expect(await finished(H, "simslim.upgrade")).toMatchObject({ status: "failed", exitCode: 3 });

    const slow = (await H("setup.run", { fix: "argent.install" })) as JobView;
    // 같은 항목을 또 누르면 돌던 것을 그대로 준다
    expect(((await H("setup.run", { fix: "argent.install" })) as JobView).id).toBe(slow.id);
    expect(((await H("setup.cancel", { job: slow.id })) as JobView).status).toBe("canceled");
  });

  test("정해 두지 않은 항목은 실행하지 않는다", async () => {
    const { H } = await start();
    expect((await H("setup.run", { fix: "rm -rf /" })).code).toBe("INVALID");
  });
});
