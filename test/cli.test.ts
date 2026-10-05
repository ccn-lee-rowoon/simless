import { describe, expect, test } from "bun:test";
import pkg from "../package.json" with { type: "json" };

const entry = new URL("../bin/simless.ts", import.meta.url).pathname;

async function run(args: string[], stdin = "") {
  const proc = Bun.spawn([process.execPath, entry, ...args], {
    stdin: new Blob([stdin]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

describe("simless", () => {
  test("--version 은 package.json 버전을 출력한다", async () => {
    const { stdout, exitCode } = await run(["--version"]);
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toBe(pkg.version);
  });

  test("모르는 명령은 사용법 오류(2)", async () => {
    const { exitCode } = await run(["no-such-command"]);
    expect(exitCode).toBe(2);
  });
});

describe("simless hook", () => {
  test("claude pre-tool-use 는 입력을 읽고 아무것도 출력하지 않은 채 통과(0)", async () => {
    const input = JSON.stringify({
      session_id: "test",
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "ls" },
    });
    const { stdout, exitCode } = await run(["hook", "claude", "pre-tool-use"], input);
    expect(exitCode).toBe(0);
    expect(stdout).toBe("");
  });

  test("어댑터가 없는 에이전트는 사용법 오류(2)", async () => {
    const { exitCode } = await run(["hook", "no-such-agent", "pre-tool-use"]);
    expect(exitCode).toBe(2);
  });

  test("어댑터에 없는 이벤트는 사용법 오류(2)", async () => {
    const { exitCode } = await run(["hook", "claude", "post-tool-use"]);
    expect(exitCode).toBe(2);
  });
});
