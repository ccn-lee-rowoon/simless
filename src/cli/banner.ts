import { t } from "../shared/i18n.ts";

// 로고 (M12) — 사람이 터미널에서 install 을 실행할 때만(설치 파일·update 도 안에서 install 을
// 부른다). 에이전트가 부르는 명령·--json·파이프에는 찍지 않는다. 앱 아이콘(폰 얼굴)과 같은 민트색

export interface Terminal {
  isTTY: boolean;
  /** 터미널 폭 — 모르거나 0 이면 넉넉하다고 본다 */
  columns?: number;
  env: NodeJS.ProcessEnv;
}

const PHONE = ["╭──────╮", "│      │", "│ ╹  ╹ │", "│ ╰──╯ │", "│      │", "╰──────╯"];
const LETTERS = [
  "█▀▀ █ █▀▄▀█ █   █▀▀ █▀▀ █▀▀",
  "▀▀█ █ █ ▀ █ █   █▀▀ ▀▀█ ▀▀█",
  "▀▀▀ ▀ ▀   ▀ ▀▀▀ ▀▀▀ ▀▀▀ ▀▀▀",
];
/** 로고 전체 폭(슬로건 줄 포함) — 이보다 좁으면 한 줄 제목으로 */
const WIDE = 60;

/** help 맨 위 한 줄 — 색 없이(에이전트도 읽는다) */
export function titleLine(version: string): string {
  return `Simless ${version} — ${t("web.slogan")}`;
}

/** 찍을 로고. 터미널이 아니거나 TERM=dumb 이면 undefined. NO_COLOR 면 색 없이 */
export function banner(version: string, term: Terminal): string | undefined {
  if (!term.isTTY || term.env.TERM === "dumb") return undefined;
  const color = !term.env.NO_COLOR;
  // 24비트 색을 알리는 터미널만 정확한 색, 아니면 256색 중 가장 가까운 것
  const truecolor = /^(truecolor|24bit)$/.test(term.env.COLORTERM ?? "");
  const mint = (s: string) =>
    color ? `\x1b[${truecolor ? "38;2;94;234;192" : "38;5;79"}m${s}\x1b[0m` : s;
  const dim = (s: string) => (color ? `\x1b[2m${s}\x1b[0m` : s);
  // 폭 0 은 모르는 것(가짜 터미널 등) — 넉넉하다고 본다
  if ((term.columns || WIDE) < WIDE) return `\n${mint("Simless")} ${dim(version)}\n`;
  const right = ["", ...LETTERS.map(mint), `${dim(t("web.slogan"))}  ${dim(`v${version}`)}`, ""];
  const lines = PHONE.map((p, i) => `  ${mint(p)}  ${right[i] ?? ""}`.trimEnd());
  return `\n${lines.join("\n")}\n`;
}
