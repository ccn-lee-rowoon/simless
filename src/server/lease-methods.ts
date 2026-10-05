import { z } from "zod";
import type { AcquireResult, BusyData, LeaseItem } from "../shared/api.ts";
import { t } from "../shared/i18n.ts";
import type { Device } from "../shared/model.ts";
import type { SessionInfo } from "../shared/protocol.ts";
import type { CorgiServer } from "./app.ts";
import type { Holder } from "./leases.ts";
import { parse } from "./params.ts";
import { type Connection, HandlerError } from "./socket.ts";

// 점유 메서드 (R13·R14·R17·R21~R23) — 요청을 디바이스로 풀고 LeaseManager 에 맡긴다.
// 순서·대기열·교착 판단은 LeaseManager(leases.ts)가, 여기서는 요청 해석·결과 모양·기다리기를 한다.

const AcquireParams = z.object({
  devices: z.array(z.string()).default([]),
  /** 그룹의 디바이스 전부 (R21) */
  group: z.string().optional(),
  /** 기본 디바이스 — 플랫폼 하나 또는 둘 다 (R22) */
  default: z.enum(["android", "ios", "both"]).optional(),
  /** 기본 디바이스를 달라는데 그 플랫폼에 디바이스가 하나도 없으면 추천 기종을 슬림으로 만든다 (R22) */
  create: z.boolean().default(false),
  /** all = 전부 아니면 아무것도, available = 비어 있는 것만 (R23) */
  mode: z.enum(["all", "available"]).default("all"),
  wait: z.boolean().default(false),
  /** 기다리기의 이번 호출 최대 시간 — 지나면 «아직 대기 중» 으로 돌려준다 */
  timeoutMs: z.number().int().positive().max(3_600_000).default(600_000),
});
type AcquireParams = z.infer<typeof AcquireParams>;
const ReleaseParams = z.object({ devices: z.array(z.string()).optional() });
const WhoParams = z.object({ target: z.string().optional() });
const ForceParams = z.object({ device: z.string() });
const HistoryParams = z.object({
  limit: z.number().int().positive().max(5000).default(100),
  session: z.string().optional(),
});
const SessionsParams = z.object({
  limit: z.number().int().positive().max(1000).default(200),
});

