import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Config } from "../../shared/config.ts";
import { run as defaultRun, type Runner, runOk, which } from "../../shared/exec.ts";
import type { Device, DeviceSpec, SlimState } from "../../shared/model.ts";
import { androidSdk } from "../../shared/tools.ts";
import { HandlerError } from "../socket.ts";
import type { CatalogItem, CreateRequest, Driver, Progress, RuntimeState } from "./types.ts";

// Android 에뮬레이터 — AVD 파일을 직접 쓰고(avdmanager 불필요, HANDOFF 실측),
// emulator·adb 로 켜고 끄며, avdslim 으로 슬림화한다 (docs/design.md §9).

export interface SystemImage {
  /** config.ini 의 image.sysdir.1 값 — 예: system-images/android-36/google_apis_playstore/arm64-v8a/ */
  sysdir: string;
  /** 예: android-36 */
  target: string;
  tag: string;
  abi: string;
  api: number;
  /** 16KB 페이지 이미지 — avdslim 이 권하지 않는다 */
  pageSize16k: boolean;
}

export interface EmulatorProcess {
  exited: Promise<number | null>;
}

export interface AndroidDriverOptions {
  runner?: Runner;
  env?: NodeJS.ProcessEnv;
  logDir: string;
  avdslimPath?: () => string | undefined;
  spawnEmulator?: (command: string[], logPath: string) => EmulatorProcess;
  isPortFree?: (port: number) => Promise<boolean>;
  bootTimeoutMs?: number;
  pollMs?: number;
}

const FIRST_PORT = 5554;
const LAST_PORT = 5682;

function spawnDetached(command: string[], logPath: string): EmulatorProcess {
  const log = openSync(logPath, "a");
  const [file, ...args] = command;
  // 서버와 묶지 않는다 — 서버가 다시 켜져도 에뮬레이터는 계속 돈다
  const child = spawn(file ?? "", args, { detached: true, stdio: ["ignore", log, log] });
  const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
  child.unref();
  return { exited };
}

async function portFree(port: number): Promise<boolean> {
  try {
    const server = Bun.listen({ hostname: "127.0.0.1", port, socket: { data() {} } });
    server.stop(true);
    return true;
  } catch {
    return false;
  }
}

