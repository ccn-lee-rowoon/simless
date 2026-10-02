import type { DeviceView, HolderView } from "../shared/api.ts";

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
    return "만든 디바이스가 없습니다 — corgi catalog 로 만들 수 있는 목록을 보세요";
  const rows = [...devices]
    .sort((a, b) => a.spec.platform.localeCompare(b.spec.platform) || a.layoutWidth - b.layoutWidth)
    .map((d) => [
      d.id,
      d.label,
      d.name,
      d.booted ? `켜짐 ${d.targetId ?? ""}`.trim() : "꺼짐",
      d.slim,
      d.enabled ? "" : "사용 안 함",
      d.mine ? "나" : d.holder ? formatHolder(d.holder) : "",
    ]);
  return table(["ID", "크기", "이름", "상태", "슬림", "", "점유"], rows);
}
