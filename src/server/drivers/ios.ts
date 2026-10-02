import type { Config } from "../../shared/config.ts";
import { run as defaultRun, type Runner, runOk, which } from "../../shared/exec.ts";
import type { Device, DeviceSpec, SlimState } from "../../shared/model.ts";
import { HandlerError } from "../socket.ts";
import type { CatalogItem, CreateRequest, Driver, Progress, RuntimeState } from "./types.ts";

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

function compareVersion(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
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

  private async iosRuntimes(): Promise<SimRuntime[]> {
    const runtimes = await this.listJson<SimRuntime[]>("runtimes");
    return runtimes
      .filter((r) => r.platform === "iOS" && r.isAvailable)
      .sort((a, b) => compareVersion(b.version, a.version));
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

  /** 기기 종류마다 그 종류를 지원하는 가장 새 런타임으로 한 항목 (M1) */
  async catalog(): Promise<CatalogItem[]> {
    const [deviceTypes, runtimes] = await Promise.all([
      this.listJson<SimDeviceType[]>("devicetypes"),
      this.iosRuntimes(),
    ]);
    const items: CatalogItem[] = [];
    for (const deviceType of deviceTypes) {
      if (deviceType.productFamily !== "iPhone" && deviceType.productFamily !== "iPad") continue;
      const runtime = runtimes.find((r) =>
        r.supportedDeviceTypes.some((t) => t.identifier === deviceType.identifier),
      );
      if (!runtime) continue;
      const spec = await this.spec(deviceType, runtime);
      if (spec.platform !== "ios") continue;
      items.push({
        platform: "ios",
        spec,
        suggestedName: `${deviceType.name} ${spec.widthPt}pt`,
        detail: `${spec.widthPt * spec.scale}×${spec.heightPt * spec.scale}px @${spec.scale}x · ${runtime.name}`,
        preset: this.config.ios.presets.includes(deviceType.name),
      });
    }
    return items;
  }

  async resolveSpec(request: CreateRequest): Promise<DeviceSpec> {
    if (request.platform !== "ios") throw new HandlerError("INVALID", "iOS 요청이 아닙니다");
    const wanted = request.deviceType.toLowerCase();
    const deviceTypes = await this.listJson<SimDeviceType[]>("devicetypes");
    const deviceType = deviceTypes.find(
      (t) => t.name.toLowerCase() === wanted || t.identifier.toLowerCase() === wanted,
    );
    if (!deviceType)
      throw new HandlerError(
        "NOT_FOUND",
        `없는 기기 종류: ${request.deviceType} — corgi catalog --platform ios`,
      );

    const supporting = (await this.iosRuntimes()).filter((r) =>
      r.supportedDeviceTypes.some((t) => t.identifier === deviceType.identifier),
    );
    const runtime = request.runtime
      ? supporting.find((r) => [r.version, r.name, r.identifier].includes(request.runtime ?? ""))
      : supporting[0];
    if (!runtime) {
      throw new HandlerError(
        "NOT_FOUND",
        `${deviceType.name} 을(를) 지원하는 런타임이 없습니다${request.runtime ? `: ${request.runtime}` : ""}`,
      );
    }
    return this.spec(deviceType, runtime);
  }

  async create(
    input: { name: string; spec: DeviceSpec },
    progress: Progress,
  ): Promise<{ native: string }> {
    if (input.spec.platform !== "ios") throw new HandlerError("INVALID", "iOS spec 이 아닙니다");
    progress(`시뮬레이터 생성: ${input.spec.deviceTypeName} · ${input.spec.runtimeName}`);
    const udid = (
      await runOk(
        this.runner,
        this.simctl("create", input.name, input.spec.deviceTypeId, input.spec.runtimeId),
      )
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
      progress(`부팅: ${device.name}`);
      const result = await this.runner(this.simctl("boot", device.native));
      if (result.code !== 0 && !result.stderr.includes("current state: Booted")) {
        throw new Error(`simctl boot 실패\n${result.stderr.trim()}`);
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
      throw new Error(`simctl shutdown 실패\n${result.stderr.trim()}`);
    }
  }

  private simslim(): string {
    const path = this.simslimPath();
    if (!path)
      throw new HandlerError(
        "TOOL_MISSING",
        "simslim 이 없습니다 — corgi doctor 로 설치 방법을 보세요",
      );
    return path;
  }

  private profileArgs(): string[] {
    return this.config.ios.simslimProfile ? ["--profile", this.config.ios.simslimProfile] : [];
  }

  async slim(device: Device, progress: Progress): Promise<void> {
    progress(`슬림화(simslim): ${device.name} — 잠시 켰다가 원래 상태로 돌아간다`);
    await runOk(
      this.runner,
      [this.simslim(), "on", device.native, ...this.profileArgs(), "--preserve-boot-state"],
      {
        timeoutMs: SLIM_TIMEOUT_MS,
      },
    );
  }

  async unslim(device: Device, progress: Progress): Promise<void> {
    progress(`슬림 해제(simslim): ${device.name}`);
    await runOk(this.runner, [this.simslim(), "off", device.native, "--preserve-boot-state"], {
      timeoutMs: SLIM_TIMEOUT_MS,
    });
  }

  /** simslim verify 는 켜진 기기만 볼 수 있다 */
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
