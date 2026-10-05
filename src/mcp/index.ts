import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { kickstart } from "../install/launchd.ts";
import type {
  AcquireResult,
  CatalogResult,
  DeviceOpResult,
  DeviceView,
  StatusResult,
} from "../shared/api.ts";
import { call, RemoteError, ServerDownError } from "../shared/client.ts";
import { loadConfig } from "../shared/config.ts";
import { resolveLanguage, setLanguage } from "../shared/i18n.ts";
import type { Group } from "../shared/model.ts";
import { resolvePaths } from "../shared/paths.ts";
import type { SessionInfo } from "../shared/protocol.ts";
import { detectSession } from "../shared/session.ts";
import { systemLanguages } from "../shared/system-language.ts";
import { VERSION } from "../shared/version.ts";

// 로컬 MCP 서버 (R12, 6단계) — CLI 와 같은 소켓 메서드를 부르는 얇은 래퍼다. 상태는 없다.
// 세션은 CLI 처럼 프로세스 트리로 찾는다 — MCP 서버의 부모가 에이전트다 (docs/design.md §7).
// 긴 기다림은 MCP 호출 시간 제한 때문에 «아직 대기 중 → 다시 호출» 로 나눈다.

/** 한 번의 기다리기 — MCP 클라이언트의 호출 시간 제한보다 짧게 */
const WAIT_SLICE_MS = 45_000;

type Text = { content: { type: "text"; text: string }[]; isError?: boolean };

function text(body: string, isError = false): Text {
  return { content: [{ type: "text", text: body }], isError: isError || undefined };
}

function json(summary: string, data: unknown): Text {
  return text(`${summary}\n\n${JSON.stringify(data, null, 2)}`);
}

/** 디바이스 한 대 — 에이전트가 쓰는 것만 (argent ID·크기 라벨·상태) */
function brief(d: DeviceView) {
  return {
    id: d.id,
    name: d.name,
    platform: d.platform,
    label: d.label,
    booted: d.booted,
    targetId: d.targetId,
    slim: d.slim,
    default: d.default,
    groups: d.groups,
    holder: d.holder
      ? { agent: d.holder.human ? "human" : d.holder.agent, since: d.holder.since }
      : undefined,
    mine: d.mine,
  };
}

