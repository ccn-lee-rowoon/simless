import { describe, expect, test } from "bun:test";
import { Config } from "../src/shared/config.ts";

describe("Config", () => {
  test("빈 설정은 기본값으로 채워진다", () => {
    const config = Config.parse({});
    expect(config.idleReleaseMinutes).toBe(30);
    expect(config.android.presets.map((p) => p.widthDp)).toEqual([320, 360, 412, 600]);
    expect(config.ios.presets).toContain("iPhone 17");
    expect(config.session.extraShells).toEqual([]);
  });

  test("일부만 준 하위 설정도 나머지는 기본값", () => {
    const config = Config.parse({ android: { ramMb: 1536 } });
    expect(config.android.ramMb).toBe(1536);
    expect(config.android.emulatorArgs).toContain("-no-snapshot-save");
  });
});
