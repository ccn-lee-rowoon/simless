import { z } from "zod";
import type { CatalogResult, DeviceOpResult, DeviceView, PlatformCatalog } from "../shared/api.ts";
import { t } from "../shared/i18n.ts";
import type { Device, DeviceSpec, Platform } from "../shared/model.ts";
import type { SessionInfo } from "../shared/protocol.ts";
import type { CorgiServer } from "./app.ts";
import type { Progress, RuntimeState } from "./drivers/types.ts";
import { type Connection, HandlerError } from "./socket.ts";

// 디바이스 만들기·관리·켜기 (R1~R7, M1~M8). 메서드를 CorgiServer 에 붙인다.

const CreateParams = z
  .object({
    /** 비우면 기종 이름으로 찾는다 — 두 플랫폼에 다 있으면 INVALID */
    platform: z.enum(["android", "ios"]).optional(),
    /** 기종 — iOS 기기 종류 ID·이름, Android 대표 프로필 ID·이름 */
    model: z.string().min(1).optional(),
    /** 직접 입력 — Android 만 */
    custom: z
      .object({
        widthDp: z.number().positive(),
        heightDp: z.number().positive(),
        density: z.number().int().positive(),
      })
      .optional(),
    /** OS — iOS 런타임, Android 시스템 이미지. 비우면 기본값 */
    os: z.string().min(1).optional(),
    name: z.string().min(1).optional(),
    slim: z.boolean().default(true),
    /** 슬림하기 전에 한 번 켜서 기준 메모리를 잰다 — 슬림 후와 비교한다 (1~2분 더 걸림) */
    baseline: z.boolean().default(true),
  })
  .refine(
    (p) => (p.model === undefined) !== (p.custom === undefined),
    "Give either model or custom",
  );
const DeviceRef = z.object({ device: z.string() });
const RenameParams = DeviceRef.extend({ name: z.string().min(1) });
const MemoParams = DeviceRef.extend({ memo: z.string().max(500) });
const DevicesParams = z.object({ devices: z.array(z.string()).default([]) });
const SlimParams = DevicesParams.extend({ mode: z.enum(["on", "off", "check"]).default("on") });
const CatalogParams = z.object({ platform: z.enum(["android", "ios"]).optional() });

function parse<T extends z.ZodType>(schema: T, params: unknown): z.infer<T> {
  const parsed = schema.safeParse(params ?? {});
  if (!parsed.success) throw new HandlerError("INVALID", z.prettifyError(parsed.error));
  return parsed.data;
}

