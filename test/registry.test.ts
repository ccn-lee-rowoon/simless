import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Registry } from "../src/server/registry.ts";

const dirs: string[] = [];
function tempPath() {
  const dir = mkdtempSync(join(tmpdir(), "corgi-registry-"));
  dirs.push(dir);
  return join(dir, "registry.json");
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("Registry", () => {
  test("처음 본 기기에 ID 를 붙이고, 다시 열어도 같은 ID 다 (R4)", () => {
    const path = tempPath();
    const first = new Registry(path).adopt("ios", "UDID-1", false);
    expect(first).toMatchObject({ platform: "ios", native: "UDID-1", createdByCorgi: false });
    expect(first.id).toMatch(/^[a-z0-9]{4}$/);
    expect(new Registry(path).adopt("ios", "UDID-1", false).id).toBe(first.id);
  });

  test("같은 native 라도 플랫폼이 다르면 다른 기기", () => {
    const registry = new Registry(tempPath());
    const a = registry.adopt("ios", "X", false);
    const b = registry.adopt("android", "X", false);
    expect(a.id).not.toBe(b.id);
  });

  test("보이지 않는 기기의 정보는 prune 으로 지운다 — 다른 플랫폼은 그대로", () => {
    const registry = new Registry(tempPath());
    const gone = registry.adopt("ios", "GONE", false);
    registry.adopt("ios", "KEEP", false);
    registry.adopt("android", "AVD", false);
    expect(registry.prune("ios", new Set(["KEEP"]))).toEqual([gone.id]);
    expect(
      registry
        .list()
        .map((d) => d.native)
        .sort(),
    ).toEqual(["AVD", "KEEP"]);
  });

  test("1~3단계 형식(만든 디바이스만, 이름·크기 포함)을 읽어 옮긴다", () => {
    const path = tempPath();
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        devices: [
          {
            id: "ab12",
            name: "corgi Small",
            native: "corgi_ab12",
            spec: {
              platform: "android",
              widthPx: 720,
              heightPx: 1520,
              density: 320,
              systemImage: "x",
            },
            enabled: true,
            slim: "applied",
            createdAt: "2026-10-02T00:00:00.000Z",
          },
        ],
      }),
    );
    expect(new Registry(path).list()).toEqual([
      {
        id: "ab12",
        platform: "android",
        native: "corgi_ab12",
        createdByCorgi: true,
        slim: "applied",
        createdAt: "2026-10-02T00:00:00.000Z",
      },
    ]);
  });
});
