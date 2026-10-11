import type { SlimKeepMode, SlimMode, SlimState } from "./model.ts";

/** 화면·CLI 에 보이는 방식 — 슬림하지 않았으면 none */
export type SlimChoice = SlimMode | "none";

// 슬림 방식 이름 (M15) — 화면도 쓰므로 zod 를 끌어오지 않게 model.ts 와 나눴다.

/** 디바이스의 슬림 방식 — 슬림하지 않았으면 none */
export function slimModeOf(device: {
  slim: SlimState;
  slimKeep?: string[];
  slimMode?: SlimKeepMode;
}): SlimChoice {
  if (device.slim === "none") return "none";
  if (!device.slimKeep?.length) return "ui";
  return device.slimMode ?? "custom";
}

/** 방식 이름 — 어느 언어에서나 그대로 쓴다(device-slim 스킬과 같게) */
export const SLIM_MODE_NAMES: Record<SlimMode, string> = { ui: "UI", app: "App", custom: "Custom" };
