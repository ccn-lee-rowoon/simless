import {
  type CatalogResult,
  type DeviceView,
  type HolderView,
  memoryChange,
} from "../shared/api.ts";

/** 한글 등 넓은 글자는 터미널에서 두 칸을 쓴다 */
function displayWidth(text: string): number {
  let width = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    const wide =
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6);
    width += wide ? 2 : 1;
  }
  return width;
}

export function table(header: string[], rows: string[][]): string {
  const all = [header, ...rows];
  const widths = header.map((_, i) => Math.max(...all.map((row) => displayWidth(row[i] ?? ""))));
  return all
    .map((row) =>
      row
        .map((cell, i) =>
          i === row.length - 1 ? cell : cell + " ".repeat((widths[i] ?? 0) - displayWidth(cell)),
        )
        .join("  ")
        .trimEnd(),
    )
    .join("\n");
}

export function ago(since: number, now = Date.now()): string {
  const minutes = Math.floor((now - since) / 60_000);
  if (minutes < 1) return "방금";
  if (minutes < 60) return `${minutes}분 전`;
  return `${Math.floor(minutes / 60)}시간 ${minutes % 60}분 전`;
}

function shortPath(path: string): string {
  const home = process.env.HOME;
  return home && path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

export function formatHolder(holder: HolderView & { deviceId?: string }): string {
  const who = holder.human ? "사람" : holder.agent;
  const what = holder.reason === "queued" ? "먼저 기다리는 중" : "사용 중";
  const device = holder.deviceId ? `${holder.deviceId}: ` : "";
  return `${device}${who} · ${shortPath(holder.cwd)} · ${ago(holder.since)}부터 ${what}`;
}

export function devicesTable(devices: DeviceView[]): string {
  if (devices.length === 0)
    return "디바이스가 없습니다 — corgi catalog 에서 기종을 골라 corgi create <기종>";
  const rows = [...devices]
    .sort((a, b) => a.spec.platform.localeCompare(b.spec.platform) || a.layoutWidth - b.layoutWidth)
    .map((d) => [
      d.id,
      d.label,
      d.name,
      d.booted ? `켜짐 ${d.targetId ?? ""}`.trim() : "꺼짐",
      d.slimStats
        ? `${d.slim} ${d.slimStats.disabled}/${d.slimStats.total} ${
            memoryChange(d.slimBaseline?.memoryBytes, d.slimStats.memoryBytes) ??
            (d.slimStats.memoryBytes ? `${(d.slimStats.memoryBytes / 1024 ** 3).toFixed(1)}GB` : "")
          }`.trim()
        : d.slim,
      [d.default ? "기본" : "", d.createdByCorgi ? "Corgi" : ""].filter(Boolean).join(" "),
      d.memo ?? "",
      d.mine ? "나" : d.holder ? formatHolder(d.holder) : "",
    ]);
  // 슬림 실패 이유는 표에 넣기엔 길어 아래에 따로 적는다
  const notes = devices
    .filter((d) => d.slim === "failed" && d.slimError)
    .map((d) => `슬림 실패 ${d.id}: ${d.slimError?.split("\n")[0]}`);
  return [table(["ID", "크기", "이름", "상태", "슬림", "", "메모", "점유"], rows), ...notes].join(
    "\n",
  );
}

/** 만들 수 있는 기종·OS — 폭 순 (M1·M2) */
export function catalogText(result: CatalogResult): string {
  const lines: string[] = [];
  for (const catalog of result.platforms) {
    const unit = catalog.platform === "android" ? "dp" : "pt";
    const title = catalog.platform === "android" ? "Android 대표 프로필" : "iOS 기기 종류";
    const rows = [...catalog.models]
      .sort((a, b) => a.layoutWidth - b.layoutWidth || a.name.localeCompare(b.name))
      .map((m) => [`${m.layoutWidth}${unit}`, m.name, m.detail, m.id]);
    lines.push(title, table(["폭", "기종", "해상도", "ID"], rows), "");
    const os = catalog.os.map((o) => `  ${o.recommended ? "*" : " "} ${o.name}  (${o.id})`);
    lines.push(
      catalog.platform === "android" ? "시스템 이미지 (* 기본)" : "런타임 (* 기본)",
      ...os,
      "",
    );
    if (catalog.slimOff.length > 0) {
      lines.push(
        "슬림화하면 꺼지는 것",
        ...catalog.slimOff.map(
          (c) =>
            `  - ${c.name}${c.count ? ` (${c.count})` : ""}${c.detail ? ` — ${c.detail}` : ""}`,
        ),
        "",
      );
    }
  }
  lines.push(
    "만들기: corgi create <기종> [--os <OS>] [--no-slim]",
    "직접 입력(Android): corgi create --width <dp> --height <dp> --density <dpi> [--os <이미지>]",
    ...result.problems.map((p) => `주의(${p.platform}): ${p.message}`),
  );
  return lines.join("\n");
}
