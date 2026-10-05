import { z } from "zod";

// 소켓 메시지 — 한 줄에 JSON 하나, 연결 하나에 요청 하나 (docs/protocol.md).

export const PROTOCOL_VERSION = 1;

/** 요청을 보낸 세션 — CLI·훅·MCP 가 프로세스 트리에서 찾는다 (docs/design.md §7) */
export const SessionInfo = z.object({
  /** 세션 키 — `p<pid>-<시작 초>` 또는 `x:<직접 준 값>` */
  key: z.string(),
  /** 종료 감지용 프로세스. 없으면 프로세스 기준 해제를 하지 않는다 */
  pid: z.number().int().positive().optional(),
  pidStartedAt: z.number().optional(),
  /** 표시용 에이전트 이름 — `claude-code`·`codex`·`human`·`unknown` … */
  agent: z.string(),
  /** 에이전트가 주는 세션 ID (Claude Code 의 CLAUDE_CODE_SESSION_ID 등) */
  agentSessionId: z.string().optional(),
  cwd: z.string(),
  human: z.boolean(),
});
export type SessionInfo = z.infer<typeof SessionInfo>;

export const Request = z.object({
  v: z.literal(PROTOCOL_VERSION),
  id: z.string(),
  clientVersion: z.string(),
  method: z.string(),
  session: SessionInfo,
  params: z.unknown(),
});
export type Request = z.infer<typeof Request>;

export const ErrorCode = z.enum([
  /** 다른 세션이 사용 중 — data 에 holders */
  "BUSY",
  /** 이 세션이 점유하지 않음 */
  "NOT_HELD",
  "NOT_FOUND",
  "INVALID",
  /** 할 수 없는 작업 — 원래 있던 디바이스 삭제·슬림 등 */
  "NOT_ALLOWED",
  /** avdslim·simslim 등 필요한 도구가 없음 */
  "TOOL_MISSING",
  "FAILED",
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

export interface ErrorBody {
  code: ErrorCode;
  message: string;
  data?: unknown;
}

export type Response =
  | { id: string; serverVersion: string; ok: true; result: unknown }
  | { id: string; serverVersion: string; ok: false; error: ErrorBody };

/** 응답 전에 여러 번 올 수 있는 진행 알림 */
export interface Event {
  id: string;
  event: string;
  data: unknown;
}

export type ServerMessage = Response | Event;

export function isEvent(message: ServerMessage): message is Event {
  return "event" in message;
}
