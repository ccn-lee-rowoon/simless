import type { CatalogModel, PlatformCatalog, SlimCategory, SlimStats } from "../../shared/api.ts";
import type { Config } from "../../shared/config.ts";
import { run as defaultRun, type Runner, runOk, which } from "../../shared/exec.ts";
import { t } from "../../shared/i18n.ts";
import type { Device, DeviceSpec, SlimState } from "../../shared/model.ts";
import { HandlerError } from "../socket.ts";
import type { Discovered, Driver, ModelRequest, Progress, RuntimeState } from "./types.ts";

// iOS 시뮬레이터 — simctl 로 만들고 켜고, simslim 으로 슬림화한다 (docs/design.md §9).
// 화면 크기는 기기 종류로 정해지고 바꿀 수 없다.

interface SimDeviceType {
  identifier: string;
  name: string;
  productFamily: string;
  bundlePath: string;
}

interface SimRuntime {
  identifier: string;
  name: string;
  version: string;
  platform: string;
  isAvailable: boolean;
  supportedDeviceTypes: { identifier: string; name: string }[];
}

interface SimDevice {
  udid: string;
  name: string;
  state: string;
}

interface ScreenProfile {
  widthPt: number;
  heightPt: number;
  scale: number;
}

const SLIM_TIMEOUT_MS = 15 * 60_000;
const BOOT_TIMEOUT_MS = 10 * 60_000;

const UNITS: Record<string, number> = { KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3 };

export function parseSimslimMeasure(text: string): { memoryBytes?: number; processes?: number } {
  const processes = /(\d+)\s+processes/.exec(text)?.[1];
  const memory = /([\d.]+)\s*(KB|MB|GB)\s+memory/.exec(text);
  return {
    processes: processes ? Number(processes) : undefined,
    memoryBytes: memory?.[1] && memory[2] ? Number(memory[1]) * (UNITS[memory[2]] ?? 1) : undefined,
  };
}

/** «26.5» 와 «26.10» 을 숫자로 비교한다 */
function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * `simslim profiles` 출력 — 묶음마다 «<ID>  <이름>» 줄, 그 아래 «When disabled: …»,
 * 늘 켜 두는 데몬은 «Always on: <라벨> — <이유>».
 */
export function parseSimslimProfiles(text: string): { off: SlimCategory[]; keeps: string[] } {
  const off: SlimCategory[] = [];
  const keeps: string[] = [];
  for (const line of text.split("\n")) {
    const head = /^(\S+)\s{2,}(\S.*)$/.exec(line);
    if (head?.[2]) {
      off.push({ name: head[2].trim() });
      continue;
    }
    const disabled = /^\s+When disabled:\s*(.+)$/.exec(line);
    const last = off.at(-1);
    if (disabled?.[1] && last) last.detail = disabled[1].trim();
    const always = /^\s+Always on:\s*\S+\s+—\s*(.+)$/.exec(line);
    if (always?.[1]) keeps.push(always[1].trim());
  }
  return { off, keeps };
}

