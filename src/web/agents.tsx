import type { ReactNode } from "react";
import { t } from "../shared/i18n.ts";

// 에이전트별 아이콘 — 세션·사용 중 칸에서 어떤 AI 인지 한눈에 (M13).
// 각 도구의 대표 색에 단순한 기호를 얹은 배지다(실제 로고를 따라 그리지 않는다).

export type AgentKind = "claude" | "codex" | "gemini" | "copilot" | "cursor" | "human" | "unknown";

/** 세션의 에이전트 이름(`claude-code`·`codex`·`cursor-agent` …)을 종류로 */
export function agentKind(agent: string, human = false): AgentKind {
  if (human || agent === "human" || agent === "web") return "human";
  const name = agent.toLowerCase();
  for (const kind of ["claude", "codex", "gemini", "copilot", "cursor"] as const) {
    if (name.includes(kind)) return kind;
  }
  return "unknown";
}

const LABEL: Record<Exclude<AgentKind, "human" | "unknown">, string> = {
  claude: "Claude Code",
  codex: "Codex",
  gemini: "Gemini CLI",
  copilot: "Copilot CLI",
  cursor: "Cursor",
};

/** 화면에 보일 이름 — 알려진 에이전트는 제품 이름, 사람은 «사람» */
export function agentLabel(agent: string, human = false): string {
  const kind = agentKind(agent, human);
  if (kind === "human") return t("common.human");
  if (kind === "unknown") return agent;
  return LABEL[kind];
}

const stroke = {
  fill: "none",
  stroke: "#ffffff",
  strokeWidth: 1.6,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

const GLYPH: Record<AgentKind, { color: string; glyph: ReactNode }> = {
  // 빛살
  claude: {
    color: "#D97757",
    glyph: <path {...stroke} d="M8 3.2v9.6M3.2 8h9.6M4.6 4.6l6.8 6.8M11.4 4.6l-6.8 6.8" />,
  },
  // 터미널 프롬프트
  codex: {
    color: "#1F2328",
    glyph: <path {...stroke} d="M4 5.2l2.6 2.6L4 10.4M8.4 10.8h3.6" />,
  },
  // 네 꼭짓점 별
  gemini: {
    color: "#3D7BF7",
    glyph: (
      <path
        fill="#ffffff"
        d="M8 2.6c.5 3 2.4 4.9 5.4 5.4-3 .5-4.9 2.4-5.4 5.4-.5-3-2.4-4.9-5.4-5.4 3-.5 4.9-2.4 5.4-5.4z"
      />
    ),
  },
  // 고글
  copilot: {
    color: "#8250DF",
    glyph: (
      <g {...stroke}>
        <circle cx="5.6" cy="8" r="2.2" />
        <circle cx="10.4" cy="8" r="2.2" />
        <path d="M7.8 8h.4" />
      </g>
    ),
  },
  // 커서
  cursor: {
    color: "#2B2F36",
    glyph: <path fill="#ffffff" d="M5 3.6l6.6 3.6-2.9.9 1.7 3.1-1.3.7-1.7-3.1-2.1 2.2z" />,
  },
  // 사람
  human: {
    color: "#6B7280",
    glyph: (
      <g {...stroke}>
        <circle cx="8" cy="6" r="2.2" />
        <path d="M4.2 12.6c.6-1.9 2-2.9 3.8-2.9s3.2 1 3.8 2.9" />
      </g>
    ),
  },
  unknown: {
    color: "#6B7280",
    glyph: <path {...stroke} d="M6.3 6.2a1.8 1.8 0 1 1 2.6 1.6c-.6.3-.9.7-.9 1.3M8 11.2v.1" />,
  },
};

/** 에이전트 배지 — 둥근 네모 안에 기호 하나 */
export function AgentIcon({
  agent,
  human = false,
  size = 20,
}: {
  agent: string;
  human?: boolean;
  size?: number;
}) {
  const { color, glyph } = GLYPH[agentKind(agent, human)];
  return (
    <svg
      className="agent-icon"
      width={size}
      height={size}
      viewBox="0 0 16 16"
      role="img"
      aria-label={agentLabel(agent, human)}
    >
      <rect width="16" height="16" rx="4" fill={color} />
      {glyph}
    </svg>
  );
}

/** 아이콘 + 이름 */
export function Agent({ agent, human = false }: { agent: string; human?: boolean }) {
  return (
    <span className="agent">
      <AgentIcon agent={agent} human={human} size={18} />
      <span>{agentLabel(agent, human)}</span>
    </span>
  );
}
