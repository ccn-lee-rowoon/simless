import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { redactCwd } from "../src/server/app.ts";
import { checkRequest } from "../src/server/http.ts";
import { call } from "../src/shared/client.ts";
import { saveSettings } from "../src/shared/config.ts";
import { seedDevice, session, testServers } from "./helpers.ts";

const start = testServers();

// SECURITY.md §3·§5 — 고친 약한 점이 다시 생기지 않게

describe("보안", () => {
  test("에이전트에게는 다른 세션의 작업 폴더를 폴더 이름만 — 자기 것과 사람(웹)에게는 그대로", async () => {
    const { socket, H } = await start({
      seed: (s, d) => seedDevice(s, d, "d1", "Pixel"),
    });
    const a = session("A", { cwd: "/Users/someone/work/app-a" });
    const b = session("B", { cwd: "/Users/someone/work/app-b" });
    const ask = (who: typeof a, method: string, params: unknown = {}) =>
      call(socket, method, params, who)
        .then((r) => r.result as never)
        .catch((e: unknown) => e as never);

    await ask(a, "lease.acquire", { devices: ["d1"] });

    // 다른 세션 B 가 보면 — 누가 쓰는지는 보이되 경로는 폴더 이름만
    const who = (await ask(b, "lease.who")) as { holder?: { cwd: string } }[];
    expect(who[0]?.holder?.cwd).toBe("app-a");
    const busy = (await ask(b, "lease.acquire", { devices: ["d1"] })) as {
      code: string;
      data: { holders: { cwd: string }[] };
    };
    expect(busy.code).toBe("BUSY");
    expect(busy.data.holders[0]?.cwd).toBe("app-a");
    const status = (await ask(b, "status")) as { sessions: { cwd: string }[] };
    expect(status.sessions.map((s) => s.cwd)).toEqual(["app-a"]);
    const history = (await ask(b, "lease.history")) as { cwd: string }[];
    expect(history.every((e) => !e.cwd.includes("/"))).toBe(true);

    // 자기 것은 그대로, 사람(웹 화면)은 전부 그대로
    const mine = (await ask(a, "lease.who")) as { holder?: { cwd: string } }[];
    expect(mine[0]?.holder?.cwd).toBe("/Users/someone/work/app-a");
    const human = (await H("lease.who")) as { holder?: { cwd: string } }[];
    expect(human[0]?.holder?.cwd).toBe("/Users/someone/work/app-a");
  });

  test("redactCwd 는 cwd 키만 바꾼다", () => {
    expect(
      redactCwd({ cwd: "/a/b/c", list: [{ cwd: "/own" }, { path: "/x/y" }], n: 1 }, "/own"),
    ).toEqual({ cwd: "c", list: [{ cwd: "/own" }, { path: "/x/y" }], n: 1 });
  });

  test("웹 토큰 — 길이가 같아도 틀리면 401, 없으면 401", () => {
    const token = "a".repeat(64);
    const request = (given?: string) =>
      new Request("http://127.0.0.1:8791/api/events", {
        headers: { host: "127.0.0.1:8791", ...(given ? { "x-simless-token": given } : {}) },
      });
    expect(checkRequest(request(token), 8791, token)).toBeUndefined();
    expect(checkRequest(request("b".repeat(64)), 8791, token)?.status).toBe(401);
    expect(checkRequest(request("a"), 8791, token)?.status).toBe(401);
    expect(checkRequest(request(), 8791, token)?.status).toBe(401);
  });

  test("설정 파일은 나만 읽는다 — 폴더 0700, 파일 0600", () => {
    const dir = mkdtempSync(join(tmpdir(), "simless-config-"));
    const path = join(dir, "simless", "config.json");
    saveSettings(path, { idleReleaseMinutes: 20 });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, "simless")).mode & 0o777).toBe(0o700);
    rmSync(dir, { recursive: true, force: true });
  });
});
