import { z } from "zod";
import type { DeviceOpResult, DeviceView, SourceEntry, SourceListResult } from "../shared/api.ts";
import { type Device, type DeviceSpec, layoutWidth, sizeLabel } from "../shared/model.ts";
import type { SessionInfo } from "../shared/protocol.ts";
import type { CorgiServer } from "./app.ts";
import type { Progress, RuntimeState, SourceDevice } from "./drivers/types.ts";
import { type Connection, HandlerError } from "./socket.ts";

// 디바이스 만들기·관리·켜기 (R1~R7, M1~M8). 메서드를 CorgiServer 에 붙인다.

const CreateParams = z
  .object({
    /** 원본 — AVD ID·UDID·대표 프로필 ID(`profile:…`) 또는 이름 */
    source: z.string().min(1).optional(),
    /** 직접 입력 — Android 만 */
    custom: z
      .object({
        widthDp: z.number().positive(),
        heightDp: z.number().positive(),
        density: z.number().int().positive(),
        systemImage: z.string().optional(),
      })
      .optional(),
    name: z.string().min(1).optional(),
    slim: z.boolean().default(true),
    /** 슬림하기 전에 한 번 켜서 기준 메모리를 잰다 — 슬림 후와 비교한다 (1~2분 더 걸림) */
    baseline: z.boolean().default(true),
  })
  .refine(
    (p) => (p.source === undefined) !== (p.custom === undefined),
    "source 와 custom 중 하나만 주세요",
  );
const DeviceRef = z.object({ device: z.string() });
const RenameParams = DeviceRef.extend({ name: z.string().min(1) });
const DevicesParams = z.object({ devices: z.array(z.string()).default([]) });
const SlimParams = DevicesParams.extend({ mode: z.enum(["on", "off", "check"]).default("on") });
const SourceParams = z.object({ platform: z.enum(["android", "ios"]).optional() });

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

