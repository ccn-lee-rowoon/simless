// CLI 종료 코드 — 에이전트가 결과를 구분하는 기준이라 바꾸지 않는다 (docs/design.md §12).
export const ExitCode = {
  ok: 0,
  failed: 1,
  usage: 2,
  /** 다른 세션이 사용 중 */
  busy: 3,
  /** 서버에 연결 못 함 */
  serverDown: 4,
} as const;
