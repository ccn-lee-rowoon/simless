import type { Config } from "../../shared/config.ts";
import { run as defaultRun, type Runner, runOk, which } from "../../shared/exec.ts";
import type { Device, DeviceSpec, SlimState } from "../../shared/model.ts";
import { HandlerError } from "../socket.ts";
import type { Driver, Progress, RuntimeState, SourceDevice } from "./types.ts";

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

  /** 이 Mac 의 iPhone·iPad 시뮬레이터 — 복제 원본 후보 (M1). 크기는 기기 종류가 정한다 */
  async sources(): Promise<SourceDevice[]> {
    const [deviceTypes, runtimes, devices] = await Promise.all([
      this.listJson<SimDeviceType[]>("devicetypes"),
      this.listJson<SimRuntime[]>("runtimes"),
      this.listJson<
        Record<string, (SimDevice & { isAvailable: boolean; deviceTypeIdentifier: string })[]>
      >("devices"),
    ]);
    const typeById = new Map(deviceTypes.map((t) => [t.identifier, t]));
    const runtimeById = new Map(runtimes.map((r) => [r.identifier, r]));
    const sources: SourceDevice[] = [];
    for (const [runtimeId, sims] of Object.entries(devices)) {
      const runtime = runtimeById.get(runtimeId);
      if (runtime?.platform !== "iOS" || !runtime.isAvailable) continue;
      for (const sim of sims) {
        const deviceType = typeById.get(sim.deviceTypeIdentifier);
        if (!sim.isAvailable || !deviceType) continue;
        if (deviceType.productFamily !== "iPhone" && deviceType.productFamily !== "iPad") continue;
        const spec = await this.spec(deviceType, runtime);
        if (spec.platform !== "ios") continue;
        sources.push({
          platform: "ios",
          native: sim.udid,
          name: sim.name,
          spec,
          detail: `${deviceType.name === sim.name ? "" : `${deviceType.name} · `}${spec.widthPt * spec.scale}×${spec.heightPt * spec.scale}px @${spec.scale}x · ${runtime.name}`,
          booted: sim.state === "Booted",
        });
      }
    }
    return sources;
  }

  /**
   * 원본과 같은 기기 종류·런타임으로 새로 만든다. `simctl clone` 은 원본의 앱·데이터가
   * 따라오고 원본이 꺼져 있어야 해서 쓰지 않는다 (requirements «결정 기록»).
   */
  async create(
    input: { name: string; source: SourceDevice },
    progress: Progress,
  ): Promise<{ native: string }> {
    const { spec } = input.source;
    if (spec.platform !== "ios") throw new HandlerError("INVALID", "iOS 원본이 아닙니다");
    progress(
      `시뮬레이터 생성: ${input.name} ← ${input.source.name} (${spec.deviceTypeName} · ${spec.runtimeName})`,
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
