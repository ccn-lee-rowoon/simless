import { homedir } from "node:os";
import { join } from "node:path";

export const LAUNCH_LABEL = "corgi.server";
/** Corgi.app 의 번들 ID — launchd 등록과 묶어 로그인 항목에 «Corgi» 로 보이게 한다 */
export const APP_BUNDLE_ID = "local.corgi.app";
export const MENUBAR_LABEL = "corgi.menubar";

/** 서버·CLI 가 쓰는 파일 위치 (docs/design.md §5). 테스트는 환경 변수로 바꾼다. */
export interface Paths {
  stateDir: string;
  configDir: string;
  logDir: string;
  socket: string;
  registry: string;
  leases: string;
  /** 점유 기록 (M13) — SQLite */
  history: string;
  /** 예전 JSON 기록 — 처음 한 번 history 로 옮긴다 */
  legacyHistory: string;
  managedIndex: string;
  /** 첫 실행 설정을 끝낸 시각 (M14) — 없으면 앱이 설정 창을 띄운다 */
  setup: string;
  /** 스킬을 넣은 위치 (S9) — Corgi 가 바뀌면 모두 고친다 */
  skills: string;
  /** 웹 UI 요청 토큰 (0600) — corgi ui 가 읽어 브라우저에 넘긴다 */
  webToken: string;
  config: string;
  appsDir: string;
  /** launchd 사용자 에이전트 — 로그인 시 서버를 띄우고 죽으면 다시 살린다 */
  launchAgent: string;
  /** 사람이 여는 앱 — corgi install 이 그 Mac 에서 만든다 */
  appBundle: string;
  /** 로그인 시 메뉴바 앱을 띄우는 launchd 에이전트 */
  menubarAgent: string;
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
    history: join(stateDir, "history.db"),
    legacyHistory: join(stateDir, "history.json"),
    managedIndex: join(stateDir, "managed-index.json"),
    setup: join(stateDir, "setup.json"),
    skills: join(stateDir, "skills.json"),
    webToken: join(stateDir, "web-token"),
    config: join(configDir, "config.json"),
    appsDir: join(configDir, "apps"),
    launchAgent: join(home, "Library", "LaunchAgents", `${LAUNCH_LABEL}.plist`),
    appBundle: join(home, "Applications", "Corgi.app"),
    menubarAgent: join(home, "Library", "LaunchAgents", `${MENUBAR_LABEL}.plist`),
  };
}
