import { mkdirSync } from "node:fs";
import { loadConfig } from "../shared/config.ts";
import { resolvePaths } from "../shared/paths.ts";
import { VERSION } from "../shared/version.ts";
import { CorgiServer } from "./app.ts";
import { listen } from "./socket.ts";

/** `corgi serve` — 상주 서버. launchd 가 띄운다 (docs/design.md §4). */
export async function serve(): Promise<void> {
  const paths = resolvePaths();
  const config = loadConfig(paths.config);
  mkdirSync(paths.stateDir, { recursive: true, mode: 0o700 });

  const server = new CorgiServer({ paths, config, drivers: [] });
  const listener = await listen(paths.socket, VERSION, server.handle);
  const timer = setInterval(() => server.tick(), 2000);

  const stop = () => {
    clearInterval(timer);
    listener.stop();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  console.error(`corgi ${VERSION} 서버 시작 — ${paths.socket}`);
}
