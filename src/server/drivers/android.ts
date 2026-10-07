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
import type { PlatformCatalog, SlimCategory, SlimStats } from "../../shared/api.ts";
import type { Config } from "../../shared/config.ts";
import { run as defaultRun, type Runner, runOk, which } from "../../shared/exec.ts";
import { t } from "../../shared/i18n.ts";
import type { Device, DeviceSpec, SlimState } from "../../shared/model.ts";
import { androidSdk } from "../../shared/tools.ts";
import { HandlerError } from "../socket.ts";
import {
  ANDROID_PROFILES,
  type AndroidProfile,
  mergeProfiles,
  parseDeviceDefinitions,
} from "./android-profiles.ts";
import type { Discovered, Driver, ModelRequest, Progress, RuntimeState } from "./types.ts";

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
  /** 기기 정의 XML — 기본은 Android Studio 의 sdklib.jar 와 ~/.android/devices.xml (M1) */
  deviceDefinitions?: () => Promise<{ user: string[]; studio: string[] }>;
}

/** Android Studio 가 있을 만한 곳 — 정식·미리 보기, /Applications·~/Applications */
function studioJars(home: string): string[] {
  const roots = ["/Applications", join(home, "Applications")];
  const jars: string[] = [];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const app of readdirSync(root)) {
      if (!/^Android Studio.*\.app$/.test(app)) continue;
      const jar = join(root, app, "Contents", "plugins", "android", "lib", "sdklib.jar");
      if (existsSync(jar)) jars.push(jar);
    }
  }
  return jars;
}

/** sdklib.jar 안의 폰·태블릿 정의 파일 — 워치·TV·자동차·XR·데스크톱 파일은 읽지 않는다 */
const STUDIO_FILES = [
  "com/android/sdklib/devices/devices.xml",
  "com/android/sdklib/devices/nexus.xml",
];

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

/**
 * `avdslim profiles` 출력 — «📦 <묶음> (~… RAM):» 아래 «• <패키지>» 줄들, 공격적 모드(🔥)는 빼고,
 * «✓ <끄지 않는 것>» 은 남는 것으로.
 */
export function parseAvdslimProfiles(text: string): {
  off: SlimCategory[];
  keeps: string[];
  /** 묶음 ID → 패키지 — 남길 묶음의 패키지를 다시 켤 때 (M15) */
  packages: Map<string, string[]>;
} {
  const off: SlimCategory[] = [];
  const keeps: string[] = [];
  const packages = new Map<string, string[]>();
  let current: { name: string; packages: string[] } | undefined;
  const flush = () => {
    if (current) {
      const id = slimId(current.name);
      off.push({ id, kind: "packages", name: current.name, count: current.packages.length });
      packages.set(id, current.packages);
    }
    current = undefined;
  };
  for (const line of text.split("\n")) {
    const head = /^\s*(\S+)\s+(.+?)(?:\s*\(~[^)]*\))?:\s*$/u.exec(line);
    if (head?.[1] && head[2] && /📦|🔥|🔒|📋/u.test(head[1])) {
      flush();
      if (head[1].includes("📦")) current = { name: head[2].trim(), packages: [] };
      continue;
    }
    const pkg = /^\s*•\s*(\S+)/.exec(line)?.[1];
    if (current && pkg) current.packages.push(pkg);
    const keep = /^\s*✓\s*(.+)$/.exec(line);
    if (keep?.[1]) keeps.push(keep[1].trim());
  }
  flush();
  return { off, keeps, packages };
}

