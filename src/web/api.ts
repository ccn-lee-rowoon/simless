import type { JobView } from "../shared/api.ts";

// 서버 HTTP API 클라이언트 — 토큰은 corgi ui 가 주소의 #token= 으로 넘긴다.

const TOKEN_KEY = "corgi-token";

function readToken(): string | null {
  const fromHash = new URLSearchParams(location.hash.slice(1)).get("token");
  try {
    if (fromHash) {
      sessionStorage.setItem(TOKEN_KEY, fromHash);
      // 토큰(#…)만 지운다 — ?window=settings 같은 주소 값은 남겨야 설정 창이 설정을 그린다
      history.replaceState(null, "", location.pathname + location.search);
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
  changed?: () => void;
  progress?: (message: string) => void;
  connection?: (online: boolean) => void;
  /** 설정 창의 설치 — 출력 한 줄 (M14) */
  output?: (job: string, line: string) => void;
  /** 설치 상태가 바뀜 */
  job?: (job: JobView) => void;
}): () => void {
  const source = new EventSource(`/api/events?token=${encodeURIComponent(token ?? "")}`);
  const data = <T>(event: Event) => JSON.parse((event as MessageEvent<string>).data) as T;
  source.addEventListener("hello", () => handlers.connection?.(true));
  source.addEventListener("changed", () => handlers.changed?.());
  source.addEventListener("progress", (event) =>
    handlers.progress?.(data<{ message: string }>(event).message),
  );
  source.addEventListener("output", (event) => {
    const { job, line } = data<{ job: string; line: string }>(event);
    handlers.output?.(job, line);
  });
  source.addEventListener("job", (event) => handlers.job?.(data<{ job: JobView }>(event).job));
  source.onerror = () => handlers.connection?.(false);
  return () => source.close();
}
