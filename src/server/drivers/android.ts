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
import type { SlimStats } from "../../shared/api.ts";
import type { Config } from "../../shared/config.ts";
import { run as defaultRun, type Runner, runOk, which } from "../../shared/exec.ts";
import type { Device, SlimState } from "../../shared/model.ts";
import { androidSdk } from "../../shared/tools.ts";
import { HandlerError } from "../socket.ts";
import { ANDROID_PROFILES } from "./android-profiles.ts";
import type {
  CustomRequest,
  Driver,
  Progress,
  RuntimeState,
  SourceDevice,
  SystemImageInfo,
} from "./types.ts";

// Android 에뮬레이터 — 원본 AVD 의 하드웨어 설정을 복사해 AVD 파일을 직접 쓰고(avdmanager 불필요),
// emulator·adb 로 켜고 끄며, avdslim 으로 슬림화한다 (docs/design.md §9).

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

/** `avdslim measure` 의 «Activity Monitor Memory (Footprint): 7583 MB» → 바이트 */
export function parseFootprint(text: string): number | undefined {
  const mb = /Footprint\):\s*([\d,.]+)\s*MB/.exec(text)?.[1];
  return mb ? Number(mb.replace(/,/g, "")) * 1024 * 1024 : undefined;
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
    if (!this.avdslimPath()) missing.push("avdslim");
    return missing;
  }

  /** `<ID>.ini` 의 path= 가 가리키는 AVD 폴더 (Android Studio 가 만든 것은 다른 곳일 수도 있다) */
  private avdDir(avdId: string): string {
    const ini = join(this.avdHome, `${avdId}.ini`);
    const path = existsSync(ini) ? readProps(ini).path : undefined;
    return path && existsSync(path) ? path : join(this.avdHome, `${avdId}.avd`);
  }

  private configPath(avdId: string): string {
    return join(this.avdDir(avdId), "config.ini");
  }

  /** 설치된 시스템 이미지 — 이 Mac 의 CPU 용만, 4KB 페이지 우선·API 높은 순 (avdslim 권장) */
  private systemImages() {
    const root = join(this.sdk, "system-images");
    if (!existsSync(root)) return [];
    const hostAbi = process.arch === "arm64" ? "arm64-v8a" : "x86_64";
    const images: {
      sysdir: string;
      target: string;
      tag: string;
      abi: string;
      api: number;
      page16k: boolean;
    }[] = [];
    for (const target of readdirSync(root)) {
      for (const tag of readdirSync(join(root, target))) {
        if (!existsSync(join(root, target, tag, hostAbi, "source.properties"))) continue;
        images.push({
          sysdir: `system-images/${target}/${tag}/${hostAbi}/`,
          target,
          tag,
          abi: hostAbi,
          api: Number.parseFloat(target.replace(/^android-/, "")) || 0,
          page16k: tag.includes("16k"),
        });
      }
    }
    return images.sort((a, b) => Number(a.page16k) - Number(b.page16k) || b.api - a.api);
  }

  images(): SystemImageInfo[] {
    return this.systemImages().map((image, i) => ({
      sysdir: image.sysdir,
      label: `${image.target} ${image.tag}${image.page16k ? " (16KB 페이지)" : ""}`,
      recommended: i === 0,
    }));
  }

  private image(wanted?: string) {
    const images = this.systemImages();
    const image = wanted
      ? images.find((i) => i.sysdir === wanted || i.sysdir.includes(wanted))
      : images[0];
    if (!image) {
      throw new HandlerError(
        wanted ? "NOT_FOUND" : "TOOL_MISSING",
        wanted
          ? `없는 시스템 이미지: ${wanted}`
          : `Android 시스템 이미지가 없습니다 (${this.sdk}/system-images)`,
      );
    }
    return image;
  }

  private sized(
    native: string,
    name: string,
    size: { widthPx: number; heightPx: number; density: number },
    sysdir?: string,
  ): SourceDevice {
    const image = this.image(sysdir);
    return {
      platform: "android",
      native,
      name,
      spec: { platform: "android", ...size, systemImage: image.sysdir },
      detail: `${size.widthPx}×${size.heightPx}px · ${size.density}dpi · ${image.target} ${image.tag}`,
      booted: false,
    };
  }

  /** 내장 대표 프로필 — 기본 이미지로 (requirements M1) */
  async presetSources(): Promise<SourceDevice[]> {
    if (this.systemImages().length === 0) return [];
    return ANDROID_PROFILES.map((p) => this.sized(`profile:${p.id}`, p.name, p));
  }

  async customSource(request: CustomRequest): Promise<SourceDevice> {
    return this.sized(
      `custom:${request.widthDp}x${request.heightDp}@${request.density}`,
      `Android ${request.widthDp}dp`,
      {
        widthPx: Math.round((request.widthDp * request.density) / 160),
        heightPx: Math.round((request.heightDp * request.density) / 160),
        density: request.density,
      },
      request.systemImage,
    );
  }

  /**
   * Android 는 이 Mac 의 AVD 를 원본으로 쓰지 않는다 — 크기는 대표 프로필·직접 입력으로 정한다
   * (requirements M1, «결정 기록»).
   */
  async sources(): Promise<SourceDevice[]> {
    return [];
  }

  /** 대표 프로필·직접 입력의 크기와 이미지로 config.ini 를 새로 쓴다 */
  async create(
    input: { id: string; name: string; source: SourceDevice },
    progress: Progress,
  ): Promise<{ native: string }> {
    const { source } = input;
    if (source.spec.platform !== "android")
      throw new HandlerError("INVALID", "Android 원본이 아닙니다");
    const avdId = `corgi_${input.id}`;
    const avdDir = join(this.avdHome, `${avdId}.avd`);
    if (existsSync(avdDir)) throw new HandlerError("INVALID", `이미 있는 AVD: ${avdId}`);
    progress(`AVD 생성: ${input.name} ← ${source.name} (${source.detail})`);

    const config: Record<string, string> = {
      AvdId: avdId,
      "avd.ini.displayname": input.name.replace(/[\r\n]/g, " "),
      "avd.ini.encoding": "UTF-8",
      ...this.freshConfig(source),
    };
    mkdirSync(avdDir, { recursive: true });
    writeFileSync(
      join(avdDir, "config.ini"),
      `${Object.entries(config)
        .map(([k, v]) => `${k}=${v}`)
        .join("\n")}\n`,
    );
    const target = config.target ?? "";
    writeFileSync(
      join(this.avdHome, `${avdId}.ini`),
      `avd.ini.encoding=UTF-8\npath=${avdDir}\npath.rel=avd/${avdId}.avd\ntarget=${target}\n`,
    );
    return { native: avdId };
  }

  /** 프로필·직접 입력용 config.ini — 크기와 이미지만 정하고 나머지는 흔한 기본값 */
  private freshConfig(source: SourceDevice): Record<string, string> {
    const { spec } = source;
    if (spec.platform !== "android") throw new HandlerError("INVALID", "Android 원본이 아닙니다");
    const image = this.image(spec.systemImage);
    return {
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
  /** 설치된 avdslim 프로필 패키지 중 꺼진 수 — 기기에 프로필 패키지가 없으면 undefined */
  private async slimCounts(serial: string): Promise<{ off: number; relevant: number } | undefined> {
    const [profile, installed, disabled] = await Promise.all([
      this.slimPackages(),
      this.packages(serial, false),
      this.packages(serial, true),
    ]);
    const relevant = [...profile].filter((pkg) => installed.has(pkg));
    if (relevant.length === 0) return undefined;
    return { off: relevant.filter((pkg) => disabled.has(pkg)).length, relevant: relevant.length };
  }

  async checkSlim(_device: Device, state: RuntimeState): Promise<SlimState | undefined> {
    if (!state.booted || !state.targetId || !this.avdslimPath()) return undefined;
    const counts = await this.slimCounts(state.targetId);
    if (!counts) return undefined;
    return counts.off / counts.relevant >= 0.5 ? "applied" : "drifted";
  }

  async slimStats(
    devices: Device[],
    states: Map<string, RuntimeState>,
  ): Promise<Map<string, SlimStats>> {
    const stats = new Map<string, SlimStats>();
    if (!this.avdslimPath()) return stats;
    await Promise.all(
      devices.map(async (device) => {
        const serial = states.get(device.id)?.targetId;
        if (!serial) return;
        const [counts, measure] = await Promise.all([
          this.slimCounts(serial).catch(() => undefined),
          this.runner([this.avdslim(), "measure", serial], { timeoutMs: 30_000 }),
        ]);
        if (!counts) return;
        stats.set(device.id, {
          disabled: counts.off,
          total: counts.relevant,
          unit: "패키지",
          memoryBytes: parseFootprint(measure.stdout),
          measuredAt: Date.now(),
        });
      }),
    );
    return stats;
  }
}
