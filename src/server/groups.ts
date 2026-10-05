import { z } from "zod";
import type { Group } from "../shared/model.ts";
import type { SessionInfo } from "../shared/protocol.ts";
import type { CorgiServer } from "./app.ts";
import { HandlerError } from "./socket.ts";

// 그룹 — 용도별 디바이스 묶음 (R21). 사람은 앱에서, 에이전트는 CLI·MCP 로 만들고 고친다.

const GroupRef = z.object({ group: z.string().min(1) });
const CreateParams = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().max(1000).default(""),
  devices: z.array(z.string()).default([]),
});
const UpdateParams = GroupRef.extend({
  name: z.string().trim().min(1).max(80).optional(),
  description: z.string().max(1000).optional(),
  /** 주면 디바이스 목록을 통째로 바꾼다 */
  devices: z.array(z.string()).optional(),
  add: z.array(z.string()).default([]),
  remove: z.array(z.string()).default([]),
});

function parse<T extends z.ZodType>(schema: T, params: unknown): z.infer<T> {
  const parsed = schema.safeParse(params ?? {});
  if (!parsed.success) throw new HandlerError("INVALID", z.prettifyError(parsed.error));
  return parsed.data;
}

/** 마지막으로 고친 쪽 — 화면에 «사람» 또는 에이전트 이름으로 보인다 */
function editor(session: SessionInfo): string {
  return session.human ? "human" : session.agent;
}

export function registerGroupMethods(server: CorgiServer): void {
  const find = (ref: string): Group => {
    const group = server.registry.findGroup(ref);
    if (!group) throw new HandlerError("NOT_FOUND", `없는 그룹: ${ref}`);
    return group;
  };

  const guardName = (name: string, except?: string) => {
    const other = server.registry.findGroup(name);
    if (other && other.id !== except && other.name.toLowerCase() === name.toLowerCase())
      throw new HandlerError("INVALID", `이미 쓰는 그룹 이름입니다: ${name}`);
  };

  const deviceIds = async (refs: string[]) => [
    ...new Set((await server.resolve(refs)).map((d) => d.id)),
  ];

  server.addMethod("group.list", async () => server.registry.groups());

  server.addMethod("group.create", async (p, session) => {
    const params = parse(CreateParams, p);
    guardName(params.name);
    return server.registry.addGroup({
      name: params.name,
      description: params.description,
      deviceIds: await deviceIds(params.devices),
      updatedBy: editor(session),
      updatedAt: new Date().toISOString(),
    });
  });

  server.addMethod("group.update", async (p, session) => {
    const params = parse(UpdateParams, p);
    const group = find(params.group);
    if (params.name) guardName(params.name, group.id);
    let ids = params.devices ? await deviceIds(params.devices) : group.deviceIds;
    const add = await deviceIds(params.add);
    const remove = new Set(await deviceIds(params.remove));
    ids = [...new Set([...ids, ...add])].filter((id) => !remove.has(id));
    return server.registry.updateGroup(group.id, {
      name: params.name,
      description: params.description,
      deviceIds: ids,
      updatedBy: editor(session),
      updatedAt: new Date().toISOString(),
    });
  });

  server.addMethod("group.delete", async (p) => {
    const group = find(parse(GroupRef, p).group);
    server.registry.removeGroup(group.id);
    return { deleted: group.id };
  });
}
