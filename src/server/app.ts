import type { Fix } from "../install/fixes.ts";
import type {
  CheckView,
  DeviceView,
  FixId,
  HolderView,
  JobView,
  SlimStats,
  StatusResult,
} from "../shared/api.ts";
import type { Config } from "../shared/config.ts";
import { type Lang, resolveLanguage, setLanguage, t } from "../shared/i18n.ts";
import { type Device, layoutHeight, layoutWidth, sizeLabel } from "../shared/model.ts";
import type { Paths } from "../shared/paths.ts";
import { isAlive as defaultIsAlive } from "../shared/proc.ts";
import type { Request, SessionInfo } from "../shared/protocol.ts";
import { VERSION } from "../shared/version.ts";
import { registerDeviceMethods } from "./devices.ts";
import type { Discovered, Driver, RuntimeState } from "./drivers/types.ts";
import { registerGroupMethods } from "./groups.ts";
import { History } from "./history.ts";
import { registerHookMethods } from "./hook.ts";
import { registerLeaseMethods } from "./lease-methods.ts";
import { EMPTY_LEASE_STATE, type Holder, LeaseManager, LeaseStateSchema } from "./leases.ts";
import { Registry } from "./registry.ts";
import { registerSettingsMethods } from "./settings.ts";
import { registerSetupMethods, setupNeeded } from "./setup.ts";
import { type Connection, type Handler, HandlerError } from "./socket.ts";
import { readJson, writeJson } from "./store.ts";

export interface ServerDeps {
  paths: Paths;
  config: Config;
  drivers: Driver[];
  /** 언어 설정이 system 일 때 볼 선호 언어 — 서버는 macOS 언어 설정을 준다 (R25) */
  systemLanguages?: () => string[];
  now?: () => number;
  /** 첫 실행 설정 창이 스킬·훅·MCP 를 넣을 때 보는 환경(HOME) — 테스트는 임시 HOME 을 준다 (M14) */
  env?: NodeJS.ProcessEnv;
  /** 훅·MCP 에 적을 corgi 명령 — 기본은 지금 실행 중인 corgi */
  selfCommand?: string[];
  /** 설정 창의 점검 — 기본은 corgi doctor 와 같은 점검. 테스트는 바꾼다 */
  setupChecks?: () => Promise<CheckView[]>;
  /** 설정 창의 설치 명령 — 기본은 install/fixes.ts. 테스트는 가짜 명령으로 바꾼다 */
  fixes?: Partial<Record<FixId, Fix>>;
  isAlive?: (pid: number, startedAt: number | undefined) => boolean;
}

type Method = (params: unknown, session: SessionInfo, connection: Connection) => Promise<unknown>;

export interface InventoryProblem {
  platform: Device["platform"];
  message: string;
}

/** 화면 갱신 알림이 필요 없는 메서드 */
const READ_ONLY = new Set([
  "status",
  "device.list",
  "device.available",
  "catalog",
  "group.list",
  "lease.who",
  "lease.history",
  "lease.sessions",
  "settings.get",
  "hook.check",
  "setup.jobs",
]);

export type ServerEvent =
  | { type: "changed" }
  | { type: "progress"; message: string }
  /** 설정 창의 설치 — 출력 한 줄, 상태가 바뀜 (M14) */
  | { type: "output"; job: string; line: string }
  | { type: "job"; job: JobView };

export class CorgiServer {
  readonly registry: Registry;
  readonly leases: LeaseManager;
  readonly history: History;
  private readonly waiters = new Map<string, Set<() => void>>();
  private readonly isAlive: NonNullable<ServerDeps["isAlive"]>;
  private readonly methods: Record<string, Method>;

