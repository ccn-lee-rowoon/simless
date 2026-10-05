import { describe, expect, test } from "bun:test";
import { plist } from "../src/install/launchd.ts";
import { resolvePaths } from "../src/shared/paths.ts";

describe("launchd plist", () => {
  const paths = resolvePaths({ HOME: "/Users/me" });

  test("자기 자신을 serve 로 실행하고, 로그인 시 켜고 죽으면 다시 살린다", () => {
    const xml = plist(paths, ["/Users/me/.local/bin/simless"], {});
    expect(xml).toContain("<string>simless.server</string>");
    expect(xml).toContain(
      "<string>/Users/me/.local/bin/simless</string>\n    <string>serve</string>",
    );
    expect(xml).toContain("<key>RunAtLoad</key>\n  <true/>");
    expect(xml).toContain("<key>KeepAlive</key>\n  <true/>");
    expect(xml).toContain("/Users/me/Library/Logs/Simless/server.log");
    expect(paths.launchAgent).toBe("/Users/me/Library/LaunchAgents/simless.server.plist");
  });

  test("개발 중(bun link)이면 bun + 스크립트, 설정한 SIMLESS_* 환경 변수는 넘긴다", () => {
    const xml = plist(paths, ["/bin/bun", "/repo/bin/simless.ts"], {
      SIMLESS_SOCKET: "/tmp/a&b.sock",
      OTHER: "x",
    });
    expect(xml).toContain(
      "<string>/bin/bun</string>\n    <string>/repo/bin/simless.ts</string>\n    <string>serve</string>",
    );
    expect(xml).toContain("<key>SIMLESS_SOCKET</key>\n    <string>/tmp/a&amp;b.sock</string>");
    expect(xml).not.toContain("OTHER");
  });
});
