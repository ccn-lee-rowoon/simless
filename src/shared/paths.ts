import { homedir } from "node:os";
import { join } from "node:path";

export const LAUNCH_LABEL = "corgi.server";

/** 서버·CLI 가 쓰는 파일 위치 (docs/design.md §5). 테스트는 환경 변수로 바꾼다. */
export interface Paths {
  stateDir: string;
  configDir: string;
  logDir: string;
  socket: string;
  registry: string;
  leases: string;
  managedIndex: string;
  config: string;
  appsDir: string;
  /** launchd 사용자 에이전트 — 로그인 시 서버를 띄우고 죽으면 다시 살린다 */
  launchAgent: string;
}

export function resolvePaths(env: NodeJS.ProcessEnv = process.env): Paths {
  const home = env.HOME ?? homedir();
  const stateDir = env.CORGI_STATE_DIR ?? join(home, "Library", "Application Support", "Corgi");
  const configDir = env.CORGI_CONFIG_DIR ?? join(home, ".config", "corgi");
  return {
    stateDir,
    configDir,
    logDir: env.CORGI_LOG_DIR ?? join(home, "Library", "Logs", "Corgi"),
    // Unix 소켓 경로는 104 바이트 제한이 있어 따로 바꿀 수 있게 한다.
    socket: env.CORGI_SOCKET ?? join(stateDir, "corgi.sock"),
    registry: join(stateDir, "registry.json"),
    leases: join(stateDir, "leases.json"),
    managedIndex: join(stateDir, "managed-index.json"),
    config: join(configDir, "config.json"),
    appsDir: join(configDir, "apps"),
    launchAgent: join(home, "Library", "LaunchAgents", `${LAUNCH_LABEL}.plist`),
  };
}
