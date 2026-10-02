// Android 대표 프로필 — Android Studio 의 기기 정의를 본떠 폭별로 골랐다 (requirements M1).
// 세로 기준(가로 < 세로). 폭(dp) = 가로 px × 160 ÷ 밀도.

export interface AndroidProfile {
  id: string;
  name: string;
  widthPx: number;
  heightPx: number;
  density: number;
}

export const ANDROID_PROFILES: AndroidProfile[] = [
  { id: "small-320", name: "Small Phone 320dp", widthPx: 480, heightPx: 854, density: 240 },
  { id: "small-phone", name: "Small Phone", widthPx: 720, heightPx: 1280, density: 320 },
  { id: "pixel-4a", name: "Pixel 4a", widthPx: 1080, heightPx: 2340, density: 440 },
  { id: "medium-phone", name: "Medium Phone", widthPx: 1080, heightPx: 2400, density: 420 },
  { id: "pixel-9-pro-xl", name: "Pixel 9 Pro XL", widthPx: 1344, heightPx: 2992, density: 480 },
  { id: "tablet-7", name: "7 inch Tablet", widthPx: 1200, heightPx: 1920, density: 320 },
  { id: "medium-tablet", name: "Medium Tablet", widthPx: 1600, heightPx: 2560, density: 320 },
];
