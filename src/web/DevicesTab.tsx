import { type ReactNode, useEffect, useState } from "react";
import type { DeviceView, StatusResult } from "../shared/api.ts";
import { call } from "./api.ts";
import { Dialog, holderText, PlatformBadge, SlimBadge } from "./ui.tsx";

type Act = (label: string, fn: () => Promise<unknown>) => Promise<void>;

/** «생성됨» 탭 — Corgi 가 만든 디바이스 (M5~M8) */
export function DevicesTab({
  devices,
  queue,
  act,
  onCreate,
}: {
  devices: DeviceView[];
  queue: StatusResult["queue"];
  act: Act;
  onCreate: () => void;
}) {
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [renaming, setRenaming] = useState<DeviceView | null>(null);
  const [deleting, setDeleting] = useState<DeviceView | null>(null);

  // 열린 메뉴(⋯)는 다른 곳을 누르거나 Esc 를 누르면 닫는다
  useEffect(() => {
    const closeAll = (except?: Element | null) => {
      for (const menu of document.querySelectorAll<HTMLDetailsElement>("details.menu[open]")) {
        if (menu !== except) menu.open = false;
      }
    };
    const onPointer = (event: PointerEvent) =>
      closeAll((event.target as Element | null)?.closest("details.menu"));
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeAll();
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, []);

  const run = async (device: DeviceView, label: string, fn: () => Promise<unknown>) => {
    setBusy((s) => new Set(s).add(device.id));
    await act(`${device.name} ${label}`, fn);
    setBusy((s) => {
      const next = new Set(s);
      next.delete(device.id);
      return next;
    });
  };

  // 사람이 켜고 끄는 건 점유가 아니다 — 다른 세션이 쓰는 중이면 서버가 막는다
  const boot = (d: DeviceView) => run(d, "켜기", () => call("device.up", { devices: [d.id] }));
  const shutdown = (d: DeviceView) =>
    run(d, "끄기", () => call("device.down", { devices: [d.id] }));

  if (devices.length === 0) {
    return (
      <div className="empty">
        <p>아직 만든 디바이스가 없습니다.</p>
        <p className="subtle">
          이 Mac 의 에뮬레이터·시뮬레이터를 원본으로 골라 같은 크기로 복제하고 슬림화합니다.
        </p>
        <button type="button" className="button button-primary" onClick={onCreate}>
          + 생성
        </button>
      </div>
    );
  }

  const sorted = [...devices].sort(
    (a, b) => a.spec.platform.localeCompare(b.spec.platform) || a.layoutWidth - b.layoutWidth,
  );
  return (
    <>
      <table className="table">
        <thead>
          <tr>
            <th>크기</th>
            <th>이름</th>
            <th>상태</th>
            <th>슬림</th>
            <th>점유</th>
            <th aria-label="동작" />
          </tr>
        </thead>
        <tbody>
          {sorted.map((d) => {
            const lockedByOther = d.holder !== undefined && !d.mine;
            const waiting = queue.filter((q) => q.deviceIds.includes(d.id)).length;
            return (
              <tr key={d.id} className={d.enabled ? "" : "row-disabled"}>
                <td>
                  <div className="size">{d.label.replace(/^(Android|iOS) /, "")}</div>
                  <PlatformBadge platform={d.spec.platform} />
                </td>
                <td>
                  <div className="name">{d.name}</div>
                  <div className="subtle mono">
                    {d.id}
                    {d.source ? ` · 원본 ${d.source.name}` : ""}
                    {d.enabled ? "" : " · 사용 안 함"}
                  </div>
                </td>
                <td>
                  {d.booted ? (
                    <span className="state-on">
                      켜짐 <span className="subtle mono">{d.targetId}</span>
                    </span>
                  ) : (
                    <span className="subtle">꺼짐</span>
                  )}
                </td>
                <td>
                  <SlimBadge state={d.slim} error={d.slimError} />
                </td>
                <td>
                  {d.holder ? (
                    <span className={d.mine ? "holder holder-mine" : "holder"}>
                      {d.mine ? "웹 UI (나)" : holderText(d.holder)}
                    </span>
                  ) : (
                    <span className="subtle">비어 있음</span>
                  )}
                  {waiting > 0 && <div className="subtle">대기 {waiting}</div>}
                </td>
                <td className="actions">
                  <button
                    type="button"
                    className="button"
                    disabled={busy.has(d.id) || lockedByOther}
                    title={lockedByOther ? "다른 세션이 사용 중" : undefined}
                    onClick={() => (d.booted ? shutdown(d) : boot(d))}
                  >
                    {busy.has(d.id) ? "…" : d.booted ? "끄기" : "켜기"}
                  </button>
                  <details className="menu">
                    <summary className="icon-button" aria-label="더 보기">
                      ⋯
                    </summary>
                    <div className="menu-items">
                      <MenuItem disabled={lockedByOther} onClick={() => setRenaming(d)}>
                        이름 변경
                      </MenuItem>
                      <MenuItem
                        onClick={() =>
                          run(d, d.enabled ? "사용 안 함" : "다시 사용", () =>
                            call("device.setEnabled", { device: d.id, enabled: !d.enabled }),
                          )
                        }
                      >
                        {d.enabled ? "사용 안 함" : "다시 사용"}
                      </MenuItem>
                      <MenuItem
                        disabled={lockedByOther}
                        onClick={() =>
                          run(d, "슬림 적용", () =>
                            call("device.slim", { devices: [d.id], mode: "on" }),
                          )
                        }
                      >
                        슬림 다시 적용
                      </MenuItem>
                      <MenuItem
                        disabled={lockedByOther}
                        onClick={() =>
                          run(d, "슬림 확인", () =>
                            call("device.slim", { devices: [d.id], mode: "check" }),
                          )
                        }
                      >
                        슬림 상태 확인
                      </MenuItem>
                      {lockedByOther && (
                        <MenuItem
                          onClick={() =>
                            run(d, "점유 강제 해제", () =>
                              call("lease.forceRelease", { device: d.id }),
                            )
                          }
                        >
                          점유 강제 해제
                        </MenuItem>
                      )}
                      <MenuItem danger disabled={lockedByOther} onClick={() => setDeleting(d)}>
                        삭제…
                      </MenuItem>
                    </div>
                  </details>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <RenameDialog
        device={renaming}
        onClose={() => setRenaming(null)}
        onSave={(d, name) => {
          setRenaming(null);
          void run(d, "이름 변경", () => call("device.rename", { device: d.id, name }));
        }}
      />
      <Dialog open={deleting !== null} onClose={() => setDeleting(null)} title="디바이스 삭제">
        {deleting && (
          <div className="dialog-body">
            <p>
              <strong>{deleting.name}</strong> 을(를) 지울까요? 켜져 있으면 끄고 지웁니다. 되돌릴 수
              없습니다.
            </p>
            <footer className="dialog-footer">
              <button type="button" className="button" onClick={() => setDeleting(null)}>
                취소
              </button>
              <button
                type="button"
                className="button button-danger"
                onClick={() => {
                  const d = deleting;
                  setDeleting(null);
                  void run(d, "삭제", () => call("device.delete", { device: d.id }));
                }}
              >
                삭제
              </button>
            </footer>
          </div>
        )}
      </Dialog>
    </>
  );
}

function RenameDialog({
  device,
  onClose,
  onSave,
}: {
  device: DeviceView | null;
  onClose: () => void;
  onSave: (device: DeviceView, name: string) => void;
}) {
  const [name, setName] = useState("");
  return (
    <Dialog open={device !== null} onClose={onClose} title="이름 변경">
      {device && (
        <form
          className="dialog-body"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) onSave(device, name.trim());
          }}
        >
          <label className="field">
            <span>새 이름 — ID({device.id})는 그대로라 같은 디바이스로 실행됩니다</span>
            <input defaultValue={device.name} onChange={(e) => setName(e.target.value)} />
          </label>
          <footer className="dialog-footer">
            <button type="button" className="button" onClick={onClose}>
              취소
            </button>
            <button type="submit" className="button button-primary">
              저장
            </button>
          </footer>
        </form>
      )}
    </Dialog>
  );
}

/** 메뉴 항목 — 누르면 메뉴(<details>)를 닫고 동작한다 */
function MenuItem({
  onClick,
  disabled,
  danger,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className={danger ? "danger" : undefined}
      disabled={disabled}
      onClick={(event) => {
        const menu = event.currentTarget.closest("details");
        if (menu) menu.open = false;
        onClick();
      }}
    >
      {children}
    </button>
  );
}
