import { homedir } from "node:os";
import { join } from "node:path";
import type { Config } from "./config.ts";
import { t } from "./i18n.ts";

/** Android SDK 위치 — 설정 → ANDROID_HOME → ANDROID_SDK_ROOT → 기본 위치 */
export function androidSdk(config: Config, env: NodeJS.ProcessEnv = process.env): string {
  return (
    config.android.sdkPath ??
    env.ANDROID_HOME ??
    env.ANDROID_SDK_ROOT ??
    join(env.HOME ?? homedir(), "Library", "Android", "sdk")
  );
}

/** 설치 안내 — doctor 와 오류 메시지가 같이 쓴다 (S1). 설명 문구는 설정 언어로 */
export function installHints() {
  return {
    avdslim: `brew tap kdbhalala/avdslim https://github.com/kdbhalala/avdslim.git && brew install kdbhalala/avdslim/avdslim ${t("hint.avdslimTrust")}`,
    simslim: "brew install mobai-app/tap/simslim",
    androidSdk: t("hint.androidSdk"),
    systemImage: t("hint.systemImage"),
    xcode: t("hint.xcode"),
    argent: "npx @swmansion/argent@latest init -y",
  } as const;
}
