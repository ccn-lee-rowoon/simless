import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Discovered, Driver, RuntimeState } from "../src/server/drivers/types.ts";
import type { Registry } from "../src/server/registry.ts";
import { HandlerError } from "../src/server/socket.ts";
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

const ANDROID_SPEC = {
  platform: "android",
  widthPx: 720,
  heightPx: 1520,
  density: 320,
  systemImage: "x",
} as const;

/** Corgi 가 만든 Android 디바이스 하나 (레지스트리 정보 + 기기) */
export function androidDevice(id: string, name = `Android ${id}`): Device {
  return {
    id,
    platform: "android",
    name,
    native: `corgi_${id}`,
    spec: ANDROID_SPEC,
    createdByCorgi: true,
    listed: true,
    slim: "none",
    createdAt: "2026-10-02T00:00:00.000Z",
  };
}

/** 가짜 기종 — 폭(dp)만 다르다 */
const FAKE_MODELS = [
  { id: "small-360", name: "Small 360", widthDp: 360 },
  { id: "large-412", name: "Large 412", widthDp: 412 },
];

export type FakeDriver = Driver & {
  booted: Set<string>;
  /** 이 Mac 에 있는 기기 — list() 가 돌려준다. 만들면 늘고 지우면 준다 */
  existing: Discovered[];
};

/** 아무것도 실제로 켜지 않는 드라이버 — 켜짐 상태만 기억한다 */
export function fakeDriver(platform: "android" | "ios" = "android"): FakeDriver {
  const booted = new Set<string>();
  const existing: Discovered[] = [];
  const state = (d: Device): RuntimeState =>
    booted.has(d.id)
      ? { booted: true, targetId: `emulator-${5554 + booted.size * 2}` }
      : { booted: false };
  const driver: FakeDriver = {
    platform,
    booted,
    existing,
    missingTools: async () => [],
    list: async () => [...driver.existing],
    catalog: async () => ({
      platform,
      models: FAKE_MODELS.map((m) => ({
        id: m.id,
        name: m.name,
        form: "phone",
        layoutWidth: m.widthDp,
        layoutHeight: 760,
        detail: `${m.widthDp * 2}×1520px · 320dpi`,
      })),
      os: [{ id: "image-36", name: "android-36", recommended: true }],
      custom: true,
      slimOff: [{ name: "Assistant & Search", count: 3 }],
      slimKeeps: ["Core Android OS"],
    }),
    resolve: async ({ model, custom }) => {
      if (custom) {
        return {
          spec: { ...ANDROID_SPEC, widthPx: (custom.widthDp * custom.density) / 160 },
          modelName: `Android ${custom.widthDp}dp`,
        };
      }
      const found = FAKE_MODELS.find(
        (m) => m.id === model || m.name.toLowerCase() === model?.toLowerCase(),
      );
      if (!found) throw new HandlerError("NOT_FOUND", `없는 프로필: ${model}`);
      return { spec: { ...ANDROID_SPEC, widthPx: found.widthDp * 2 }, modelName: found.name };
    },
    create: async ({ id, name, spec }) => {
      const native = `corgi_${id}`;
      driver.existing.push({ native, name, spec });
      return { native };
    },
    rename: async (device, name) => {
      const item = driver.existing.find((e) => e.native === device.native);
      if (item) item.name = name;
    },
    remove: async (device) => {
      driver.existing = driver.existing.filter((e) => e.native !== device.native);
    },
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
            {
              disabled: 49,
              total: 52,
              unit: "packages" as const,
              memoryBytes: 1.5e9,
              measuredAt: 0,
            },
          ]),
      ),
  };
  return driver;
}

/**
 * 이 Mac 에 기기를 두고 ID 를 정해 둔다 — 테스트에서 ID 로 가리키려고.
 * 원래 있던 기기(createdByCorgi false)는 기본으로 Corgi 목록에 추가된 것으로 둔다
 */
export function seedDevice(
  server: { registry: Registry },
  driver: FakeDriver,
  id: string,
  name: string,
  createdByCorgi = true,
  listed = true,
): void {
  const device = androidDevice(id, name);
  if (!createdByCorgi) device.native = `${name.replace(/\s/g, "_")}_${id}`;
  driver.existing.push({ native: device.native, name, spec: device.spec });
  server.registry.add({
    id,
    platform: "android",
    native: device.native,
    createdByCorgi,
    listed,
    slim: "none",
    createdAt: device.createdAt,
  });
}