/** 기본 이름 — `corgi <원본 이름>` (M4) */
function defaultName(source: SourceDevice): string {
  return `corgi ${source.name}`;
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

  /** Corgi 가 만든 디바이스만 — 삭제·슬림 켜고 끄기 (M7·M8·N5) */
  const guardCreated = (device: Device, what: string) => {
    if (!device.createdByCorgi) {
      throw new HandlerError(
        "NOT_ALLOWED",
        `${device.name} 은 이 Mac 에 원래 있던 디바이스라 ${what}할 수 없습니다 — Corgi 가 만든 디바이스만 됩니다`,
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
    if (devices.length === 0)
      throw new HandlerError(
        "NOT_HELD",
        "점유한 디바이스가 없습니다 — corgi use 로 점유하고 켜세요",
      );
    // 사람(웹 UI 등)이 직접 켜고 끄는 건 점유가 아니다 — 다른 세션이 쓰는 중인 것만 막는다
    if (session.human) {
      for (const device of devices) guardOthers(device, session);
      return devices;
    }
    const notHeld = devices.filter((d) => !held.has(d.id));
    if (notHeld.length > 0) {
      throw new HandlerError(
        "NOT_HELD",
        `점유하지 않은 디바이스: ${notHeld.map((d) => d.name).join(", ")} — corgi use 로 점유하세요`,
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
      progress(`슬림 전 기준값 측정 — 켜는 중: ${device.name}`);
      state = await driver.boot(device, progress);
      const settle = server.config.slimBaselineSettleSeconds;
      if (settle > 0) {
        progress(`백그라운드 서비스가 다 뜰 때까지 ${settle}초 기다립니다`);
        await Bun.sleep(settle * 1000);
      }
      const measured = await driver.measure(device, state);
      const gb = measured.memoryBytes
        ? `${(measured.memoryBytes / 1024 ** 3).toFixed(1)}GB`
        : "알 수 없음";
      progress(
        `기준값: 메모리 ${gb}${measured.processes ? ` · 프로세스 ${measured.processes}` : ""}`,
      );
      device = update(device, {
        slimBaseline: { ...measured, measuredAt: new Date().toISOString() },
      });
    } catch (error) {
      progress(`기준값 측정 실패 — 건너뜁니다: ${message(error).split("\n")[0]}`);
    }
    if (state?.booted) {
      progress(`끄는 중: ${device.name}`);
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

  /** 이 Mac 의 디바이스 — 플랫폼별로 모은다. 도구가 없거나 실패한 플랫폼은 problems 로 */
  const allSources = async (platform?: "android" | "ios") => {
    const sources: SourceDevice[] = [];
    const presets: SourceDevice[] = [];
    const problems: SourceListResult["problems"] = [];
    for (const name of ["android", "ios"] as const) {
      if (platform && platform !== name) continue;
      try {
        const driver = server.driver(name);
        for (const tool of await driver.missingTools())
          problems.push({ platform: name, message: `${tool} 없음` });
        sources.push(...(await driver.sources()));
        presets.push(...((await driver.presetSources?.()) ?? []));
      } catch (error) {
        problems.push({ platform: name, message: message(error) });
      }
    }
    return { sources, presets, problems };
  };

  server.addMethod("source.list", async (p): Promise<SourceListResult> => {
    const { platform } = parse(SourceParams, p);
    const { sources, presets, problems } = await allSources(platform);
    const devices = (await server.devices()).filter((d) => d.createdByCorgi);
    const created = new Map(devices.map((d) => [specKey(d.spec), d.id]));
    const items: SourceEntry[] = [
      ...sources.map((s) => ({ s, kind: "device" as const })),
      ...presets.map((s) => ({ s, kind: "profile" as const })),
    ].map(({ s: source, kind }) => {
      const managed = devices.find((d) => d.native === source.native)?.id;
      return {
        ...source,
        kind,
        label: sizeLabel(source.spec),
        layoutWidth: layoutWidth(source.spec),
        managed,
        created: managed ? undefined : created.get(specKey(source.spec)),
      };
    });
    items.sort(
      (a, b) =>
        a.platform.localeCompare(b.platform) ||
        a.layoutWidth - b.layoutWidth ||
        a.name.localeCompare(b.name),
    );
    const androidImages =
      platform === "ios" ? [] : (server.driverOrUndefined("android")?.images?.() ?? []);
    return { items, problems, androidImages };
  });

  server.addMethod("device.list", (_p, session) => server.deviceViews(session));

  server.addMethod("device.create", async (p, session, connection) => {
    const params = parse(CreateParams, p);
    const { sources, presets } = await allSources();
    const all = await server.devices();
    const corgiNatives = new Set(all.filter((d) => d.createdByCorgi).map((d) => d.native));
    // 원본은 Corgi 가 만든 것이 아닌 이 Mac 의 디바이스 (슬림된 것을 원본으로 쓰는 건 나중에 — L4)
    const candidates = [...sources, ...presets].filter((s) => !corgiNatives.has(s.native));
    const wanted = (params.source ?? "").toLowerCase();
    const exact = candidates.filter((s) => s.native.toLowerCase() === wanted);
    const byName = candidates.filter((s) => s.name.toLowerCase() === wanted);
    const matches = exact.length > 0 ? exact : byName;
    const wantedLower = params.source?.toLowerCase();
    if (
      wantedLower &&
      all.some(
        (d) =>
          d.createdByCorgi &&
          (d.id === params.source ||
            d.native === params.source ||
            d.name.toLowerCase() === wantedLower),
      )
    ) {
      throw new HandlerError(
        "INVALID",
        "Corgi 가 만든 디바이스는 원본으로 쓸 수 없습니다 — corgi list --all 에서 원본을 고르세요",
      );
    }
    if (params.custom) {
      const android = server.driver("android");
      if (!android.customSource) throw new HandlerError("INVALID", "직접 입력은 Android 만 됩니다");
      matches.splice(0, matches.length, await android.customSource(params.custom));
    }
    if (matches.length === 0)
      throw new HandlerError("NOT_FOUND", `없는 원본: ${params.source} — corgi list --all`);
    if (matches.length > 1) {
      throw new HandlerError(
        "INVALID",
        `같은 이름의 원본이 여럿입니다 — ID 로 고르세요:\n${matches.map((m) => `  ${m.native}  ${m.detail}`).join("\n")}`,
      );
    }
    const source = matches[0] as SourceDevice;
    // 같은 크기도 여러 대 만들 수 있다 — 막는 건 이름 중복뿐 (M3)
    const taken = new Set(all.map((d) => d.name.toLowerCase()));
    let name = params.name ?? defaultName(source);
    if (taken.has(name.toLowerCase())) {
      if (params.name) throw new HandlerError("INVALID", `이미 쓰는 이름입니다: ${name}`);
      const base = name;
      let n = 2;
      while (taken.has(`${base} ${n}`.toLowerCase())) n++;
      name = `${base} ${n}`;
    }

    const id = server.registry.newId();
    const progress = progressOf(connection);
    const driver = server.driver(source.platform);
    const { native } = await driver.create({ id, name, source }, progress);
    const meta = server.registry.add({
      id,
      platform: source.platform,
      native,
      createdByCorgi: true,
      slim: "none",
      createdAt: new Date().toISOString(),
    });
    server.invalidate();
    let device: Device = { ...meta, name, spec: source.spec };
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
      throw new HandlerError("INVALID", `이미 쓰는 이름입니다: ${params.name}`);
    await withLock(device.id, () =>
      server.driver(device.spec.platform).rename(device, params.name),
    );
    server.invalidate();
    return view(session, { ...device, name: params.name });
  });

  server.addMethod("device.delete", async (p, session, connection) => {
    const params = parse(DeviceRef, p);
    const [device] = await server.resolve([params.device]);
    if (!device) throw new HandlerError("NOT_FOUND", params.device);
    guardCreated(device, "삭제");
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
    for (const device of devices) guardCreated(device, "슬림 설정");
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
      progress(`켜짐: ${device.name}${state.targetId ? ` (${state.targetId})` : ""}`);
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
        progress(`끄는 중: ${device.name}`);
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
