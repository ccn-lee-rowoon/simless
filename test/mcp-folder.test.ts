import { describe, expect, test } from "bun:test";
import { agentFolder, type RootsClient } from "../src/mcp/folder.ts";

function client(roots: () => Promise<{ uri: string }[]>, supports = true) {
  let asked = 0;
  const fake: RootsClient = {
    getClientCapabilities: () => (supports ? { roots: { listChanged: true } } : {}),
    listRoots: async () => {
      asked += 1;
      return { roots: await roots() };
    },
  };
  return { fake, asked: () => asked };
}

describe("MCP 작업 폴더 — roots (M13)", () => {
  test("roots 의 첫 file:// 을 요청마다 읽는다 — worktree 로 옮기면 따라간다", async () => {
    let root = "file:///repo";
    const { fake, asked } = client(async () => [{ uri: root }, { uri: "file:///extra" }]);
    const folder = agentFolder(fake, "/launch");
    expect(await folder()).toEqual({ cwd: "/repo", cwdKind: "workspace" });
    root = "file:///repo/.claude/worktrees/x";
    expect(await folder()).toEqual({ cwd: "/repo/.claude/worktrees/x", cwdKind: "workspace" });
    expect(asked()).toBe(2);
  });

  test("roots 를 지원하지 않거나 file:// 이 없으면 띄운 폴더(launch)로", async () => {
    const none = client(async () => [{ uri: "file:///repo" }], false);
    expect(await agentFolder(none.fake, "/launch")()).toEqual({
      cwd: "/launch",
      cwdKind: "launch",
    });
    expect(none.asked()).toBe(0);
    const remote = client(async () => [{ uri: "https://example.com/x" }]);
    expect(await agentFolder(remote.fake, "/launch")()).toEqual({
      cwd: "/launch",
      cwdKind: "launch",
    });
  });

  test("roots 요청이 실패하면 그만 묻는다 — 요청마다 기다리지 않게", async () => {
    const { fake, asked } = client(async () => {
      throw new Error("timeout");
    });
    const folder = agentFolder(fake, "/launch");
    expect(await folder()).toEqual({ cwd: "/launch", cwdKind: "launch" });
    expect(await folder()).toEqual({ cwd: "/launch", cwdKind: "launch" });
    expect(asked()).toBe(1);
  });

  test("퍼센트 인코딩된 경로(공백·한글)도 풀어서", async () => {
    const { fake } = client(async () => [{ uri: "file:///Users/me/My%20App/%ED%95%9C" }]);
    expect(await agentFolder(fake, "/launch")()).toEqual({
      cwd: "/Users/me/My App/한",
      cwdKind: "workspace",
    });
  });
});
