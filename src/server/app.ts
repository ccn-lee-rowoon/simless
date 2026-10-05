import { z } from "zod";
import type {
  AcquireResult,
  BusyData,
  DeviceView,
  HolderView,
  SlimStats,
  StatusResult,
} from "../shared/api.ts";
import type { Config } from "../shared/config.ts";
import { type Device, layoutHeight, layoutWidth, sizeLabel } from "../shared/model.ts";
import type { Paths } from "../shared/paths.ts";
import { isAlive as defaultIsAlive } from "../shared/proc.ts";
import type { Request, SessionInfo } from "../shared/protocol.ts";
import { VERSION } from "../shared/version.ts";
import { registerDeviceMethods } from "./devices.ts";
import type { Discovered, Driver, RuntimeState } from "./drivers/types.ts";
import { registerGroupMethods } from "./groups.ts";
import { EMPTY_LEASE_STATE, type Holder, LeaseManager, LeaseStateSchema } from "./leases.ts";
import { Registry } from "./registry.ts";
import { type Connection, type Handler, HandlerError } from "./socket.ts";
import { readJson, writeJson } from "./store.ts";

export interface ServerDeps {
  paths: Paths;
  config: Config;
  drivers: Driver[];
  now?: () => number;
  isAlive?: (pid: number, startedAt: number | undefined) => boolean;
}

type Method = (params: unknown, session: SessionInfo, connection: Connection) => Promise<unknown>;

export interface InventoryProblem {
  platform: Device["platform"];
  message: string;
}

const AcquireParams = z.object({
  devices: z.array(z.string()).default([]),
  wait: z.boolean().default(false),
  /** 기다리기의 이번 호출 최대 시간 — 지나면 «아직 대기 중» 으로 돌려준다 */
  timeoutMs: z.number().int().positive().max(3_600_000).default(600_000),
});
const ReleaseParams = z.object({ devices: z.array(z.string()).optional() });
const WhoParams = z.object({ target: z.string().optional() });
const ForceParams = z.object({ device: z.string() });

/** 화면 갱신 알림이 필요 없는 메서드 */
const READ_ONLY = new Set(["status", "device.list", "catalog", "group.list", "lease.who"]);

export type ServerEvent = { type: "changed" } | { type: "progress"; message: string };

function parse<T extends z.ZodType>(schema: T, params: unknown): z.infer<T> {
  const parsed = schema.safeParse(params ?? {});
  if (!parsed.success) throw new HandlerError("INVALID", z.prettifyError(parsed.error));
  return parsed.data;
}

export class CorgiServer {
  readonly registry: Registry;
  readonly leases: LeaseManager;
  private readonly waiters = new Map<string, Set<() => void>>();
  private readonly isAlive: NonNullable<ServerDeps["isAlive"]>;
  private readonly methods: Record<string, Method>;

  constructor(private readonly deps: ServerDeps) {
    this.isAlive = deps.isAlive ?? ((pid, startedAt) => defaultIsAlive(pid, startedAt));
    this.registry = new Registry(deps.paths.registry);
    this.leases = new LeaseManager(
      readJson(deps.paths.leases, LeaseStateSchema, EMPTY_LEASE_STATE),
      {
        idleMs: deps.config.idleReleaseMinutes * 60_000,
        now: deps.now,
        onChange: (state) => {
          writeJson(deps.paths.leases, state);
          this.notify();
        },
        onGranted: (key) => this.wake(key),
      },
    );
    this.methods = {
      status: (_p, session) => this.status(session),
      "lease.acquire": (p, session, connection) =>
        this.acquire(parse(AcquireParams, p), session, connection),
      "lease.release": (p, session) => this.release(parse(ReleaseParams, p), session),
      "lease.who": (p) => this.who(parse(WhoParams, p)),
      "lease.forceRelease": (p, session) => this.forceRelease(parse(ForceParams, p), session),
    };
    registerDeviceMethods(this);
    registerGroupMethods(this);
  }

  /** 다른 모듈(드라이버 명령 등)이 메서드를 붙인다 */
  addMethod(name: string, method: Method): void {
    this.methods[name] = method;
  }

  readonly handle: Handler = async (request: Request, connection: Connection) => {
    const method = this.methods[request.method];
    if (!method) throw new HandlerError("INVALID", `모르는 메서드: ${request.method}`);
    // 요청이 곧 «사용» 이다 — 마지막 사용 시각 갱신 (R17). 웹 UI(사람)는 점유 기록을 남기지 않는다
    if (!request.session.human || this.leases.session(request.session.key))
      this.leases.touch(request.session);
    try {
      return await method(request.params, request.session, connection);
    } finally {
      // 읽기만 하는 메서드가 아니면 화면(웹 UI·메뉴바)에 바뀌었다고 알린다
      if (!READ_ONLY.has(request.method)) {
        this.invalidate();
        this.notify();
      }
    }
  };

