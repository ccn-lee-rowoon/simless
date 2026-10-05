// Simless.app 안이면 Swift 에 창 열기·닫기를 알린다 (window.webkit.messageHandlers.simless).
// 브라우저에서 열었으면 false — 부르는 쪽이 window.open 등으로 대신한다.

export type AppMessage =
  | { open: "settings" }
  | { open: "setup" }
  | { open: "dashboard" }
  | { open: "session"; key: string }
  | { close: "setup" };

export function postToApp(message: AppMessage): boolean {
  const bridge = (
    window as unknown as {
      webkit?: { messageHandlers?: { simless?: { postMessage: (message: unknown) => void } } };
    }
  ).webkit?.messageHandlers?.simless;
  if (!bridge) return false;
  bridge.postMessage(message);
  return true;
}

/** 첫 실행 설정 창 (M14) */
export function openSetup(): void {
  if (!postToApp({ open: "setup" }))
    window.open("/?window=setup", "simless-setup", "width=820,height=780");
}
