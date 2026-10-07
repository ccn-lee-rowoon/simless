import { language, t } from "./i18n.ts";

// 시각 표시 (R25) — 가까운 것은 상대 시간, 지난 것은 날짜로. 웹 화면·CLI 가 같이 쓴다.
//   1분 안 «방금» · 1시간 안 «12분 전» · 오늘 «오늘 14:05» · 어제 «어제 14:05»
//   · 올해 «10월 5일 14:05» · 작년 이전 «2025년 10월 5일». 시간은 24시간제.
// 마우스를 올리면 보이는 전체 시각은 fullTime — «2026년 10월 7일 (수) 14:05:31».

function locale(): string {
  return language() === "ko" ? "ko-KR" : "en-US";
}

function clock(at: Date, seconds: boolean): string {
  return at.toLocaleTimeString(locale(), {
    hour: "2-digit",
    minute: "2-digit",
    second: seconds ? "2-digit" : undefined,
    hourCycle: "h23",
  });
}

function startOfDay(at: Date): number {
  return new Date(at.getFullYear(), at.getMonth(), at.getDate()).getTime();
}

/**
 * 언제 — `seconds` 면 상대 시간 없이 늘 시각(초까지)으로. 기록처럼 순서·간격을 봐야 하는 곳에 쓴다
 */
export function when(at: number, options: { now?: number; seconds?: boolean } = {}): string {
  const now = options.now ?? Date.now();
  const seconds = options.seconds ?? false;
  const minutes = Math.floor((now - at) / 60_000);
  if (!seconds && minutes >= 0 && minutes < 1) return t("common.justNow");
  if (!seconds && minutes >= 0 && minutes < 60) return t("common.minutesAgo", { minutes });
  const date = new Date(at);
  const today = startOfDay(new Date(now));
  const day = startOfDay(date);
  const time = clock(date, seconds);
  if (day === today) return t("time.today", { time });
  // «어제» 는 날짜로 본다 — 24시간을 빼면 서머타임이 바뀌는 날에 어긋난다
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (day === startOfDay(yesterday)) return t("time.yesterday", { time });
  if (date.getFullYear() === new Date(now).getFullYear()) {
    const monthDay = date.toLocaleDateString(locale(), { month: "short", day: "numeric" });
    return t("time.date", { date: monthDay, time });
  }
  return date.toLocaleDateString(locale(), { year: "numeric", month: "short", day: "numeric" });
}

/** 전체 시각 — 마우스를 올리면 보이는 값 */
export function fullTime(at: number): string {
  const date = new Date(at);
  return t("time.full", {
    date: date.toLocaleDateString(locale(), { year: "numeric", month: "long", day: "numeric" }),
    weekday: date.toLocaleDateString(locale(), { weekday: "short" }),
    time: clock(date, true),
  });
}
