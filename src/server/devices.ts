import { z } from "zod";
import type { CatalogEntry, CatalogResult, DeviceOpResult, DeviceView } from "../shared/api.ts";
import { type Device, type DeviceSpec, layoutWidth, sizeLabel } from "../shared/model.ts";
import type { SessionInfo } from "../shared/protocol.ts";
import type { CorgiServer } from "./app.ts";
import type { CreateRequest, Progress } from "./drivers/types.ts";
import { type Connection, HandlerError } from "./socket.ts";

// 디바이스 만들기·관리·켜기 (R1~R7, M1~M8). 메서드를 CorgiServer 에 붙인다.

const CreateParams = z.object({
  request: z.discriminatedUnion("platform", [
    z.object({
      platform: z.literal("android"),
      widthDp: z.number().positive(),
      heightDp: z.number().positive().optional(),
      density: z.number().int().positive().optional(),
      systemImage: z.string().optional(),
    }),
    z.object({
      platform: z.literal("ios"),
      deviceType: z.string(),
      runtime: z.string().optional(),
    }),
  ]),
  name: z.string().min(1).optional(),
  slim: z.boolean().default(true),
});
const DeviceRef = z.object({ device: z.string() });
const RenameParams = DeviceRef.extend({ name: z.string().min(1) });
const EnableParams = DeviceRef.extend({ enabled: z.boolean() });
const DevicesParams = z.object({ devices: z.array(z.string()).default([]) });
const SlimParams = DevicesParams.extend({ mode: z.enum(["on", "off", "check"]).default("on") });
const CatalogParams = z.object({ platform: z.enum(["android", "ios"]).optional() });

function parse<T extends z.ZodType>(schema: T, params: unknown): z.infer<T> {
  const parsed = schema.safeParse(params ?? {});
  if (!parsed.success) throw new HandlerError("INVALID", z.prettifyError(parsed.error));
  return parsed.data;
}

/** 같은 크기·이미지(또는 기기 종류·런타임)면 같은 항목 (M3) */
export function specKey(spec: DeviceSpec): string {
  return spec.platform === "android"
    ? `android:${spec.widthPx}x${spec.heightPx}@${spec.density}:${spec.systemImage}`
    : `ios:${spec.deviceTypeId}:${spec.runtimeId}`;
}

