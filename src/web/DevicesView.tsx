import { useEffect, useId, useMemo, useState } from "react";
import { type DeviceView, observedSlim, type StatusResult } from "../shared/api.ts";
import { t } from "../shared/i18n.ts";
import type { Group } from "../shared/model.ts";
import { Agent } from "./agents.tsx";
import { call } from "./api.ts";
import { PlatformIcon } from "./icons.tsx";
import { SlimDetailDialog, SlimDialog } from "./SlimPicker.tsx";
import type { Act } from "./types.ts";
import {
  ago,
  Dialog,
  Menu,
  MenuItem,
  MenuSeparator,
  osText,
  resolutionText,
  SlimBadge,
  shortPath,
  widthText,
} from "./ui.tsx";

type Platform = "all" | "android" | "ios";

const TAB_KEY = "simless-tab";
const GROUP_KEY = "simless-group-filter";

function saved(key: string, fallback: string): string {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

function remember(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // 기억 못 해도 화면은 그대로 쓴다
  }
}

function compare(a: DeviceView, b: DeviceView): number {
  return (
    Number(b.booted) - Number(a.booted) ||
    Number(b.default) - Number(a.default) ||
    a.platform.localeCompare(b.platform) ||
    a.layoutWidth - b.layoutWidth ||
    a.name.localeCompare(b.name)
  );
}

