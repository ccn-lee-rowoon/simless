import { z } from "zod";
import {
  Defaults,
  DeviceMeta,
  DeviceSpec,
  Group,
  type Platform,
  SlimState,
} from "../shared/model.ts";
import { readJson, writeJson } from "./store.ts";

const RegistryV2 = z.object({
  version: z.literal(2),
  devices: z.array(DeviceMeta),
  groups: z.array(Group).default([]),
  defaults: Defaults.default({}),
});
type RegistryV2 = z.infer<typeof RegistryV2>;

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

function migrate(file: z.infer<typeof RegistryFile>): RegistryV2 {
  if (file.version === 2) return file;
  return {
    version: 2,
    devices: file.devices.map((d) => ({
      id: d.id,
      platform: d.spec.platform,
      native: d.native,
      createdByCorgi: true,
      slim: d.slim,
      slimError: d.slimError,
      slimBaseline: d.slimBaseline,
      createdAt: d.createdAt,
    })),
    groups: [],
    defaults: {},
  };
}

export type GroupPatch = Partial<Pick<Group, "name" | "description" | "deviceIds">>;

/**
 * 디바이스에 Corgi 가 붙인 정보 (docs/design.md §6). 기기 목록 자체는 드라이버에서 읽고,
 * 여기에는 ID·만든 여부·슬림 상태·메모와 그룹·기본 디바이스만 둔다 — `native`(AVD ID·UDID)로
 * 기기와 잇는다.
 */
export class Registry {
  private devices: DeviceMeta[];
  private groupList: Group[];
  private defaultIds: Defaults;

  constructor(private readonly path: string) {
    const file = migrate(
      readJson(path, RegistryFile, { version: 2, devices: [], groups: [], defaults: {} }),
    );
    this.devices = file.devices;
    this.groupList = file.groups;
    this.defaultIds = file.defaults;
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

  /** 겹치지 않는 짧은 ID — AVD ID(`corgi_<id>`)에도 쓰므로 소문자·숫자만. 그룹 ID 와도 안 겹친다 */
  newId(): string {
    for (;;) {
      const id = Math.random().toString(36).slice(2, 6);
      if (id.length === 4 && !this.get(id) && !this.group(id)) return id;
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

  /** 디바이스를 지우면 그룹 소속·기본 지정도 함께 지운다 (M8) */
  remove(id: string): void {
    this.forget(new Set([id]));
    this.save();
  }

  /** 이 플랫폼에서 더는 보이지 않는 기기의 정보를 지운다 — 지운 ID 를 돌려준다 */
  prune(platform: Platform, seen: Set<string>): string[] {
    const gone = this.devices.filter((d) => d.platform === platform && !seen.has(d.native));
    if (gone.length === 0) return [];
    const ids = new Set(gone.map((d) => d.id));
    this.forget(ids);
    this.save();
    return [...ids];
  }

  private forget(ids: Set<string>): void {
    this.devices = this.devices.filter((d) => !ids.has(d.id));
    for (const group of this.groupList)
      group.deviceIds = group.deviceIds.filter((id) => !ids.has(id));
    for (const platform of ["android", "ios"] as const) {
      const current = this.defaultIds[platform];
      if (current && ids.has(current)) delete this.defaultIds[platform];
    }
  }

  // 기본 디바이스 (R22)

  defaults(): Defaults {
    return { ...this.defaultIds };
  }

  setDefault(platform: Platform, id: string): void {
    this.defaultIds[platform] = id;
    this.save();
  }

  // 그룹 (R21)

  groups(): Group[] {
    return this.groupList.map((g) => ({ ...g, deviceIds: [...g.deviceIds] }));
  }

  group(id: string): Group | undefined {
    return this.groupList.find((g) => g.id === id);
  }

  /** ID 또는 이름(대소문자 무시)으로 찾는다 */
  findGroup(ref: string): Group | undefined {
    const lower = ref.toLowerCase();
    return this.group(ref) ?? this.groupList.find((g) => g.name.toLowerCase() === lower);
  }

  addGroup(group: Omit<Group, "id">): Group {
    const parsed = Group.parse({ ...group, id: this.newId() });
    this.groupList.push(parsed);
    this.save();
    return parsed;
  }

  updateGroup(id: string, patch: GroupPatch & Pick<Group, "updatedBy" | "updatedAt">): Group {
    const index = this.groupList.findIndex((g) => g.id === id);
    const current = this.groupList[index];
    if (!current) throw new Error(`없는 그룹: ${id}`);
    // 안 준 값(undefined)은 그대로 둔다
    const given = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
    const next = Group.parse({ ...current, ...given });
    this.groupList[index] = next;
    this.save();
    return next;
  }

  removeGroup(id: string): void {
    this.groupList = this.groupList.filter((g) => g.id !== id);
    this.save();
  }

  private save(): void {
    writeJson(this.path, {
      version: 2,
      devices: this.devices,
      groups: this.groupList,
      defaults: this.defaultIds,
    });
  }
}