export class IosDriver implements Driver {
  readonly platform = "ios" as const;
  private readonly profiles = new Map<string, ScreenProfile>();
  /** 여러 대를 동시에 켜면 중단 오류가 났다 — 한 대씩 켠다 (HANDOFF 실측) */
  private bootChain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly config: Config,
    private readonly runner: Runner = defaultRun,
    private readonly simslimPath: () => string | undefined = () => which("simslim"),
  ) {}

  private simctl(...args: string[]) {
    return ["xcrun", "simctl", ...args];
  }

  async missingTools(): Promise<string[]> {
    const missing: string[] = [];
    if ((await this.runner(this.simctl("help"))).code !== 0) missing.push("xcrun simctl (Xcode)");
    if (!this.simslimPath()) missing.push("simslim");
    return missing;
  }

  private async listJson<T>(kind: string): Promise<T> {
    return JSON.parse(await runOk(this.runner, this.simctl("list", "-j", kind)))[kind] as T;
  }

  private async profile(deviceType: SimDeviceType): Promise<ScreenProfile> {
    const cached = this.profiles.get(deviceType.identifier);
    if (cached) return cached;
    const plist = `${deviceType.bundlePath}/Contents/Resources/profile.plist`;
    const json = JSON.parse(
      await runOk(this.runner, ["plutil", "-convert", "json", "-o", "-", plist]),
    ) as {
      mainScreenWidth: number;
      mainScreenHeight: number;
      mainScreenScale: number;
    };
    const profile = {
      widthPt: json.mainScreenWidth / json.mainScreenScale,
      heightPt: json.mainScreenHeight / json.mainScreenScale,
      scale: json.mainScreenScale,
    };
    this.profiles.set(deviceType.identifier, profile);
    return profile;
  }

  private async spec(deviceType: SimDeviceType, runtime: SimRuntime): Promise<DeviceSpec> {
    return {
      platform: "ios",
      deviceTypeId: deviceType.identifier,
      deviceTypeName: deviceType.name,
      runtimeId: runtime.identifier,
      runtimeName: runtime.name,
      ...(await this.profile(deviceType)),
    };
  }

  private catalogCache?: { at: number; deviceTypes: SimDeviceType[]; runtimes: SimRuntime[] };

  /** 기기 종류·런타임은 Xcode 를 바꿀 때만 바뀐다 — 1분 동안 다시 읽지 않는다 */
  private async simCatalog(): Promise<{ deviceTypes: SimDeviceType[]; runtimes: SimRuntime[] }> {
    if (this.catalogCache && Date.now() - this.catalogCache.at < 60_000) return this.catalogCache;
    const [deviceTypes, runtimes] = await Promise.all([
      this.listJson<SimDeviceType[]>("devicetypes"),
      this.listJson<SimRuntime[]>("runtimes"),
    ]);
    this.catalogCache = { at: Date.now(), deviceTypes, runtimes };
    return this.catalogCache;
  }

  /** 이 Mac 의 iPhone·iPad 시뮬레이터 (워치·TV·쓸 수 없는 것은 뺀다). 크기는 기기 종류가 정한다 */
  private async simulators() {
    const [{ deviceTypes, runtimes }, devices] = await Promise.all([
      this.simCatalog(),
      this.listJson<
        Record<string, (SimDevice & { isAvailable: boolean; deviceTypeIdentifier: string })[]>
      >("devices"),
    ]);
    const typeById = new Map(deviceTypes.map((t) => [t.identifier, t]));
    const runtimeById = new Map(runtimes.map((r) => [r.identifier, r]));
    const result: {
      sim: SimDevice;
      deviceType: SimDeviceType;
      runtime: SimRuntime;
      spec: Extract<DeviceSpec, { platform: "ios" }>;
    }[] = [];
    for (const [runtimeId, sims] of Object.entries(devices)) {
      const runtime = runtimeById.get(runtimeId);
      if (runtime?.platform !== "iOS" || !runtime.isAvailable) continue;
      for (const sim of sims) {
        const deviceType = typeById.get(sim.deviceTypeIdentifier);
        if (!sim.isAvailable || !deviceType) continue;
        if (deviceType.productFamily !== "iPhone" && deviceType.productFamily !== "iPad") continue;
        const spec = await this.spec(deviceType, runtime);
        if (spec.platform !== "ios") continue;
        result.push({ sim, deviceType, runtime, spec });
      }
    }
    return result;
  }

  async list(): Promise<Discovered[]> {
    return (await this.simulators()).map(({ sim, spec }) => ({
      native: sim.udid,
      name: sim.name,
      spec,
    }));
  }

  /** iPhone·iPad 이고 쓸 수 있는 iOS 런타임 — 최신 먼저 */
  private async iosRuntimes(): Promise<SimRuntime[]> {
    const { runtimes } = await this.simCatalog();
    return runtimes
      .filter((r) => r.platform === "iOS" && r.isAvailable)
      .sort((a, b) => compareVersions(b.version, a.version));
  }

  async catalog(): Promise<PlatformCatalog> {
    const [{ deviceTypes }, runtimes] = await Promise.all([this.simCatalog(), this.iosRuntimes()]);
    const models: CatalogModel[] = [];
    for (const type of deviceTypes) {
      if (type.productFamily !== "iPhone" && type.productFamily !== "iPad") continue;
      const os = runtimes
        .filter((r) => r.supportedDeviceTypes.some((t) => t.identifier === type.identifier))
        .map((r) => r.identifier);
      if (os.length === 0) continue;
      const profile = await this.profile(type);
      models.push({
        id: type.identifier,
        name: type.name,
        form: type.productFamily === "iPad" ? "tablet" : "phone",
        layoutWidth: profile.widthPt,
        layoutHeight: profile.heightPt,
        detail: `${profile.widthPt * profile.scale}×${profile.heightPt * profile.scale}px @${profile.scale}x`,
        os,
      });
    }
    const slim = await this.slimCategories();
    return {
      platform: "ios",
      models,
      os: runtimes.map((r, i) => ({ id: r.identifier, name: r.name, recommended: i === 0 })),
      custom: false,
      slimOff: slim.off,
      slimKeeps: slim.keeps,
    };
  }

  private slimCache?: { off: SlimCategory[]; keeps: string[] };

  /** `simslim profiles` — 묶음 ID·이름 줄 뒤에 «When disabled: …» 설명이 온다 */
  private async slimCategories(): Promise<{ off: SlimCategory[]; keeps: string[] }> {
    if (this.slimCache) return this.slimCache;
    const path = this.simslimPath();
    if (!path) return { off: [], keeps: [] };
    const result = await this.runner([path, "profiles"]);
    if (result.code !== 0) return { off: [], keeps: [] };
    this.slimCache = parseSimslimProfiles(result.stdout);
    return this.slimCache;
  }

  async resolve(request: ModelRequest): Promise<{ spec: DeviceSpec; modelName: string }> {
    if (request.custom) throw new HandlerError("INVALID", t("err.iosCustom"));
    const [{ deviceTypes }, runtimes] = await Promise.all([this.simCatalog(), this.iosRuntimes()]);
    const wanted = (request.model ?? "").toLowerCase();
    const type = deviceTypes.find(
      (t) =>
        (t.productFamily === "iPhone" || t.productFamily === "iPad") &&
        (t.identifier.toLowerCase() === wanted || t.name.toLowerCase() === wanted),
    );
    if (!type)
      throw new HandlerError("NOT_FOUND", t("err.noDeviceType", { model: request.model ?? "" }));
    const supported = runtimes.filter((r) =>
      r.supportedDeviceTypes.some((t) => t.identifier === type.identifier),
    );
    const os = request.os?.toLowerCase();
    const runtime = os
      ? runtimes.find(
          (r) =>
            r.identifier.toLowerCase() === os ||
            r.name.toLowerCase() === os ||
            r.version === request.os,
        )
      : supported[0];
    if (!runtime) {
      throw new HandlerError(
        "NOT_FOUND",
        os
          ? t("err.noRuntime", { os: request.os ?? "" })
          : t("err.noRuntimeFor", { model: type.name }),
      );
    }
    if (!supported.includes(runtime))
      throw new HandlerError(
        "INVALID",
        t("err.runtimeUnsupported", { runtime: runtime.name, model: type.name }),
      );
    return { spec: await this.spec(type, runtime), modelName: type.name };
  }

  /**
   * 기기 종류·런타임으로 새로 만든다. `simctl clone` 은 원본의 앱·데이터가 따라오고
   * 원본이 꺼져 있어야 해서 쓰지 않는다 (requirements «결정 기록»).
   */
  async create(
    input: { name: string; spec: DeviceSpec },
    progress: Progress,
  ): Promise<{ native: string }> {
    const { spec } = input;
    if (spec.platform !== "ios") throw new HandlerError("INVALID", "Not an iOS model");
    progress(
      t("progress.simCreate", {
        name: input.name,
        detail: `${spec.deviceTypeName} · ${spec.runtimeName}`,
      }),
    );
    const udid = (
      await runOk(this.runner, this.simctl("create", input.name, spec.deviceTypeId, spec.runtimeId))
    ).trim();
    return { native: udid };
  }

  async rename(device: Device, name: string): Promise<void> {
    await runOk(this.runner, this.simctl("rename", device.native, name));
  }

  async remove(device: Device): Promise<void> {
    await this.runner(this.simctl("shutdown", device.native));
    await runOk(this.runner, this.simctl("delete", device.native));
  }

  async states(devices: Device[]): Promise<Map<string, RuntimeState>> {
    const all = Object.values(await this.listJson<Record<string, SimDevice[]>>("devices")).flat();
    const byUdid = new Map(all.map((d) => [d.udid, d]));
    return new Map(
      devices.map((device) => {
        const sim = byUdid.get(device.native);
        const booted = sim?.state === "Booted";
        return [device.id, booted ? { booted, targetId: device.native } : { booted: false }];
      }),
    );
  }

  boot(device: Device, progress: Progress): Promise<RuntimeState> {
    const next = this.bootChain.then(async () => {
      progress(t("progress.booting", { name: device.name }));
      const result = await this.runner(this.simctl("boot", device.native));
      if (result.code !== 0 && !result.stderr.includes("current state: Booted")) {
        throw new Error(`simctl boot failed\n${result.stderr.trim()}`);
      }
      await runOk(this.runner, this.simctl("bootstatus", device.native), {
        timeoutMs: BOOT_TIMEOUT_MS,
      });
      return { booted: true, targetId: device.native };
    });
    this.bootChain = next.catch(() => {});
    return next;
  }

  async shutdown(device: Device): Promise<void> {
    const result = await this.runner(this.simctl("shutdown", device.native));
    if (result.code !== 0 && !result.stderr.includes("current state: Shutdown")) {
      throw new Error(`simctl shutdown failed\n${result.stderr.trim()}`);
    }
  }

  async install(device: Device, _state: RuntimeState, path: string): Promise<void> {
    await runOk(this.runner, this.simctl("install", device.native, path), {
      timeoutMs: 5 * 60_000,
    });
  }

  private simslim(): string {
    const path = this.simslimPath();
    if (!path) throw new HandlerError("TOOL_MISSING", t("err.toolMissing", { tool: "simslim" }));
    return path;
  }

  private profileArgs(): string[] {
    return this.config.ios.simslimProfile ? ["--profile", this.config.ios.simslimProfile] : [];
  }

  async slim(device: Device, progress: Progress): Promise<void> {
    progress(t("progress.slimSim", { name: device.name }));
    await runOk(
      this.runner,
      [this.simslim(), "on", device.native, ...this.profileArgs(), "--preserve-boot-state"],
      {
        timeoutMs: SLIM_TIMEOUT_MS,
      },
    );
  }

  async unslim(device: Device, progress: Progress): Promise<void> {
    progress(t("progress.unslimSim", { name: device.name }));
    await runOk(this.runner, [this.simslim(), "off", device.native, "--preserve-boot-state"], {
      timeoutMs: SLIM_TIMEOUT_MS,
    });
  }

  /** simslim verify 는 켜진 기기만 볼 수 있다 */
  /** `simslim measure` — «UDID: 89 processes, 1.51 GB memory footprint (phys_footprint)» */
  async measure(device: Device): Promise<{ memoryBytes?: number; processes?: number }> {
    const out = await runOk(this.runner, [this.simslim(), "measure", device.native], {
      timeoutMs: 60_000,
    });
    return parseSimslimMeasure(out);
  }

  async slimStats(
    devices: Device[],
    states: Map<string, RuntimeState>,
  ): Promise<Map<string, SlimStats>> {
    const stats = new Map<string, SlimStats>();
    const booted = devices.filter((d) => states.get(d.id)?.booted);
    if (booted.length === 0 || !this.simslimPath()) return stats;
    const result = await this.runner([this.simslim(), "list", "--json", "--booted"], {
      timeoutMs: 30_000,
    });
    if (result.code !== 0) return stats;
    const rows = JSON.parse(result.stdout) as {
      udid: string;
      managedDisabled?: number;
      managedTotal?: number;
      memory?: { bytes?: number; processes?: number };
    }[];
    for (const device of booted) {
      const row = rows.find((r) => r.udid === device.native);
      if (!row || row.managedTotal === undefined) continue;
      stats.set(device.id, {
        disabled: row.managedDisabled ?? 0,
        total: row.managedTotal,
        unit: "daemons",
        memoryBytes: row.memory?.bytes,
        processes: row.memory?.processes,
        measuredAt: Date.now(),
      });
    }
    return stats;
  }

  async checkSlim(device: Device, state: RuntimeState): Promise<SlimState | undefined> {
    if (!state.booted || !this.simslimPath()) return undefined;
    const result = await this.runner([
      this.simslim(),
      "verify",
      device.native,
      ...this.profileArgs(),
    ]);
    return result.code === 0 ? "applied" : "drifted";
  }
}