function defaultName(spec: DeviceSpec): string {
  return spec.platform === "android"
    ? `Android ${Math.round(layoutWidth(spec) * 100) / 100}dp`
    : `${spec.deviceTypeName} ${spec.widthPt}pt`;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function registerDeviceMethods(server: CorgiServer): void {
  const locks = new Map<string, Promise<unknown>>();

  /** 같은 디바이스에 대한 작업은 한 번에 하나씩 */
  const withLock = <T>(id: string, fn: () => Promise<T>): Promise<T> => {
    const next = (locks.get(id) ?? Promise.resolve()).then(fn, fn);
    locks.set(
      id,
      next.catch(() => {}),
    );
    return next;
  };

  const progressOf =
    (connection: Connection): Progress =>
    (text) =>
      connection.emit("progress", { message: text });

  /** 다른 세션이 쓰는 중이면 막는다 (M8·P1) */
  const guardOthers = (device: Device, session: SessionInfo) => {
    const holder = server.leases.holderOf(device.id);
    if (holder && holder.key !== session.key) {
      const lease = server.leases.snapshot().leases.find((l) => l.deviceId === device.id);
      const view = server.holderView({
        deviceId: device.id,
        session: holder,
        since: lease?.acquiredAt ?? 0,
        reason: "held",
      });
      throw new HandlerError("BUSY", `다른 세션이 사용 중입니다: ${device.name}`, {
        holders: view ? [{ ...view, deviceId: device.id }] : [],
      });
    }
  };

  /** 켜기·끄기는 이 세션이 점유한 디바이스만 (P1) */
  const heldTargets = (refs: string[], session: SessionInfo): Device[] => {
    const held = new Set(server.leases.heldBy(session.key));
    const devices =
      refs.length > 0 ? server.resolve(refs) : server.registry.list().filter((d) => held.has(d.id));
    if (devices.length === 0)
      throw new HandlerError(
        "NOT_HELD",
        "점유한 디바이스가 없습니다 — corgi use 로 점유하고 켜세요",
      );
    const notHeld = devices.filter((d) => !held.has(d.id));
    if (notHeld.length > 0) {
      throw new HandlerError(
        "NOT_HELD",
        `점유하지 않은 디바이스: ${notHeld.map((d) => d.name).join(", ")} — corgi use 로 점유하세요`,
      );
    }
    return devices;
  };

  /** 작업 중에 바뀐 값(슬림 상태 등)을 반영한 최신 레지스트리 항목 */
  const fresh = (devices: Device[]): Device[] => devices.map((d) => server.registry.get(d.id) ?? d);

  const applySlim = async (device: Device, progress: Progress): Promise<Device> => {
    server.registry.update(device.id, { slim: "applying", slimError: undefined });
    try {
      await server.driver(device.spec.platform).slim(device, progress);
      return server.registry.update(device.id, { slim: "applied", slimError: undefined });
    } catch (error) {
      return server.registry.update(device.id, { slim: "failed", slimError: message(error) });
    }
  };

  const view = async (session: SessionInfo, device: Device): Promise<DeviceView> => {
    const [result] = await server.deviceViews(session, [device]);
    if (!result) throw new HandlerError("NOT_FOUND", device.id);
    return result;
  };

  /** 여러 대를 한꺼번에 — 하나가 실패해도 나머지는 계속한다 */
  const forEach = async (
    devices: Device[],
    fn: (device: Device) => Promise<void>,
  ): Promise<DeviceOpResult[]> =>
    Promise.all(
      devices.map((device) =>
        withLock(device.id, () => fn(device)).then(
          () => ({ id: device.id, name: device.name, ok: true }),
          (error: unknown) => ({
            id: device.id,
            name: device.name,
            ok: false,
            error: message(error),
          }),
        ),
      ),
    );

  server.addMethod("catalog.list", async (p): Promise<CatalogResult> => {
    const { platform } = parse(CatalogParams, p);
    const created = new Map(server.registry.list().map((d) => [specKey(d.spec), d.id]));
    const items: CatalogEntry[] = [];
    const problems: CatalogResult["problems"] = [];
    for (const name of ["android", "ios"] as const) {
      if (platform && platform !== name) continue;
      try {
        const driver = server.driver(name);
        for (const tool of await driver.missingTools())
          problems.push({ platform: name, message: `${tool} 없음` });
        for (const item of await driver.catalog()) {
          items.push({
            ...item,
            label: sizeLabel(item.spec),
            layoutWidth: layoutWidth(item.spec),
            created: created.get(specKey(item.spec)),
          });
        }
      } catch (error) {
        problems.push({ platform: name, message: message(error) });
      }
    }
    items.sort((a, b) => a.platform.localeCompare(b.platform) || a.layoutWidth - b.layoutWidth);
    return { items, problems };
  });

  server.addMethod("device.list", (_p, session) => server.deviceViews(session));

  server.addMethod("device.create", async (p, session, connection) => {
    const params = parse(CreateParams, p);
    const driver = server.driver(params.request.platform);
    const spec = await driver.resolveSpec(params.request as CreateRequest);
    const existing = server.registry.list().find((d) => specKey(d.spec) === specKey(spec));
    if (existing)
      throw new HandlerError(
        "INVALID",
        `이미 만든 디바이스입니다: ${existing.id} ${existing.name}`,
      );

    let name = params.name ?? defaultName(spec);
    if (server.registry.find(name)) {
      if (params.name) throw new HandlerError("INVALID", `이미 쓰는 이름입니다: ${name}`);
      const base = name;
      let n = 2;
      while (server.registry.find(`${base} ${n}`)) n++;
      name = `${base} ${n}`;
    }

    const id = server.registry.newId();
    const progress = progressOf(connection);
    const { native } = await driver.create({ id, name, spec }, progress);
    let device: Device = {
      id,
      name,
      native,
      spec,
      enabled: true,
      slim: "none",
      createdAt: new Date().toISOString(),
    };
    server.registry.add(device);
    if (params.slim) device = await withLock(id, () => applySlim(device, progress));
    return view(session, device);
  });

  server.addMethod("device.rename", async (p, session) => {
    const params = parse(RenameParams, p);
    const [device] = server.resolve([params.device]);
    if (!device) throw new HandlerError("NOT_FOUND", params.device);
    guardOthers(device, session);
    const other = server.registry.find(params.name);
    if (other && other.id !== device.id)
      throw new HandlerError("INVALID", `이미 쓰는 이름입니다: ${params.name}`);
    await withLock(device.id, () =>
      server.driver(device.spec.platform).rename(device, params.name),
    );
    return view(session, server.registry.update(device.id, { name: params.name }));
  });

  server.addMethod("device.setEnabled", async (p, session) => {
    const params = parse(EnableParams, p);
    const [device] = server.resolve([params.device]);
    if (!device) throw new HandlerError("NOT_FOUND", params.device);
    return view(session, server.registry.update(device.id, { enabled: params.enabled }));
  });

  server.addMethod("device.delete", async (p, session, connection) => {
    const params = parse(DeviceRef, p);
    const [device] = server.resolve([params.device]);
    if (!device) throw new HandlerError("NOT_FOUND", params.device);
    guardOthers(device, session);
    const driver = server.driver(device.spec.platform);
    await withLock(device.id, async () => {
      const state = (await driver.states([device])).get(device.id);
      if (state?.booted) {
        progressOf(connection)(`끄는 중: ${device.name}`);
        await driver.shutdown(device, state);
      }
      await driver.remove(device);
    });
    server.registry.remove(device.id);
    server.leases.release(session.key, [device.id]);
    return { deleted: device.id };
  });

  server.addMethod("device.slim", async (p, session, connection) => {
    const params = parse(SlimParams, p);
    const devices =
      params.devices.length > 0 ? server.resolve(params.devices) : server.registry.list();
    const progress = progressOf(connection);
    if (params.mode !== "check") for (const device of devices) guardOthers(device, session);
    const results = await forEach(devices, async (device) => {
      const driver = server.driver(device.spec.platform);
      if (params.mode === "on") {
        const updated = await applySlim(device, progress);
        if (updated.slim === "failed") throw new Error(updated.slimError);
      } else if (params.mode === "off") {
        await driver.unslim(device, progress);
        server.registry.update(device.id, { slim: "none", slimError: undefined });
      } else {
        const state = (await driver.states([device])).get(device.id) ?? { booted: false };
        const slim = await driver.checkSlim(device, state);
        if (slim) server.registry.update(device.id, { slim });
      }
    });
    return {
      results,
      devices: await server.deviceViews(session, fresh(devices)),
    };
  });

  server.addMethod("device.up", async (p, session, connection) => {
    const params = parse(DevicesParams, p);
    const devices = heldTargets(params.devices, session);
    const progress = progressOf(connection);
    const results = await forEach(devices, async (device) => {
      const driver = server.driver(device.spec.platform);
      const state = await driver.boot(device, progress);
      await driver.afterBoot?.(device, state, progress);
      // 켤 때 슬림 상태를 확인하고, 풀렸으면 다시 적용한다 (M6)
      if (device.slim === "applied" || device.slim === "drifted") {
        const slim = await driver.checkSlim(device, state);
        if (slim === "drifted") await applySlim(device, progress);
        else if (slim) server.registry.update(device.id, { slim });
      }
      progress(`켜짐: ${device.name}${state.targetId ? ` (${state.targetId})` : ""}`);
    });
    return { results, devices: await server.deviceViews(session, fresh(devices)) };
  });

  server.addMethod("device.down", async (p, session, connection) => {
    const params = parse(DevicesParams, p);
    const devices = heldTargets(params.devices, session);
    const progress = progressOf(connection);
    const results = await forEach(devices, async (device) => {
      const driver = server.driver(device.spec.platform);
      const state = (await driver.states([device])).get(device.id);
      if (state?.booted) {
        progress(`끄는 중: ${device.name}`);
        await driver.shutdown(device, state);
      }
    });
    return { results, devices: await server.deviceViews(session, fresh(devices)) };
  });
}

/** 서버가 켜질 때 — 켜져 있는 디바이스의 슬림 상태를 확인한다 (M6) */
export async function checkBootedSlim(server: CorgiServer): Promise<void> {
  const devices = server.registry.list();
  const states = await server.runtimeStates(devices);
  for (const device of devices) {
    const state = states.get(device.id);
    if (!state?.booted) continue;
    const slim = await server
      .driver(device.spec.platform)
      .checkSlim(device, state)
      .catch(() => undefined);
    if (slim && slim !== device.slim) server.registry.update(device.id, { slim });
  }
}
