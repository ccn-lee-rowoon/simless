import { homedir } from "node:os";
import { join } from "node:path";
import type { Config } from "./config.ts";

/** Android SDK 위치 — 설정 → ANDROID_HOME → ANDROID_SDK_ROOT → 기본 위치 */
export function androidSdk(config: Config, env: NodeJS.ProcessEnv = process.env): string {
  return (
    config.android.sdkPath ??
    env.ANDROID_HOME ??
    env.ANDROID_SDK_ROOT ??
    join(env.HOME ?? homedir(), "Library", "Android", "sdk")
  );
}

/** 설치 안내 — doctor 와 오류 메시지가 같이 쓴다 (S1) */
export const INSTALL_HINTS = {
  avdslim:
    "brew tap kdbhalala/avdslim https://github.com/kdbhalala/avdslim.git && brew install kdbhalala/avdslim/avdslim (비공식 tap 이라 거부되면 brew trust kdbhalala/avdslim 뒤 다시)",
  simslim: "brew install mobai-app/tap/simslim",
  androidSdk:
    "Android Studio 를 설치하거나, SDK 가 다른 곳이면 ~/.config/corgi/config.json 의 android.sdkPath",
  systemImage:
    "Android Studio → Settings → Android SDK → SDK Platforms 에서 시스템 이미지(Google APIs, arm64-v8a) 설치",
  xcode: "Xcode 를 설치하고 sudo xcode-select -s /Applications/Xcode.app",
  argent: "npx @swmansion/argent@latest init -y",
} as const;
