import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import icnsPath from "../../assets/Corgi.icns" with { type: "file" };
import { run } from "../shared/exec.ts";
import { APP_BUNDLE_ID, type Paths } from "../shared/paths.ts";
import { VERSION } from "../shared/version.ts";
import { selfCommand } from "./launchd.ts";

// Corgi.app — 더블클릭·Spotlight 로 웹 UI 를 연다 (docs/design.md §4).
// 미리 빌드한 앱을 배포하지 않고 그 Mac 에서 만들므로 서명·공증 없이 Gatekeeper 에 막히지 않는다.

const LSREGISTER =
  "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";

function shellQuote(text: string): string {
  return `'${text.replace(/'/g, "'\\''")}'`;
}

export function infoPlist(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key>
  <string>Corgi</string>
  <key>CFBundleDisplayName</key>
  <string>Corgi</string>
  <key>CFBundleIdentifier</key>
  <string>${APP_BUNDLE_ID}</string>
  <key>CFBundleExecutable</key>
  <string>corgi-app</string>
  <key>CFBundleIconFile</key>
  <string>Corgi</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>${VERSION}</string>
  <key>LSUIElement</key>
  <true/>
</dict>
</plist>
`;
}

/** 앱 실행 = corgi ui (서버를 깨우고 웹 UI 를 연 뒤 끝난다). 6단계 메뉴바가 생기면 바뀐다 */
export function launcherScript(command: string[]): string {
  return `#!/bin/sh\nexec ${command.map(shellQuote).join(" ")} ui\n`;
}

export async function installApp(paths: Paths): Promise<string> {
  const app = paths.appBundle;
  rmSync(app, { recursive: true, force: true });
  const contents = join(app, "Contents");
  mkdirSync(join(contents, "MacOS"), { recursive: true });
  mkdirSync(join(contents, "Resources"), { recursive: true });
  writeFileSync(join(contents, "Info.plist"), infoPlist());
  const launcher = join(contents, "MacOS", "corgi-app");
  writeFileSync(launcher, launcherScript(selfCommand()));
  chmodSync(launcher, 0o755);
  writeFileSync(
    join(contents, "Resources", "Corgi.icns"),
    new Uint8Array(await Bun.file(icnsPath).arrayBuffer()),
  );
  // ad-hoc 서명 + LaunchServices 등록 — Spotlight·Launchpad 에 보이고 아이콘이 바로 바뀐다
  await run(["codesign", "--force", "--sign", "-", app]);
  await run([LSREGISTER, "-f", app]);
  return app;
}

export function isAppInstalled(paths: Paths): boolean {
  return existsSync(join(paths.appBundle, "Contents", "Info.plist"));
}

export async function uninstallApp(paths: Paths): Promise<void> {
  if (existsSync(paths.appBundle)) await run([LSREGISTER, "-u", paths.appBundle]);
  rmSync(paths.appBundle, { recursive: true, force: true });
}
