import type { Command } from "commander";
import type { DeviceView } from "../../shared/api.ts";
import { t } from "../../shared/i18n.ts";
import type { Group } from "../../shared/model.ts";
import { type Context, output, type Run, request } from "../context.ts";
import { ago, table } from "../format.ts";

function editorText(group: Group): string {
  return `${group.updatedBy === "human" ? t("common.human") : group.updatedBy} · ${ago(Date.parse(group.updatedAt))}`;
}

async function groupText(ctx: Context, group: Group): Promise<string> {
  const devices = await request<DeviceView[]>(ctx, "device.list", {});
  const rows = group.deviceIds.map((id) => {
    const d = devices.find((x) => x.id === id);
    return d ? [d.id, d.label, d.name, d.memo ?? ""] : [id, "", t("cli.group.missingDevice"), ""];
  });
  return [
    `${group.name}  (${group.id})`,
    ...(group.description ? [group.description] : []),
    t("cli.group.lastEdit", { who: editorText(group) }),
    "",
    rows.length > 0
      ? table([t("table.id"), t("table.size"), t("table.name"), t("table.memo")], rows)
      : t("cli.group.empty"),
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
  const group = program.command("group").description(t("cli.group"));

  group
    .command("list", { isDefault: true })
    .description(t("cli.group.list"))
    .action(
      run(async (ctx) => {
        const groups = await request<Group[]>(ctx, "group.list", {});
        output(ctx, groups, () =>
          groups.length === 0
            ? t("cli.group.none")
            : table(
                [
                  t("table.id"),
                  t("table.name"),
                  t("table.count"),
                  t("table.description"),
                  t("table.updated"),
                ],
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
    .description(t("cli.group.show"))
    .argument("<group>", t("cli.group.arg"))
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
    .description(t("cli.group.create"))
    .argument("<name>", t("cli.group.name"))
    .argument("[devices...]", t("cli.arg.devices"))
    .option("--desc <text>", t("cli.group.desc"))
    .action(
      run(async (ctx, name: string, devices: string[], o: { desc?: string }) => {
        const created = await request<Group>(ctx, "group.create", {
          name,
          description: o.desc,
          devices: refs(devices),
        });
        output(ctx, created, () => t("cli.group.created", { name: created.name, id: created.id }));
      }),
    );

  group
    .command("edit")
    .description(t("cli.group.edit"))
    .argument("<group>", t("cli.group.arg"))
    .option("--name <name>", t("cli.group.newName"))
    .option("--desc <text>", t("cli.group.newDesc"))
    .option("--add <devices...>", t("cli.group.add"))
    .option("--remove <devices...>", t("cli.group.remove"))
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
    .description(t("cli.group.delete"))
    .argument("<group>", t("cli.group.arg"))
    .action(
      run(async (ctx, ref: string) => {
        const result = await request<{ deleted: string }>(ctx, "group.delete", { group: ref });
        output(ctx, result, () => t("cli.deleted", { id: result.deleted }));
      }),
    );
}
