import { mkdirSync } from "node:fs";
import { loadConfig } from "../shared/config.ts";
import { resolvePaths } from "../shared/paths.ts";
import { systemLanguages } from "../shared/system-language.ts";
import { VERSION } from "../shared/version.ts";
import { CorgiServer } from "./app.ts";
import { checkBootedSlim } from "./devices.ts";
import { AndroidDriver } from "./drivers/android.ts";
import { IosDriver } from "./drivers/ios.ts";
import { ensureToken, startHttp } from "./http.ts";
import { listen } from "./socket.ts";

/** `corgi serve` — 상주 서버. launchd 가 띄운다 (docs/design.md §4). */
export async function serve(): Promise<void> {
  const paths = resolvePaths();
  const config = loadConfig(paths.config);
  mkdirSync(paths.stateDir, { recursive: true, mode: 0o700 });

  const drivers = [new AndroidDriver(config, { logDir: paths.logDir }), new IosDriver(config)];
  const server = new CorgiServer({ paths, config, drivers, systemLanguages });
  const listener = await listen(paths.socket, VERSION, server.handle);
  const timer = setInterval(() => server.tick(), 2000);
  // 웹 UI — 포트를 못 열어도 소켓(CLI·훅)은 계속 돈다
  let http: ReturnType<typeof startHttp> | undefined;
  try {
    http = startHttp(server, { port: config.httpPort, token: ensureToken(paths.webToken) });
    console.error(`웹 UI: http://127.0.0.1:${http.port} (corgi ui 로 연다)`);
  } catch (error) {
    console.error(`웹 UI 를 열지 못했습니다 (포트 ${config.httpPort}): ${String(error)}`);
  }

  const stop = () => {
    clearInterval(timer);
    http?.stop(true);
    listener.stop();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  console.error(`corgi ${VERSION} 서버 시작 — ${paths.socket}`);
  void checkBootedSlim(server).catch((error: unknown) =>
    console.error(`슬림 확인 실패: ${String(error)}`),
  );
}