/** 메인 화면 — 이 Mac 의 디바이스 전부, 플랫폼 탭·그룹 거르기·검색 (M5·M9) */
export function DevicesView({
  status,
  act,
  onCreate,
}: {
  status: StatusResult;
  act: Act;
  onCreate: () => void;
}) {
  const [platform, setPlatformState] = useState<Platform>(() => {
    const value = saved(TAB_KEY, "all");
    return value === "android" || value === "ios" ? value : "all";
  });
  const [groupFilter, setGroupFilterState] = useState(() => saved(GROUP_KEY, ""));
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [renaming, setRenaming] = useState<DeviceView | null>(null);
  const [grouping, setGrouping] = useState<DeviceView | null>(null);
  const [deleting, setDeleting] = useState<DeviceView | null>(null);
  const [slimming, setSlimming] = useState<DeviceView | null>(null);
  const [slimDetail, setSlimDetail] = useState<DeviceView | null>(null);

  const setPlatform = (next: Platform) => {
    setPlatformState(next);
    remember(TAB_KEY, next);
  };
  const setGroupFilter = (next: string) => {
    setGroupFilterState(next);
    remember(GROUP_KEY, next);
  };

  const groups = status.groups;
  const groupById = useMemo(() => new Map(groups.map((g) => [g.id, g])), [groups]);
  const activeGroup = groupById.get(groupFilter);

  const counts = {
    all: status.devices.length,
    android: status.devices.filter((d) => d.platform === "android").length,
    ios: status.devices.filter((d) => d.platform === "ios").length,
  };

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return status.devices
      .filter((d) => platform === "all" || d.platform === platform)
      .filter((d) => !activeGroup || activeGroup.deviceIds.includes(d.id))
      .filter((d) => q === "" || `${d.name} ${osText(d)} ${widthText(d)}`.toLowerCase().includes(q))
      .sort(compare);
  }, [status.devices, platform, activeGroup, query]);

  const run = async (device: DeviceView, label: string, fn: () => Promise<unknown>) => {
    setBusy((s) => new Set(s).add(device.id));
    await act(`${device.name} — ${label}`, fn);
    setBusy((s) => {
      const next = new Set(s);
      next.delete(device.id);
      return next;
    });
  };

  const waiting = (id: string) => status.queue.filter((q) => q.deviceIds.includes(id)).length;

  const row = (d: DeviceView) => {
    const lockedByOther = d.holder !== undefined && !d.mine;
    const queued = waiting(d.id);
    return (
      <tr key={d.id}>
        <td>
          <div className="mono strong">{widthText(d)}</div>
          <div className="sub mono nowrap">{resolutionText(d)}</div>
        </td>
        <td className="name-cell">
          <div className="strong name-line">
            <PlatformIcon platform={d.platform} />
            <span>
              {d.name}{" "}
              {d.slimOff && (d.slim !== "none" || observedSlim(d)) ? (
                <button
                  type="button"
                  className="slim-open"
                  aria-label={t("web.slimDetail.open", { name: d.name })}
                  onClick={() => setSlimDetail(d)}
                >
                  <SlimBadge device={d} />
                </button>
              ) : (
                <SlimBadge device={d} />
              )}
            </span>
          </div>
          <div className="sub name-sub">
            {osText(d)}
            {d.createdBySimless ? ` · ${t("web.device.createdBySimless")}` : ""}
          </div>
        </td>
        <td>
          <span className={d.booted ? "dot dot-on" : "dot"} />
          {d.booted ? t("common.on") : t("common.off")}
          {d.booted && d.targetId && (
            <div className="sub mono nowrap" title={d.targetId}>
              {d.targetId.length > 16 ? `${d.targetId.slice(0, 8)}…` : d.targetId}
            </div>
          )}
        </td>
        <td>
          {d.default && (
            <span className="chip chip-default">
              {t("web.device.default", { platform: d.platform === "android" ? "Android" : "iOS" })}
            </span>
          )}
          {d.groups.map((id) => {
            const group = groupById.get(id);
            return group ? (
              <button
                key={id}
                type="button"
                className="chip chip-button"
                title={t("web.device.filterByGroup")}
                onClick={() => setGroupFilter(id)}
              >
                {group.name}
              </button>
            ) : null;
          })}
        </td>
        <td>
          {d.holder ? (
            <>
              <div>
                {d.mine ? (
                  t("web.device.mine")
                ) : (
                  <>
                    <Agent agent={d.holder.agent} human={d.holder.human} />
                    <span className="sub"> · {ago(d.holder.since)}</span>
                  </>
                )}
              </div>
              {!d.holder.human && <div className="sub">{shortPath(d.holder.cwd)}</div>}
            </>
          ) : (
            <span className="sub">—</span>
          )}
          {queued > 0 && <div className="sub">{t("web.device.waiting", { count: queued })}</div>}
        </td>
        <td className="actions">
          <button
            type="button"
            className="button button-small"
            disabled={busy.has(d.id) || lockedByOther}
            title={lockedByOther ? t("web.device.lockedByOther") : undefined}
            onClick={() =>
              d.booted
                ? run(d, t("cli.verb.shutdown"), () => call("device.down", { devices: [d.id] }))
                : run(d, t("cli.verb.boot"), () => call("device.up", { devices: [d.id] }))
            }
          >
            {busy.has(d.id) ? "…" : d.booted ? t("web.device.shutdown") : t("web.device.boot")}
          </button>
          <Menu label={t("web.device.more")}>
            <MenuItem disabled={lockedByOther} onClick={() => setRenaming(d)}>
              {t("web.device.rename")}
            </MenuItem>
            <MenuItem onClick={() => setGrouping(d)}>{t("web.device.groups")}</MenuItem>
            <MenuItem
              disabled={d.default}
              onClick={() =>
                run(d, t("web.device.makeDefault"), () =>
                  call("device.setDefault", { device: d.id }),
                )
              }
            >
              {t("web.device.makeDefault")}
            </MenuItem>
            {(d.createdBySimless || d.slimOff) && <MenuSeparator />}
            {d.slimOff && (
              <MenuItem onClick={() => setSlimDetail(d)}>{t("web.slimDetail.title")}</MenuItem>
            )}
            {d.createdBySimless && (
              <MenuItem
                disabled={lockedByOther || d.slim === "applying"}
                onClick={() => setSlimming(d)}
              >
                {t("web.device.slimSettings")}
              </MenuItem>
            )}
            {lockedByOther && (
              <>
                <MenuSeparator />
                <MenuItem
                  onClick={() =>
                    run(d, t("web.device.forceRelease"), () =>
                      call("lease.forceRelease", { device: d.id }),
                    )
                  }
                >
                  {t("web.device.forceRelease")}
                </MenuItem>
              </>
            )}
            <MenuSeparator />
            {d.createdBySimless ? (
              <MenuItem
                danger
                disabled={lockedByOther || d.default}
                title={d.default ? t("web.device.defaultCantDelete") : undefined}
                onClick={() => setDeleting(d)}
              >
                {t("web.device.delete")}
              </MenuItem>
            ) : (
              <MenuItem
                onClick={() =>
                  run(d, t("web.device.unlist"), () => call("device.unlist", { device: d.id }))
                }
              >
                {t("web.device.unlist")}
              </MenuItem>
            )}
          </Menu>
        </td>
      </tr>
    );
  };

  return (
    <>
      <div className="toolbar">
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
              <span className="mono count">{counts[p]}</span>
            </button>
          ))}
        </div>
        <label className="inline-field">
          <span>{t("web.groupFilter")}</span>
          <select
            value={activeGroup ? groupFilter : ""}
            onChange={(e) => setGroupFilter(e.target.value)}
          >
            <option value="">{t("web.groupFilter.all")}</option>
            {groups.map((g: Group) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </select>
        </label>
        <span className="spacer" />
        <input
          type="search"
          className="search"
          placeholder={t("web.search")}
          aria-label={t("web.search")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      {status.devices.length === 0 ? (
        <div className="empty">
          <p>{t("web.empty.title")}</p>
          <p className="sub">{t("web.empty.body")}</p>
          <button type="button" className="button button-primary" onClick={onCreate}>
            {t("web.create")}
          </button>
        </div>
      ) : (
        <div className="panel">
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th className="col-width">{t("table.width")}</th>
                  <th>{t("table.name")}</th>
                  <th className="col-state">{t("table.state")}</th>
                  <th>{t("web.tags")}</th>
                  <th>{t("web.holder")}</th>
                  <th className="col-actions">
                    <span className="visually-hidden">{t("web.actions")}</span>
                  </th>
                </tr>
              </thead>
              <tbody>{filtered.map(row)}</tbody>
            </table>
            {filtered.length === 0 && <p className="sub empty-row">{t("web.noMatch")}</p>}
          </div>
        </div>
      )}

      <TextDialog
        title={t("web.device.rename")}
        label={t("web.rename.label", { id: renaming?.id ?? "" })}
        device={renaming}
        initial={renaming?.name ?? ""}
        onClose={() => setRenaming(null)}
        onSave={(d, name) => {
          setRenaming(null);
          if (name.trim())
            void run(d, t("web.device.rename"), () =>
              call("device.rename", { device: d.id, name: name.trim() }),
            );
        }}
      />
      <SlimDetailDialog
        device={slimDetail}
        onClose={() => setSlimDetail(null)}
        onEdit={
          slimDetail?.createdBySimless &&
          !(slimDetail.holder !== undefined && !slimDetail.mine) &&
          slimDetail.slim !== "applying"
            ? (d) => {
                setSlimDetail(null);
                setSlimming(d);
              }
            : undefined
        }
      />
      <SlimDialog
        device={slimming}
        onClose={() => setSlimming(null)}
        onApply={(d, mode, keep) => {
          setSlimming(null);
          void run(d, t(mode === "none" ? "web.device.slimOff" : "web.device.slimSettings"), () =>
            call(
              "device.slim",
              mode === "none"
                ? { devices: [d.id], mode: "off" }
                : { devices: [d.id], mode: "on", keep },
            ),
          );
        }}
      />
      <DeviceGroupsDialog
        device={grouping}
        groups={groups}
        onClose={() => setGrouping(null)}
        onSave={(d, add, remove) => {
          setGrouping(null);
          void run(d, t("web.device.groups"), async () => {
            for (const id of add) await call("group.update", { group: id, add: [d.id] });
            for (const id of remove) await call("group.update", { group: id, remove: [d.id] });
          });
        }}
      />
      <Dialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        title={t("web.delete.title")}
      >
        {deleting && (
          <div className="dialog-body">
            <p>{t("web.delete.body", { name: deleting.name })}</p>
            <footer className="dialog-footer">
              <span className="spacer" />
              <button type="button" className="button" onClick={() => setDeleting(null)}>
                {t("web.cancel")}
              </button>
              <button
                type="button"
                className="button button-danger"
                onClick={() => {
                  const d = deleting;
                  setDeleting(null);
                  void run(d, t("web.device.delete"), () =>
                    call("device.delete", { device: d.id }),
                  );
                }}
              >
                {t("web.delete.confirm")}
              </button>
            </footer>
          </div>
        )}
      </Dialog>
    </>
  );
}

/** 이름·메모 — 글 하나를 고치는 창 */
function TextDialog({
  title,
  label,
  device,
  initial,
  onClose,
  onSave,
}: {
  title: string;
  label: string;
  device: DeviceView | null;
  initial: string;
  onClose: () => void;
  onSave: (device: DeviceView, text: string) => void;
}) {
  const [text, setText] = useState(initial);
  const inputId = useId();
  // 다른 디바이스로 열 때마다 처음 값으로
  useEffect(() => {
    if (device) setText(initial);
  }, [initial, device]);
  return (
    <Dialog open={device !== null} onClose={onClose} title={title}>
      {device && (
        <form
          className="dialog-body"
          onSubmit={(e) => {
            e.preventDefault();
            onSave(device, text);
          }}
        >
          <p className="sub">{device.name}</p>
          <div className="field">
            <label htmlFor={inputId}>{label}</label>
            <input
              id={inputId}
              data-autofocus
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
          </div>
          <footer className="dialog-footer">
            <span className="spacer" />
            <button type="button" className="button" onClick={onClose}>
              {t("web.cancel")}
            </button>
            <button type="submit" className="button button-primary">
              {t("web.save")}
            </button>
          </footer>
        </form>
      )}
    </Dialog>
  );
}

/** 이 디바이스가 들 그룹 고르기 (R21) */
function DeviceGroupsDialog({
  device,
  groups,
  onClose,
  onSave,
}: {
  device: DeviceView | null;
  groups: Group[];
  onClose: () => void;
  onSave: (device: DeviceView, add: string[], remove: string[]) => void;
}) {
  const [picked, setPicked] = useState<Set<string> | null>(null);
  const current = new Set(device?.groups ?? []);
  const selected = picked ?? current;
  return (
    <Dialog
      open={device !== null}
      onClose={() => {
        setPicked(null);
        onClose();
      }}
      title={t("web.device.groups")}
    >
      {device && (
        <form
          className="dialog-body"
          onSubmit={(e) => {
            e.preventDefault();
            const add = [...selected].filter((id) => !current.has(id));
            const remove = [...current].filter((id) => !selected.has(id));
            setPicked(null);
            onSave(device, add, remove);
          }}
        >
          <p className="sub">{device.name}</p>
          {groups.length === 0 ? (
            <p>{t("web.groups.noneForDevice")}</p>
          ) : (
            <ul className="check-list">
              {groups.map((g) => (
                <li key={g.id}>
                  <label className="check">
                    <input
                      type="checkbox"
                      checked={selected.has(g.id)}
                      onChange={(e) => {
                        const next = new Set(selected);
                        if (e.target.checked) next.add(g.id);
                        else next.delete(g.id);
                        setPicked(next);
                      }}
                    />
                    <span>
                      <strong>{g.name}</strong>
                      {g.description && (
                        <span className="sub"> — {g.description.split("\n")[0]}</span>
                      )}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          )}
          <footer className="dialog-footer">
            <span className="spacer" />
            <button
              type="button"
              className="button"
              onClick={() => {
                setPicked(null);
                onClose();
              }}
            >
              {t("web.cancel")}
            </button>
            <button type="submit" className="button button-primary" disabled={groups.length === 0}>
              {t("web.save")}
            </button>
          </footer>
        </form>
      )}
    </Dialog>
  );
}
