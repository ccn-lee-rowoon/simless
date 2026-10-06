import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { SessionInfo } from "../shared/protocol.ts";
import { PROTOCOL_VERSION } from "../shared/protocol.ts";
import { VERSION } from "../shared/version.ts";
import index from "../web/index.html";
import type { SimlessServer } from "./app.ts";
import { HandlerError } from "./socket.ts";

// 웹 UI·메뉴바용 HTTP (docs/design.md §11). 상태를 바꾸는 요청도 받지만 다음으로 막는다.
//   - 127.0.0.1 에만 연다
//   - Host 가 127.0.0.1·localhost 가 아니면 거부 (DNS rebinding)
//   - /api 는 토큰 필수, POST 는 Origin 도 확인 (다른 웹사이트의 요청)
//   - 웹 UI 가 부를 수 있는 메서드만 허용

/** 웹 UI 를 쓰는 사람 — 프로세스 기준 해제 없이 30분 규칙만 (docs/design.md §7) */
export const WEB_SESSION: SessionInfo = { key: "web", agent: "web", cwd: "web", human: true };

const WEB_METHODS = new Set([
  "status",
  "setup.status",
  "setup.apply",
  "setup.skillScope",
  "setup.run",
  "setup.jobs",
  "setup.cancel",
  "setup.openTerminal",
  "setup.finish",
  "setup.uninstall",
  "device.list",
  "catalog",
  "device.create",
  "device.rename",
  "device.setMemo",
  "device.setDefault",
  "device.available",
  "device.add",
  "device.unlist",
  "group.list",
  "group.create",
  "group.update",
  "group.delete",
  "settings.get",
  "settings.set",
  "device.delete",
  "device.slim",
  "device.up",
  "device.down",
  "lease.acquire",
  "lease.release",
  "lease.forceRelease",
  "lease.history",
  "lease.sessions",
]);

/** 이 서버 프로세스가 뜬 시각 — 화면이 서버가 다시 켜진 것을 알아채고 새 화면을 받게 */
const STARTED_AT = Date.now();

/** 없으면 만든다 — 같은 사용자만 읽을 수 있다 */
export function ensureToken(path: string): string {
  if (existsSync(path)) return readFileSync(path, "utf8").trim();
  const token = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${token}\n`, { mode: 0o600 });
  return token;
}

export function checkRequest(
  request: Request,
  port: number,
  token: string,
): { status: number; message: string } | undefined {
  const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
  if (!hosts.includes(request.headers.get("host") ?? ""))
    return { status: 403, message: "허용하지 않는 Host" };
  const url = new URL(request.url);
  const given = request.headers.get("x-simless-token") ?? url.searchParams.get("token");
  if (given !== token)
    return { status: 401, message: "토큰이 없거나 틀립니다 — simless ui 로 여세요" };
  const origin = request.headers.get("origin");
  if (request.method !== "GET" && origin !== null && !hosts.some((h) => origin === `http://${h}`)) {
    return { status: 403, message: "허용하지 않는 Origin" };
  }
  return undefined;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function callMethod(
  server: SimlessServer,
  method: string,
  params: unknown,
): Promise<Response> {
  if (!WEB_METHODS.has(method))
    return json(
      { ok: false, error: { code: "INVALID", message: `웹 UI 에서 못 쓰는 메서드: ${method}` } },
      403,
    );
  try {
    const result = await server.handle(
      {
        v: PROTOCOL_VERSION,
        id: crypto.randomUUID(),
        clientVersion: VERSION,
        method,
        session: WEB_SESSION,
        params,
      },
      {
        emit: (event, data) => {
          if (event === "progress")
            server.publish({ type: "progress", message: (data as { message: string }).message });
        },
        closed: false,
        onClose: () => {},
      },
    );
    return json({ ok: true, result });
  } catch (error) {
    const body =
      error instanceof HandlerError
        ? { code: error.code, message: error.message, data: error.data }
        : { code: "FAILED", message: error instanceof Error ? error.message : String(error) };
    return json({ ok: false, error: body });
  }
}

/** 점유·켜짐·진행 알림을 SSE 로 — 화면은 changed 를 받으면 다시 읽는다 */
function events(server: SimlessServer): Response {
  let cleanup = () => {};
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      const send = (text: string) => controller.enqueue(encoder.encode(text));
      send(
        `event: hello\ndata: ${JSON.stringify({ version: VERSION, startedAt: STARTED_AT })}\n\n`,
      );
      const unsubscribe = server.subscribe((event) =>
        send(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`),
      );
      const keepalive = setInterval(() => send(": keepalive\n\n"), 15_000);
      cleanup = () => {
        clearInterval(keepalive);
        unsubscribe();
      };
    },
    cancel() {
      cleanup();
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
}

export function startHttp(server: SimlessServer, options: { port: number; token: string }) {
  const http = Bun.serve({
    hostname: "127.0.0.1",
    port: options.port,
    // HMR·오류 오버레이 없이 묶어서 서빙한다 — 개발할 때만 SIMLESS_WEB_DEV=1
    development: process.env.SIMLESS_WEB_DEV === "1",
    // 페이지에는 비밀이 없다 — 토큰은 simless ui 가 주소의 #token= 으로 넘긴다
    routes: { "/": index },
    async fetch(request) {
      const url = new URL(request.url);
      if (!url.pathname.startsWith("/api/")) return new Response("Not Found", { status: 404 });
      const port = http.port ?? options.port;
      const denied = checkRequest(request, port, options.token);
      if (denied)
        return json(
          { ok: false, error: { code: "INVALID", message: denied.message } },
          denied.status,
        );
      if (url.pathname === "/api/events" && request.method === "GET") {
        // 기본 유휴 시간(10초)에 끊기지 않게 이 연결만 시간 제한을 끈다
        http.timeout(request, 0);
        return events(server);
      }
      if (url.pathname === "/api/call" && request.method === "POST") {
        const body = (await request.json().catch(() => ({}))) as {
          method?: string;
          params?: unknown;
        };
        return callMethod(server, body.method ?? "", body.params);
      }
      return new Response("Not Found", { status: 404 });
    },
  });
  return http;
}
