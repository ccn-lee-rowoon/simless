/** 작업 기록 한 줄 — 서버의 진행 알림 */
export interface LogLine {
  id: number;
  text: string;
}

/** 버튼 동작 공통 — 실패하면 알림, 끝나면 목록을 다시 읽는다 */
export type Act = (label: string, fn: () => Promise<unknown>) => Promise<void>;
