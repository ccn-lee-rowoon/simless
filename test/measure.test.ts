import { describe, expect, test } from "bun:test";
import { parseSimslimMeasure } from "../src/server/drivers/ios.ts";
import { memoryChange } from "../src/shared/api.ts";

describe("슬림 전후 비교", () => {
  test("simslim measure 출력에서 프로세스 수와 메모리", () => {
    expect(
      parseSimslimMeasure("UDID: 89 processes, 1.51 GB memory footprint (phys_footprint)"),
    ).toEqual({
      processes: 89,
      memoryBytes: 1.51 * 1024 ** 3,
    });
    expect(parseSimslimMeasure("UDID: 167 processes, 812 MB memory footprint")).toEqual({
      processes: 167,
      memoryBytes: 812 * 1024 ** 2,
    });
  });

  test("«7.8GB → 1.6GB (−79%)» 형식, 값이 없으면 undefined", () => {
    expect(memoryChange(7.8 * 1024 ** 3, 1.6 * 1024 ** 3)).toBe("7.8GB → 1.6GB (−79%)");
    expect(memoryChange(1 * 1024 ** 3, 1.2 * 1024 ** 3)).toBe("1.0GB → 1.2GB (+20%)");
    expect(memoryChange(undefined, 1)).toBeUndefined();
  });
});
