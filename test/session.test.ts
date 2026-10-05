import { describe, expect, test } from "bun:test";
import type { ProcInfo } from "../src/shared/proc.ts";
import { detectSession } from "../src/shared/session.ts";

/** [pid, ppid, name, path] 로 가짜 프로세스 표를 만든다. 표에 없는 PID 는 못 읽는 프로세스(root 등) */
function table(rows: [number, number, string, string][]) {
  const map = new Map<number, ProcInfo>(
    rows.map(([pid, ppid, name, path]) => [pid, { pid, ppid, name, path, startedAt: 1000 + pid }]),
  );
  return (pid: number) => map.get(pid) ?? null;
}

const base = { env: {}, cwd: "/work" };

describe("detectSession — 세션 = 에이전트 프로세스 (R18)", () => {
  test("Claude Code — 셸을 건너뛰고 claude 프로세스가 세션 (이 Mac 실측 모양)", () => {
    const read = table([
      [300, 200, "zsh", "/bin/zsh"],
      [200, 100, "2.1.287", "/Users/me/.local/share/claude/versions/2.1.287"],
      [100, 90, "zsh", "/bin/zsh"],
      [90, 80, "zsh (kiro-cli-term)", "/Users/me/.local/bin/zsh (kiro-cli-term)"],
      // 80 = /usr/bin/login (root) — 못 읽는다
    ]);
    const session = detectSession({ ...base, startPid: 300, read });
    expect(session).toMatchObject({
      key: "p200-1200",
      pid: 200,
      agent: "claude-code",
      human: false,
    });
  });

  test("Codex — sandbox-exec 래퍼도 건너뛴다", () => {
    const read = table([
      [30, 20, "bash", "/bin/bash"],
      [20, 10, "sandbox-exec", "/usr/bin/sandbox-exec"],
      [10, 5, "codex", "/opt/homebrew/bin/codex"],
    ]);
    expect(detectSession({ ...base, startPid: 30, read })).toMatchObject({
      key: "p10-1010",
      agent: "codex",
      human: false,
    });
  });

  test("node 로 도는 에이전트는 이름이 node 여도 에이전트로 본다", () => {
    const read = table([
      [30, 20, "zsh", "/bin/zsh"],
      [20, 10, "node", "/opt/homebrew/bin/node"],
    ]);
    expect(detectSession({ ...base, startPid: 30, read })).toMatchObject({
      key: "p20-1020",
      agent: "node",
      human: false,
    });
  });

  test("사람 터미널 — login 아래 맨 위 셸이 세션, 사람으로 표시", () => {
    const read = table([
      [30, 20, "zsh", "/bin/zsh"],
      [20, 10, "-zsh", "/bin/zsh"],
      // 10 = login (root)
    ]);
    expect(detectSession({ ...base, startPid: 30, read })).toMatchObject({
      key: "p20-1020",
      agent: "human",
      human: true,
    });
  });

  test("IDE 터미널 — Helper 아래 셸이 세션, 에이전트 환경 변수가 있으면 에이전트", () => {
    const read = table([
      [30, 20, "zsh", "/bin/zsh"],
      [20, 10, "Cursor Helper", "/Applications/Cursor.app/Contents/Frameworks/Cursor Helper"],
    ]);
    expect(
      detectSession({ ...base, env: { AI_AGENT: "cursor_1-0_agent" }, startPid: 30, read }),
    ).toMatchObject({ key: "p30-1030", agent: "cursor", human: false });
  });

  test("AI_AGENT 가 있으면 표시 이름은 그 앞부분", () => {
    const read = table([
      [30, 20, "zsh", "/bin/zsh"],
      [20, 1, "2.1.287", "/x/claude/versions/2.1.287"],
    ]);
    const env = { AI_AGENT: "claude-code_2-1-287_agent", CLAUDE_CODE_SESSION_ID: "abc" };
    expect(detectSession({ ...base, env, startPid: 30, read })).toMatchObject({
      agent: "claude-code",
      agentSessionId: "abc",
    });
  });

  test("CORGI_SESSION_ID 를 주면 그 값이 세션", () => {
    const read = table([[50, 1, "worker", "/x/worker"]]);
    const env = { CORGI_SESSION_ID: "job-7", CORGI_SESSION_PID: "50" };
    expect(detectSession({ ...base, env, startPid: 999, read })).toMatchObject({
      key: "x:job-7",
      pid: 50,
      pidStartedAt: 1050,
    });
  });

  test("설정으로 셸을 늘릴 수 있다", () => {
    const read = table([
      [30, 20, "zsh", "/bin/zsh"],
      [20, 10, "mywrap", "/x/mywrap"],
      [10, 1, "codex", "/x/codex"],
    ]);
    expect(detectSession({ ...base, startPid: 30, read, extraShells: ["mywrap"] }).key).toBe(
      "p10-1010",
    );
  });
});
