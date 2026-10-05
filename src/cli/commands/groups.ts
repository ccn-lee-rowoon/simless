import type { Command } from "commander";
import type { DeviceView } from "../../shared/api.ts";
import type { Group } from "../../shared/model.ts";
import { type Context, output, type Run, request } from "../context.ts";
import { ago, table } from "../format.ts";

function editorText(group: Group): string {
  return `${group.updatedBy === "human" ? "사람" : group.updatedBy} · ${ago(Date.parse(group.updatedAt))}`;
}

async function groupText(ctx: Context, group: Group): Promise<string> {
  const devices = await request<DeviceView[]>(ctx, "device.list", {});
  const rows = group.deviceIds.map((id) => {
    const d = devices.find((x) => x.id === id);
    return d ? [d.id, d.label, d.name, d.memo ?? ""] : [id, "", "(없는 디바이스)", ""];
  });
  return [
    `${group.name}  (${group.id})`,
    ...(group.description ? [group.description] : []),
    `마지막 수정: ${editorText(group)}`,
    "",
    rows.length > 0 ? table(["ID", "크기", "이름", "메모"], rows) : "디바이스가 없습니다",
  ].join("\n");
}

/** 쉼표나 여러 인자로 받은 디바이스 목록 */
function refs(values: string[] | undefined): string[] {
  return (values ?? [])
    .flatMap((v) => v.split(","))
    .map((v) => v.trim())
    .filter(Boolean);
}

export function registerGroups(program: Command, run: Run) {
  const group = program
    .command("group")
    .description("디바이스 그룹 — 용도별 디바이스 묶음 (R21). 예: «UI 레이아웃 체크», «DM 확인»");

  group
    .command("list", { isDefault: true })
    .description("그룹 목록")
    .action(
      run(async (ctx) => {
        const groups = await request<Group[]>(ctx, "group.list", {});
        output(ctx, groups, () =>
          groups.length === 0
            ? "그룹이 없습니다 — corgi group create <이름> --desc <설명> <디바이스…>"
            : table(
                ["ID", "이름", "대수", "설명", "마지막 수정"],
                groups.map((g) => [
                  g.id,
                  g.name,
                  String(g.deviceIds.length),
                  g.description.split("\n")[0] ?? "",
                  editorText(g),
                ]),
              ),
        );
      }),
    );

  group
    .command("show")
    .description("그룹의 설명과 디바이스(메모 포함)")
    .argument("<group>", "그룹 ID 또는 이름")
    .action(
      run(async (ctx, ref: string) => {
        const groups = await request<Group[]>(ctx, "group.list", {});
        const lower = ref.toLowerCase();
        const found = groups.find((g) => g.id === ref || g.name.toLowerCase() === lower);
        if (!found) {
          await request(ctx, "group.update", { group: ref }); // NOT_FOUND 를 서버 오류로 낸다
          return;
        }
        if (ctx.json) output(ctx, found, () => "");
        else console.log(await groupText(ctx, found));
      }),
    );

  group
    .command("create")
    .description("그룹을 만든다")
    .argument("<name>", "그룹 이름")
    .argument("[devices...]", "디바이스 ID 또는 이름")
    .option("--desc <설명>", "용도 설명 — 에이전트도 읽는다 (예: «2대 모두 필요»)")
    .action(
      run(async (ctx, name: string, devices: string[], o: { desc?: string }) => {
        const created = await request<Group>(ctx, "group.create", {
          name,
          description: o.desc,
          devices: refs(devices),
        });
        output(ctx, created, () => `만들었습니다: ${created.name} (${created.id})`);
      }),
    );

  group
    .command("edit")
    .description("그룹 이름·설명·디바이스를 고친다")
    .argument("<group>", "그룹 ID 또는 이름")
    .option("--name <이름>", "새 이름")
    .option("--desc <설명>", "새 설명")
    .option("--add <devices...>", "넣을 디바이스")
    .option("--remove <devices...>", "뺄 디바이스")
    .action(
      run(
        async (
          ctx,
          ref: string,
          o: { name?: string; desc?: string; add?: string[]; remove?: string[] },
        ) => {
          const updated = await request<Group>(ctx, "group.update", {
            group: ref,
            name: o.name,
            description: o.desc,
            add: refs(o.add),
            remove: refs(o.remove),
          });
          if (ctx.json) output(ctx, updated, () => "");
          else console.log(await groupText(ctx, updated));
        },
      ),
    );

  group
    .command("delete")
    .description("그룹을 지운다 — 디바이스는 그대로")
    .argument("<group>", "그룹 ID 또는 이름")
    .action(
      run(async (ctx, ref: string) => {
        const result = await request<{ deleted: string }>(ctx, "group.delete", { group: ref });
        output(ctx, result, () => `지웠습니다: ${result.deleted}`);
      }),
    );
}
