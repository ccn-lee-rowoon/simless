import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  computeFingerprint,
  findCached,
  findLatestBuild,
  listBuilds,
  projectKey,
  pruneBuilds,
  saveBuild,
} from "../src/builds/cache.ts";
import type { DeviceOpResult } from "../src/shared/api.ts";
import type { Runner } from "../src/shared/exec.ts";
import { seedDevice, testServers } from "./helpers.ts";

const start = testServers();

function temp(): string {
  return mkdtempSync(join(tmpdir(), "simless-builds-"));
}

/** 가짜 .app (폴더) */
function fakeApp(dir: string, name = "MyApp.app"): string {
  const app = join(dir, name);
  mkdirSync(app, { recursive: true });
  writeFileSync(join(app, "Info.plist"), "plist");
  writeFileSync(join(app, "main.jsbundle"), "x".repeat(100));
  return app;
}

describe("네이티브 빌드 캐시 (R26)", () => {
  test("앱 이름은 package.json 의 name, 없으면 폴더 이름", () => {
    const dir = temp();
    expect(projectKey(dir)).toMatch(/^simless-builds-/);
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "@acme/my app" }));
    expect(projectKey(dir)).toBe("_acme_my_app");
    rmSync(dir, { recursive: true, force: true });
  });

  test("지문은 앱의 지문 도구로 — 없으면 TOOL_MISSING, 출력의 hash 를 쓴다", async () => {
    const dir = temp();
    const runner: Runner = async (command, options) => {
      expect(command.slice(1)).toEqual(["fingerprint:generate", "--platform", "ios"]);
      expect(options?.cwd).toBe(dir);
      return { code: 0, stdout: JSON.stringify({ sources: [], hash: "abc123" }), stderr: "" };
    };
    expect(await computeFingerprint(dir, "ios", runner).catch((e) => e)).toMatchObject({
      code: "TOOL_MISSING",
    });
    mkdirSync(join(dir, "node_modules", ".bin"), { recursive: true });
    writeFileSync(join(dir, "node_modules", ".bin", "fingerprint"), "");
    expect(await computeFingerprint(dir, "ios", runner)).toBe("abc123");
    const broken: Runner = async () => ({ code: 0, stdout: "not json", stderr: "" });
    expect(await computeFingerprint(dir, "ios", broken).catch((e) => e)).toMatchObject({
      code: "FAILED",
    });
    rmSync(dir, { recursive: true, force: true });
  });

  test("보관한 빌드는 같은 지문으로 찾고, 원본을 지워도 남는다", () => {
    const root = temp();
    const build = temp();
    const app = fakeApp(build);
    const meta = saveBuild(root, "myapp", "ios", "fp1", app);
    expect(meta).toMatchObject({ project: "myapp", platform: "ios", fingerprint: "fp1" });
    expect(meta.bytes).toBe(105);
    rmSync(build, { recursive: true, force: true }); // DerivedData 를 지운 것처럼
    expect(findCached(root, "myapp", "ios", "fp1")?.path).toBe(meta.path);
    expect(findCached(root, "myapp", "ios", "fp2")).toBeUndefined();
    expect(findCached(root, "myapp", "android", "fp1")).toBeUndefined();
    rmSync(root, { recursive: true, force: true });
  });

  test("앱·플랫폼마다 최근 것만 남긴다", () => {
    const root = temp();
    const build = temp();
    const app = fakeApp(build);
    for (let i = 0; i < 4; i++)
      saveBuild(root, "myapp", "ios", `fp${i}`, app, new Date(2026, 9, 5, 10, i));
    saveBuild(root, "other", "ios", "x", app);
    const removed = pruneBuilds(root, 2);
    expect(removed.map((b) => b.fingerprint).sort()).toEqual(["fp0", "fp1"]);
    expect(listBuilds(root, "myapp").map((b) => b.fingerprint)).toEqual(["fp3", "fp2"]);
    expect(listBuilds(root, "other")).toHaveLength(1);
    rmSync(root, { recursive: true, force: true });
    rmSync(build, { recursive: true, force: true });
  });

  test("방금 빌드한 것 찾기 — iOS 는 워크스페이스 이름의 DerivedData, Android 는 apk", () => {
    const home = temp();
    const project = join(home, "app");
    mkdirSync(join(project, "ios", "MyApp.xcworkspace"), { recursive: true });
    const products = (name: string) =>
      join(
        home,
        "Library/Developer/Xcode/DerivedData",
        name,
        "Build/Products/Debug-iphonesimulator",
      );
    const old = fakeApp(products("MyApp-aaa"));
    const fresh = fakeApp(products("MyApp-bbb"));
    fakeApp(products("Other-ccc"), "Other.app");
    utimesSync(old, new Date(2026, 0, 1), new Date(2026, 0, 1));
    const env = { HOME: home };
    expect(findLatestBuild(project, "ios", env)).toBe(fresh);

    expect(findLatestBuild(project, "android", env)).toBeUndefined();
    const apkDir = join(project, "android/app/build/outputs/apk/debug");
    mkdirSync(apkDir, { recursive: true });
    writeFileSync(join(apkDir, "app-debug.apk"), "apk");
    expect(findLatestBuild(project, "android", env)).toBe(join(apkDir, "app-debug.apk"));
    rmSync(home, { recursive: true, force: true });
  });

  test("설치는 이 세션이 점유한 켜진 기기에만 — 플랫폼은 파일 종류로 (R26)", async () => {
    const { A, B, server, driver } = await start();
    seedDevice(server, driver, "d1", "Pixel");
    const dir = temp();
    const apk = join(dir, "app-debug.apk");
    writeFileSync(apk, "apk");

    expect(await A("device.install", { path: join(dir, "app.zip") })).toMatchObject({
      code: "INVALID",
    });
    expect(await A("device.install", { path: join(dir, "none.apk") })).toMatchObject({
      code: "NOT_FOUND",
    });
    expect(await A("device.install", { path: apk })).toMatchObject({ code: "NOT_HELD" });
    expect(await A("device.install", { path: fakeApp(dir) })).toMatchObject({
      code: "NOT_HELD",
    });

    await A("lease.acquire", { devices: ["d1"] });
    expect(await B("device.install", { devices: ["d1"], path: apk })).toMatchObject({
      code: "NOT_HELD",
    });
    const off: { results: DeviceOpResult[] } = await A("device.install", { path: apk });
    expect(off.results[0]).toMatchObject({ ok: false });
    expect(driver.installed).toEqual([]);

    await A("device.up");
    const on: { results: DeviceOpResult[] } = await A("device.install", { path: apk });
    expect(on.results).toEqual([{ id: "d1", name: "Pixel", ok: true }]);
    expect(driver.installed).toEqual([["d1", apk]]);
    rmSync(dir, { recursive: true, force: true });
  });
});
