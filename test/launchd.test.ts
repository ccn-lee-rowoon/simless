import { describe, expect, test } from "bun:test";
import { plist } from "../src/cli/launchd.ts";
import { resolvePaths } from "../src/shared/paths.ts";

describe("launchd plist", () => {
  const paths = resolvePaths({ HOME: "/Users/me" });

  test("자기 자신을 serve 로 실행하고, 로그인 시 켜고 죽으면 다시 살린다", () => {
    const xml = plist(paths, ["/Users/me/.local/bin/corgi"], {});
    expect(xml).toContain("<string>corgi.server</string>");
    expect(xml).toContain(
      "<string>/Users/me/.local/bin/corgi</string>\n    <string>serve</string>",
    );
    expect(xml).toContain("<key>RunAtLoad</key>\n  <true/>");
    expect(xml).toContain("<key>KeepAlive</key>\n  <true/>");
    expect(xml).toContain("/Users/me/Library/Logs/Corgi/server.log");
    expect(paths.launchAgent).toBe("/Users/me/Library/LaunchAgents/corgi.server.plist");
  });

  test("개발 중(bun link)이면 bun + 스크립트, 설정한 CORGI_* 환경 변수는 넘긴다", () => {
    const xml = plist(paths, ["/bin/bun", "/repo/bin/corgi.ts"], {
      CORGI_SOCKET: "/tmp/a&b.sock",
      OTHER: "x",
    });
    expect(xml).toContain(
      "<string>/bin/bun</string>\n    <string>/repo/bin/corgi.ts</string>\n    <string>serve</string>",
    );
    expect(xml).toContain("<key>CORGI_SOCKET</key>\n    <string>/tmp/a&amp;b.sock</string>");
    expect(xml).not.toContain("OTHER");
  });
});
