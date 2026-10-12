import { existsSync, readFileSync } from "node:fs";
import { call, ServerDownError } from "../shared/client.ts";
import { loadConfig } from "../shared/config.ts";
import { ExitCode } from "../shared/exit-codes.ts";
import { resolveLanguage, setLanguage, t } from "../shared/i18n.ts";
import { resolvePaths } from "../shared/paths.ts";
import { detectSession } from "../shared/session.ts";
import { systemLanguages } from "../shared/system-language.ts";
import { allowOutput, denyOutput, HOOK_EVENTS, isHookAgent, normalize } from "./adapters.ts";
import { extractTargets, type Targets } from "./targets.ts";

interface Decision {
  allow: boolean;
  reason?: string;
}

/** 서버가 꺼졌을 때 훅이 읽는 관리 디바이스 목록 (P9) — 서버가 status·list 때마다 써 둔다 */
interface ManagedIndex {
  devices: {
    id: string;
    name: string;
    platform: "android" | "ios";
    native: string;
    targetId?: string;
  }[];
}

/**
 * 서버가 꺼져 있으면 점유를 알 수 없다 — 관리 디바이스로 보이는 호출은 막는다 (P9).
 * 마지막에 켜져 있던 시리얼까지 본다. 목록 파일이 없으면 관리 디바이스가 없는 것이다.
 */
export function offlineDecision(index: ManagedIndex | undefined, targets: Targets): Decision {
  for (const d of index?.devices ?? []) {
    const hit =
      [...targets.ids, ...targets.boots].some((id) => id === d.native || id === d.targetId) ||
      (targets.allAndroid && d.platform === "android" && d.targetId !== undefined) ||
      (targets.allIos && d.platform === "ios" && d.targetId !== undefined);
    if (hit) return { allow: false, reason: t("hook.serverDown", { name: d.name }) };
  }
  return { allow: true };
}

function readIndex(path: string): ManagedIndex | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as ManagedIndex;
  } catch {
    return undefined;
  }
}

/**
 * 에이전트 훅 진입점 (`simless hook <에이전트> <이벤트>`, P3~P9).
 * 디바이스를 건드리지 않는 호출은 소켓도 열지 않고 바로 통과한다. 아무것도 출력하지 않고 0 으로
 * 끝나면 에이전트는 평소대로 진행한다.
 */
export async function runHook(
  agent: string | undefined,
  event: string | undefined,
  stdin: Blob,
): Promise<number> {
  if (!isHookAgent(agent)) {
    console.error(`unsupported agent: ${agent ?? "(none)"}`);
    return ExitCode.usage;
  }
  if (event === undefined || !HOOK_EVENTS[agent].includes(event)) {
    console.error(`unsupported ${agent} hook event: ${event ?? "(none)"}`);
    return ExitCode.usage;
  }
  const allow = () => {
    const text = allowOutput(agent);
    if (text) console.log(text);
    return ExitCode.ok;
  };

  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(await stdin.text()) as Record<string, unknown>;
  } catch {
    return allow(); // 읽을 수 없는 입력은 막지 않는다
  }
  const input = normalize(agent, event, raw);
  const targets = input ? extractTargets(input.tool, input.input) : undefined;
  if (!input || !targets) return allow(); // 빠른 통과

  const paths = resolvePaths();
  let config: ReturnType<typeof loadConfig> | undefined;
  try {
    config = loadConfig(paths.config);
  } catch {
    config = undefined;
  }
  const detected = detectSession({
    extraShells: config?.session.extraShells,
    extraHosts: config?.session.extraHosts,
  });
  // 훅 입력의 세션 ID 는 CLI 가 셸에서 받는 세션 ID 와 같은 값이다 (§17 실측 — Claude·Copilot)
  const session = {
    ...detected,
    key: input.sessionKey ?? detected.key,
    agentSessionId: input.sessionId ?? detected.agentSessionId,
    cwd: input.cwd ?? detected.cwd,
    human: input.sessionKey ? false : detected.human,
  };

  let decision: Decision;
  try {
    decision = (await call<Decision>(paths.socket, "hook.check", targets, session)).result;
  } catch (error) {
    if (!(error instanceof ServerDownError)) {
      // 서버가 이상한 답을 하면 막지 않는다 — 훅 때문에 에이전트가 멈추지 않게
      console.error(`simless hook: ${error instanceof Error ? error.message : String(error)}`);
      return allow();
    }
    setLanguage(resolveLanguage(config?.language ?? "system", systemLanguages()));
    decision = offlineDecision(readIndex(paths.managedIndex), targets);
  }
  if (decision.allow) return allow();
  console.log(denyOutput(agent, decision.reason ?? ""));
  return ExitCode.ok;
}