export function registerLeaseMethods(server: CorgiServer): void {
  const { leases } = server;

  const holdersData = (holders: Holder[]): BusyData["holders"] =>
    holders.flatMap((h) => {
      const view = server.holderView(h);
      return view ? [{ ...view, deviceId: h.deviceId }] : [];
    });

  /** 디바이스가 하나도 없을 때 만들 기종 — Android 는 Medium Phone, iOS 는 가장 새 기본 iPhone */
  const recommendedModel = async (platform: Device["platform"]): Promise<string> => {
    const { models } = await server.driver(platform).catalog();
    const phones = models.filter((m) => m.form === "phone");
    if (platform === "android") {
      const model = phones.find((m) => m.id === "medium-phone") ?? phones[0];
      if (!model) throw new HandlerError("TOOL_MISSING", t("err.noModel", { model: "phone" }));
      return model.id;
    }
    const plain = phones
      .map((m) => ({ m, n: Number(/^iPhone (\d+)$/.exec(m.name)?.[1]) }))
      .filter((x) => Number.isFinite(x.n))
      .sort((a, b) => b.n - a.n);
    const model = plain[0]?.m ?? phones.at(-1);
    if (!model) throw new HandlerError("TOOL_MISSING", t("err.noModel", { model: "iPhone" }));
    return model.id;
  };

  /** 디바이스·그룹·기본 디바이스를 디바이스 목록으로 푼다 */
  const targets = async (
    params: AcquireParams,
    session: SessionInfo,
    connection: Connection,
  ): Promise<Device[]> => {
    const refs = [...params.devices];
    if (params.group) {
      const group = server.registry.findGroup(params.group);
      if (!group) throw new HandlerError("NOT_FOUND", t("err.noGroup", { ref: params.group }));
      if (group.deviceIds.length === 0)
        throw new HandlerError("INVALID", t("err.emptyGroup", { name: group.name }));
      refs.push(...group.deviceIds);
    }
    if (params.default) {
      const platforms =
        params.default === "both" ? (["android", "ios"] as const) : [params.default];
      const listed = await server.devices();
      const missing = platforms.filter((p) => !server.registry.defaults()[p]);
      // 디바이스가 하나도 없는 플랫폼만 만든다 — 있는데 기본이 없으면 사람이 고른다
      const creatable = missing.filter((p) => !listed.some((d) => d.spec.platform === p));
      if (params.create) {
        for (const platform of creatable) {
          await server.invoke(
            "device.create",
            { platform, model: await recommendedModel(platform), slim: true, baseline: false },
            session,
            connection,
          );
        }
      }
      const defaults = server.registry.defaults();
      const ids = platforms.map((p) => defaults[p]).filter((id): id is string => id !== undefined);
      // both 는 있는 쪽만 줘도 된다 — 하나도 없을 때만 실패
      if (ids.length === 0 || (params.default !== "both" && ids.length < platforms.length)) {
        const left = platforms.filter((p) => !defaults[p]);
        throw new HandlerError("NO_DEFAULT", t("err.noDefault"), {
          missing: left.map((platform) => ({
            platform,
            devices: listed.filter((d) => d.spec.platform === platform).length,
          })),
        });
      }
      refs.push(...ids);
    }
    if (refs.length === 0) throw new HandlerError("INVALID", t("err.noTarget"));
    const devices = await server.resolve(refs);
    return [...new Map(devices.map((d) => [d.id, d])).values()];
  };

  /** 요청한 디바이스마다 지금 상태 (R23) */
  const leaseItems = (session: SessionInfo, devices: Device[]): LeaseItem[] => {
    const held = new Set(leases.heldBy(session.key));
    const queued = new Set(leases.queuedFor(session.key));
    return devices.map((device) => {
      if (held.has(device.id)) return { deviceId: device.id, name: device.name, state: "held" };
      const [blocker] = leases.blockers(session.key, [device.id]);
      if (!blocker) return { deviceId: device.id, name: device.name, state: "free" };
      return {
        deviceId: device.id,
        name: device.name,
        state: queued.has(device.id) ? "queued" : "busy",
        holder: server.holderView(blocker),
      };
    });
  };

  const acquire = async (
    params: AcquireParams,
    session: SessionInfo,
    connection: Connection,
  ): Promise<AcquireResult> => {
    const devices = await targets(params, session, connection);
    const ids = devices.map((d) => d.id);
    const items = () => leaseItems(session, devices);
    const options = { wait: params.wait, mode: params.mode };

    const result = leases.acquire(session, ids, options);
    if (result.status === "granted") return { ...result, devices: items() };
    if (result.status === "partial")
      return {
        status: "partial",
        deviceIds: result.deviceIds,
        devices: items(),
        queued: result.queued,
      };
    if (result.status === "busy") {
      const data: BusyData = { holders: holdersData(result.holders), devices: items() };
      throw new HandlerError("BUSY", t("err.busy"), data);
    }
    if (result.status === "deadlock") {
      const cycle = result.cycle.map((key) => leases.session(key)?.agent ?? key);
      const data: BusyData = { holders: holdersData(result.holders), devices: items(), cycle };
      throw new HandlerError("DEADLOCK", t("err.deadlock", { cycle: cycle.join(" → ") }), data);
    }

    connection.emit("queued", {
      position: result.position,
      holders: holdersData(result.holders),
    });
    await server.waitForGrant(session.key, params.timeoutMs, connection);

    const held = new Set(leases.heldBy(session.key));
    if (ids.every((id) => held.has(id)))
      return { status: "granted", deviceIds: ids, devices: items() };
    if (params.mode === "available" && ids.some((id) => held.has(id))) {
      const got = ids.filter((id) => held.has(id));
      return { status: "partial", deviceIds: got, devices: items(), queued: true };
    }
    const position = leases.queuePosition(session.key);
    return {
      status: "queued",
      position: position ?? 0,
      holders: holdersData(leases.blockers(session.key, ids)),
      devices: items(),
    };
  };

  server.addMethod("lease.acquire", (p, session, connection) =>
    acquire(parse(AcquireParams, p), session, connection),
  );

  server.addMethod("lease.release", async (p, session) => {
    const params = parse(ReleaseParams, p);
    const ids = params.devices
      ? (await server.resolve(params.devices)).map((d) => d.id)
      : undefined;
    return { released: leases.release(session.key, ids) };
  });

  /** 강제 해제 — 사람(웹 UI·CLI --force)만 (docs/design.md §8) */
  server.addMethod("lease.forceRelease", async (p, session) => {
    const params = parse(ForceParams, p);
    if (!session.human) throw new HandlerError("INVALID", t("err.forceHumanOnly"));
    const [device] = await server.resolve([params.device]);
    const holder = device ? leases.holderOf(device.id) : undefined;
    if (!device || !holder) return { released: [] };
    return { released: leases.release(holder.key, [device.id], "forced") };
  });

  server.addMethod("lease.who", async (p) => {
    const params = parse(WhoParams, p);
    const snapshot = leases.snapshot();
    let devices = await server.devices();
    if (params.target) {
      const target = params.target;
      const states = await server.runtimeStates(devices);
      devices = devices.filter(
        (d) =>
          d.id === target ||
          d.name === target ||
          d.native === target ||
          states.get(d.id)?.targetId === target,
      );
      if (devices.length === 0)
        throw new HandlerError("NOT_FOUND", t("err.notThisMac", { target }));
    }
    return devices.map((device) => {
      const lease = snapshot.leases.find((l) => l.deviceId === device.id);
      const session = lease ? leases.session(lease.sessionKey) : undefined;
      return {
        deviceId: device.id,
        name: device.name,
        holder:
          lease && session
            ? server.holderView({
                deviceId: device.id,
                session,
                since: lease.acquiredAt,
                reason: "held",
              })
            : undefined,
      };
    });
  });

  server.addMethod("lease.history", async (p) => {
    const params = parse(HistoryParams, p);
    return server.history.list({ limit: params.limit, sessionKey: params.session });
  });

  server.addMethod("lease.sessions", async (p) =>
    server.history.sessions({ limit: parse(SessionsParams, p).limit }),
  );
}