  private readonly listeners = new Set<(event: ServerEvent) => void>();

  /** 웹 UI·메뉴바가 SSE 로 받는 변화 알림 */
  subscribe(listener: (event: ServerEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  publish(event: ServerEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  notify(): void {
    this.publish({ type: "changed" });
  }

  /** 2초마다 — 끝난 세션의 점유를 풀고, 오래 안 쓴 점유 중 누가 기다리는 것을 푼다 */
  tick(): void {
    for (const session of this.leases.snapshot().sessions) {
      if (
        !session.human &&
        session.pid !== undefined &&
        !this.isAlive(session.pid, session.pidStartedAt)
      ) {
        this.leases.endSession(session.key);
      }
    }
    this.leases.sweepIdle();
  }

  get config(): Config {
    return this.deps.config;
  }

  driverOrUndefined(platform: Device["spec"]["platform"]): Driver | undefined {
    return this.deps.drivers.find((d) => d.platform === platform);
  }

  driver(platform: Device["spec"]["platform"]): Driver {
    const driver = this.deps.drivers.find((d) => d.platform === platform);
    if (!driver) throw new HandlerError("TOOL_MISSING", `${platform} 드라이버가 없습니다`);
    return driver;
  }

  private inventoryCache?: { at: number; devices: Device[]; problems: InventoryProblem[] };

  /** 목록을 바꾸는 작업(만들기·이름 변경·삭제) 뒤에 부른다 */
  invalidate(): void {
    this.inventoryCache = undefined;
  }

  /**
   * 이 Mac 의 디바이스 전부 (R20) — 드라이버가 읽은 기기에 레지스트리 정보를 붙인다.
   * 처음 보는 기기에는 ID 를 붙이고, 목록 읽기가 성공한 플랫폼에서 사라진 기기의 정보는 지운다.
   * 목록을 자주 묻으므로(웹 화면·CLI) 잠깐 기억해 둔다.
   */
  async inventory(): Promise<{ devices: Device[]; problems: InventoryProblem[] }> {
    if (this.inventoryCache && Date.now() - this.inventoryCache.at < 1500)
      return this.inventoryCache;
    const devices: Device[] = [];
    const problems: InventoryProblem[] = [];
    for (const driver of this.deps.drivers) {
      let found: Discovered[];
      try {
        found = await driver.list();
      } catch (error) {
        problems.push({
          platform: driver.platform,
          message: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
      for (const item of found) {
        const meta = this.registry.adopt(
          driver.platform,
          item.native,
          driver.platform === "android" && item.native.startsWith("corgi_"),
        );
        devices.push({ ...meta, name: item.name, spec: item.spec });
      }
      const gone = this.registry.prune(driver.platform, new Set(found.map((f) => f.native)));
      for (const id of gone) this.leases.forgetDevice(id);
    }
    this.inventoryCache = { at: Date.now(), devices, problems };
    return this.inventoryCache;
  }

  async devices(): Promise<Device[]> {
    return (await this.inventory()).devices;
  }

  /** ID·AVD ID·UDID·이름(대소문자 무시)으로 찾는다. 없으면 NOT_FOUND, 이름이 여럿이면 INVALID */
  async resolve(refs: string[]): Promise<Device[]> {
    const devices = await this.devices();
    return refs.map((ref) => {
      const exact = devices.find((d) => d.id === ref || d.native === ref);
      if (exact) return exact;
      const lower = ref.toLowerCase();
      const named = devices.filter((d) => d.name.toLowerCase() === lower);
      if (named.length === 0) throw new HandlerError("NOT_FOUND", `없는 디바이스: ${ref}`);
      if (named.length > 1) {
        throw new HandlerError(
          "INVALID",
          `이름이 같은 디바이스가 여럿입니다 — ID 로 고르세요:\n${named
            .map((d) => `  ${d.id}  ${sizeLabel(d.spec)}  ${d.native}`)
            .join("\n")}`,
        );
      }
      return named[0] as Device;
    });
  }

  async runtimeStates(devices: Device[]): Promise<Map<string, RuntimeState>> {
    const result = new Map<string, RuntimeState>();
    for (const driver of this.deps.drivers) {
      const mine = devices.filter((d) => d.spec.platform === driver.platform);
      if (mine.length === 0) continue;
      const states = await driver.states(mine).catch(() => new Map<string, RuntimeState>());
      for (const [id, state] of states) result.set(id, state);
    }
    return result;
  }

  holderView(holder: Holder | undefined): HolderView | undefined {
    if (!holder) return undefined;
    const { session } = holder;
    return {
      sessionKey: session.key,
      agent: session.agent,
      cwd: session.cwd,
      human: session.human,
      since: holder.since,
      reason: holder.reason,
    };
  }

  private readonly slimStatsCache = new Map<string, SlimStats>();
  private slimStatsAt = 0;
  private slimStatsBooted = "";
  private slimStatsRefreshing = false;

  /**
   * 슬림 수치는 읽는 데 몇 초 걸린다(simslim list 등) — 목록은 기다리지 않고 지난 값을 붙이고,
   * 15초가 지났으면 뒤에서 다시 읽은 뒤 화면에 바뀌었다고 알린다.
   */
  private refreshSlimStats(all: Device[], states: Map<string, RuntimeState>): void {
    // 슬림 수치는 Corgi 가 슬림화한 기기만 본다
    const devices = all.filter((d) => d.createdByCorgi && states.get(d.id)?.booted);
    // 켜진 디바이스가 바뀌면 시간과 상관없이 다시 읽는다
    const booted = devices.map((d) => d.id).join(",");
    if (this.slimStatsRefreshing) return;
    if (booted === this.slimStatsBooted && Date.now() - this.slimStatsAt < 15_000) return;
    this.slimStatsRefreshing = true;
    Promise.all(
      this.deps.drivers.map((driver) =>
        driver
          .slimStats(
            devices.filter((d) => d.spec.platform === driver.platform),
            states,
          )
          .catch(() => new Map<string, SlimStats>()),
      ),
    )
      .then((maps) => {
        this.slimStatsCache.clear();
        for (const map of maps) for (const [id, stats] of map) this.slimStatsCache.set(id, stats);
        this.slimStatsAt = Date.now();
        this.slimStatsBooted = booted;
        if (devices.length > 0) this.notify();
      })
      .finally(() => {
        this.slimStatsRefreshing = false;
      });
  }

  async deviceViews(session: SessionInfo, only?: Device[]): Promise<DeviceView[]> {
    const all = await this.devices();
    const devices = only ?? all;
    const states = await this.runtimeStates(devices);
    if (!only) this.writeManagedIndex(all, states);
    this.refreshSlimStats(devices, states);
    const leases = new Map(this.leases.snapshot().leases.map((l) => [l.deviceId, l]));
    const defaults = this.registry.defaults();
    const groups = this.registry.groups();
    return devices.map((device) => {
      const state = states.get(device.id);
      const lease = leases.get(device.id);
      const holderSession = lease ? this.leases.session(lease.sessionKey) : undefined;
      return {
        ...device,
        label: sizeLabel(device.spec),
        layoutWidth: layoutWidth(device.spec),
        layoutHeight: layoutHeight(device.spec),
        booted: state?.booted ?? false,
        targetId: state?.booted ? state.targetId : undefined,
        holder:
          lease && holderSession
            ? this.holderView({
                deviceId: device.id,
                session: holderSession,
                since: lease.acquiredAt,
                reason: "held",
              })
            : undefined,
        slimStats: state?.booted ? this.slimStatsCache.get(device.id) : undefined,
        mine: lease?.sessionKey === session.key,
        default: defaults[device.platform] === device.id,
        groups: groups.filter((g) => g.deviceIds.includes(device.id)).map((g) => g.id),
      };
    });
  }

  private lastIndex = "";

  /** 서버가 꺼졌을 때 훅이 «이 Mac 의 디바이스인지» 판단하는 파일 (P9, docs/design.md §5) */
  writeManagedIndex(all: Device[], states: Map<string, RuntimeState>): void {
    const devices = all.map((d) => ({
      id: d.id,
      name: d.name,
      platform: d.spec.platform,
      native: d.native,
      targetId: states.get(d.id)?.targetId,
    }));
    const text = JSON.stringify(devices);
    if (text === this.lastIndex) return;
    this.lastIndex = text;
    writeJson(this.deps.paths.managedIndex, { updatedAt: new Date().toISOString(), devices });
  }

  private async status(session: SessionInfo): Promise<StatusResult> {
    const snapshot = this.leases.snapshot();
    return {
      serverVersion: VERSION,
      session,
      held: this.leases.heldBy(session.key),
      queuePosition: this.leases.queuePosition(session.key),
      devices: await this.deviceViews(session),
      groups: this.registry.groups(),
      defaults: this.registry.defaults(),
      queue: snapshot.queue.map((e) => ({
        sessionKey: e.sessionKey,
        agent: this.leases.session(e.sessionKey)?.agent ?? "unknown",
        deviceIds: e.deviceIds,
        enqueuedAt: e.enqueuedAt,
      })),
    };
  }

  private holdersData(holders: Holder[]): BusyData["holders"] {
    return holders.flatMap((h) => {
      const view = this.holderView(h);
      return view ? [{ ...view, deviceId: h.deviceId }] : [];
    });
  }

  private async acquire(
    params: z.infer<typeof AcquireParams>,
    session: SessionInfo,
    connection: Connection,
  ): Promise<AcquireResult> {
    if (params.devices.length === 0)
      throw new HandlerError("INVALID", "점유할 디바이스를 지정하세요");
    const devices = await this.resolve(params.devices);
    const ids = devices.map((d) => d.id);

    const result = this.leases.acquire(session, ids, { wait: params.wait });
    if (result.status === "granted") return result;
    if (result.status === "busy") {
      const data: BusyData = { holders: this.holdersData(result.holders) };
      throw new HandlerError("BUSY", "다른 세션이 사용 중입니다", data);
    }

    connection.emit("queued", {
      position: result.position,
      holders: this.holdersData(result.holders),
    });
    await this.waitForGrant(session.key, params.timeoutMs, connection);

    const held = new Set(this.leases.heldBy(session.key));
    if (ids.every((id) => held.has(id))) return { status: "granted", deviceIds: ids };
    const again = this.leases.acquire(session, ids, { wait: true });
    if (again.status === "granted") return again;
    if (again.status === "busy") throw new HandlerError("BUSY", "다른 세션이 사용 중입니다");
    return { status: "queued", position: again.position, holders: this.holdersData(again.holders) };
  }

  private waitForGrant(
    sessionKey: string,
    timeoutMs: number,
    connection: Connection,
  ): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.waiters.get(sessionKey)?.delete(done);
        resolve();
      };
      const timer = setTimeout(done, timeoutMs);
      if (!this.waiters.has(sessionKey)) this.waiters.set(sessionKey, new Set());
      this.waiters.get(sessionKey)?.add(done);
      // 클라이언트가 끊어도 대기열 항목은 남는다 — 이 호출만 끝낸다
      connection.onClose(done);
    });
  }

  private wake(sessionKey: string): void {
    for (const done of [...(this.waiters.get(sessionKey) ?? [])]) done();
  }

  private async release(params: z.infer<typeof ReleaseParams>, session: SessionInfo) {
    const ids = params.devices ? (await this.resolve(params.devices)).map((d) => d.id) : undefined;
    return { released: this.leases.release(session.key, ids) };
  }

  /** 강제 해제 — 사람(웹 UI·CLI --force)만 (docs/design.md §8) */
  private async forceRelease(params: z.infer<typeof ForceParams>, session: SessionInfo) {
    if (!session.human)
      throw new HandlerError(
        "INVALID",
        "강제 해제는 사람만 할 수 있습니다 — 에이전트는 기다리거나 사용자에게 물으세요",
      );
    const [device] = await this.resolve([params.device]);
    const holder = device ? this.leases.holderOf(device.id) : undefined;
    if (!device || !holder) return { released: [] };
    return { released: this.leases.release(holder.key, [device.id]) };
  }

  private async who(params: z.infer<typeof WhoParams>) {
    const snapshot = this.leases.snapshot();
    let devices = await this.devices();
    if (params.target) {
      const target = params.target;
      const states = await this.runtimeStates(devices);
      devices = devices.filter(
        (d) =>
          d.id === target ||
          d.name === target ||
          d.native === target ||
          states.get(d.id)?.targetId === target,
      );
      if (devices.length === 0)
        throw new HandlerError("NOT_FOUND", `이 Mac 의 디바이스가 아닙니다: ${target}`);
    }
    return devices.map((device) => {
      const lease = snapshot.leases.find((l) => l.deviceId === device.id);
      const session = lease ? this.leases.session(lease.sessionKey) : undefined;
      return {
        deviceId: device.id,
        name: device.name,
        holder:
          lease && session
            ? this.holderView({
                deviceId: device.id,
                session,
                since: lease.acquiredAt,
                reason: "held",
              })
            : undefined,
      };
    });
  }
}
