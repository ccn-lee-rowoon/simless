import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import icnsPath from "../../assets/simless.icns" with { type: "file" };
import traySource from "../../tray/SimlessTray.swift" with { type: "file" };
import type { Config } from "../shared/config.ts";
import { run } from "../shared/exec.ts";
import { t } from "../shared/i18n.ts";
import { APP_BUNDLE_ID, LAUNCH_LABEL, MENUBAR_LABEL, type Paths } from "../shared/paths.ts";
import { VERSION } from "../shared/version.ts";
import { selfCommand } from "./launchd.ts";

// Simless.app — 메뉴바 앱 + 앱 창. 실행하면 메뉴바에 아이콘이 생기고 «대시보드 열기» 로 웹 화면을
// 자기 창(WKWebView)에 연다 (R11).
// 미리 빌드한 앱을 배포하지 않고 그 Mac 에서 Swift 소스를 컴파일해 만든다 —
// 서명·공증 없이 Gatekeeper 에 막히지 않는다 (requirements «결정 기록»).

const LSREGISTER =
  "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";

const MENUBAR_EXECUTABLE = "simless-menubar";
/** 컴파일을 못 하면(Xcode 없음) 웹 UI 를 바로 여는 스크립트로 대신한다 */
const FALLBACK_EXECUTABLE = "simless-app";

function shellQuote(text: string): string {
  return `'${text.replace(/'/g, "'\\''")}'`;
}

function xml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function infoPlist(
  executable: string,
  settings: { port: number; tokenPath: string },
): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key>
  <string>Simless</string>
  <key>CFBundleDisplayName</key>
  <string>Simless</string>
  <key>CFBundleIdentifier</key>
  <string>${APP_BUNDLE_ID}</string>
  <key>CFBundleExecutable</key>
  <string>${executable}</string>
  <key>CFBundleIconFile</key>
  <string>simless</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>${VERSION}</string>
  <key>LSUIElement</key>
  <true/>
  <key>NSAppTransportSecurity</key>
  <dict>
    <key>NSAllowsLocalNetworking</key>
    <true/>
  </dict>
  <key>SimlessHTTPPort</key>
  <integer>${settings.port}</integer>
  <key>SimlessTokenPath</key>
  <string>${xml(settings.tokenPath)}</string>
  <key>SimlessLaunchLabel</key>
  <string>${LAUNCH_LABEL}</string>
</dict>
</plist>
`;
}

/** 컴파일을 못 했을 때 — 앱 실행 = simless ui */
export function launcherScript(command: string[]): string {
  return `#!/bin/sh\nexec ${command.map(shellQuote).join(" ")} ui\n`;
}

/** 로그인 시 메뉴바 앱을 한 번 띄운다 (종료하면 다시 띄우지 않는다) */
export function menubarAgentPlist(appPath: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${MENUBAR_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/open</string>
    <string>-a</string>
    <string>${xml(appPath)}</string>
  </array>
  <key>AssociatedBundleIdentifiers</key>
  <array>
    <string>${APP_BUNDLE_ID}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
</dict>
</plist>
`;
}

async function compileMenubar(output: string): Promise<string | undefined> {
  const work = mkdtempSync(join(tmpdir(), "simless-tray-"));
  try {
    const source = join(work, "SimlessTray.swift");
    writeFileSync(source, await Bun.file(traySource).text());
    const result = await run(["xcrun", "swiftc", "-O", "-o", output, source], {
      timeoutMs: 5 * 60_000,
    });
    return result.code === 0
      ? undefined
      : (result.stderr || result.stdout).trim().split("\n").slice(-3).join("\n");
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function domain(): string {
  return `gui/${process.getuid?.() ?? 501}`;
}

async function stopMenubar(paths: Paths): Promise<void> {
  await run(["pkill", "-f", join(paths.appBundle, "Contents", "MacOS", MENUBAR_EXECUTABLE)]);
}

export interface AppInstallResult {
  path: string;
  menubar: boolean;
  /** 메뉴바 앱을 못 만든 이유 — 이때는 앱을 열면 웹 UI 가 바로 열린다 */
  warning?: string;
}

export async function installApp(paths: Paths, config: Config): Promise<AppInstallResult> {
  const app = paths.appBundle;
  await stopMenubar(paths);
  rmSync(app, { recursive: true, force: true });
  const contents = join(app, "Contents");
  const macos = join(contents, "MacOS");
  mkdirSync(macos, { recursive: true });
  mkdirSync(join(contents, "Resources"), { recursive: true });
  writeFileSync(
    join(contents, "Resources", "simless.icns"),
    new Uint8Array(await Bun.file(icnsPath).arrayBuffer()),
  );

  const failure = await compileMenubar(join(macos, MENUBAR_EXECUTABLE));
  let executable = MENUBAR_EXECUTABLE;
  if (failure) {
    executable = FALLBACK_EXECUTABLE;
    const launcher = join(macos, FALLBACK_EXECUTABLE);
    writeFileSync(launcher, launcherScript(selfCommand()));
    chmodSync(launcher, 0o755);
  }
  writeFileSync(
    join(contents, "Info.plist"),
    infoPlist(executable, { port: config.httpPort, tokenPath: paths.webToken }),
  );
  // ad-hoc 서명 + LaunchServices 등록 — Spotlight·Launchpad 에 보이고 아이콘이 바로 바뀐다
  await run(["codesign", "--force", "--sign", "-", app]);
  await run([LSREGISTER, "-f", app]);

  if (!failure) {
    // 로그인 시 메뉴바에 뜨게 하고, 지금 바로 띄운다
    await run(["launchctl", "bootout", `${domain()}/${MENUBAR_LABEL}`]);
    writeFileSync(paths.menubarAgent, menubarAgentPlist(app));
    await run(["launchctl", "bootstrap", domain(), paths.menubarAgent]);
    await run(["open", "-a", app]);
  }
  return {
    path: app,
    menubar: !failure,
    warning: failure ? t("app.compileFailed", { error: failure }) : undefined,
  };
}

export function isAppInstalled(paths: Paths): boolean {
  return existsSync(join(paths.appBundle, "Contents", "Info.plist"));
}

export async function uninstallApp(paths: Paths): Promise<void> {
  await run(["launchctl", "bootout", `${domain()}/${MENUBAR_LABEL}`]);
  rmSync(paths.menubarAgent, { force: true });
  await stopMenubar(paths);
  if (existsSync(paths.appBundle)) await run([LSREGISTER, "-u", paths.appBundle]);
  rmSync(paths.appBundle, { recursive: true, force: true });
}
