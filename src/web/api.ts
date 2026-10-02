// 서버 HTTP API 클라이언트 — 토큰은 corgi ui 가 주소의 #token= 으로 넘긴다.

const TOKEN_KEY = "corgi-token";

function readToken(): string | null {
  const fromHash = new URLSearchParams(location.hash.slice(1)).get("token");
  try {
    if (fromHash) {
      sessionStorage.setItem(TOKEN_KEY, fromHash);
      history.replaceState(null, "", location.pathname);
      return fromHash;
    }
    return sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return fromHash;
  }
}

export const token = readToken();

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

export async function call<T>(method: string, params: unknown = {}): Promise<T> {
  const response = await fetch("/api/call", {
    method: "POST",
    headers: { "content-type": "application/json", "x-corgi-token": token ?? "" },
    body: JSON.stringify({ method, params }),
  });
  const body = (await response.json()) as
    | { ok: true; result: T }
    | { ok: false; error: { code: string; message: string; data?: unknown } };
  if (!body.ok) throw new ApiError(body.error.code, body.error.message, body.error.data);
  return body.result;
}

export function subscribe(handlers: {
  changed: () => void;
  progress: (message: string) => void;
  connection: (online: boolean) => void;
}): () => void {
  const source = new EventSource(`/api/events?token=${encodeURIComponent(token ?? "")}`);
  source.addEventListener("hello", () => handlers.connection(true));
  source.addEventListener("changed", () => handlers.changed());
  source.addEventListener("progress", (event) => {
    handlers.progress(
      (JSON.parse((event as MessageEvent<string>).data) as { message: string }).message,
    );
  });
  source.onerror = () => handlers.connection(false);
  return () => source.close();
}
