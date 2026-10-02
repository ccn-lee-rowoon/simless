import { describe, expect, test } from "bun:test";
import { infoPlist, launcherScript, menubarAgentPlist } from "../src/cli/app-bundle.ts";

describe("Corgi.app", () => {
  test("Info.plist — Dock 아이콘 없는 앱, 아이콘·번들 ID·실행 파일", async () => {
    const xml = infoPlist("corgi-menubar", { port: 8791, tokenPath: "/Users/me/web-token" });
    expect(xml).toContain("<key>LSUIElement</key>\n  <true/>");
    expect(xml).toContain("<string>local.corgi.app</string>");
    expect(xml).toContain("<key>CFBundleIconFile</key>\n  <string>Corgi</string>");
    expect(xml).toContain("<key>CFBundleExecutable</key>\n  <string>corgi-menubar</string>");
    expect(xml).toContain("<key>CorgiHTTPPort</key>\n  <integer>8791</integer>");
    const lint = Bun.spawnSync(["plutil", "-lint", "-"], { stdin: new Blob([xml]) });
    expect(lint.exitCode).toBe(0);
  });

  test("실행 스크립트는 corgi ui 를 부른다 — 경로의 따옴표는 감싼다", () => {
    expect(launcherScript(["/bin/bun", "/Users/me/it's/corgi.ts"])).toBe(
      "#!/bin/sh\nexec '/bin/bun' '/Users/me/it'\\''s/corgi.ts' ui\n",
    );
  });
});

describe("메뉴바 로그인 항목", () => {
  test("로그인 시 open -a 로 앱을 한 번 띄운다 (KeepAlive 없음)", () => {
    const xml = menubarAgentPlist("/Users/me/Applications/Corgi.app");
    expect(xml).toContain(
      "<string>/usr/bin/open</string>\n    <string>-a</string>\n    <string>/Users/me/Applications/Corgi.app</string>",
    );
    expect(xml).not.toContain("KeepAlive");
    expect(Bun.spawnSync(["plutil", "-lint", "-"], { stdin: new Blob([xml]) }).exitCode).toBe(0);
  });
});
