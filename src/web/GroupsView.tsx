import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import type { DeviceView, StatusResult } from "../shared/api.ts";
import { t } from "../shared/i18n.ts";
import type { Group } from "../shared/model.ts";
import { Agent } from "./agents.tsx";
import { call } from "./api.ts";
import { PlatformIcon } from "./icons.tsx";
import type { Act } from "./types.ts";
import { ago, Dialog, osText, widthText } from "./ui.tsx";

/** 그룹 화면 — 용도별 디바이스 묶음을 만들고 고친다 (R21·M9) */
export function GroupsView({
  status,
  act,
  newRequest,
}: {
  status: StatusResult;
  act: Act;
  /** 머리의 «새 그룹» 을 누를 때마다 늘어난다 */
  newRequest: number;
}) {
  const [editing, setEditing] = useState<Group | "new" | null>(null);
  // 화면을 다시 열었을 때 지난 요청으로 창이 뜨지 않게 — 처음 본 값과 달라질 때만
  const seenRequest = useRef(newRequest);
  useEffect(() => {
    if (newRequest !== seenRequest.current) setEditing("new");
    seenRequest.current = newRequest;
  }, [newRequest]);
  const [deleting, setDeleting] = useState<Group | null>(null);
  const byId = useMemo(() => new Map(status.devices.map((d) => [d.id, d])), [status.devices]);

  return (
    <>
      <div className="toolbar">
        <p className="sub view-intro">{t("web.groups.intro")}</p>
      </div>

      {status.groups.length === 0 ? (
        <div className="empty">
          <p>{t("web.groups.empty")}</p>
        </div>
      ) : (
        <div className="group-list">
          {status.groups.map((group) => (
            <article key={group.id} className="panel group-card">
              <header className="group-head">
                <h3>{group.name}</h3>
                <span className="sub mono">{group.id}</span>
                <span className="spacer" />
                <button
                  type="button"
                  className="button button-small"
                  onClick={() => setEditing(group)}
                >
                  {t("web.edit")}
                </button>
                <button
                  type="button"
                  className="button button-small button-ghost-danger"
                  onClick={() => setDeleting(group)}
                >
                  {t("web.delete")}
                </button>
              </header>
              {group.description && <p className="group-desc">{group.description}</p>}
              {group.deviceIds.length === 0 ? (
                <p className="sub">{t("cli.group.empty")}</p>
              ) : (
                <ul className="group-devices">
                  {group.deviceIds.map((id) => {
                    const device = byId.get(id);
                    if (!device) return null;
                    return (
                      <li key={id}>
                        <span className={device.booted ? "dot dot-on" : "dot"} />
                        <PlatformIcon platform={device.platform} />
                        <span className="mono">{widthText(device)}</span>
                        <span className="strong">{device.name}</span>
                        {device.holder && (
                          <Agent agent={device.holder.agent} human={device.holder.human} />
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
              <footer className="sub">
                {t("web.groups.lastEdit", {
                  who: group.updatedBy === "human" ? t("common.human") : group.updatedBy,
                  ago: ago(Date.parse(group.updatedAt)),
                })}
              </footer>
            </article>
          ))}
        </div>
      )}

      <GroupDialog
        group={editing}
        devices={status.devices}
        onClose={() => setEditing(null)}
        onSave={(input) => {
          const target = editing;
          setEditing(null);
          void act(input.name, () =>
            target === "new" || target === null
              ? call("group.create", input)
              : call("group.update", { group: target.id, ...input }),
          );
        }}
      />
      <Dialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        title={t("web.groups.deleteTitle")}
      >
        {deleting && (
          <div className="dialog-body">
            <p>{t("web.groups.deleteBody", { name: deleting.name })}</p>
            <footer className="dialog-footer">
              <span className="spacer" />
              <button type="button" className="button" onClick={() => setDeleting(null)}>
                {t("web.cancel")}
              </button>
              <button
                type="button"
                className="button button-danger"
                onClick={() => {
                  const g = deleting;
                  setDeleting(null);
                  void act(g.name, () => call("group.delete", { group: g.id }));
                }}
              >
                {t("web.delete")}
              </button>
            </footer>
          </div>
        )}
      </Dialog>
    </>
  );
}

/** 그룹 만들기·고치기 — 이름·설명·디바이스 고르기 */
function GroupDialog({
  group,
  devices,
  onClose,
  onSave,
}: {
  group: Group | "new" | null;
  devices: DeviceView[];
  onClose: () => void;
  onSave: (input: { name: string; description: string; devices: string[] }) => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [platform, setPlatform] = useState<"all" | "android" | "ios">("all");
  // 열 때 고른 것 — 고를 때마다 순서가 바뀌면 헷갈려서 정렬은 이걸로만 한다
  const [openedWith, setOpenedWith] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (group === null) return;
    setName(group === "new" ? "" : group.name);
    setDescription(group === "new" ? "" : group.description);
    setPicked(new Set(group === "new" ? [] : group.deviceIds));
    setOpenedWith(new Set(group === "new" ? [] : group.deviceIds));
    setQuery("");
    setPlatform("all");
  }, [group]);

  // 고른 것·켜진 것·simless 가 만든 것을 위로
  const sorted = useMemo(() => {
    const q = query.trim().toLowerCase();
    return devices
      .filter((d) => platform === "all" || d.platform === platform)
      .filter((d) => q === "" || d.name.toLowerCase().includes(q))
      .sort(
        (a, b) =>
          a.platform.localeCompare(b.platform) ||
          Number(openedWith.has(b.id)) - Number(openedWith.has(a.id)) ||
          Number(b.createdBySimless || b.booted) - Number(a.createdBySimless || a.booted) ||
          a.platform.localeCompare(b.platform) ||
          a.layoutWidth - b.layoutWidth,
      );
  }, [devices, query, openedWith, platform]);

  return (
    <Dialog
      open={group !== null}
      onClose={onClose}
      title={group === "new" ? t("web.groups.newTitle") : t("web.groups.editTitle")}
      wide
    >
      <form
        className="dialog-body"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) onSave({ name: name.trim(), description, devices: [...picked] });
        }}
      >
        <label className="field">
          <span>{t("web.groups.name")}</span>
          <input
            value={name}
            placeholder={t("web.groups.namePlaceholder")}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label className="field">
          <span>{t("web.groups.description")}</span>
          <textarea
            rows={3}
            value={description}
            placeholder={t("web.groups.descriptionPlaceholder")}
            onChange={(e) => setDescription(e.target.value)}
          />
        </label>
        <div className="field">
          <span>{t("web.groups.devices", { count: picked.size })}</span>
          <div className="picker-toolbar">
            <div className="segmented" role="tablist" aria-label={t("web.platform")}>
              {(["all", "android", "ios"] as const).map((p) => (
                <button
                  key={p}
                  type="button"
                  role="tab"
                  aria-selected={platform === p}
                  className={platform === p ? "segment segment-active" : "segment"}
                  onClick={() => setPlatform(p)}
                >
                  {p === "all" ? "All" : p === "android" ? "Android" : "iOS"}{" "}
                  <span className="mono count">
                    {p === "all" ? devices.length : devices.filter((d) => d.platform === p).length}
                  </span>
                </button>
              ))}
            </div>
            <input
              type="search"
              className="search"
              placeholder={t("web.search")}
              aria-label={t("web.search")}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <ul className="check-list device-picker">
            {sorted.map((d, i) => (
              <Fragment key={d.id}>
                {platform === "all" && d.platform !== sorted[i - 1]?.platform && (
                  <li key={`h-${d.platform}`} className="picker-heading">
                    {d.platform === "android" ? "Android" : "iOS"}
                  </li>
                )}
                <li key={d.id}>
                  <label className="check">
                    <input
                      type="checkbox"
                      checked={picked.has(d.id)}
                      onChange={(e) => {
                        const next = new Set(picked);
                        if (e.target.checked) next.add(d.id);
                        else next.delete(d.id);
                        setPicked(next);
                      }}
                    />
                    <PlatformIcon platform={d.platform} />
                    <span className="mono picker-width">{widthText(d)}</span>
                    <span className="strong">{d.name}</span>
                    <span className="sub">{osText(d)}</span>
                  </label>
                </li>
              </Fragment>
            ))}
          </ul>
        </div>
        <footer className="dialog-footer">
          <span className="spacer" />
          <button type="button" className="button" onClick={onClose}>
            {t("web.cancel")}
          </button>
          <button type="submit" className="button button-primary" disabled={!name.trim()}>
            {t("web.save")}
          </button>
        </footer>
      </form>
    </Dialog>
  );
}
