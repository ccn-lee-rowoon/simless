import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SimlessServer } from "../src/server/app.ts";
import { listen } from "../src/server/socket.ts";
import { call } from "../src/shared/client.ts";
import { VERSION } from "../src/shared/version.ts";
import { fakeDriver, seedDevice, session, tempEnv } from "./helpers.ts";

const entry = new URL("../bin/simless.ts", import.meta.url).pathname;
const env = tempEnv();
let stop = () => {};
let client: Client;

beforeAll(async () => {
  const driver = fakeDriver();
  const server = new SimlessServer({ ...env, drivers: [driver] });
  seedDevice(server, driver, "ab12", "Small");
  seedDevice(server, driver, "cd34", "Large");
  await server.registry.addGroup({
    name: "Layout",
    description: "needs both",
    deviceIds: ["ab12", "cd34"],
    updatedBy: "human",
    updatedAt: "2026-10-05T00:00:00.000Z",
  });
  stop = (await listen(env.paths.socket, VERSION, server.handle)).stop;
  client = new Client({ name: "test", version: "0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [entry, "mcp"],
      env: { ...(process.env as Record<string, string>), ...env.env, SIMLESS_SESSION_ID: "mcp-A" },
    }),
  );
});
afterAll(async () => {
  await client.close();
  stop();
  env.cleanup();
});

const textOf = (result: unknown) =>
  ((result as { content: { text: string }[] }).content[0]?.text ?? "") as string;

describe("simless mcp (R12)", () => {
  test("도구 목록", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "simless_catalog",
      "simless_create",
      "simless_down",
      "simless_group_save",
      "simless_release",
      "simless_status",
      "simless_use",
    ]);
  });

  test("status — 그룹 설명과 디바이스", async () => {
    const result = await client.callTool({ name: "simless_status", arguments: {} });
    expect(textOf(result)).toContain('"description": "needs both"');
    expect(textOf(result)).toContain('"id": "ab12"');
  });

  test("use — 그룹을 점유하고 켜서 targetId 를 돌려주고, release 로 푼다", async () => {
    const result = await client.callTool({ name: "simless_use", arguments: { group: "Layout" } });
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain("Acquired and booted 2 device(s)");
    expect(textOf(result)).toContain('"targetId": "emulator-');
    const released = await client.callTool({ name: "simless_release", arguments: {} });
    expect(textOf(released)).toContain("ab12");
  });

  test("다른 세션이 쓰는 중이면 BUSY 를 코드로 돌려준다", async () => {
    await call(env.paths.socket, "lease.acquire", { devices: ["ab12"] }, session("other"));
    const result = await client.callTool({ name: "simless_use", arguments: { devices: ["ab12"] } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toStartWith("BUSY:");
    await call(env.paths.socket, "lease.release", {}, session("other"));
  });
});