/** 기본 이름 — 슬림이면 `corgi <기종>`, 아니면 `<기종>` (R5·M4) */
function defaultName(modelName: string, slim: boolean): string {
  return slim ? `corgi ${modelName}` : modelName;
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
      throw new HandlerError("BUSY", t("err.busyDevice", { name: device.name }), {
        holders: view ? [{ ...view, deviceId: device.id }] : [],
      });
    }
  };

  /** Corgi 가 만든 디바이스만 — 삭제·슬림 켜고 끄기 (M7·M8·N5) */
  const guardCreated = (device: Device, what: "delete" | "slim") => {
    if (!device.createdByCorgi) {
      throw new HandlerError(
        "NOT_ALLOWED",
        t(what === "delete" ? "err.preexistingDelete" : "err.preexistingSlim", {
          name: device.name,
        }),
      );
    }
  };

  /** 켜기·끄기는 이 세션이 점유한 디바이스만 (P1). 사람은 점유 없이, 남이 쓰는 중인 것만 빼고 */
  const heldTargets = async (refs: string[], session: SessionInfo): Promise<Device[]> => {
    const held = new Set(server.leases.heldBy(session.key));
    const devices =
      refs.length > 0
        ? await server.resolve(refs)
        : (await server.devices()).filter((d) => held.has(d.id));
    if (devices.length === 0) throw new HandlerError("NOT_HELD", t("err.notHeldAny"));
    // 사람(웹 UI 등)이 직접 켜고 끄는 건 점유가 아니다 — 다른 세션이 쓰는 중인 것만 막는다
    if (session.human) {
      for (const device of devices) guardOthers(device, session);
      return devices;
    }
    const notHeld = devices.filter((d) => !held.has(d.id));
    if (notHeld.length > 0) {
      throw new HandlerError(
        "NOT_HELD",
        t("err.notHeld", { names: notHeld.map((d) => d.name).join(", ") }),
      );
    }
    return devices;
  };

  /** 작업 중에 바뀐 값(슬림 상태 등)을 반영한 최신 정보 */
  const fresh = (devices: Device[]): Device[] =>
    devices.map((d) => {
      const meta = server.registry.get(d.id);
      return meta ? { ...d, ...meta } : d;
    });

  const update = (device: Device, patch: Parameters<typeof server.registry.update>[1]): Device => ({
    ...device,
    ...server.registry.update(device.id, patch),
  });

  const applySlim = async (device: Device, progress: Progress): Promise<Device> => {
    update(device, { slim: "applying", slimError: undefined });
    try {
      await server.driver(device.spec.platform).slim(device, progress);
      return update(device, { slim: "applied", slimError: undefined });
    } catch (error) {
      return update(device, { slim: "failed", slimError: message(error) });
    }
  };

  /** 슬림 전 기준값 — 켜고, 안정될 때까지 기다리고, 재고, 끈다. 실패해도 만들기는 이어 간다 */
  const measureBaseline = async (device: Device, progress: Progress): Promise<Device> => {
    const driver = server.driver(device.spec.platform);
    let state: RuntimeState | undefined;
    try {
      progress(t("progress.baselineBoot", { name: device.name }));
      state = await driver.boot(device, progress);
      const settle = server.config.slimBaselineSettleSeconds;
      if (settle > 0) {
        progress(t("progress.baselineSettle", { seconds: settle }));
        await Bun.sleep(settle * 1000);
      }
      const measured = await driver.measure(device, state);
      const gb = measured.memoryBytes
        ? `${(measured.memoryBytes / 1024 ** 3).toFixed(1)}GB`
        : t("common.unknown");
      progress(
        t("progress.baseline", { memory: gb }) +
          (measured.processes
            ? t("progress.baselineProcesses", { count: measured.processes })
            : ""),
      );
      device = update(device, {
        slimBaseline: { ...measured, measuredAt: new Date().toISOString() },
      });
    } catch (error) {
      progress(t("progress.baselineFailed", { error: message(error).split("\n")[0] ?? "" }));
    }
    if (state?.booted) {
      progress(t("progress.shuttingDown", { name: device.name }));
      await driver.shutdown(device, state).catch(() => {});
    }
    return device;
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

  server.addMethod("catalog", async (p): Promise<CatalogResult> => {
    const { platform } = parse(CatalogParams, p);
    const platforms: PlatformCatalog[] = [];
    const problems: CatalogResult["problems"] = [];
    for (const name of ["android", "ios"] as const) {
      if (platform && platform !== name) continue;
      const driver = server.driverOrUndefined(name);
      if (!driver) continue;
      try {
        for (const tool of await driver.missingTools())
          problems.push({ platform: name, message: t("err.toolNotFound", { tool }) });
        platforms.push(await driver.catalog());
      } catch (error) {
        problems.push({ platform: name, message: message(error) });
      }
    }
    return { platforms, problems };
  });

  server.addMethod("device.list", (_p, session) => server.deviceViews(session));

  /** 기종 이름만 주면 두 플랫폼에서 찾는다 */
  const resolveModel = async (params: z.infer<typeof CreateParams>) => {
    const platforms = params.platform
      ? [params.platform]
      : params.custom
        ? (["android"] as const)
        : (["android", "ios"] as const);
    const found: { platform: Platform; spec: DeviceSpec; modelName: string }[] = [];
    let lastError: unknown;
    for (const platform of platforms) {
      const driver = server.driverOrUndefined(platform);
      if (!driver) continue;
      try {
        const resolved = await driver.resolve({
          model: params.model,
          custom: params.custom,
          os: params.os,
        });
        found.push({ platform, ...resolved });
      } catch (error) {
        lastError = error;
      }
    }
    if (found.length === 0) {
      if (lastError instanceof HandlerError) throw lastError;
      throw new HandlerError("NOT_FOUND", t("err.noModel", { model: params.model ?? "" }));
    }
    if (found.length > 1) {
      throw new HandlerError("INVALID", t("err.modelBothPlatforms", { model: params.model ?? "" }));
    }
    return found[0] as (typeof found)[number];
  };

  server.addMethod("device.create", async (p, session, connection) => {
    const params = parse(CreateParams, p);
    const { platform, spec, modelName } = await resolveModel(params);
    const all = await server.devices();
    // 같은 크기도 여러 대 만들 수 있다 — 막는 건 이름 중복뿐 (M3)
    const taken = new Set(all.map((d) => d.name.toLowerCase()));
    let name = params.name ?? defaultName(modelName, params.slim);
    if (taken.has(name.toLowerCase())) {
      if (params.name) throw new HandlerError("INVALID", t("err.nameTaken", { name }));
      const base = name;
      let n = 2;
      while (taken.has(`${base} ${n}`.toLowerCase())) n++;
      name = `${base} ${n}`;
    }

    const id = server.registry.newId();
    const progress = progressOf(connection);
    const { native } = await server.driver(platform).create({ id, name, spec }, progress);
    const meta = server.registry.add({
      id,
      platform,
      native,
      createdByCorgi: true,
      listed: true,
      slim: "none",
      createdAt: new Date().toISOString(),
    });
    // 그 플랫폼에 기본 디바이스가 없으면 처음 만든 것이 기본이 된다 (R22)
    if (!server.registry.defaults()[platform]) server.registry.setDefault(platform, id);
    server.invalidate();
    let device: Device = { ...meta, listed: true, name, spec };
    if (params.slim && params.baseline)
      device = await withLock(id, () => measureBaseline(device, progress));
    if (params.slim) device = await withLock(id, () => applySlim(device, progress));
    return view(session, device);
  });

  server.addMethod("device.rename", async (p, session) => {
    const params = parse(RenameParams, p);
    const [device] = await server.resolve([params.device]);
    if (!device) throw new HandlerError("NOT_FOUND", params.device);
    guardOthers(device, session);
    const lower = params.name.toLowerCase();
    if ((await server.devices()).some((d) => d.id !== device.id && d.name.toLowerCase() === lower))
      throw new HandlerError("INVALID", t("err.nameTaken", { name: params.name }));
    await withLock(device.id, () =>
      server.driver(device.spec.platform).rename(device, params.name),
    );
    server.invalidate();
    return view(session, { ...device, name: params.name });
  });

  /** 이 Mac 에 있지만 Corgi 목록에 없는 디바이스 — 생성 화면의 «이 Mac 의 디바이스» (M1·R20) */
  server.addMethod("device.available", async (_p, session) =>
    server.deviceViews(session, await server.available()),
  );

  /** 이 Mac 의 디바이스를 Corgi 목록에 넣는다 — 만들지도 슬림화하지도 않는다 (R20) */
  server.addMethod("device.add", async (p, session) => {
    const params = parse(DeviceRef, p);
    const lower = params.device.toLowerCase();
    const matches = (await server.available()).filter(
      (d) => d.id === params.device || d.native === params.device || d.name.toLowerCase() === lower,
    );
    if (matches.length === 0) {
      const listed = (await server.devices()).some(
        (d) =>
          d.id === params.device || d.native === params.device || d.name.toLowerCase() === lower,
      );
      throw new HandlerError(
        listed ? "INVALID" : "NOT_FOUND",
        t(listed ? "err.alreadyListed" : "err.noDevice", { ref: params.device }),
      );
    }
    if (matches.length > 1) {
      throw new HandlerError(
        "INVALID",
        t("err.ambiguousDevice", {
          list: matches.map((d) => `  ${d.id}  ${d.native}  ${d.name}`).join("\n"),
        }),
      );
    }
    const device = matches[0] as Device;
    return view(session, { ...update(device, { listed: true }), listed: true });
  });

  /** Corgi 목록에서 뺀다 — 원래 있던(추가한) 디바이스만, 기기는 그대로 (R20) */
  server.addMethod("device.unlist", async (p) => {
    const params = parse(DeviceRef, p);
    const [device] = await server.resolve([params.device]);
    if (!device) throw new HandlerError("NOT_FOUND", params.device);
    if (device.createdByCorgi)
      throw new HandlerError("NOT_ALLOWED", t("err.unlistCreated", { name: device.name }));
    server.registry.unlist(device.id);
    server.leases.forgetDevice(device.id);
    server.invalidate();
    return { unlisted: device.id };
  });

  /** 메모는 기기 상태 기록이라 누가 쓰는 중이어도 고칠 수 있다 (R24) */
  server.addMethod("device.setMemo", async (p, session) => {
    const params = parse(MemoParams, p);
    const [device] = await server.resolve([params.device]);
    if (!device) throw new HandlerError("NOT_FOUND", params.device);
    const memo = params.memo.trim();
    return view(session, update(device, { memo: memo === "" ? undefined : memo }));
  });

  server.addMethod("device.setDefault", async (p, session) => {
    const params = parse(DeviceRef, p);
    const [device] = await server.resolve([params.device]);
    if (!device) throw new HandlerError("NOT_FOUND", params.device);
    server.registry.setDefault(device.platform, device.id);
    return view(session, device);
  });

  server.addMethod("device.delete", async (p, session, connection) => {
    const params = parse(DeviceRef, p);
    const [device] = await server.resolve([params.device]);
    if (!device) throw new HandlerError("NOT_FOUND", params.device);
    guardCreated(device, "delete");
    if (server.registry.defaults()[device.platform] === device.id) {
      throw new HandlerError("NOT_ALLOWED", t("err.deleteDefault", { name: device.name }));
    }
    guardOthers(device, session);
    const driver = server.driver(device.spec.platform);
    await withLock(device.id, async () => {
      const state = (await driver.states([device])).get(device.id);
      if (state?.booted) {
        progressOf(connection)(t("progress.shuttingDown", { name: device.name }));
        await driver.shutdown(device, state);
      }
      await driver.remove(device);
    });
    server.registry.remove(device.id);
    server.leases.forgetDevice(device.id);
    server.invalidate();
    return { deleted: device.id };
  });

  server.addMethod("device.slim", async (p, session, connection) => {
    const params = parse(SlimParams, p);
    const devices =
      params.devices.length > 0
        ? await server.resolve(params.devices)
        : (await server.devices()).filter((d) => d.createdByCorgi);
    const progress = progressOf(connection);
    for (const device of devices) guardCreated(device, "slim");
    if (params.mode !== "check") for (const device of devices) guardOthers(device, session);
    const results = await forEach(devices, async (device) => {
      const driver = server.driver(device.spec.platform);
      if (params.mode === "on") {
        const updated = await applySlim(device, progress);
        if (updated.slim === "failed") throw new Error(updated.slimError);
      } else if (params.mode === "off") {
        await driver.unslim(device, progress);
        update(device, { slim: "none", slimError: undefined });
      } else {
        const state = (await driver.states([device])).get(device.id) ?? { booted: false };
        const slim = await driver.checkSlim(device, state);
        if (slim) update(device, { slim });
      }
    });
    return {
      results,
      devices: await server.deviceViews(session, fresh(devices)),
    };
  });

  server.addMethod("device.up", async (p, session, connection) => {
    const params = parse(DevicesParams, p);
    const devices = await heldTargets(params.devices, session);
    const progress = progressOf(connection);
    const results = await forEach(devices, async (device) => {
      const driver = server.driver(device.spec.platform);
      const state = await driver.boot(device, progress);
      await driver.afterBoot?.(device, state, progress);
      // 켤 때 슬림 상태를 확인하고, 풀렸으면 다시 적용한다 (M6)
      if (device.slim === "applied" || device.slim === "drifted") {
        const slim = await driver.checkSlim(device, state);
        if (slim === "drifted") await applySlim(device, progress);
        else if (slim) update(device, { slim });
      }
      progress(
        t("progress.booted", {
          name: `${device.name}${state.targetId ? ` (${state.targetId})` : ""}`,
        }),
      );
    });
    return { results, devices: await server.deviceViews(session, fresh(devices)) };
  });

  server.addMethod("device.down", async (p, session, connection) => {
    const params = parse(DevicesParams, p);
    const devices = await heldTargets(params.devices, session);
    const progress = progressOf(connection);
    const results = await forEach(devices, async (device) => {
      const driver = server.driver(device.spec.platform);
      const state = (await driver.states([device])).get(device.id);
      if (state?.booted) {
        progress(t("progress.shuttingDown", { name: device.name }));
        await driver.shutdown(device, state);
      }
    });
    return { results, devices: await server.deviceViews(session, fresh(devices)) };
  });
}

/** 서버가 켜질 때 — 켜져 있는 디바이스의 슬림 상태를 확인한다 (M6) */
export async function checkBootedSlim(server: CorgiServer): Promise<void> {
  const devices = (await server.devices()).filter((d) => d.createdByCorgi && d.slim !== "none");
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
