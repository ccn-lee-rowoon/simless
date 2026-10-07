import { afterEach, describe, expect, test } from "bun:test";
import { setLanguage } from "../src/shared/i18n.ts";
import { fullTime, when } from "../src/shared/time.ts";

// 시각 표시 — 가까운 것은 상대 시간, 지난 것은 날짜 (R25·M13·R21)

const now = new Date(2026, 9, 7, 15, 0, 0).getTime(); // 2026-10-07 (수) 15:00 이 Mac 시간
const at = (y: number, m: number, d: number, h: number, min: number, s = 0) =>
  new Date(y, m - 1, d, h, min, s).getTime();

afterEach(() => setLanguage("en"));

describe("시각 표시 (R25)", () => {
  test("한국어 — 방금·N분 전·오늘·어제·올해·작년, 24시간제", () => {
    setLanguage("ko");
    expect(when(now - 20_000, { now })).toBe("방금");
    expect(when(now - 12 * 60_000, { now })).toBe("12분 전");
    expect(when(at(2026, 10, 7, 9, 5), { now })).toBe("오늘 09:05");
    expect(when(at(2026, 10, 6, 21, 30), { now })).toBe("어제 21:30");
    expect(when(at(2026, 10, 5, 14, 5), { now })).toBe("10월 5일 14:05");
    expect(when(at(2025, 10, 5, 14, 5), { now })).toBe("2025년 10월 5일");
  });

  test("영어 — just now·min ago·today·yesterday·날짜", () => {
    setLanguage("en");
    expect(when(now - 20_000, { now })).toBe("just now");
    expect(when(now - 12 * 60_000, { now })).toBe("12 min ago");
    expect(when(at(2026, 10, 7, 9, 5), { now })).toBe("today 09:05");
    expect(when(at(2026, 10, 6, 21, 30), { now })).toBe("yesterday 21:30");
    expect(when(at(2026, 10, 5, 14, 5), { now })).toBe("Oct 5, 14:05");
    expect(when(at(2025, 10, 5, 14, 5), { now })).toBe("Oct 5, 2025");
  });

  test("기록은 상대 시간 없이 초까지, 마우스를 올리면 전체 시각", () => {
    setLanguage("ko");
    expect(when(now - 20_000, { now, seconds: true })).toBe("오늘 14:59:40");
    expect(fullTime(at(2026, 10, 7, 14, 5, 31))).toBe("2026년 10월 7일 (수) 14:05:31");
    setLanguage("en");
    expect(fullTime(at(2026, 10, 7, 14, 5, 31))).toBe("Wed, October 7, 2026 14:05:31");
  });
});
