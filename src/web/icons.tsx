// 왼쪽 메뉴 아이콘 — 16px 선 아이콘, 글자색을 따른다 (M12)

const base = {
  width: 16,
  height: 16,
  viewBox: "0 0 16 16",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.5,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

/** 디바이스 — 폰 */
export function DevicesIcon() {
  return (
    <svg {...base} aria-hidden="true">
      <rect x="4" y="1.5" width="8" height="13" rx="1.8" />
      <path d="M7 12h2" />
    </svg>
  );
}

/** 그룹 — 겹친 층 */
export function GroupsIcon() {
  return (
    <svg {...base} aria-hidden="true">
      <path d="M8 2l6 3-6 3-6-3 6-3z" />
      <path d="M2 8l6 3 6-3" />
      <path d="M2 11l6 3 6-3" />
    </svg>
  );
}

/** 세션 — 사람 둘 */
export function SessionsIcon() {
  return (
    <svg {...base} aria-hidden="true">
      <circle cx="6" cy="5.5" r="2.4" />
      <path d="M1.8 13.5c.6-2.3 2.2-3.5 4.2-3.5s3.6 1.2 4.2 3.5" />
      <path d="M10.6 3.4a2.2 2.2 0 0 1 0 4.2" />
      <path d="M11.6 10.2c1.3.4 2.2 1.5 2.6 3.3" />
    </svg>
  );
}

/** 설정 — 슬라이더 */
export function SettingsIcon() {
  return (
    <svg {...base} aria-hidden="true">
      <path d="M2 4h3.2M8.2 4H14M2 8h6.7M11.7 8H14M2 12h1.7M6.7 12H14" />
      <circle cx="6.7" cy="4" r="1.5" />
      <circle cx="10.2" cy="8" r="1.5" />
      <circle cx="5.2" cy="12" r="1.5" />
    </svg>
  );
}

/** 새 창으로 열림 */
export function ExternalIcon() {
  return (
    <svg {...base} aria-hidden="true" width={12} height={12} viewBox="0 0 12 12" strokeWidth={1.4}>
      <path d="M4.5 2.5h5v5M9.5 2.5L3 9" />
    </svg>
  );
}
