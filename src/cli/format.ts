import {
  type CatalogResult,
  type DeviceView,
  type HolderView,
  memoryChange,
  observedSlim,
} from "../shared/api.ts";
import { t } from "../shared/i18n.ts";
import { SLIM_MODE_NAMES, slimModeOf } from "../shared/slim-mode.ts";
import { when } from "../shared/time.ts";

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

/** 언제 — 가까우면 «N분 전», 지난 것은 «오늘 14:05»·날짜 (shared/time.ts) */
export function ago(since: number, now = Date.now()): string {
  return when(since, { now });
}

function shortPath(path: string): string {
  const home = process.env.HOME;
  return home && path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

export function formatHolder(holder: HolderView & { deviceId?: string }): string {
  const who = holder.human ? t("common.human") : holder.agent;
  const what = holder.reason === "queued" ? t("cli.holder.waiting") : t("cli.holder.using");
  const device = holder.deviceId ? `${holder.deviceId}: ` : "";
  return t("cli.holder.since", {
    device,
    who,
    cwd: shortPath(holder.cwd),
    ago: ago(holder.since),
    what,
  });
}

/** 슬림 표시 (M6) — SLIM 하나, 켜져 있으면 수치와 슬림 전후 비교, 실패만 따로 */
function slimText(d: DeviceView): string {
  if (d.slim === "none") {
    // Simless 가 하지 않은 슬림 — 꺼져 있으면 마지막으로 본 값과 그 시각
    const seen = observedSlim(d);
    if (!seen) return "";
    const unit = t(seen.unit === "packages" ? "slim.unit.packages" : "slim.unit.daemons");
    const text = `${t("slim.applied")} ${seen.disabled}/${seen.total} ${unit}`;
    return seen.seenAt
      ? `${text} ${t("cli.slim.seen", { ago: ago(Date.parse(seen.seenAt)) })}`
      : text;
  }
  if (d.slim === "failed") return t("slim.failed");
  if (d.slim === "applying") return t("slim.applying");
  const stats = d.slimStats;
  // 방식(UI·App·Custom)과 남긴 수를 붙인다 (M15)
  const mode = slimModeOf(d);
  const custom =
    mode === "none"
      ? ""
      : `(${SLIM_MODE_NAMES[mode]}${d.slimKeep?.length ? ` −${d.slimKeep.length}` : ""})`;
  if (!stats) return `${t("slim.applied")} ${custom}`.trim();
  const memory =
    memoryChange(d.slimBaseline?.memoryBytes, stats.memoryBytes) ??
    (stats.memoryBytes ? `${(stats.memoryBytes / 1024 ** 3).toFixed(1)}GB` : "");
  const unit = t(stats.unit === "packages" ? "slim.unit.packages" : "slim.unit.daemons");
  return `${t("slim.applied")}${custom ? ` ${custom}` : ""} ${stats.disabled}/${stats.total} ${unit} ${memory}`.trim();
}

export function devicesTable(devices: DeviceView[]): string {
  if (devices.length === 0) return t("table.noDevices");
  const rows = [...devices]
    .sort((a, b) => a.spec.platform.localeCompare(b.spec.platform) || a.layoutWidth - b.layoutWidth)
    .map((d) => [
      d.id,
      d.label,
      d.name,
      d.booted ? `${t("common.on")} ${d.targetId ?? ""}`.trim() : t("common.off"),
      slimText(d),
      [d.default ? t("table.default") : "", d.createdBySimless ? "simless" : ""]
        .filter(Boolean)
        .join(" "),
      d.mine ? t("table.me") : d.holder ? formatHolder(d.holder) : "",
    ]);
  // 슬림 실패 이유는 표에 넣기엔 길어 아래에 따로 적는다
  const notes = devices
    .filter((d) => d.slim === "failed" && d.slimError)
    .map((d) => t("table.slimFailed", { id: d.id, error: d.slimError?.split("\n")[0] ?? "" }));
  return [
    table(
      [
        t("table.id"),
        t("table.size"),
        t("table.name"),
        t("table.state"),
        t("table.slim"),
        "",
        t("table.holder"),
      ],
      rows,
    ),
    ...notes,
  ].join("\n");
}

/** 만들 수 있는 기종·OS — 폭 순 (M1·M2) */
export function catalogText(result: CatalogResult): string {
  const lines: string[] = [];
  for (const catalog of result.platforms) {
    const unit = catalog.platform === "android" ? "dp" : "pt";
    const title = t(catalog.platform === "android" ? "catalog.android" : "catalog.ios");
    const rows = [...catalog.models]
      .sort((a, b) => a.layoutWidth - b.layoutWidth || a.name.localeCompare(b.name))
      .map((m) => [`${m.layoutWidth}${unit}`, m.name, m.detail, m.id]);
    lines.push(
      title,
      table([t("table.width"), t("table.model"), t("table.resolution"), t("table.id")], rows),
      "",
    );
    const os = catalog.os.map((o) => `  ${o.recommended ? "*" : " "} ${o.name}  (${o.id})`);
    lines.push(
      t(catalog.platform === "android" ? "catalog.images" : "catalog.runtimes"),
      ...os,
      "",
    );
    if (catalog.slimOff.length > 0) {
      lines.push(
        t("catalog.slimOff"),
        ...catalog.slimOff.map(
          (c) =>
            `  - ${c.id}  ${c.name}${c.count ? ` (${c.count})` : ""}${c.detail ? ` — ${c.detail}` : ""}`,
        ),
        "",
      );
    }
  }
  lines.push(
    t("catalog.howCreate"),
    t("catalog.howCustom"),
    ...result.problems.map((p) =>
      t("catalog.problem", { platform: p.platform, message: p.message }),
    ),
  );
  return lines.join("\n");
}
