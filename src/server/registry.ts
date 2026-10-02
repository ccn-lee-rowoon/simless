import { z } from "zod";
import { Device } from "../shared/model.ts";
import { readJson, writeJson } from "./store.ts";

const RegistryFile = z.object({ version: z.literal(1), devices: z.array(Device) });

/** Corgi 가 만든 디바이스 목록 (M5). 관리 대상은 여기 있는 것뿐이다. */
export class Registry {
  private devices: Device[];

  constructor(private readonly path: string) {
    this.devices = readJson(path, RegistryFile, { version: 1, devices: [] }).devices;
  }

  list(): Device[] {
    return [...this.devices];
  }

  get(id: string): Device | undefined {
    return this.devices.find((d) => d.id === id);
  }

  /** ID 나 이름(대소문자 무시)으로 찾는다 */
  find(ref: string): Device | undefined {
    const lower = ref.toLowerCase();
    return this.get(ref) ?? this.devices.find((d) => d.name.toLowerCase() === lower);
  }

  findByNative(native: string): Device | undefined {
    return this.devices.find((d) => d.native === native);
  }

  /** 겹치지 않는 짧은 ID — AVD ID(`corgi_<id>`)에도 쓰므로 소문자·숫자만 */
  newId(): string {
    for (;;) {
      const id = Math.random().toString(36).slice(2, 6);
      if (id.length === 4 && !this.get(id)) return id;
    }
  }

  add(device: Device): void {
    if (this.get(device.id)) throw new Error(`이미 있는 ID: ${device.id}`);
    this.devices.push(device);
    this.save();
  }

  update(id: string, patch: Partial<Omit<Device, "id">>): Device {
    const index = this.devices.findIndex((d) => d.id === id);
    const current = this.devices[index];
    if (!current) throw new Error(`없는 디바이스: ${id}`);
    const next = Device.parse({ ...current, ...patch });
    this.devices[index] = next;
    this.save();
    return next;
  }

  remove(id: string): void {
    this.devices = this.devices.filter((d) => d.id !== id);
    this.save();
  }

  private save(): void {
    writeJson(this.path, { version: 1, devices: this.devices });
  }
}