/** 묶음 이름 → 남길 때 쓰는 ID — «Assistant & Search» → `assistant-search` */
export function slimId(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * avdslim 이 바꾸는 기기 설정 — `on --skip=<묶음>` 으로 건너뛴다 (M15).
 * `setup` 외에는 `avdslim enable <묶음>` 으로 되돌릴 수 있다
 */
export const ANDROID_SLIM_SETTINGS = ["location", "sync", "bglimit", "bluetooth", "setup"] as const;
const ENABLEABLE_SETTINGS = new Set(["location", "sync", "bglimit", "bluetooth"]);
/** 에뮬레이터 하드웨어 — tune-avd 가 끄고 `avdslim enable <기능> <AVD>` 로 켠다 (M15) */
export const ANDROID_SLIM_HOST = ["camera", "audio"] as const;

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

  private image(wanted?: string) {
    const images = this.systemImages();
    const lower = wanted?.toLowerCase();
    const image = lower
      ? images.find((i) => i.sysdir === wanted || i.sysdir.toLowerCase().includes(lower))
      : images[0];
    if (!image) {
      throw new HandlerError(
        wanted ? "NOT_FOUND" : "TOOL_MISSING",
        wanted
          ? t("err.noImage", { image: wanted })
          : t("err.noImages", { path: `${this.sdk}/system-images` }),
      );
    }
    return image;
  }

  private profilesCache?: { at: number; list: Promise<AndroidProfile[]> };

  /**
   * 만들 수 있는 기종 — 사람이 Android Studio 에서 만든 정의, Android Studio 의 기기 정의, 대표 프로필 순.
   * 10분 동안 기억한다(Android Studio 를 업데이트하면 그 뒤에 새 기종이 보인다)
   */
  private profiles(): Promise<AndroidProfile[]> {
    if (this.profilesCache && Date.now() - this.profilesCache.at < 10 * 60_000) {
      return this.profilesCache.list;
    }
    const list = (this.options.deviceDefinitions ?? (() => this.readDefinitions()))()
      .then(({ user, studio }) =>
        mergeProfiles(
          user.flatMap(parseDeviceDefinitions),
          studio.flatMap(parseDeviceDefinitions),
          ANDROID_PROFILES,
        ),
      )
      .catch(() => ANDROID_PROFILES);
    this.profilesCache = { at: Date.now(), list };
    return list;
  }

  private async readDefinitions(): Promise<{ user: string[]; studio: string[] }> {
    const home = this.env.HOME ?? homedir();
    const userFile = join(this.env.ANDROID_USER_HOME ?? join(home, ".android"), "devices.xml");
    const user = existsSync(userFile) ? [readFileSync(userFile, "utf8")] : [];
    const studio: string[] = [];
    const [jar] = studioJars(home);
    if (jar) {
      for (const file of STUDIO_FILES) {
        const result = await this.runner(["unzip", "-p", jar, file], { timeoutMs: 10_000 });
        if (result.code === 0) studio.push(result.stdout);
      }
    }
    return { user, studio };
  }

  async catalog(): Promise<PlatformCatalog> {
    const images = this.systemImages();
    const slim = await this.slimCategories();
    const profiles = await this.profiles();
    return {
      platform: "android",
      models: profiles.map((p) => ({
        id: p.id,
        name: p.name,
        form: (p.widthPx * 160) / p.density >= 600 ? "tablet" : "phone",
        layoutWidth: Math.round((p.widthPx * 160) / p.density),
        layoutHeight: Math.round((p.heightPx * 160) / p.density),
        detail: `${p.widthPx}×${p.heightPx}px · ${p.density}dpi`,
      })),
      os: images.map((image, i) => ({
        id: image.sysdir,
        name: `${image.target} ${image.tag}${image.page16k ? t("os.page16k") : ""}`,
        recommended: i === 0,
      })),
      custom: true,
      slimOff: slim.off,
      slimKeeps: slim.keeps,
    };
  }

  /** 대표 프로필(ID·이름) 또는 직접 입력 + 시스템 이미지 (requirements M1) */
  async resolve(request: ModelRequest): Promise<{ spec: DeviceSpec; modelName: string }> {
    const image = this.image(request.os);
    if (request.custom) {
      const { widthDp, heightDp, density } = request.custom;
      return {
        spec: {
          platform: "android",
          widthPx: Math.round((widthDp * density) / 160),
          heightPx: Math.round((heightDp * density) / 160),
          density,
          systemImage: image.sysdir,
        },
        modelName: `Android ${widthDp}dp`,
      };
    }
    const wanted = (request.model ?? "").toLowerCase();
    const profile = (await this.profiles()).find(
      (p) => p.id === wanted || p.name.toLowerCase() === wanted,
    );
    if (!profile)
      throw new HandlerError("NOT_FOUND", t("err.noProfile", { model: request.model ?? "" }));
    return {
      spec: {
        platform: "android",
        widthPx: profile.widthPx,
        heightPx: profile.heightPx,
        density: profile.density,
        systemImage: image.sysdir,
      },
      modelName: profile.name,
    };
  }

  private slimCache?: ReturnType<typeof parseAvdslimProfiles>;

  /**
   * `avdslim profiles` — 꺼지는 묶음(📦)과 끄지 않는 것(✓). 공격적 모드(🔥)는 쓰지 않아 뺀다.
   * 고를 수 있는 항목에는 패키지 묶음 뒤에 기기 설정·에뮬레이터 하드웨어를 붙인다 (M15)
   */
  private async slimCategories(): Promise<{ off: SlimCategory[]; keeps: string[] }> {
    const empty = { off: [], keeps: [] };
    if (!this.slimCache) {
      const path = this.avdslimPath();
      if (!path) return empty;
      const result = await this.runner([path, "profiles"]);
      if (result.code !== 0) return empty;
      this.slimCache = parseAvdslimProfiles(result.stdout);
    }
    const extra: SlimCategory[] = [
      ...ANDROID_SLIM_SETTINGS.map((id) => ({
        id,
        kind: "settings" as const,
        name: t(`slim.android.${id}`),
        detail: t(`slim.android.${id}.detail`),
      })),
      ...ANDROID_SLIM_HOST.map((id) => ({
        id,
        kind: "host" as const,
        name: t(`slim.android.${id}`),
        detail: t(`slim.android.${id}.detail`),
      })),
    ];
    return { off: [...this.slimCache.off, ...extra], keeps: this.slimCache.keeps };
  }

  async slimItems(): Promise<SlimCategory[]> {
    return (await this.slimCategories()).off;
  }

  /** 남길 패키지 묶음에 든 패키지 */
  private async keptPackages(device: Device): Promise<Set<string>> {
    const keep = device.slimKeep ?? [];
    if (keep.length === 0) return new Set();
    await this.slimCategories();
    return new Set(keep.flatMap((id) => this.slimCache?.packages.get(id) ?? []));
  }

  /**
   * 이 Mac 의 AVD 전부 (R20) — `<ID>.ini` 마다 config.ini 의 표시 이름·화면 크기를 읽는다.
   * 크기가 없으면 skin.name(`1080x2400`)으로, 그것도 없으면 뺀다.
   */
  async list(): Promise<Discovered[]> {
    if (!existsSync(this.avdHome)) return [];
    const result: Discovered[] = [];
    for (const file of readdirSync(this.avdHome)) {
      if (!file.endsWith(".ini")) continue;
      const avdId = file.slice(0, -".ini".length);
      const path = this.configPath(avdId);
      if (!existsSync(path)) continue;
      const config = readProps(path);
      const skin = /^(\d+)x(\d+)$/.exec(config["skin.name"] ?? "");
      const widthPx = Number(config["hw.lcd.width"] ?? skin?.[1]);
      const heightPx = Number(config["hw.lcd.height"] ?? skin?.[2]);
      const density = Number(config["hw.lcd.density"] ?? 420);
      if (!(widthPx > 0 && heightPx > 0 && density > 0)) continue;
      result.push({
        native: avdId,
        name: config["avd.ini.displayname"] || avdId.replace(/_/g, " "),
        spec: {
          platform: "android",
          widthPx,
          heightPx,
          density,
          systemImage: config["image.sysdir.1"] ?? "",
        },
      });
    }
    return result;
  }

  /** 대표 프로필·직접 입력의 크기와 이미지로 config.ini 를 새로 쓴다 */
  async create(
    input: { id: string; name: string; spec: DeviceSpec },
    progress: Progress,
  ): Promise<{ native: string }> {
    const { spec } = input;
    if (spec.platform !== "android") throw new HandlerError("INVALID", "Not an Android model");
    const avdId = `simless_${input.id}`;
    const avdDir = join(this.avdHome, `${avdId}.avd`);
    if (existsSync(avdDir)) throw new HandlerError("INVALID", t("err.avdExists", { id: avdId }));
    progress(
      t("progress.avdCreate", {
        name: input.name,
        detail: `${spec.widthPx}×${spec.heightPx}px · ${spec.density}dpi`,
      }),
    );

    const config: Record<string, string> = {
      AvdId: avdId,
      "avd.ini.displayname": input.name.replace(/[\r\n]/g, " "),
      "avd.ini.encoding": "UTF-8",
      ...this.freshConfig(spec),
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
  private freshConfig(spec: DeviceSpec): Record<string, string> {
    if (spec.platform !== "android") throw new HandlerError("INVALID", "Not an Android model");
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
    throw new HandlerError("FAILED", t("err.noFreePort"));
  }

  /** 슬림하면서 소리를 남기기로 했으면 `-no-audio` 를 뺀다 (M15) */
  private emulatorArgs(device: Device): string[] {
    const args = this.config.android.emulatorArgs;
    const audio = device.slim !== "none" && device.slimKeep?.includes("audio");
    return audio ? args.filter((a) => a !== "-no-audio") : args;
  }

  async boot(device: Device, progress: Progress): Promise<RuntimeState> {
    const running = await this.running();
    const already = running.get(device.native);
    if (already?.ready) return { booted: true, targetId: already.serial };

    // 포트를 정해 켜면 시리얼이 emulator-<포트> 로 정해진다 (설계 결정 기록)
    const port = await this.freePort(new Set([...running.values()].map((r) => r.serial)));
    const serial = `emulator-${port}`;
    mkdirSync(this.options.logDir, { recursive: true, mode: 0o700 });
    const logPath = join(this.options.logDir, `emulator-${device.native}.log`);
    progress(t("progress.booting", { name: `${device.name} (${serial})` }));
    const proc = this.spawnEmulator(
      [this.emulator, "-avd", device.native, "-port", String(port), ...this.emulatorArgs(device)],
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
        throw new Error(t("err.emulatorExited", { code: String(exitCode), log: tail }));
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
    throw new Error(t("err.bootTimeout", { name: device.name, log: logPath }));
  }

  async shutdown(device: Device, state: RuntimeState): Promise<void> {
    const serial = state.targetId;
    if (!serial) return;
    await this.runner([this.adb, "-s", serial, "emu", "kill"]);
    for (let i = 0; i < 30; i++) {
      if (!(await this.running()).has(device.native)) return;
      await Bun.sleep(this.options.pollMs ?? 1000);
    }
    throw new Error(t("err.shutdownFailed", { name: device.name, serial }));
  }

  async install(_device: Device, state: RuntimeState, path: string): Promise<void> {
    if (!state.targetId) throw new Error("not booted");
    // -r 다시 설치(데이터 유지), -t 테스트 빌드 허용
    await runOk(this.runner, [this.adb, "-s", state.targetId, "install", "-r", "-t", path], {
      timeoutMs: 5 * 60_000,
    });
  }

  private avdslim(): string {
    const path = this.avdslimPath();
    if (!path) throw new HandlerError("TOOL_MISSING", t("err.toolMissing", { tool: "avdslim" }));
    return path;
  }

  /** 호스트 설정(tune-avd)은 바로, 기기 안 정리(on)는 켜져 있을 때 — 켤 때마다 afterBoot 에서 다시 한다 */
  async slim(device: Device, progress: Progress): Promise<void> {
    const avdslim = this.avdslim();
    progress(t("progress.slimAvd", { name: device.name }));
    await runOk(this.runner, [
      avdslim,
      "tune-avd",
      device.native,
      `--ram=${this.config.android.ramMb}`,
    ]);
    // tune-avd 가 끈 하드웨어 중 남길 것을 다시 켠다 — 다음에 켤 때부터 (M15)
    for (const host of ANDROID_SLIM_HOST) {
      if (device.slimKeep?.includes(host))
        await runOk(this.runner, [avdslim, "enable", host, device.native]);
    }
    const state = (await this.states([device])).get(device.id);
    if (state?.booted && state.targetId) await this.slimGuest(device, state.targetId, progress);
  }

  async afterBoot(device: Device, state: RuntimeState, progress: Progress): Promise<void> {
    if (device.slim === "applied" && state.targetId && this.avdslimPath()) {
      await this.slimGuest(device, state.targetId, progress);
    }
  }

  /**
   * 기기 안 정리 — 남길 설정은 `--skip`, 남길 묶음의 패키지는 `on` 뒤에 `avdslim enable` 로 다시 켠다.
   * 예전에 끈 설정도 되돌리므로, 남길 항목이 바뀌어도 풀지 않고 그대로 맞춰진다 (M15)
   */
  private async slimGuest(device: Device, serial: string, progress: Progress): Promise<void> {
    const avdslim = this.avdslim();
    const keep = new Set(device.slimKeep ?? []);
    const skip = ANDROID_SLIM_SETTINGS.filter((id) => keep.has(id));
    progress(t("progress.slimGuest", { name: device.name }));
    await runOk(
      this.runner,
      [avdslim, "on", serial, ...(skip.length > 0 ? [`--skip=${skip.join(",")}`] : [])],
      { timeoutMs: 5 * 60_000 },
    );
    for (const id of skip) {
      if (ENABLEABLE_SETTINGS.has(id)) await runOk(this.runner, [avdslim, "enable", id, serial]);
    }
    const kept = await this.keptPackages(device);
    if (kept.size === 0) return;
    const installed = await this.packages(serial, false);
    for (const pkg of kept) {
      if (installed.has(pkg)) await runOk(this.runner, [avdslim, "enable", pkg, serial]);
    }
  }

  async unslim(device: Device, progress: Progress): Promise<void> {
    const avdslim = this.avdslim();
    const state = (await this.states([device])).get(device.id);
    if (!state?.booted || !state.targetId) {
      throw new HandlerError("INVALID", t("err.unslimNeedsBoot"));
    }
    progress(t("progress.unslimAvd", { name: device.name }));
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
  private async slimCounts(
    serial: string,
    device?: Device,
  ): Promise<{ off: number; relevant: number } | undefined> {
    const [profile, installed, disabled, kept] = await Promise.all([
      this.slimPackages(),
      this.packages(serial, false),
      this.packages(serial, true),
      device ? this.keptPackages(device) : new Set<string>(),
    ]);
    // 남기기로 한 패키지는 세지 않는다 — 커스텀 슬림도 «다 꺼짐» 으로 보이게 (M15)
    const relevant = [...profile].filter((pkg) => installed.has(pkg) && !kept.has(pkg));
    if (relevant.length === 0) return undefined;
    return { off: relevant.filter((pkg) => disabled.has(pkg)).length, relevant: relevant.length };
  }

  /** 기기 설정 하나 — 읽지 못하면 undefined */
  private async setting(serial: string, scope: "global" | "secure", key: string) {
    const result = await this.runner([
      this.adb,
      "-s",
      serial,
      "shell",
      "settings",
      "get",
      scope,
      key,
    ]);
    return result.code === 0 ? result.stdout.trim() : undefined;
  }

  /**
   * 실제로 꺼진 슬림 항목 (M16). 패키지 묶음은 설치된 패키지의 절반 이상이 꺼졌으면,
   * 위치·블루투스·계정 동기화는 기기 설정으로(avdslim 이 바꾸는 값), 카메라는 config.ini, 소리는 켤 때
   * `-no-audio` 를 줬는지로. 백그라운드 제한·초기 설정은 읽을 방법이 없어 Simless 가 슬림한 내용으로 본다
   */
  async slimOff(device: Device, state: RuntimeState): Promise<string[] | undefined> {
    const serial = state.targetId;
    if (!state.booted || !serial || !this.avdslimPath()) return undefined;
    await this.slimCategories();
    const packages = this.slimCache?.packages;
    if (!packages) return undefined;
    const [installed, disabled] = await Promise.all([
      this.packages(serial, false),
      this.packages(serial, true),
    ]);
    const off: string[] = [];
    for (const [id, list] of packages) {
      const present = list.filter((pkg) => installed.has(pkg));
      const gone = present.filter((pkg) => disabled.has(pkg));
      if (present.length > 0 && gone.length * 2 >= present.length) off.push(id);
    }
    const [location, bluetooth, sync] = await Promise.all([
      this.setting(serial, "secure", "location_mode"),
      this.setting(serial, "global", "bluetooth_on"),
      this.setting(serial, "global", "auto_sync"),
    ]);
    if (location === "0") off.push("location");
    if (sync === "0") off.push("sync");
    if (bluetooth === "0") off.push("bluetooth");
    const keep = new Set(device.slimKeep ?? []);
    if (device.slim !== "none") {
      for (const id of ["bglimit", "setup"]) if (!keep.has(id)) off.push(id);
    }
    const config = existsSync(this.configPath(device.native))
      ? readProps(this.configPath(device.native))
      : {};
    if (config["hw.camera.back"] === "none" && (config["hw.camera.front"] ?? "none") === "none") {
      off.push("camera");
    }
    if (this.emulatorArgs(device).includes("-no-audio") || config["hw.audioOutput"] === "no") {
      off.push("audio");
    }
    return off;
  }

  async checkSlim(device: Device, state: RuntimeState): Promise<SlimState | undefined> {
    if (!state.booted || !state.targetId || !this.avdslimPath()) return undefined;
    const counts = await this.slimCounts(state.targetId, device);
    if (!counts) return undefined;
    return counts.off / counts.relevant >= 0.5 ? "applied" : "drifted";
  }

  /** `avdslim measure` 의 Activity Monitor 메모리 — 슬림 후 수치와 같은 기준 */
  async measure(_device: Device, state: RuntimeState): Promise<{ memoryBytes?: number }> {
    if (!state.targetId) throw new HandlerError("INVALID", t("err.measureOff"));
    const out = await runOk(this.runner, [this.avdslim(), "measure", state.targetId], {
      timeoutMs: 60_000,
    });
    return { memoryBytes: parseFootprint(out) };
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
          this.slimCounts(serial, device).catch(() => undefined),
          this.runner([this.avdslim(), "measure", serial], { timeoutMs: 30_000 }),
        ]);
        if (!counts) return;
        stats.set(device.id, {
          disabled: counts.off,
          total: counts.relevant,
          unit: "packages",
          memoryBytes: parseFootprint(measure.stdout),
          measuredAt: Date.now(),
        });
      }),
    );
    return stats;
  }
}
