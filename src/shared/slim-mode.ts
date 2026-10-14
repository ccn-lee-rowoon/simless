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

/** 슬림이 실패했거나 풀린 기기 — 고른 방식이 같아도 다시 걸 수 있어야 한다 (M6·M15) */
export function needsReslim(device: { slim: SlimState }): boolean {
  return device.slim === "failed" || device.slim === "drifted";
}

/** 지금 설정과 같아 «적용» 할 것이 없는가 — 실패했거나 풀린 기기는 같아도 다시 적용한다 (M15) */
export function slimUnchanged(
  device: { slim: SlimState; slimMode: SlimChoice; slimKeep?: string[] },
  mode: SlimChoice,
  keep: string[],
): boolean {
  if (mode !== "none" && needsReslim(device)) return false;
  if (mode !== device.slimMode) return false;
  if (mode !== "custom" && mode !== "app") return true;
  return [...keep].sort().join() === [...(device.slimKeep ?? [])].sort().join();
}
