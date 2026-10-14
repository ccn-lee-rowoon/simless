import { describe, expect, test } from "bun:test";
import { needsReslim, slimUnchanged } from "../src/shared/slim-mode.ts";

describe("슬림 설정 창의 «적용» (M6, M15)", () => {
  test("같은 방식이면 적용할 것이 없다", () => {
    expect(slimUnchanged({ slim: "applied", slimMode: "ui" }, "ui", [])).toBe(true);
    expect(slimUnchanged({ slim: "none", slimMode: "none" }, "none", [])).toBe(true);
  });

  test("방식이나 남길 항목이 바뀌면 적용한다", () => {
    expect(slimUnchanged({ slim: "applied", slimMode: "ui" }, "custom", ["photos"])).toBe(false);
    expect(
      slimUnchanged({ slim: "applied", slimMode: "custom", slimKeep: ["photos"] }, "custom", [
        "photos",
        "push",
      ]),
    ).toBe(false);
    expect(
      slimUnchanged(
        { slim: "applied", slimMode: "custom", slimKeep: ["push", "photos"] },
        "custom",
        ["photos", "push"],
      ),
    ).toBe(true);
  });

  test("슬림이 실패했거나 풀린 기기는 같은 방식이어도 다시 건다", () => {
    expect(needsReslim({ slim: "failed" })).toBe(true);
    expect(needsReslim({ slim: "drifted" })).toBe(true);
    expect(needsReslim({ slim: "applied" })).toBe(false);
    expect(slimUnchanged({ slim: "failed", slimMode: "ui" }, "ui", [])).toBe(false);
    expect(slimUnchanged({ slim: "drifted", slimMode: "ui" }, "ui", [])).toBe(false);
    expect(
      slimUnchanged({ slim: "failed", slimMode: "custom", slimKeep: ["push"] }, "custom", ["push"]),
    ).toBe(false);
  });
});
