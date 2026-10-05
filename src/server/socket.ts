import { chmodSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import type { Socket } from "bun";
import type { ErrorBody, ErrorCode, Response } from "../shared/protocol.ts";
import { Request } from "../shared/protocol.ts";

/** 처리 중 오류 — 코드가 그대로 클라이언트에 간다 */
export class HandlerError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

export interface Connection {
  /** 응답 전 진행 알림 */
  emit(event: string, data: unknown): void;
  /** 클라이언트가 먼저 끊었는지 — 오래 기다리는 요청이 확인한다 */
  readonly closed: boolean;
  onClose(listener: () => void): void;
}

export type Handler = (request: Request, connection: Connection) => Promise<unknown>;

interface ConnState {
  buffer: string;
  decoder: TextDecoder;
  /** 아직 못 쓴 바이트 — write 는 쓴 바이트 수를 돌려준다 */
  pending: Uint8Array[];
  ending: boolean;
  closed: boolean;
  closeListeners: (() => void)[];
  started: boolean;
}

const encoder = new TextEncoder();

function flush(socket: Socket<ConnState>): void {
  const state = socket.data;
  while (state.pending.length > 0) {
    const chunk = state.pending[0] ?? new Uint8Array();
    const written = socket.write(chunk);
    if (written < chunk.byteLength) {
      state.pending[0] = chunk.subarray(Math.max(written, 0));
      return; // drain 에서 이어 쓴다
    }
    state.pending.shift();
  }
  if (state.ending) socket.end();
}

function send(socket: Socket<ConnState>, message: unknown, end = false): void {
  if (socket.data.closed) return;
  socket.data.pending.push(encoder.encode(`${JSON.stringify(message)}\n`));
  socket.data.ending ||= end;
  flush(socket);
}

/** 이미 떠 있는 서버가 있는지 — 있으면 true, 죽은 소켓 파일이면 지우고 false */
async function claimSocket(path: string): Promise<boolean> {
  if (!existsSync(path)) return false;
  const alive = await Bun.connect({
    unix: path,
    socket: {
      data() {},
      open(socket) {
        socket.end();
      },
    },
  }).then(
    () => true,
    () => false,
  );
  if (!alive) unlinkSync(path);
  return alive;
}

export async function listen(path: string, version: string, handle: Handler) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  if (await claimSocket(path)) throw new Error(`simless 서버가 이미 실행 중입니다 (${path})`);

  const respond = (socket: Socket<ConnState>, response: Response) => send(socket, response, true);

  const server = Bun.listen<ConnState>({
    unix: path,
    socket: {
      open(socket) {
        socket.data = {
          buffer: "",
          decoder: new TextDecoder(),
          pending: [],
          ending: false,
          closed: false,
          closeListeners: [],
          started: false,
        };
      },
      data(socket, chunk) {
        const state = socket.data;
        if (state.started) return; // 연결 하나에 요청 하나
        state.buffer += state.decoder.decode(chunk, { stream: true });
        const nl = state.buffer.indexOf("\n");
        if (nl < 0) return;
        state.started = true;
        const line = state.buffer.slice(0, nl);

        let request: Request;
        try {
          request = Request.parse(JSON.parse(line));
        } catch (error) {
          const body: ErrorBody = { code: "INVALID", message: `잘못된 요청: ${String(error)}` };
          respond(socket, { id: "", serverVersion: version, ok: false, error: body });
          return;
        }

        const connection: Connection = {
          emit: (event, data) => send(socket, { id: request.id, event, data }),
          get closed() {
            return state.closed;
          },
          onClose: (listener) => state.closeListeners.push(listener),
        };

        handle(request, connection).then(
          (result) => respond(socket, { id: request.id, serverVersion: version, ok: true, result }),
          (error: unknown) => {
            const body: ErrorBody =
              error instanceof HandlerError
                ? { code: error.code, message: error.message, data: error.data }
                : {
                    code: "FAILED",
                    message: error instanceof Error ? error.message : String(error),
                  };
            respond(socket, { id: request.id, serverVersion: version, ok: false, error: body });
          },
        );
      },
      drain(socket) {
        flush(socket);
      },
      close(socket) {
        socket.data.closed = true;
        for (const listener of socket.data.closeListeners) listener();
      },
    },
  });
  chmodSync(path, 0o600);

  return {
    stop() {
      server.stop(true);
      if (existsSync(path)) unlinkSync(path);
    },
  };
}
