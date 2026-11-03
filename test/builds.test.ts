import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  computeFingerprint,
  FINGERPRINT_IGNORES,
  type Fingerprint,
  findCached,
  findLatestBuild,
  forgetMiss,
  listBuilds,
  logEvent,
  nodeModulesLink,
  onlyBuildOutputs,
  projectKey,
  pruneBuilds,
  readEvents,
  rememberMiss,
  saveBuild,
  takeMiss,
} from "../src/builds/cache.ts";
import type { DeviceOpResult } from "../src/shared/api.ts";
import { type Runner, run } from "../src/shared/exec.ts";
import { seedDevice, testServers } from "./helpers.ts";

const start = testServers();
const entry = new URL("../bin/simless.ts", import.meta.url).pathname;

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

  test("지문은 앱의 지문 도구로 — 없으면 TOOL_MISSING, 출력의 hash 와 파일마다 해시를 쓴다", async () => {
    const dir = temp();
    const sources = [
      {
        type: "file",
        filePath: "package.json",
        hash: "f1",
        debugInfo: { path: "package.json", hash: "f1" },
      },
      {
        type: "dir",
        filePath: "node_modules/a",
        hash: "d1",
        debugInfo: {
          path: "node_modules/a",
          hash: "d1",
          children: [
            { path: "node_modules/a/x.m", hash: "x1" },
            {
              path: "node_modules/a/ios",
              hash: "d2",
              children: [{ path: "node_modules/a/ios/y.m", hash: "y1" }],
            },
          ],
        },
      },
      { type: "dir", filePath: "ios", reasons: ["bareNativeDir"], hash: null },
      { type: "contents", id: "expoConfig", contents: "{}", hash: "c1", debugInfo: { hash: "c1" } },
    ];
    const runner: Runner = async (command, options) => {
      expect(command.slice(1, 5)).toEqual(["fingerprint:generate", "--platform", "ios", "--debug"]);
      // Gradle 하위 모듈 산출물은 빼고 계산한다
      expect(command.slice(5)).toEqual(FINGERPRINT_IGNORES.flatMap((p) => ["--ignore-path", p]));
      expect(options?.cwd).toBe(dir);
      return { code: 0, stdout: JSON.stringify({ sources, hash: "abc123" }), stderr: "" };
    };
    expect(await computeFingerprint(dir, "ios", runner).catch((e) => e)).toMatchObject({
      code: "TOOL_MISSING",
    });
    mkdirSync(join(dir, "node_modules", ".bin"), { recursive: true });
    writeFileSync(join(dir, "node_modules", ".bin", "fingerprint"), "");
    expect(await computeFingerprint(dir, "ios", runner)).toEqual({
      hash: "abc123",
      files: {
        "package.json": "f1",
        "node_modules/a/x.m": "x1",
        "node_modules/a/ios/y.m": "y1",
        "contents:expoConfig": "c1",
      },
    });
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
      saveBuild(root, "myapp", "ios", `fp${i}`, app, { now: new Date(2026, 9, 5, 10, i) });
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
    const derived = (name: string, workspace: string) => {
      const app = fakeApp(products(name));
      writeFileSync(
        join(home, "Library/Developer/Xcode/DerivedData", name, "info.plist"),
        `<plist><dict>\n\t<key>WorkspacePath</key>\n\t<string>${workspace}</string>\n</dict></plist>`,
      );
      return app;
    };
    const old = derived("MyApp-aaa", join(project, "ios", "MyApp.xcworkspace"));
    const fresh = derived("MyApp-bbb", join(project, "ios", "MyApp.xcworkspace"));
    fakeApp(products("Other-ccc"), "Other.app");
    utimesSync(old, new Date(2026, 0, 1), new Date(2026, 0, 1));
    const env = { HOME: home };
    expect(findLatestBuild(project, "ios", env)).toBe(fresh);
    // 같은 앱의 다른 작업 트리가 더 나중에 빌드했어도 이 작업 트리 것만
    const elsewhere = derived("MyApp-ccc", join(home, "worktree", "ios", "MyApp.xcworkspace"));
    utimesSync(fresh, new Date(2026, 0, 2), new Date(2026, 0, 2));
    expect(statSync(elsewhere).mtimeMs).toBeGreaterThan(statSync(fresh).mtimeMs);
    expect(findLatestBuild(project, "ios", env)).toBe(fresh);
    // WorkspacePath 를 모르는 DerivedData 는 고르지 않는다
    fakeApp(products("MyApp-ddd"));
    expect(findLatestBuild(project, "ios", env)).toBe(fresh);

    expect(findLatestBuild(project, "android", env)).toBeUndefined();
    const apkDir = join(project, "android/app/build/outputs/apk/debug");
    mkdirSync(apkDir, { recursive: true });
    writeFileSync(join(apkDir, "app-debug.apk"), "apk");
    expect(findLatestBuild(project, "android", env)).toBe(join(apkDir, "app-debug.apk"));
    rmSync(home, { recursive: true, force: true });
  });

  test("빌드 전 지문으로는 node_modules 안에 새로 생긴 파일만 다를 때 (R26)", () => {
    const before: Fingerprint = {
      hash: "pre",
      files: { "app.json": "a", "node_modules/skia/ios/x.mm": "x", "contents:expoConfig": "c" },
    };
    const after = (files: Record<string, string>): Fingerprint => ({
      hash: "post",
      files: { ...before.files, ...files },
    });
    // pod install·Gradle 이 패키지 폴더에 만든 파일
    expect(onlyBuildOutputs(before, after({ "node_modules/skia/libs/ios/lib.a": "l" }))).toBe(true);
    // 있던 파일이 바뀜 (패치·버전)
    expect(onlyBuildOutputs(before, after({ "node_modules/skia/ios/x.mm": "x2" }))).toBe(false);
    // 바깥이 바뀜 (앱 설정·환경 변수)
    expect(onlyBuildOutputs(before, after({ "contents:expoConfig": "c2" }))).toBe(false);
    expect(onlyBuildOutputs(before, after({ "plugins/withX.js": "p" }))).toBe(false);
    // 링크된 node_modules 처럼 바깥 경로
    expect(onlyBuildOutputs(before, after({ "../main/node_modules/a/x.m": "m" }))).toBe(false);
    // 있던 파일이 사라짐
    const removed: Fingerprint = { hash: "post", files: { "app.json": "a" } };
    expect(onlyBuildOutputs(before, removed)).toBe(false);
  });

  test("빌드 전 지문으로 보관한 빌드도 찾고, 정리하면 함께 사라진다 (R26)", () => {
    const root = temp();
    const build = temp();
    const app = fakeApp(build);
    const meta = saveBuild(root, "myapp", "ios", "post", app, { aliases: ["pre"] });
    expect(meta.aliases).toEqual(["pre"]);
    expect(findCached(root, "myapp", "ios", "pre")?.path).toBe(meta.path);
    expect(findCached(root, "myapp", "ios", "post")?.path).toBe(meta.path);
    expect(findCached(root, "myapp", "android", "pre")).toBeUndefined();
    // 같은 빌드 전 지문이면 더 나중 것
    const newer = saveBuild(root, "myapp", "ios", "post2", app, {
      aliases: ["pre"],
      now: new Date(Date.now() + 1000),
    });
    expect(findCached(root, "myapp", "ios", "pre")?.fingerprint).toBe(newer.fingerprint);
    // 그 지문으로 직접 보관한 것이 먼저
    saveBuild(root, "myapp", "ios", "pre", app);
    expect(findCached(root, "myapp", "ios", "pre")?.fingerprint).toBe("pre");
    pruneBuilds(root, 0);
    expect(findCached(root, "myapp", "ios", "pre")).toBeUndefined();
    rmSync(root, { recursive: true, force: true });
    rmSync(build, { recursive: true, force: true });
  });

  test("못 찾았을 때의 지문은 작업 트리·플랫폼마다 기억하고 본인만 읽는다 (R26)", () => {
    const root = temp();
    const a = temp();
    const b = temp();
    const fp: Fingerprint = { hash: "pre", files: { "app.json": "a" } };
    expect(takeMiss(root, "myapp", "ios", a)).toBeUndefined();
    rememberMiss(root, "myapp", "ios", a, fp);
    expect(takeMiss(root, "myapp", "ios", a)).toEqual(fp);
    expect(takeMiss(root, "myapp", "ios", b)).toBeUndefined();
    expect(takeMiss(root, "myapp", "android", a)).toBeUndefined();
    const dir = join(root, "myapp", "ios", ".pending");
    const [file] = readdirSync(dir);
    expect(statSync(join(dir, file as string)).mode & 0o777).toBe(0o600);
    // 목록에는 보이지 않는다
    expect(listBuilds(root)).toEqual([]);
    forgetMiss(root, "myapp", "ios", a);
    expect(takeMiss(root, "myapp", "ios", a)).toBeUndefined();
    for (const d of [root, a, b]) rmSync(d, { recursive: true, force: true });
  });

  test("app save — 빌드가 node_modules 에 파일만 더했으면 빌드 전 지문으로도 찾는다 (R26)", async () => {
    const root = temp();
    const project = temp();
    writeFileSync(join(project, "package.json"), JSON.stringify({ name: "myapp" }));
    // 가짜 지문 도구 — 프로젝트의 fp.json 을 그대로 내보낸다
    const bin = join(project, "node_modules", ".bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "fingerprint"), '#!/bin/sh\ncat "$PWD/fp.json"\n');
    chmodSync(join(bin, "fingerprint"), 0o755);
    const file = (path: string, hash: string) => ({
      type: "file",
      filePath: path,
      hash,
      debugInfo: { path, hash },
    });
    const state = (hash: string, ...sources: object[]) =>
      writeFileSync(join(project, "fp.json"), JSON.stringify({ hash, sources }));
    const apkDir = join(project, "android/app/build/outputs/apk/debug");
    mkdirSync(apkDir, { recursive: true });
    writeFileSync(join(apkDir, "app-debug.apk"), "apk");
    const save = async () => {
      const proc = Bun.spawn(
        [process.execPath, entry, "--json", "app", "save", "--platform", "android"],
        { cwd: project, env: { ...process.env, SIMLESS_BUILD_CACHE: root }, stdout: "pipe" },
      );
      const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
      expect(code).toBe(0);
      return JSON.parse(out);
    };
    // app install 이 못 찾음 → 빌드 전 지문을 기억
    const missed = async () =>
      rememberMiss(
        root,
        "myapp",
        "android",
        project,
        await computeFingerprint(project, "android", run),
      );

    state("pre", file("app.json", "a"));
    await missed();
    state("post", file("app.json", "a"), file("node_modules/x/android/libs/x.so", "x"));
    const ok = await save();
    expect(ok.beforeBuild).toEqual({ fingerprint: "pre", aliased: true });
    expect(ok.saved).toMatchObject({ fingerprint: "post", aliases: ["pre"] });
    expect(findCached(root, "myapp", "android", "pre")?.fingerprint).toBe("post");
    expect(takeMiss(root, "myapp", "android", project)).toBeUndefined();

    // 빌드하는 사이 앱 설정이 바뀌었으면 빌드 전 지문으로는 보관하지 않는다
    state("pre2", file("app.json", "a"));
    await missed();
    state("post2", file("app.json", "b"));
    const changed = await save();
    expect(changed.beforeBuild).toEqual({ fingerprint: "pre2", aliased: false });
    expect(changed.saved.aliases).toBeUndefined();
    expect(findCached(root, "myapp", "android", "pre2")).toBeUndefined();

    // 보관한 것은 기록에 남고 app stats 가 센다
    const stats = Bun.spawn([process.execPath, entry, "--json", "app", "stats"], {
      env: { ...process.env, SIMLESS_BUILD_CACHE: root },
      stdout: "pipe",
    });
    expect(JSON.parse(await new Response(stats.stdout).text()).stats).toEqual([
      { project: "myapp", platform: "android", hit: 0, miss: 0, saved: 2, aliased: 1 },
    ]);

    // node_modules 가 다른 작업 트리를 가리키는 링크면 알린다
    const linked = temp();
    writeFileSync(join(linked, "package.json"), JSON.stringify({ name: "myapp" }));
    writeFileSync(join(linked, "fp.json"), JSON.stringify({ hash: "l", sources: [] }));
    symlinkSync(join(project, "node_modules"), join(linked, "node_modules"));
    const linkedApk = join(linked, "android/app/build/outputs/apk/debug");
    mkdirSync(linkedApk, { recursive: true });
    writeFileSync(join(linkedApk, "app-debug.apk"), "apk");
    const proc = Bun.spawn([process.execPath, entry, "app", "save", "--platform", "android"], {
      cwd: linked,
      env: { ...process.env, SIMLESS_BUILD_CACHE: root },
      stderr: "pipe",
    });
    expect(await proc.exited).toBe(0);
    expect(await new Response(proc.stderr).text()).toContain(join(project, "node_modules"));
    for (const d of [root, project, linked]) rmSync(d, { recursive: true, force: true });
  });

  test("node_modules 링크 알아보기 (R26)", () => {
    const a = temp();
    const b = temp();
    expect(nodeModulesLink(a)).toBeUndefined(); // 없음
    mkdirSync(join(a, "node_modules"));
    expect(nodeModulesLink(a)).toBeUndefined(); // 폴더
    symlinkSync(join(a, "node_modules"), join(b, "node_modules"));
    expect(nodeModulesLink(b)).toBe(join(a, "node_modules"));
    for (const d of [a, b]) rmSync(d, { recursive: true, force: true });
  });

  test("찾음·못 찾음 기록은 본인만 읽고, 최근 것만 남긴다 (R26)", () => {
    const root = join(temp(), "builds");
    const event = (n: number) =>
      ({
        project: "myapp",
        platform: "ios",
        event: "miss",
        fingerprint: `fp${n}`,
        worktree: "wt",
      }) as const;
    for (let i = 0; i < 5; i++) logEvent(root, event(i), { keep: 3 });
    expect(readEvents(root).map((e) => e.fingerprint)).toEqual(["fp2", "fp3", "fp4"]);
    expect(statSync(join(root, "events.jsonl")).mode & 0o777).toBe(0o600);
    // 기록은 목록에 섞이지 않는다
    expect(listBuilds(root)).toEqual([]);
    rmSync(dirname(root), { recursive: true, force: true });
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