  constructor(private readonly deps: ServerDeps) {
    this.isAlive = deps.isAlive ?? ((pid, startedAt) => defaultIsAlive(pid, startedAt));
    this.registry = new Registry(deps.paths.registry);
    this.history = new History(deps.paths.history, {
      retentionDays: deps.config.historyRetentionDays,
      legacyPath: deps.paths.legacyHistory,
      now: deps.now,
    });
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
        onHistory: (event) => this.history.add(event),
      },
    );
    this.methods = {
      status: (_p, session) => this.status(session),
    };
    this.applyLanguage();
    registerDeviceMethods(this);
    registerGroupMethods(this);
    registerHookMethods(this);
    registerSetupMethods(this);
    registerLeaseMethods(this);
    registerSettingsMethods(this);
  }

  /** 다른 모듈(드라이버 명령 등)이 메서드를 붙인다 */
  addMethod(name: string, method: Method): void {
    this.methods[name] = method;
  }

  readonly handle: Handler = async (request: Request, connection: Connection) => {
    const method = this.methods[request.method];
    if (!method)
      throw new HandlerError("INVALID", t("err.unknownMethod", { method: request.method }));
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

  /** 스킬 업데이트가 있는지 — setup.ts 가 켤 때·10분마다·설치를 바꿀 때 다시 본다 (S9) */
  skillUpdate = false;

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
    this.history.pruneIfDue();
  }

  get config(): Config {
    return this.deps.config;
  }

  get paths(): Paths {
    return this.deps.paths;
  }

  /** 첫 실행 설정 창이 쓰는 것 (M14) */
  get setupDeps(): Pick<ServerDeps, "env" | "selfCommand" | "setupChecks" | "fixes"> {
    return this.deps;
  }

  /** 지금 언어 — 서버가 만드는 오류·진행 문장도 이 언어로 (R25) */
  get lang(): Lang {
    return resolveLanguage(this.deps.config.language, this.deps.systemLanguages?.() ?? []);
  }

  /** 설정 언어를 서버 문장(오류·진행)에 적용한다 */
  applyLanguage(): void {
    setLanguage(this.lang);
  }

  driverOrUndefined(platform: Device["spec"]["platform"]): Driver | undefined {
    return this.deps.drivers.find((d) => d.platform === platform);
  }

  driver(platform: Device["spec"]["platform"]): Driver {
    const driver = this.deps.drivers.find((d) => d.platform === platform);
    if (!driver) throw new HandlerError("TOOL_MISSING", t("err.noDriver", { platform }));
    return driver;
  }

  private inventoryCache?: { at: number; devices: Device[]; problems: InventoryProblem[] };

  private readonly invalidators: (() => void)[] = [];

  /** 목록·켜짐이 바뀌는 작업(만들기·이름 변경·삭제·켜기·끄기) 뒤에 부른다 */
  invalidate(): void {
    this.inventoryCache = undefined;
    for (const fn of this.invalidators) fn();
  }

  /** invalidate 때 함께 버릴 기억 */
  onInvalidate(fn: () => void): void {
    this.invalidators.push(fn);
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
        devices.push({
          ...meta,
          listed: meta.listed ?? this.wasInUse(meta),
          name: item.name,
          spec: item.spec,
        });
      }
      const gone = this.registry.prune(driver.platform, new Set(found.map((f) => f.native)));
      for (const id of gone) this.leases.forgetDevice(id);
    }
    this.inventoryCache = { at: Date.now(), devices, problems };
    return this.inventoryCache;
  }

  /**
   * listed 가 없는(이전 형식) 정보 — Corgi 가 만든 것, 기본 디바이스, 그룹에 든 것은 이미 쓰던
   * 기기라 목록에 둔다. 나머지(Xcode 기본 시뮬레이터 등)는 빼 둔다
   */
  private wasInUse(meta: { id: string; platform: Device["platform"]; createdByCorgi: boolean }) {
    return (
      meta.createdByCorgi ||
      this.registry.defaults()[meta.platform] === meta.id ||
      this.registry.groups().some((g) => g.deviceIds.includes(meta.id))
    );
  }

  /** Corgi 목록 — 메인 목록·점유·보호는 이것만 (R20) */
  async devices(): Promise<Device[]> {
    return (await this.inventory()).devices.filter((d) => d.listed);
  }

  /** 이 Mac 에 있지만 Corgi 목록에 없는 디바이스 — 생성 화면에서 골라 추가한다 */
  async available(): Promise<Device[]> {
    return (await this.inventory()).devices.filter((d) => !d.listed);
  }

  /** 이 Mac 에는 있지만 Corgi 목록에 없는 디바이스인지 — 오류 안내용 */
  private isOnMac(ref: string): boolean {
    const lower = ref.toLowerCase();
    return (this.inventoryCache?.devices ?? []).some(
      (d) => !d.listed && (d.id === ref || d.native === ref || d.name.toLowerCase() === lower),
    );
  }

  /** ID·AVD ID·UDID·이름(대소문자 무시)으로 찾는다. 없으면 NOT_FOUND, 이름이 여럿이면 INVALID */
  async resolve(refs: string[]): Promise<Device[]> {
    const devices = await this.devices();
    return refs.map((ref) => {
      const exact = devices.find((d) => d.id === ref || d.native === ref);
      if (exact) return exact;
      const lower = ref.toLowerCase();
      const named = devices.filter((d) => d.name.toLowerCase() === lower);
      if (named.length === 0) {
        throw new HandlerError(
          "NOT_FOUND",
          t(this.isOnMac(ref) ? "err.notListed" : "err.noDevice", { ref }),
        );
      }
      if (named.length > 1) {
        throw new HandlerError(
          "INVALID",
          t("err.ambiguousDevice", {
            list: named.map((d) => `  ${d.id}  ${sizeLabel(d.spec)}  ${d.native}`).join("\n"),
          }),
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
      language: this.lang,
      systemLanguage: resolveLanguage("system", this.deps.systemLanguages?.() ?? []),
      session,
      held: this.leases.heldBy(session.key),
      queuePosition: this.leases.queuePosition(session.key),
      devices: await this.deviceViews(session),
      groups: this.registry.groups(),
      defaults: this.registry.defaults(),
      // 점유하거나 기다리는 세션만 — 조회만 한 세션은 빼고
      sessions: snapshot.sessions
        .filter(
          (s) =>
            snapshot.leases.some((l) => l.sessionKey === s.key) ||
            snapshot.queue.some((e) => e.sessionKey === s.key),
        )
        .map((s) => ({
          sessionKey: s.key,
          agentSessionId: s.agentSessionId,
          agent: s.agent,
          cwd: s.cwd,
          human: s.human,
          lastUsedAt: s.lastUsedAt,
          held: snapshot.leases
            .filter((l) => l.sessionKey === s.key)
            .map((l) => ({ deviceId: l.deviceId, since: l.acquiredAt })),
          queued: snapshot.queue.find((e) => e.sessionKey === s.key)?.deviceIds ?? [],
          queuePosition: this.leases.queuePosition(s.key),
        })),
      queue: snapshot.queue.map((e) => ({
        sessionKey: e.sessionKey,
        agent: this.leases.session(e.sessionKey)?.agent ?? "unknown",
        deviceIds: e.deviceIds,
        enqueuedAt: e.enqueuedAt,
      })),
      setupNeeded: setupNeeded(this.deps.paths),
      skillUpdate: this.skillUpdate,
    };
  }

  /** 다른 메서드를 안에서 부른다 — 기본 디바이스를 만들 때 device.create 를 그대로 쓴다 */
  invoke(name: string, params: unknown, session: SessionInfo, connection: Connection) {
    const method = this.methods[name];
    if (!method) throw new HandlerError("INVALID", t("err.unknownMethod", { method: name }));
    return method(params, session, connection);
  }

  /** 대기열에 넣은 세션의 차례가 오거나 시간이 지나거나 연결이 끊길 때까지 기다린다 */
  waitForGrant(sessionKey: string, timeoutMs: number, connection: Connection): Promise<void> {
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
}
