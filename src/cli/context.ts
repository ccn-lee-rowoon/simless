import type { BusyData } from "../shared/api.ts";
import { call, RemoteError, ServerDownError } from "../shared/client.ts";
import { type Config, loadConfig } from "../shared/config.ts";
import { ExitCode } from "../shared/exit-codes.ts";
import { type Paths, resolvePaths } from "../shared/paths.ts";
import type { SessionInfo } from "../shared/protocol.ts";
import { detectSession } from "../shared/session.ts";
import { VERSION } from "../shared/version.ts";
import { formatHolder } from "./format.ts";
import { kickstart } from "./launchd.ts";

/** 메시지와 종료 코드를 가진 CLI 오류 — runCli 가 출력하고 끝낸다 */
export class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode: number,
    readonly code?: string,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

/** 명령 액션 — commander 가 주는 인자는 명령마다 달라 any 로 받는다 */
// biome-ignore lint/suspicious/noExplicitAny: 위 설명 참고
export type Action = (ctx: Context, ...args: any[]) => Promise<void>;
export type Run = (fn: Action) => (...args: unknown[]) => Promise<void>;

export interface Context {
  paths: Paths;
  config: Config;
  session: SessionInfo;
  json: boolean;
}

export function makeContext(options: { json?: boolean; session?: string }): Context {
  const paths = resolvePaths();
  const config = loadConfig(paths.config);
  const env = options.session ? { ...process.env, CORGI_SESSION_ID: options.session } : process.env;
  const session = detectSession({
    env,
    extraShells: config.session.extraShells,
    extraHosts: config.session.extraHosts,
  });
  return { paths, config, session, json: options.json ?? false };
}

let warnedVersion = false;

export async function request<T>(
  ctx: Context,
  method: string,
  params: unknown,
  onEvent?: (event: string, data: unknown) => void,
): Promise<T> {
  try {
    const send = () => call<T>(ctx.paths.socket, method, params, ctx.session, { onEvent });
    // 서버가 꺼져 있으면 launchd 로 켜고 한 번 더 보낸다 (Q10)
    const { result, serverVersion } = await send().catch(async (error: unknown) => {
      if (error instanceof ServerDownError && (await kickstart(ctx.paths))) return send();
      throw error;
    });
    if (serverVersion !== VERSION && !warnedVersion) {
      warnedVersion = true;
      console.error(
        `주의: 서버 버전(${serverVersion})이 CLI(${VERSION})와 다릅니다 — 서버를 다시 시작하세요`,
      );
    }
    return result;
  } catch (error) {
    if (error instanceof ServerDownError) {
      throw new CliError(
        `${error.message}\n  서버 등록(로그인 시 자동 실행): corgi install · 한 번만 띄우기: corgi serve`,
        ExitCode.serverDown,
        "SERVER_DOWN",
      );
    }
    if (error instanceof RemoteError) {
      let message = error.message;
      if (error.code === "BUSY" || error.code === "DEADLOCK") {
        const { holders } = error.data as BusyData;
        message += `\n${holders.map((h) => `  ${formatHolder(h)}`).join("\n")}`;
        if (error.code === "BUSY")
          message += "\n  기다리려면 --wait, 비어 있는 것만 쓰려면 --available";
      }
      const exitCode =
        error.code === "BUSY" || error.code === "DEADLOCK"
          ? ExitCode.busy
          : error.code === "INVALID"
            ? ExitCode.usage
            : ExitCode.failed;
      throw new CliError(message, exitCode, error.code, error.data);
    }
    throw error;
  }
}

/** --json 이면 JSON 을, 아니면 사람이 읽는 문장을 stdout 에 */
export function output(ctx: Context, data: unknown, human: () => string): void {
  console.log(ctx.json ? JSON.stringify(data, null, 2) : human());
}
