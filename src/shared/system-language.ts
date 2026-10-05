// macOS 의 선호 언어 — 시스템 설정 «언어 및 지역» 순서 (R25). 터미널의 LANG 은 macOS 언어와
// 다르게 잡혀 있는 경우가 많아(예: 한국어 macOS 에 en_US.UTF-8) macOS 설정을 먼저 본다.

let cached: string[] | undefined;

export function systemLanguages(env: NodeJS.ProcessEnv = process.env): string[] {
  if (cached) return cached;
  const languages: string[] = [];
  try {
    const result = Bun.spawnSync(["defaults", "read", "-g", "AppleLanguages"], {
      stdout: "pipe",
      stderr: "ignore",
    });
    if (result.exitCode === 0) {
      for (const match of result.stdout
        .toString()
        .matchAll(/"?([A-Za-z]{2,3}(?:[-_][\w-]+)?)"?,?\s*$/gm)) {
        if (match[1]) languages.push(match[1]);
      }
    }
  } catch {
    // defaults 가 없는 환경 — LANG 만 본다
  }
  for (const name of ["LC_ALL", "LC_MESSAGES", "LANG"] as const) {
    const value = env[name];
    if (value && value !== "C" && value !== "POSIX") languages.push(value);
  }
  cached = languages;
  return languages;
}