function readProps(path: string): Record<string, string> {
  const props: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const eq = line.indexOf("=");
    if (eq > 0) props[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return props;
}

export class AndroidDriver implements Driver {
  readonly platform = "android" as const;
  private readonly runner: Runner;
  private readonly env: NodeJS.ProcessEnv;
  private readonly avdslimPath: () => string | undefined;
  private readonly spawnEmulator: NonNullable<AndroidDriverOptions["spawnEmulator"]>;
  private readonly isPortFree: NonNullable<AndroidDriverOptions["isPortFree"]>;

  constructor(
    private readonly config: Config,
    private readonly options: AndroidDriverOptions,
  ) {
    this.runner = options.runner ?? defaultRun;
    this.env = options.env ?? process.env;
    this.avdslimPath = options.avdslimPath ?? (() => which("avdslim", this.env));
    this.spawnEmulator = options.spawnEmulator ?? spawnDetached;
    this.isPortFree = options.isPortFree ?? portFree;
  }

  get sdk(): string {
    return androidSdk(this.config, this.env);
  }

  get avdHome(): string {
    return this.env.ANDROID_AVD_HOME ?? join(this.env.HOME ?? homedir(), ".android", "avd");
  }

  private get adb() {
    return join(this.sdk, "platform-tools", "adb");
  }

  private get emulator() {
    return join(this.sdk, "emulator", "emulator");
  }

  async missingTools(): Promise<string[]> {
    const missing: string[] = [];
    if (!existsSync(this.adb)) missing.push(`adb (${this.adb})`);
    if (!existsSync(this.emulator)) missing.push(`emulator (${this.emulator})`);
    if (this.systemImages().length === 0) missing.push("Android 시스템 이미지");
    if (!this.avdslimPath()) missing.push("avdslim");
    return missing;
  }

  /** 설치된 시스템 이미지 — 4KB 페이지 우선, API 높은 순 */
  systemImages(): SystemImage[] {
    const root = join(this.sdk, "system-images");
    if (!existsSync(root)) return [];
    const images: SystemImage[] = [];
    for (const target of readdirSync(root)) {
      for (const tag of readdirSync(join(root, target), { withFileTypes: true }).filter((d) =>
        d.isDirectory(),
      )) {
        for (const abi of readdirSync(join(root, target, tag.name), { withFileTypes: true })) {
          const props = join(root, target, tag.name, abi.name, "source.properties");
          if (!abi.isDirectory() || !existsSync(props)) continue;
          const p = readProps(props);
          images.push({
            sysdir: `system-images/${target}/${tag.name}/${abi.name}/`,
            target,
            tag: tag.name,
            abi: abi.name,
            api:
              Number.parseFloat(target.replace(/^android-/, "")) ||
              Number(p["AndroidVersion.ApiLevel"] ?? 0),
            pageSize16k: tag.name.includes("16k"),
          });
        }
      }
    }
    const hostAbi = process.arch === "arm64" ? "arm64-v8a" : "x86_64";
    return images
      .filter((i) => i.abi === hostAbi)
      .sort((a, b) => Number(a.pageSize16k) - Number(b.pageSize16k) || b.api - a.api);
  }

  private image(wanted?: string): SystemImage {
    const images = this.systemImages();
    const query = wanted ?? this.config.android.systemImage;
    const image = query ? images.find((i) => i.sysdir.includes(query)) : images[0];
    if (!image) {
      throw new HandlerError(
        query ? "NOT_FOUND" : "TOOL_MISSING",
        query
          ? `없는 시스템 이미지: ${query}`
          : `Android 시스템 이미지가 없습니다 (${this.sdk}/system-images)`,
      );
    }
    return image;
  }

  private specFor(
    widthDp: number,
    heightDp: number,
    density: number,
    image: SystemImage,
  ): DeviceSpec {
    return {
      platform: "android",
      widthPx: Math.round((widthDp * density) / 160),
      heightPx: Math.round((heightDp * density) / 160),
      density,
      systemImage: image.sysdir,
    };
  }

  async catalog(): Promise<CatalogItem[]> {
    const image = this.image();
    return this.config.android.presets.map((preset) => {
      const spec = this.specFor(preset.widthDp, preset.heightDp, preset.density, image);
      return {
        platform: "android",
        spec,
        suggestedName: `Android ${preset.widthDp}dp`,
        detail:
          spec.platform === "android"
            ? `${spec.widthPx}×${spec.heightPx}px · ${spec.density}dpi · ${image.target} ${image.tag}`
            : "",
        preset: true,
      };
    });
  }

  async resolveSpec(request: CreateRequest): Promise<DeviceSpec> {
    if (request.platform !== "android")
      throw new HandlerError("INVALID", "Android 요청이 아닙니다");
    const preset = this.config.android.presets.find((p) => p.widthDp === request.widthDp);
    const density = request.density ?? preset?.density ?? 320;
    const heightDp = request.heightDp ?? preset?.heightDp ?? Math.round(request.widthDp * 2.1);
    return this.specFor(request.widthDp, heightDp, density, this.image(request.systemImage));
  }

  private avdId(device: { id: string }): string {
    return `corgi_${device.id}`;
  }

  private configPath(avdId: string): string {
    return join(this.avdHome, `${avdId}.avd`, "config.ini");
  }

  async create(
    input: { id: string; name: string; spec: DeviceSpec },
    progress: Progress,
  ): Promise<{ native: string }> {
    const { spec } = input;
    if (spec.platform !== "android") throw new HandlerError("INVALID", "Android spec 이 아닙니다");
    const image =
      this.systemImages().find((i) => i.sysdir === spec.systemImage) ??
      this.image(spec.systemImage);
    const avdId = this.avdId(input);
    const avdDir = join(this.avdHome, `${avdId}.avd`);
    if (existsSync(avdDir)) throw new HandlerError("INVALID", `이미 있는 AVD: ${avdId}`);
    progress(`AVD 생성: ${avdId} (${spec.widthPx}×${spec.heightPx}px · ${spec.density}dpi)`);

    mkdirSync(avdDir, { recursive: true });
    const lines = {
      AvdId: avdId,
      "avd.ini.displayname": input.name.replace(/[\r\n]/g, " "),
      "avd.ini.encoding": "UTF-8",
      "PlayStore.enabled": String(image.tag.includes("playstore")),
      "abi.type": image.abi,
      "hw.cpu.arch": image.abi === "arm64-v8a" ? "arm64" : image.abi,
      "hw.cpu.ncore": "2",
      "hw.ramSize": String(this.config.android.ramMb),
      "hw.lcd.width": String(spec.widthPx),
      "hw.lcd.height": String(spec.heightPx),
      "hw.lcd.density": String(spec.density),
      "hw.keyboard": "yes",
      "hw.gpu.enabled": "yes",
      "hw.gpu.mode": "auto",
      "hw.mainKeys": "no",
      "hw.initialOrientation": "portrait",
      "disk.dataPartition.size": "6G",
      "skin.dynamic": "yes",
      showDeviceFrame: "no",
      "image.sysdir.1": image.sysdir,
      "tag.id": image.tag,
      target: image.target,
    };
    writeFileSync(
      join(avdDir, "config.ini"),
      `${Object.entries(lines)
        .map(([k, v]) => `${k}=${v}`)
        .join("\n")}\n`,
    );
    writeFileSync(
      join(this.avdHome, `${avdId}.ini`),
      `avd.ini.encoding=UTF-8\npath=${avdDir}\npath.rel=avd/${avdId}.avd\ntarget=${image.target}\n`,
    );
    return { native: avdId };
  }

  async rename(device: Device, name: string): Promise<void> {
    const path = this.configPath(device.native);
    const text = readFileSync(path, "utf8").replace(
      /^avd\.ini\.displayname=.*$/m,
      `avd.ini.displayname=${name.replace(/[\r\n]/g, " ")}`,
    );
    writeFileSync(path, text);
  }

  async remove(device: Device): Promise<void> {
    rmSync(join(this.avdHome, `${device.native}.avd`), { recursive: true, force: true });
    rmSync(join(this.avdHome, `${device.native}.ini`), { force: true });
  }

  /** 켜진 에뮬레이터 시리얼 → AVD ID */
  private async running(): Promise<Map<string, { serial: string; ready: boolean }>> {
    const result = await this.runner([this.adb, "devices"]);
    const byAvd = new Map<string, { serial: string; ready: boolean }>();
    if (result.code !== 0) return byAvd;
    const serials = result.stdout
      .split("\n")
      .map((line) => line.trim().split(/\s+/))
      .filter(([serial]) => serial?.startsWith("emulator-"));
    await Promise.all(
      serials.map(async ([serial = "", state]) => {
        const name = await this.runner([this.adb, "-s", serial, "emu", "avd", "name"]);
        const avd = name.stdout.split("\n")[0]?.trim();
        if (name.code === 0 && avd) byAvd.set(avd, { serial, ready: state === "device" });
      }),
    );
    return byAvd;
  }

  async states(devices: Device[]): Promise<Map<string, RuntimeState>> {
    const running = await this.running();
    return new Map(
      devices.map((device) => {
        const found = running.get(device.native);
        return [
          device.id,
          found?.ready ? { booted: true, targetId: found.serial } : { booted: false },
        ];
      }),
    );
  }

  private async freePort(taken: Set<string>): Promise<number> {
    for (let port = FIRST_PORT; port <= LAST_PORT; port += 2) {
      if (taken.has(`emulator-${port}`)) continue;
      if ((await this.isPortFree(port)) && (await this.isPortFree(port + 1))) return port;
    }
    throw new HandlerError("FAILED", "에뮬레이터에 쓸 빈 포트가 없습니다 (5554~5683)");
  }

  async boot(device: Device, progress: Progress): Promise<RuntimeState> {
    const running = await this.running();
    const already = running.get(device.native);
    if (already?.ready) return { booted: true, targetId: already.serial };

    // 포트를 정해 켜면 시리얼이 emulator-<포트> 로 정해진다 (설계 결정 기록)
    const port = await this.freePort(new Set([...running.values()].map((r) => r.serial)));
    const serial = `emulator-${port}`;
    mkdirSync(this.options.logDir, { recursive: true });
    const logPath = join(this.options.logDir, `emulator-${device.native}.log`);
    progress(`부팅: ${device.name} (${serial})`);
    const proc = this.spawnEmulator(
      [
        this.emulator,
        "-avd",
        device.native,
        "-port",
        String(port),
        ...this.config.android.emulatorArgs,
      ],
      logPath,
    );

    let exitCode: number | null | undefined;
    void proc.exited.then((code) => {
      exitCode = code;
    });
    const deadline = Date.now() + (this.options.bootTimeoutMs ?? 5 * 60_000);
    const pollMs = this.options.pollMs ?? 2000;
    while (Date.now() < deadline) {
      if (exitCode !== undefined) {
        const tail = existsSync(logPath)
          ? readFileSync(logPath, "utf8").trim().split("\n").slice(-8).join("\n")
          : "";
        throw new Error(`에뮬레이터가 부팅 중에 끝났습니다 (code ${exitCode})\n${tail}`);
      }
      const prop = await this.runner([
        this.adb,
        "-s",
        serial,
        "shell",
        "getprop",
        "sys.boot_completed",
      ]);
      if (prop.code === 0 && prop.stdout.trim() === "1") return { booted: true, targetId: serial };
      await Bun.sleep(pollMs);
    }
    throw new Error(`부팅 시간이 지났습니다: ${device.name} — 로그 ${logPath}`);
  }

  async shutdown(device: Device, state: RuntimeState): Promise<void> {
    const serial = state.targetId;
    if (!serial) return;
    await this.runner([this.adb, "-s", serial, "emu", "kill"]);
    for (let i = 0; i < 30; i++) {
      if (!(await this.running()).has(device.native)) return;
      await Bun.sleep(this.options.pollMs ?? 1000);
    }
    throw new Error(`끄지 못했습니다: ${device.name} (${serial})`);
  }

  private avdslim(): string {
    const path = this.avdslimPath();
    if (!path)
      throw new HandlerError(
        "TOOL_MISSING",
        "avdslim 이 없습니다 — corgi doctor 로 설치 방법을 보세요",
      );
    return path;
  }

  /** 호스트 설정(tune-avd)은 바로, 기기 안 정리(on)는 켜져 있을 때 — 켤 때마다 afterBoot 에서 다시 한다 */
  async slim(device: Device, progress: Progress): Promise<void> {
    const avdslim = this.avdslim();
    progress(`슬림화(avdslim tune-avd): ${device.name}`);
    await runOk(this.runner, [
      avdslim,
      "tune-avd",
      device.native,
      `--ram=${this.config.android.ramMb}`,
    ]);
    const state = (await this.states([device])).get(device.id);
    if (state?.booted && state.targetId) await this.slimGuest(device, state.targetId, progress);
  }

  async afterBoot(device: Device, state: RuntimeState, progress: Progress): Promise<void> {
    if (device.slim === "applied" && state.targetId && this.avdslimPath()) {
      await this.slimGuest(device, state.targetId, progress);
    }
  }

  private async slimGuest(device: Device, serial: string, progress: Progress): Promise<void> {
    progress(`기기 안 정리(avdslim on): ${device.name}`);
    await runOk(this.runner, [this.avdslim(), "on", serial], { timeoutMs: 5 * 60_000 });
  }

  async unslim(device: Device, progress: Progress): Promise<void> {
    const avdslim = this.avdslim();
    const state = (await this.states([device])).get(device.id);
    if (!state?.booted || !state.targetId) {
      throw new HandlerError(
        "INVALID",
        "Android 슬림 해제는 켜진 상태에서만 됩니다 — corgi up 뒤에 다시",
      );
    }
    progress(`슬림 해제(avdslim off): ${device.name}`);
    await runOk(this.runner, [avdslim, "off", state.targetId], { timeoutMs: 5 * 60_000 });
  }

  private profilePackages?: Set<string>;

  /** avdslim 이 끄는 패키지 목록 — `avdslim profiles` 의 «•» 줄 (끄지 않는 핵심 목록 앞까지) */
  private async slimPackages(): Promise<Set<string>> {
    if (this.profilePackages) return this.profilePackages;
    const text = await runOk(this.runner, [this.avdslim(), "profiles"]);
    const listed = text.split("GUARANTEED")[0] ?? "";
    this.profilePackages = new Set(
      listed
        .split("\n")
        .map((line) => /^\s*•\s*(\S+)/.exec(line)?.[1])
        .filter((pkg): pkg is string => pkg !== undefined),
    );
    return this.profilePackages;
  }

  private async packages(serial: string, disabledOnly: boolean): Promise<Set<string>> {
    const args = [
      this.adb,
      "-s",
      serial,
      "shell",
      "pm",
      "list",
      "packages",
      ...(disabledOnly ? ["-d"] : []),
    ];
    const text = await runOk(this.runner, args);
    return new Set(
      text
        .split("\n")
        .map((line) => line.trim().replace(/^package:/, ""))
        .filter(Boolean),
    );
  }

  /**
   * avdslim 에는 상태 조회 명령이 없다. 기기에 설치된 프로필 패키지 중 꺼진 비율로 본다 —
   * 표준 프리셋도 Chrome·Play 스토어 등 일부는 남기므로(실측 52개 중 49개) 절반 이상이면 적용됨.
   */
  async checkSlim(_device: Device, state: RuntimeState): Promise<SlimState | undefined> {
    if (!state.booted || !state.targetId || !this.avdslimPath()) return undefined;
    const [profile, installed, disabled] = await Promise.all([
      this.slimPackages(),
      this.packages(state.targetId, false),
      this.packages(state.targetId, true),
    ]);
    const relevant = [...profile].filter((pkg) => installed.has(pkg));
    if (relevant.length === 0) return undefined;
    const off = relevant.filter((pkg) => disabled.has(pkg)).length;
    return off / relevant.length >= 0.5 ? "applied" : "drifted";
  }
}
