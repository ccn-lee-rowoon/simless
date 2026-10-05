import { z } from "zod";
import { DeviceMeta, DeviceSpec, type Platform, SlimState } from "../shared/model.ts";
import { readJson, writeJson } from "./store.ts";

const RegistryV2 = z.object({ version: z.literal(2), devices: z.array(DeviceMeta) });

/** 1단계~3단계의 형식 — Corgi 가 만든 디바이스만, 이름·크기까지 저장했다 */
const RegistryV1 = z.object({
  version: z.literal(1),
  devices: z.array(
    z.object({
      id: z.string(),
      native: z.string(),
      spec: DeviceSpec,
      slim: SlimState,
      slimError: z.string().optional(),
      slimBaseline: DeviceMeta.shape.slimBaseline,
      createdAt: z.string(),
    }),
  ),
});

const RegistryFile = z.union([RegistryV2, RegistryV1]);

function migrate(file: z.infer<typeof RegistryFile>): DeviceMeta[] {
  if (file.version === 2) return file.devices;
  return file.devices.map((d) => ({
    id: d.id,
    platform: d.spec.platform,
    native: d.native,
    createdByCorgi: true,
    slim: d.slim,
    slimError: d.slimError,
    slimBaseline: d.slimBaseline,
    createdAt: d.createdAt,
  }));
}

/**
 * 디바이스에 Corgi 가 붙인 정보 (docs/design.md §6). 기기 목록 자체는 드라이버에서 읽고,
 * 여기에는 ID·만든 여부·슬림 상태 등만 둔다 — `native`(AVD ID·UDID)로 기기와 잇는다.
 */
export class Registry {
  private devices: DeviceMeta[];

  constructor(private readonly path: string) {
    this.devices = migrate(readJson(path, RegistryFile, { version: 2, devices: [] }));
  }

  list(): DeviceMeta[] {
    return [...this.devices];
  }

  get(id: string): DeviceMeta | undefined {
    return this.devices.find((d) => d.id === id);
  }

  findByNative(platform: Platform, native: string): DeviceMeta | undefined {
    return this.devices.find((d) => d.platform === platform && d.native === native);
  }

  /** 겹치지 않는 짧은 ID — AVD ID(`corgi_<id>`)에도 쓰므로 소문자·숫자만 */
  newId(): string {
    for (;;) {
      const id = Math.random().toString(36).slice(2, 6);
      if (id.length === 4 && !this.get(id)) return id;
    }
  }

  add(device: DeviceMeta): DeviceMeta {
    if (this.get(device.id)) throw new Error(`이미 있는 ID: ${device.id}`);
    const parsed = DeviceMeta.parse(device);
    this.devices.push(parsed);
    this.save();
    return parsed;
  }

  /** 처음 본 기기에 ID 를 붙인다 */
  adopt(platform: Platform, native: string, createdByCorgi: boolean): DeviceMeta {
    return (
      this.findByNative(platform, native) ??
      this.add({
        id: this.newId(),
        platform,
        native,
        createdByCorgi,
        slim: "none",
        createdAt: new Date().toISOString(),
      })
    );
  }

  update(id: string, patch: Partial<Omit<DeviceMeta, "id" | "platform" | "native">>): DeviceMeta {
    const index = this.devices.findIndex((d) => d.id === id);
    const current = this.devices[index];
    if (!current) throw new Error(`없는 디바이스: ${id}`);
    const next = DeviceMeta.parse({ ...current, ...patch });
    this.devices[index] = next;
    this.save();
    return next;
  }

  remove(id: string): void {
    this.devices = this.devices.filter((d) => d.id !== id);
    this.save();
  }

  /** 이 플랫폼에서 더는 보이지 않는 기기의 정보를 지운다 — 지운 ID 를 돌려준다 */
  prune(platform: Platform, seen: Set<string>): string[] {
    const gone = this.devices.filter((d) => d.platform === platform && !seen.has(d.native));
    if (gone.length === 0) return [];
    const ids = new Set(gone.map((d) => d.id));
    this.devices = this.devices.filter((d) => !ids.has(d.id));
    this.save();
    return [...ids];
  }

  private save(): void {
    writeJson(this.path, { version: 2, devices: this.devices });
  }
}
