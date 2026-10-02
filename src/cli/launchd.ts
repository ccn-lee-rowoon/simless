import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { run } from "../shared/exec.ts";
import { LAUNCH_LABEL, type Paths } from "../shared/paths.ts";

// 서버를 launchd 사용자 에이전트로 등록한다 — 로그인 시 켜지고, 죽으면 다시 살아난다 (docs/design.md §4).

const PASS_ENV = [
  "CORGI_STATE_DIR",
  "CORGI_CONFIG_DIR",
  "CORGI_LOG_DIR",
  "CORGI_SOCKET",
  "ANDROID_HOME",
];

/** 지금 실행 중인 corgi 를 다시 실행하는 명령 — 단일 실행 파일이면 그 파일, 개발 중이면 bun + 스크립트 */
export function selfCommand(): string[] {
  const compiled = Bun.main.startsWith("/$bunfs/");
  return compiled ? [process.execPath] : [process.execPath, Bun.main];
}

function escapeXml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function plist(
  paths: Paths,
  command: string[],
  env: NodeJS.ProcessEnv = process.env,
): string {
  const args = [...command, "serve"].map((a) => `    <string>${escapeXml(a)}</string>`).join("\n");
  // launchd 는 로그인 셸 PATH 를 안 준다 — 명령 위치는 서버가 직접 찾지만 기본 PATH 는 넣어 둔다
  const vars: Record<string, string> = {
    PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
  };
  for (const name of PASS_ENV) {
    const value = env[name];
    if (value) vars[name] = value;
  }
  const envXml = Object.entries(vars)
    .map(([k, v]) => `    <key>${k}</key>\n    <string>${escapeXml(v)}</string>`)
    .join("\n");
  const log = escapeXml(join(paths.logDir, "server.log"));
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCH_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${envXml}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${log}</string>
  <key>StandardErrorPath</key>
  <string>${log}</string>
</dict>
</plist>
`;
}

function domain(): string {
  return `gui/${process.getuid?.() ?? 501}`;
}

export function isInstalled(paths: Paths): boolean {
  return existsSync(paths.launchAgent);
}

export async function install(paths: Paths): Promise<void> {
  mkdirSync(dirname(paths.launchAgent), { recursive: true });
  mkdirSync(paths.logDir, { recursive: true });
  // 이미 등록돼 있으면 내렸다가 새 설정으로 다시 올린다 (업데이트 후 재시작 포함)
  await run(["launchctl", "bootout", `${domain()}/${LAUNCH_LABEL}`]);
  writeFileSync(paths.launchAgent, plist(paths, selfCommand()));
  const result = await run(["launchctl", "bootstrap", domain(), paths.launchAgent]);
  if (result.code !== 0) throw new Error(`launchctl bootstrap 실패: ${result.stderr.trim()}`);
}

export async function uninstall(paths: Paths): Promise<void> {
  await run(["launchctl", "bootout", `${domain()}/${LAUNCH_LABEL}`]);
  rmSync(paths.launchAgent, { force: true });
}

/** 등록돼 있으면 서버를 켜고 소켓이 생길 때까지 기다린다 (Q10). 켰으면 true */
export async function kickstart(paths: Paths, waitMs = 5000): Promise<boolean> {
  if (!isInstalled(paths)) return false;
  await run(["launchctl", "kickstart", `${domain()}/${LAUNCH_LABEL}`]);
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    if (existsSync(paths.socket)) return true;
    await Bun.sleep(100);
  }
  return false;
}
