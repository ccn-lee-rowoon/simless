import { z } from "zod";
import { t } from "../shared/i18n.ts";
import type { Device } from "../shared/model.ts";
import type { SessionInfo } from "../shared/protocol.ts";
import type { SimlessServer } from "./app.ts";
import type { RuntimeState } from "./drivers/types.ts";
import { HandlerError } from "./socket.ts";

// 실행 직전 훅의 판정 (P1·P5·P8, docs/design.md §13). 훅이 뽑은 대상 중 simless 목록의 디바이스를
// 이 세션이 점유했는지 본다. 켜기는 점유와 상관없이 simless 로 하게 한다 (S6).

const CheckParams = z.object({
  ids: z.array(z.string()).default([]),
  boots: z.array(z.string()).default([]),
  allAndroid: z.boolean().default(false),
  allIos: z.boolean().default(false),
});

export interface HookDecision {
  allow: boolean;
  /** 막을 때 에이전트에게 보일 이유 — 누가 쓰는지와 점유 방법 */
  reason?: string;
  /** 대상이 된 관리 디바이스 ID */
  devices: string[];
}

/** 대상 문자열이 이 디바이스를 가리키는지 — AVD ID·UDID·지금 시리얼 (simless ID 는 흔한 낱말과 겹칠 수 있어 빼고) */
function matches(device: Device, state: RuntimeState | undefined, id: string): boolean {
  return id === device.native || (state?.targetId !== undefined && id === state.targetId);
}

export function registerHookMethods(server: SimlessServer): void {
  // 훅은 Bash·argent 호출마다 부른다 — 켜짐 상태(시리얼)를 읽는 데 0.5초쯤 걸려 10초 기억해 둔다.
  // 시리얼은 켤 때만 바뀌고, simless 로 켜면(점유가 있어야 함) 기억을 버린다
  let cache: { at: number; states: Map<string, RuntimeState> } | undefined;
  server.onInvalidate(() => {
    cache = undefined;
  });
  const states = async (devices: Device[]) => {
    if (cache && Date.now() - cache.at < 10_000) return cache.states;
    cache = { at: Date.now(), states: await server.runtimeStates(devices) };
    return cache.states;
  };

  server.addMethod("hook.check", async (p, session: SessionInfo): Promise<HookDecision> => {
    const parsed = CheckParams.safeParse(p ?? {});
    if (!parsed.success) throw new HandlerError("INVALID", z.prettifyError(parsed.error));
    const params = parsed.data;
    const devices = await server.devices();
    const runtime = await states(devices);

    const targeted = new Map<string, Device>();
    const booting: Device[] = [];
    for (const device of devices) {
      const state = runtime.get(device.id);
      const hit =
        params.ids.some((id) => matches(device, state, id)) ||
        (params.allAndroid && device.platform === "android" && state?.booted === true) ||
        (params.allIos && device.platform === "ios" && state?.booted === true);
      if (params.boots.some((id) => matches(device, state, id))) booting.push(device);
      if (hit) targeted.set(device.id, device);
    }

    const ids = [...targeted.keys()];
    const [boot] = booting;
    if (boot) {
      return {
        allow: false,
        reason: t("hook.bootViaSimless", { name: boot.name, id: boot.id }),
        devices: ids,
      };
    }
    const held = new Set(server.leases.heldBy(session.key));
    for (const device of targeted.values()) {
      if (held.has(device.id)) continue;
      const holder = server.leases.holderOf(device.id);
      return {
        allow: false,
        reason: holder
          ? t("hook.heldByOther", {
              name: device.name,
              who: holder.human ? t("common.human") : holder.agent,
              id: device.id,
            })
          : t("hook.notHeld", { name: device.name, id: device.id }),
        devices: ids,
      };
    }
    return { allow: true, devices: ids };
  });
}
