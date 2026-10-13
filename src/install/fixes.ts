// 첫 실행 설정 창의 «설치·업데이트·열기» 버튼이 실행하는 명령 (M14·S1).
// 웹 화면은 고칠 항목의 ID 만 보낸다 — 서버는 여기 적힌 명령만 실행한다(임의의 명령은 받지 않는다).
// 입력을 기다리지 않게 묻지 않는 모드로 실행하고, 그래도 안 되면 «터미널에서 열기» 로 같은 명령을 띄운다.

import type { FixId } from "../shared/api.ts";

export interface FixStep {
  command: string[];
  /** 이 글이 출력에 있으며 실패하면 retry 를 실행하고 같은 단계를 한 번 더 */
  retryWhen?: RegExp;
  retry?: string[];
}

export interface Fix {
  id: FixId;
  /** run = 명령 실행(출력을 보여 준다), open = 앱·페이지 열기 */
  kind: "run" | "open";
  steps: FixStep[];
}

const AVDSLIM_TAP = "kdbhalala/avdslim";

export const FIXES: Record<FixId, Fix> = {
  "simslim.install": {
    id: "simslim.install",
    kind: "run",
    steps: [{ command: ["brew", "install", "mobai-app/tap/simslim"] }],
  },
  "simslim.upgrade": {
    id: "simslim.upgrade",
    kind: "run",
    steps: [{ command: ["brew", "upgrade", "simslim"] }],
  },
  "avdslim.install": {
    id: "avdslim.install",
    kind: "run",
    steps: [
      { command: ["brew", "tap", AVDSLIM_TAP, "https://github.com/kdbhalala/avdslim.git"] },
      {
        command: ["brew", "install", `${AVDSLIM_TAP}/avdslim`],
        // 비공식 tap 이라 거부되는 brew 버전이 있다 — 믿는다고 알리고 다시
        retryWhen: /trust/i,
        retry: ["brew", "trust", AVDSLIM_TAP],
      },
    ],
  },
  "avdslim.upgrade": {
    id: "avdslim.upgrade",
    kind: "run",
    steps: [{ command: ["brew", "upgrade", "avdslim"] }],
  },
  "xcode.open": {
    id: "xcode.open",
    kind: "open",
    steps: [{ command: ["open", "macappstore://apps.apple.com/app/id497799835"] }],
  },
  "androidStudio.open": {
    id: "androidStudio.open",
    kind: "open",
    steps: [
      {
        command: ["open", "-a", "Android Studio"],
        // 없으면 내려받는 페이지
        retryWhen: /./,
        retry: ["open", "https://developer.android.com/studio"],
      },
    ],
  },
};

/** 묻지 않게 — brew 는 자동 업데이트·힌트를 끄고, 어떤 도구든 질문 없이 */
export function fixEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const path = env.PATH ?? "";
  const extra = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"];
  return {
    ...env,
    PATH: [...path.split(":").filter(Boolean), ...extra.filter((d) => !path.includes(d))].join(":"),
    NONINTERACTIVE: "1",
    HOMEBREW_NO_AUTO_UPDATE: "1",
    HOMEBREW_NO_ENV_HINTS: "1",
    HOMEBREW_NO_INSTALL_CLEANUP: "1",
    npm_config_yes: "true",
  };
}

function shellQuote(text: string): string {
  return /^[\w./:@=-]+$/.test(text) ? text : `'${text.replace(/'/g, "'\\''")}'`;
}

/** 터미널에 띄울 한 줄 — 단계를 && 로 잇는다 (다시 시도할 명령은 사람이 판단) */
export function fixCommandLine(fix: Fix): string {
  return fix.steps.map((s) => s.command.map(shellQuote).join(" ")).join(" && ");
}
