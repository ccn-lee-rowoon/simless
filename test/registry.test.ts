import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Registry } from "../src/server/registry.ts";

const dirs: string[] = [];
function tempPath() {
  const dir = mkdtempSync(join(tmpdir(), "simless-registry-"));
  dirs.push(dir);
  return join(dir, "registry.json");
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("Registry — 디바이스 기억 (R4·R20)", () => {
  test("처음 본 기기에 ID 를 붙이고, 다시 열어도 같은 ID 다 (R4)", () => {
    const path = tempPath();
    const first = new Registry(path).adopt("ios", "UDID-1", false);
    expect(first).toMatchObject({ platform: "ios", native: "UDID-1", createdBySimless: false });
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

  test("1~3단계 형식(만든 디바이스만, 이름·크기 포함)을 읽어 옮기고, 처음 만든 것을 기본으로", () => {
    const path = tempPath();
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        devices: [
          {
            id: "ab12",
            name: "simless Small",
            native: "simless_ab12",
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
    const registry = new Registry(path);
    expect(registry.defaults()).toEqual({ android: "ab12" });
    expect(registry.list()).toEqual([
      {
        id: "ab12",
        platform: "android",
        native: "simless_ab12",
        createdBySimless: true,
        slim: "applied",
        createdAt: "2026-10-02T00:00:00.000Z",
      },
    ]);
  });
});

describe("Registry 그룹·기본 디바이스 (R21·R22)", () => {
  test("디바이스를 지우면 그룹 소속과 기본 지정도 지운다", () => {
    const path = tempPath();
    const registry = new Registry(path);
    const a = registry.adopt("android", "A", true);
    const b = registry.adopt("android", "B", true);
    registry.setDefault("android", a.id);
    const group = registry.addGroup({
      name: "g",
      description: "",
      deviceIds: [a.id, b.id],
      updatedBy: "human",
      updatedAt: "2026-10-05T00:00:00.000Z",
    });
    registry.remove(a.id);
    const reopened = new Registry(path);
    expect(reopened.group(group.id)?.deviceIds).toEqual([b.id]);
    expect(reopened.defaults()).toEqual({});
  });
});

describe("Registry — 이름을 바꾸기 전 형식", () => {
  test("createdByCorgi 키를 createdBySimless 로 읽는다", () => {
    const dir = mkdtempSync(join(tmpdir(), "simless-reg-"));
    const path = join(dir, "registry.json");
    writeFileSync(
      path,
      JSON.stringify({
        version: 2,
        devices: [
          {
            id: "bakw",
            platform: "android",
            native: "corgi_bakw",
            createdByCorgi: true,
            listed: true,
            slim: "applied",
            createdAt: "2026-10-02T00:00:00.000Z",
          },
        ],
        groups: [],
        defaults: { android: "bakw" },
      }),
    );
    const registry = new Registry(path);
    expect(registry.get("bakw")).toMatchObject({ createdBySimless: true, native: "corgi_bakw" });
    rmSync(dir, { recursive: true, force: true });
  });
});
