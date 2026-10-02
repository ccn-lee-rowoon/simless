import { basename } from "node:path";
import { type ProcInfo, type ProcReader, readProc } from "./proc.ts";
import type { SessionInfo } from "./protocol.ts";

// 세션 = 명령을 실행한 에이전트 프로세스 (docs/design.md §7).
// 부모를 따라 올라가며 셸·래퍼는 건너뛰고, 처음 만나는 프로세스가
//   - 공용 호스트(터미널·IDE·login)가 아니면 → 그 프로세스가 에이전트
//   - 공용 호스트거나 못 읽으면 → 호스트 바로 아래 셸(터미널 탭 하나)

const SHELLS = [
  "zsh",
  "bash",
  "sh",
  "fish",
  "dash",
  "ksh",
  "tcsh",
  "csh",
  "nu",
  "env",
  "timeout",
  "nohup",
  "nice",
  "time",
  "sandbox-exec",
  "script",
  "xargs",
  "caffeinate",
];

const HOSTS = [
  "login",
  "sshd",
  "launchd",
  "tmux",
  "screen",
  "zellij",
  "Terminal",
  "iTerm2",
  "ghostty",
  "wezterm-gui",
  "kitty",
  "alacritty",
  "Electron",
];

/** 에이전트가 세션 ID 를 주는 환경 변수 — 에이전트 어댑터 (§7) */
const AGENT_SESSION_ENV = ["CLAUDE_CODE_SESSION_ID"];

/** 프로세스 경로·이름에 이 문자열이 있으면 그 에이전트로 표시한다 (표시용) */
const AGENT_HINTS: [hint: string, agent: string][] = [
  ["claude", "claude-code"],
  ["codex", "codex"],
  ["gemini", "gemini"],
  ["cursor", "cursor-agent"],
  ["opencode", "opencode"],
  ["copilot", "copilot"],
];

export interface DetectOptions {
  env?: NodeJS.ProcessEnv;
  /** 여기서부터 위로 찾는다 — 보통 corgi 의 부모 */
  startPid?: number;
  cwd?: string;
  extraShells?: string[];
  extraHosts?: string[];
  read?: ProcReader;
}

function names(p: ProcInfo): string[] {
  return [p.name, basename(p.path)].filter((n) => n !== "");
}

function matches(p: ProcInfo, list: string[]): boolean {
  // `zsh (kiro-cli-term)`·`-zsh`(로그인 셸) 처럼 꾸민 이름도 같은 셸로 본다.
  return names(p).some((n) => {
    const bare = n.replace(/^-/, "");
    return list.some((item) => bare === item || bare.startsWith(`${item} `));
  });
}

function isHost(p: ProcInfo, extra: string[]): boolean {
  // IDE·Electron 앱의 터미널은 `Code Helper`·`Cursor Helper`·`Orca Helper` 아래에서 돈다.
  return matches(p, [...HOSTS, ...extra]) || names(p).some((n) => / Helper\b/.test(n));
}

function agentFromEnv(env: NodeJS.ProcessEnv): string | undefined {
  // 예: AI_AGENT=claude-code_2-1-287_agent → claude-code
  if (env.AI_AGENT) return env.AI_AGENT.split("_")[0] || env.AI_AGENT;
  if (env.CLAUDECODE) return "claude-code";
  return undefined;
}

function agentFromProcess(p: ProcInfo): string {
  const haystack = `${p.path} ${p.name}`.toLowerCase();
  return AGENT_HINTS.find(([hint]) => haystack.includes(hint))?.[1] ?? (p.name || "unknown");
}

function agentSessionId(env: NodeJS.ProcessEnv): string | undefined {
  for (const name of AGENT_SESSION_ENV) {
    if (env[name]) return env[name];
  }
  return undefined;
}

export function detectSession(options: DetectOptions = {}): SessionInfo {
  const env = options.env ?? process.env;
  const read = options.read ?? readProc;
  const cwd = options.cwd ?? process.cwd();
  const envAgent = agentFromEnv(env);
  const common = { cwd, agentSessionId: agentSessionId(env) };

  // 1. 직접 준 세션
  if (env.CORGI_SESSION_ID) {
    const pid = env.CORGI_SESSION_PID ? Number(env.CORGI_SESSION_PID) : undefined;
    const info = pid ? read(pid) : null;
    return {
      ...common,
      key: `x:${env.CORGI_SESSION_ID}`,
      pid: info?.pid,
      pidStartedAt: info?.startedAt,
      agent: envAgent ?? "unknown",
      human: false,
    };
  }

  const shells = [...SHELLS, ...(options.extraShells ?? [])];
  const hosts = options.extraHosts ?? [];
  let topShell: ProcInfo | null = null;
  let pid = options.startPid ?? process.ppid;

  while (pid > 1) {
    const info = read(pid);
    if (info === null || isHost(info, hosts)) break;
    if (!matches(info, shells)) {
      // 2. 에이전트 프로세스
      return {
        ...common,
        key: `p${info.pid}-${info.startedAt}`,
        pid: info.pid,
        pidStartedAt: info.startedAt,
        agent: envAgent ?? agentFromProcess(info),
        human: false,
      };
    }
    topShell = info;
    pid = info.ppid;
  }

  // 3. 공용 호스트 아래 셸 = 터미널 탭 하나. 에이전트 표시가 없으면 사람이다.
  const tab = topShell ?? read(options.startPid ?? process.ppid);
  return {
    ...common,
    key: tab ? `p${tab.pid}-${tab.startedAt}` : `p${options.startPid ?? process.ppid}`,
    pid: tab?.pid,
    pidStartedAt: tab?.startedAt,
    agent: envAgent ?? "human",
    human: envAgent === undefined,
  };
}
