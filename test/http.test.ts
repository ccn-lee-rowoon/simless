import { afterEach, describe, expect, test } from "bun:test";
import { CorgiServer } from "../src/server/app.ts";
import { checkRequest, ensureToken, startHttp } from "../src/server/http.ts";
import { fakeDriver, tempEnv } from "./helpers.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
});

function start() {
  const env = tempEnv();
  const server = new CorgiServer({ ...env, drivers: [fakeDriver()] });
  const token = ensureToken(env.paths.webToken);
  const http = startHttp(server, { port: 0, token });
  cleanups.push(() => http.stop(true), env.cleanup);
  const base = `http://127.0.0.1:${http.port}`;
  const post = (body: unknown, headers: Record<string, string> = { "x-corgi-token": token }) =>
    fetch(`${base}/api/call`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  return { base, token, post, env };
}

describe("웹 UI HTTP", () => {
  test("토큰은 한 번 만들면 그대로 쓴다 (0600)", () => {
    const { env, token } = start();
    expect(ensureToken(env.paths.webToken)).toBe(token);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
  });

  test("페이지는 토큰 없이 열리고, API 는 토큰이 있어야 한다", async () => {
    const { base, post } = start();
    expect((await fetch(`${base}/`)).status).toBe(200);
    expect((await post({ method: "status" }, {})).status).toBe(401);
    const ok = (await (await post({ method: "status" })).json()) as {
      ok: boolean;
      result: { session: { key: string } };
    };
    expect(ok.ok).toBe(true);
    expect(ok.result.session.key).toBe("web");
  });

  test("웹 UI 가 쓸 수 없는 메서드는 403", async () => {
    const { post } = start();
    expect((await post({ method: "lease.who" })).status).toBe(403);
  });

  test("원본 목록·만들기가 된다", async () => {
    const { post } = start();
    const sources = (await (await post({ method: "source.list" })).json()) as {
      result: { items: unknown[] };
    };
    expect(sources.result.items).toHaveLength(2);
    const created = (await (
      await post({ method: "device.create", params: { source: "Small_360" } })
    ).json()) as {
      ok: boolean;
      result: { name: string };
    };
    expect(created).toMatchObject({ ok: true, result: { name: "corgi Small 360" } });
  });

  test("이벤트 스트림은 hello 로 시작한다", async () => {
    const { base, token } = start();
    const response = await fetch(`${base}/api/events?token=${token}`);
    const reader = response.body?.getReader();
    const first = new TextDecoder().decode((await reader?.read())?.value);
    expect(first).toStartWith("event: hello");
    await reader?.cancel();
  });
});

describe("checkRequest", () => {
  const token = "t";
  const req = (headers: Record<string, string>, method = "POST") =>
    new Request("http://127.0.0.1:8791/api/call?", { method, headers });

  test("Host 가 127.0.0.1·localhost 가 아니면 거부 (DNS rebinding)", () => {
    expect(
      checkRequest(req({ host: "evil.example:8791", "x-corgi-token": token }), 8791, token)?.status,
    ).toBe(403);
    expect(
      checkRequest(req({ host: "localhost:8791", "x-corgi-token": token }), 8791, token),
    ).toBeUndefined();
  });

  test("다른 Origin 의 POST 는 거부", () => {
    const headers = {
      host: "127.0.0.1:8791",
      "x-corgi-token": token,
      origin: "http://evil.example",
    };
    expect(checkRequest(req(headers), 8791, token)?.status).toBe(403);
  });
});
