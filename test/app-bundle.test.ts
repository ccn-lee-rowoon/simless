import { describe, expect, test } from "bun:test";
import { infoPlist, launcherScript } from "../src/cli/app-bundle.ts";

describe("Corgi.app", () => {
  test("Info.plist — Dock 아이콘 없는 앱, 아이콘·번들 ID·실행 파일", async () => {
    const xml = infoPlist();
    expect(xml).toContain("<key>LSUIElement</key>\n  <true/>");
    expect(xml).toContain("<string>local.corgi.app</string>");
    expect(xml).toContain("<key>CFBundleIconFile</key>\n  <string>Corgi</string>");
    const lint = Bun.spawnSync(["plutil", "-lint", "-"], { stdin: new Blob([xml]) });
    expect(lint.exitCode).toBe(0);
  });

  test("실행 스크립트는 corgi ui 를 부른다 — 경로의 따옴표는 감싼다", () => {
    expect(launcherScript(["/bin/bun", "/Users/me/it's/corgi.ts"])).toBe(
      "#!/bin/sh\nexec '/bin/bun' '/Users/me/it'\\''s/corgi.ts' ui\n",
    );
  });
});