export async function runMcp(): Promise<void> {
  const paths = resolvePaths();
  const config = loadConfig(paths.config);
  setLanguage(resolveLanguage(config.language, systemLanguages()));
  const session: SessionInfo = detectSession({
    extraShells: config.session.extraShells,
    extraHosts: config.session.extraHosts,
  });

  /** 서버가 꺼져 있으면 launchd 로 켜고 한 번 더 (Q10) */
  const request = async <T>(method: string, params: unknown = {}): Promise<T> => {
    const send = () => call<T>(paths.socket, method, params, session);
    const { result } = await send().catch(async (error: unknown) => {
      if (error instanceof ServerDownError && (await kickstart(paths))) return send();
      throw error;
    });
    return result;
  };

  /** 서버 오류를 에이전트가 판단할 수 있게 — 코드가 먼저 (BUSY·DEADLOCK·NO_DEFAULT …) */
  const guard =
    <A>(fn: (args: A) => Promise<Text>) =>
    async (args: A): Promise<Text> => {
      try {
        return await fn(args);
      } catch (error) {
        if (error instanceof RemoteError) {
          const data = error.data === undefined ? "" : `\n\n${JSON.stringify(error.data, null, 2)}`;
          return text(`${error.code}: ${error.message}${data}`, true);
        }
        if (error instanceof ServerDownError)
          return text(`SERVER_DOWN: ${error.message} — run \`simless doctor\``, true);
        return text(`FAILED: ${error instanceof Error ? error.message : String(error)}`, true);
      }
    };

  const server = new McpServer({ name: "simless", version: VERSION });

  server.registerTool(
    "simless_status",
    {
      title: "simless status",
      description:
        "Devices in the simless list (argent targetId, size label, booted, slim, default, groups, who holds it), device groups with their descriptions, and what this session holds. Call this first to pick a device group or the default device.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    guard(async () => {
      const status = await request<StatusResult>("status");
      return json(
        `Holding: ${status.held.join(", ") || "nothing"}${status.queuePosition ? ` · waiting #${status.queuePosition}` : ""}`,
        {
          session: status.session.key,
          held: status.held,
          devices: status.devices.map(brief),
          groups: status.groups.map((g: Group) => ({
            id: g.id,
            name: g.name,
            description: g.description,
            deviceIds: g.deviceIds,
          })),
          defaults: status.defaults,
        },
      );
    }),
  );

  server.registerTool(
    "simless_use",
    {
      title: "Acquire and boot devices",
      description:
        "Acquire devices and boot them — by device IDs/names, a device group, or the default device. mode 'all' (default) takes all or nothing; 'available' takes the free ones now. With wait, joins the queue; if it returns STILL_QUEUED, call again with the same arguments (your place is kept). Returns each device's targetId to pass to argent tools. Errors: BUSY (someone holds a device — show the holder to the user or wait), DEADLOCK, NO_DEFAULT (data.missing tells, per platform, how many devices exist — 0 means call again with create: true; otherwise ask the user which device).",
      inputSchema: {
        devices: z.array(z.string()).optional().describe("Device IDs or names"),
        group: z.string().optional().describe("Device group name or ID"),
        default: z
          .enum(["android", "ios", "both"])
          .optional()
          .describe("The default device for a platform, or both"),
        mode: z.enum(["all", "available"]).optional(),
        create: z
          .boolean()
          .optional()
          .describe(
            "With default: if the platform has no devices at all, create a slim recommended one first (takes a few minutes)",
          ),
        wait: z.boolean().optional().describe("Wait in the queue when devices are busy"),
      },
    },
    guard(async (args) => {
      const acquired = await request<AcquireResult>("lease.acquire", {
        devices: args.devices ?? [],
        group: args.group,
        default: args.default,
        mode: args.mode ?? "all",
        create: args.create ?? false,
        wait: args.wait ?? false,
        timeoutMs: WAIT_SLICE_MS,
      });
      if (acquired.status === "queued") {
        return json(
          `STILL_QUEUED: waiting #${acquired.position}. Call simless_use again with the same arguments to keep waiting.`,
          acquired.devices,
        );
      }
      const up = await request<{ results: DeviceOpResult[]; devices: DeviceView[] }>("device.up", {
        devices: acquired.deviceIds,
      });
      const failed = up.results.filter((r) => !r.ok);
      const partial =
        acquired.status === "partial"
          ? ` Only some devices were free${acquired.queued ? "; the server takes the rest as they free up — check simless_status, then call simless_use for them" : ""}.`
          : "";
      return json(
        `Acquired and booted ${up.devices.length} device(s).${partial}${failed.length > 0 ? ` Failed to boot: ${failed.map((f) => `${f.name} (${f.error})`).join(", ")}` : ""}`,
        { devices: up.devices.map(brief), leases: acquired.devices },
      );
    }),
  );

  server.registerTool(
    "simless_release",
    {
      title: "Release devices",
      description:
        "Release devices this session holds (all of them, and any queue entry, when devices is omitted). Ask the user first whether to shut them down (simless_down).",
      inputSchema: { devices: z.array(z.string()).optional() },
    },
    guard(async (args) => {
      const result = await request<{ released: string[] }>("lease.release", {
        devices: args.devices,
      });
      return text(`Released: ${result.released.join(", ") || "nothing"}`);
    }),
  );

  server.registerTool(
    "simless_down",
    {
      title: "Shut down devices",
      description: "Shut down devices this session holds (all of them when devices is omitted).",
      inputSchema: { devices: z.array(z.string()).optional() },
    },
    guard(async (args) => {
      const result = await request<{ results: DeviceOpResult[] }>("device.down", {
        devices: args.devices ?? [],
      });
      return json("Shut down.", result.results);
    }),
  );

  server.registerTool(
    "simless_catalog",
    {
      title: "Models you can create",
      description:
        "iOS device types and runtimes, Android profiles and system images, and what slimming turns off. Use before simless_create — and only create devices when the user asks.",
      inputSchema: { platform: z.enum(["android", "ios"]).optional() },
      annotations: { readOnlyHint: true },
    },
    guard(async (args) => {
      const catalog = await request<CatalogResult>("catalog", { platform: args.platform });
      return json("Catalog", catalog);
    }),
  );

  server.registerTool(
    "simless_create",
    {
      title: "Create a device",
      description:
        "Create a new simulator or emulator from a model (and optional OS). Slim by default (named `simless …`); set slim false when the test needs push notifications, iCloud and so on. Only when the user asks. Takes several minutes.",
      inputSchema: {
        model: z.string().describe("Model name or ID from simless_catalog"),
        platform: z.enum(["android", "ios"]).optional(),
        os: z.string().optional(),
        name: z.string().optional(),
        slim: z.boolean().optional(),
      },
    },
    guard(async (args) => {
      const device = await request<DeviceView>("device.create", {
        platform: args.platform,
        model: args.model,
        os: args.os,
        name: args.name,
        slim: args.slim ?? true,
        baseline: false,
      });
      return json(`Created ${device.name} (${device.id}).`, brief(device));
    }),
  );

  server.registerTool(
    "simless_group_save",
    {
      title: "Create or change a device group",
      description:
        "Create a device group, or change one (name, description, add/remove devices). Only when the user asks — never change groups someone else made on your own.",
      inputSchema: {
        group: z.string().optional().describe("Existing group name or ID — omit to create"),
        name: z.string().optional(),
        description: z.string().optional(),
        add: z.array(z.string()).optional().describe("Devices to add"),
        remove: z.array(z.string()).optional().describe("Devices to remove"),
      },
    },
    guard(async (args) => {
      const group = args.group
        ? await request<Group>("group.update", {
            group: args.group,
            name: args.name,
            description: args.description,
            add: args.add ?? [],
            remove: args.remove ?? [],
          })
        : await request<Group>("group.create", {
            name: args.name ?? "",
            description: args.description ?? "",
            devices: args.add ?? [],
          });
      return json(`Saved group ${group.name} (${group.id}).`, group);
    }),
  );

  await server.connect(new StdioServerTransport());
}
