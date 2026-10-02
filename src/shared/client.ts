import type { ErrorBody, ErrorCode, Request, ServerMessage, SessionInfo } from "./protocol.ts";
import { isEvent, PROTOCOL_VERSION } from "./protocol.ts";
import { VERSION } from "./version.ts";

/** 서버에 연결하지 못함 — 꺼져 있거나 소켓이 없다 */
export class ServerDownError extends Error {}

/** 서버가 돌려준 오류 */
export class RemoteError extends Error {
  readonly code: ErrorCode;
  readonly data: unknown;
  constructor(body: ErrorBody) {
    super(body.message);
    this.code = body.code;
    this.data = body.data;
  }
}

export interface CallOptions {
  onEvent?: (event: string, data: unknown) => void;
}

export interface CallResult<T> {
  result: T;
  serverVersion: string;
}

/** 요청 하나를 보내고 응답을 기다린다 (연결 하나에 요청 하나). */
export function call<T>(
  socketPath: string,
  method: string,
  params: unknown,
  session: SessionInfo,
  options: CallOptions = {},
): Promise<CallResult<T>> {
  const request: Request = {
    v: PROTOCOL_VERSION,
    id: crypto.randomUUID(),
    clientVersion: VERSION,
    method,
    session,
    params,
  };

  return new Promise((resolve, reject) => {
    let buffer = "";
    // 조각마다 따로 바꾸면 조각 경계에 걸린 한글 등 여러 바이트 글자가 깨진다
    const decoder = new TextDecoder();
    let settled = false;
    const settle = (fn: () => void) => {
      if (!settled) {
        settled = true;
        fn();
      }
    };

    Bun.connect({
      unix: socketPath,
      socket: {
        open(socket) {
          socket.write(`${JSON.stringify(request)}\n`);
        },
        data(socket, chunk) {
          buffer += decoder.decode(chunk, { stream: true });
          for (let nl = buffer.indexOf("\n"); nl >= 0; nl = buffer.indexOf("\n")) {
            const line = buffer.slice(0, nl);
            buffer = buffer.slice(nl + 1);
            if (line === "") continue;
            const message = JSON.parse(line) as ServerMessage;
            if (isEvent(message)) {
              options.onEvent?.(message.event, message.data);
            } else if (message.ok) {
              settle(() =>
                resolve({ result: message.result as T, serverVersion: message.serverVersion }),
              );
              socket.end();
            } else {
              settle(() => reject(new RemoteError(message.error)));
              socket.end();
            }
          }
        },
        close() {
          settle(() => reject(new Error("서버가 응답 없이 연결을 끊었습니다")));
        },
        error(_socket, error) {
          settle(() => reject(error));
        },
      },
    }).catch((error: unknown) => {
      settle(() =>
        reject(
          new ServerDownError(`Corgi 서버에 연결할 수 없습니다 (${socketPath}): ${String(error)}`),
        ),
      );
    });
  });
}
