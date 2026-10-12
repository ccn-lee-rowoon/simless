import { fileURLToPath } from "node:url";

// 에이전트의 지금 작업 폴더 (docs/design.md §7). MCP 서버는 에이전트를 켤 때 한 번 떠서 그 폴더에
// 머문다 — 에이전트가 worktree 로 옮겨 가도 process.cwd() 는 그대로다. MCP 의 roots 는 클라이언트가
// 지금 작업 공간을 알려 주는 자리라(Claude Code 는 worktree 에 들어가면 roots 를 바꾼다) 요청마다 묻고,
// 못 받으면 띄운 폴더를 보낸다. 어느 쪽인지 cwdKind 로 알려 서버가 더 정확한 폴더를 덮지 않게 한다.

/** McpServer.server 중 여기서 쓰는 것만 — 시험에서 가짜로 바꾼다 */
export interface RootsClient {
  getClientCapabilities(): { roots?: unknown } | undefined;
  listRoots(
    params?: undefined,
    options?: { timeout?: number },
  ): Promise<{ roots: { uri: string }[] }>;
}

export interface AgentFolder {
  cwd: string;
  cwdKind: "workspace" | "launch";
}

/** roots 를 기다리는 한도 — 넘기면 이 MCP 서버가 사는 동안 다시 묻지 않는다 */
const ROOTS_TIMEOUT_MS = 2_000;

export function agentFolder(client: RootsClient, launchCwd: string): () => Promise<AgentFolder> {
  let rootsBroken = false;
  return async () => {
    if (!rootsBroken && client.getClientCapabilities()?.roots) {
      try {
        const { roots } = await client.listRoots(undefined, { timeout: ROOTS_TIMEOUT_MS });
        // 여러 개면(추가 폴더 등) 첫 번째가 주 작업 폴더다
        const first = roots.find((root) => root.uri.startsWith("file://"));
        if (first) return { cwd: fileURLToPath(first.uri), cwdKind: "workspace" };
      } catch {
        // 답하지 않는 클라이언트 — 요청마다 기다리지 않게 그만 묻는다
        rootsBroken = true;
      }
    }
    return { cwd: launchCwd, cwdKind: "launch" };
  };
}
