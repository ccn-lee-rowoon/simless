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

// --- Android Studio 의 기기 정의 (M1) — 깔려 있으면 거기 있는 폰·태블릿을 전부 쓴다.
// iOS 가 설치된 런타임이 지원하는 기종을 전부 보여 주는 것과 맞춘다. 워치·TV·자동차·XR·데스크톱은 뺀다
// (iOS 에서 Watch·TV·Vision 을 빼듯). Android Studio 가 없으면 위의 대표 프로필.

/** `devices.xml` 의 밀도 이름 → dpi */
const DENSITIES: Record<string, number> = {
  ldpi: 120,
  mdpi: 160,
  tvdpi: 213,
  hdpi: 240,
  xhdpi: 320,
  xxhdpi: 480,
  xxxhdpi: 640,
};

const SKIP_TAGS = /wear|tv|automotive|xr|desktop/;

/** 정의 ID → Simless 기종 ID — «pixel_9_pro_xl» → «pixel-9-pro-xl», «Nexus 5X» → «nexus-5x» */
export function profileId(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * Android Studio 기기 정의 XML(`sdklib.jar` 의 devices.xml·nexus.xml, 사람이 만든 ~/.android/devices.xml)에서
 * 폰·태블릿을 꺼낸다. 세로 기준(가로 < 세로)으로 맞춘다
 */
export function parseDeviceDefinitions(xml: string): AndroidProfile[] {
  const profiles: AndroidProfile[] = [];
  const field = (block: string, tag: string) =>
    new RegExp(`<(?:\\w+:)?${tag}>\\s*([^<]*?)\\s*</(?:\\w+:)?${tag}>`).exec(block)?.[1] ?? "";
  for (const m of xml.matchAll(/<(?:\w+:)?device(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?device>/g)) {
    const block = m[1] ?? "";
    if (SKIP_TAGS.test(field(block, "tag-id"))) continue;
    const name = field(block, "name");
    const x = Number(field(block, "x-dimension"));
    const y = Number(field(block, "y-dimension"));
    const rawDensity = field(block, "pixel-density");
    const density = DENSITIES[rawDensity] ?? Number.parseInt(rawDensity, 10);
    if (!name || !(x > 0) || !(y > 0) || !(density > 0)) continue;
    profiles.push({
      id: profileId(field(block, "id") || name),
      name,
      widthPx: Math.min(x, y),
      heightPx: Math.max(x, y),
      density,
    });
  }
  return profiles;
}

/** 앞의 것이 이긴다 — 사람이 만든 정의 → Android Studio → 대표 프로필 */
export function mergeProfiles(...lists: AndroidProfile[][]): AndroidProfile[] {
  const byId = new Map<string, AndroidProfile>();
  for (const list of lists) for (const p of list) if (!byId.has(p.id)) byId.set(p.id, p);
  return [...byId.values()];
}
