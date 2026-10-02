import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Registry } from "../src/server/registry.ts";
import type { Device } from "../src/shared/model.ts";

const dirs: string[] = [];
function tempPath() {
  const dir = mkdtempSync(join(tmpdir(), "corgi-registry-"));
  dirs.push(dir);
  return join(dir, "registry.json");
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function device(id: string, name: string): Device {
  return {
    id,
    name,
    native: `corgi_${id}`,
    spec: { platform: "android", widthPx: 720, heightPx: 1520, density: 320, systemImage: "x" },
    enabled: true,
    slim: "none",
    createdAt: "2026-10-02T00:00:00.000Z",
  };
}

describe("Registry", () => {
  test("추가한 디바이스는 파일에 남아 다시 열어도 보인다", () => {
    const path = tempPath();
    new Registry(path).add(device("ab12", "Small 360"));
    expect(new Registry(path).list().map((d) => d.name)).toEqual(["Small 360"]);
  });

  test("ID 또는 이름(대소문자 무시)으로 찾는다", () => {
    const registry = new Registry(tempPath());
    registry.add(device("ab12", "Small 360"));
    expect(registry.find("ab12")?.id).toBe("ab12");
    expect(registry.find("small 360")?.id).toBe("ab12");
    expect(registry.find("nope")).toBeUndefined();
  });

  test("이름을 바꿔도 ID·native 는 그대로 (R4)", () => {
    const registry = new Registry(tempPath());
    registry.add(device("ab12", "Small 360"));
    const renamed = registry.update("ab12", { name: "작은 폰" });
    expect(renamed).toMatchObject({ id: "ab12", native: "corgi_ab12", name: "작은 폰" });
  });

  test("새 ID 는 소문자·숫자 4자이고 겹치지 않는다", () => {
    const registry = new Registry(tempPath());
    const id = registry.newId();
    expect(id).toMatch(/^[a-z0-9]{4}$/);
  });
});
