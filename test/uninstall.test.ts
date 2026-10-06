import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dataDirs, purgeData } from "../src/install/uninstall.ts";
import { resolvePaths } from "../src/shared/paths.ts";
import { seedDevice, testServers } from "./helpers.ts";

const startServer = testServers();

describe("Simless 제거 (S12)", () => {
  test("스킬(전역·프로젝트)·보호를 지우고, 답한 뒤에 앱·데이터·서버 등록을 지운다", async () => {
    const finished: boolean[] = [];
    const { H, A, server, driver, env } = await startServer({
      // PATH 를 비우고 HOME 을 임시 폴더로 — 진짜 ~/.claude 를 건드리지 않는다
      deps: (e) => ({
        env: { ...e.env, PATH: "" },
        selfCommand: ["/opt/simless/bin/simless"],
        finishUninstall: async (purge) => {
          finished.push(purge);
        },
      }),
    });
    const home = env.env.HOME;
    seedDevice(server, driver, "d1", "simless Pixel");
    await H("setup.apply", { item: "skill", enabled: true });
    await H("setup.apply", { item: "protection", enabled: true });
    const repo = join(home, "app");
    mkdirSync(repo);
    Bun.spawnSync(["git", "-C", repo, "init", "-q"], { env: { ...process.env, HOME: home } });
    await H("setup.skillScope", { kind: "project", paths: [repo] });
    // 프로젝트로 옮긴 뒤 전역에 다시 넣은 경우까지 — 둘 다 지워야 한다
    await H("setup.apply", { item: "skill", enabled: true });
    expect(existsSync(join(repo, ".claude", "skills", "simless", "SKILL.md"))).toBe(true);

    // 에이전트는 못 한다
    expect((await A("setup.uninstall", { purge: true })).code).toBe("NOT_ALLOWED");

    const result = await H("setup.uninstall", { purge: true });
    expect(result.devicesLeft).toBe(1);
    expect(result.steps.every((s: { ok: boolean }) => s.ok)).toBe(true);
    expect(existsSync(join(home, ".claude", "skills", "simless"))).toBe(false);
    expect(existsSync(join(home, ".agents", "skills", "simless"))).toBe(false);
    expect(existsSync(join(repo, ".claude", "skills", "simless"))).toBe(false);
    expect(readFileSync(join(repo, ".git", "info", "exclude"), "utf8")).not.toContain("simless");
    expect(readFileSync(join(home, ".claude", "settings.json"), "utf8")).not.toContain("simless");
    expect(existsSync(join(home, ".claude", "rules", "simless.md"))).toBe(false);

    await Bun.sleep(1700); // 답을 보낸 뒤에 나머지를 한다
    expect(finished).toEqual([true]);
  });

  test("--purge 는 정해 둔 데이터 폴더만 지운다", () => {
    const home = mkdtempSync(join(tmpdir(), "simless-purge-"));
    const env = {
      HOME: home,
      SIMLESS_STATE_DIR: join(home, "state"),
      SIMLESS_CONFIG_DIR: join(home, "config"),
      SIMLESS_LOG_DIR: join(home, "logs"),
    };
    const paths = resolvePaths(env);
    const dirs = dataDirs(paths, env);
    expect(dirs).toContain(join(home, "Library", "Caches", "Simless"));
    for (const dir of dirs) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "x"), "x");
    }
    const other = join(home, "keep");
    mkdirSync(other);
    const steps = purgeData(paths, env);
    expect(steps).toHaveLength(4);
    for (const dir of dirs) expect(existsSync(dir)).toBe(false);
    expect(existsSync(other)).toBe(true);
    rmSync(home, { recursive: true, force: true });
  });
});
