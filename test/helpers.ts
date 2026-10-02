import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Driver, RuntimeState, SourceDevice } from "../src/server/drivers/types.ts";
import { Config } from "../src/shared/config.ts";
import type { Device } from "../src/shared/model.ts";
import { resolvePaths } from "../src/shared/paths.ts";
import type { SessionInfo } from "../src/shared/protocol.ts";

/** 임시 상태 폴더와 짧은 소켓 경로(104바이트 제한) — 끝나면 cleanup() */
export function tempEnv() {
  const dir = mkdtempSync(join(tmpdir(), "corgi-"));
  const env = {
    HOME: dir,
    CORGI_STATE_DIR: join(dir, "state"),
    CORGI_CONFIG_DIR: join(dir, "config"),
    CORGI_LOG_DIR: join(dir, "logs"),
    CORGI_SOCKET: `/tmp/corgi-test-${process.pid}-${Math.random().toString(36).slice(2, 8)}.sock`,
  };
  return {
    env,
    paths: resolvePaths(env),
    // 슬림 전 기준값을 잴 때 기다리지 않는다
    config: Config.parse({ slimBaselineSettleSeconds: 0 }),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

export function session(key: string, extra: Partial<SessionInfo> = {}): SessionInfo {
  return { key, agent: "test-agent", cwd: "/work", human: false, ...extra };
}

export function androidDevice(id: string, name = `Android ${id}`): Device {
  return {
    id,
    name,
    native: `corgi_${id}`,
    spec: { platform: "android", widthPx: 720, heightPx: 1520, density: 320, systemImage: "x" },
    enabled: true,
    slim: "none",
    createdAt: "2026-10-02T00:00:00.000Z",
  };
}

/** 가짜 원본 — 폭(dp)만 다른 Android AVD */
export function fakeSource(native: string, widthDp: number, name = native): SourceDevice {
  return {
    platform: "android",
    native,
    name,
    spec: {
      platform: "android",
      widthPx: widthDp * 2,
      heightPx: 1520,
      density: 320,
      systemImage: "x",
    },
    detail: `${widthDp * 2}×1520px · 320dpi`,
    booted: false,
  };
}

/** 아무것도 실제로 켜지 않는 드라이버 — 켜짐 상태만 기억한다. list 를 바꾸면 원본 목록이 바뀐다 */
export function fakeDriver(
  platform: "android" | "ios" = "android",
): Driver & { booted: Set<string>; list: SourceDevice[] } {
  const booted = new Set<string>();
  const sources: SourceDevice[] = [
    fakeSource("Small_360", 360, "Small 360"),
    fakeSource("Large_412", 412, "Large 412"),
  ];
  const state = (d: Device): RuntimeState =>
    booted.has(d.id)
      ? { booted: true, targetId: `emulator-${5554 + booted.size * 2}` }
      : { booted: false };
  return {
    platform,
    booted,
    list: sources,
    missingTools: async () => [],
    sources: async () => sources,
    customSource: async (r) => ({
      ...fakeSource(
        `custom:${r.widthDp}x${r.heightDp}@${r.density}`,
        r.widthDp,
        `Android ${r.widthDp}dp`,
      ),
    }),
    create: async ({ id }) => ({ native: `corgi_${id}` }),
    rename: async () => {},
    remove: async () => {},
    states: async (devices) => new Map(devices.map((d) => [d.id, state(d)])),
    boot: async (d) => {
      booted.add(d.id);
      return state(d);
    },
    shutdown: async (d) => {
      booted.delete(d.id);
    },
    slim: async () => {},
    unslim: async () => {},
    checkSlim: async () => "applied",
    measure: async () => ({ memoryBytes: 7.8 * 1024 ** 3, processes: 167 }),
    slimStats: async (devices) =>
      new Map(
        devices
          .filter((d) => booted.has(d.id))
          .map((d) => [
            d.id,
            { disabled: 49, total: 52, unit: "패키지" as const, memoryBytes: 1.5e9, measuredAt: 0 },
          ]),
      ),
  };
}
