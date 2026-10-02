import type { SourceEntry, SourceListResult } from "../shared/api.ts";
import { PlatformBadge } from "./ui.tsx";

/** «전체 목록» 탭 — 이 Mac 의 모든 에뮬레이터·시뮬레이터 (M9) */
export function SourcesTab({
  result,
  onCreate,
  onRefresh,
}: {
  result: SourceListResult | null;
  onCreate: (source: SourceEntry) => void;
  onRefresh: () => void;
}) {
  if (!result) return <div className="empty subtle">이 Mac 의 디바이스를 읽는 중…</div>;
  return (
    <>
      <div className="toolbar">
        <p className="subtle">
          이 Mac 에 있는 에뮬레이터·시뮬레이터입니다. «복제» 하면 같은 크기의 <code>corgi …</code>{" "}
          디바이스를 만들고 슬림화합니다(앱은 설치하지 않음).
        </p>
        <button type="button" className="button" onClick={onRefresh}>
          새로 읽기
        </button>
      </div>
      {result.problems.map((p) => (
        <p key={`${p.platform}-${p.message}`} className="problem">
          {p.platform}: {p.message}
        </p>
      ))}
      <table className="table">
        <thead>
          <tr>
            <th>크기</th>
            <th>이름</th>
            <th>기기</th>
            <th>상태</th>
            <th aria-label="동작" />
          </tr>
        </thead>
        <tbody>
          {result.items
            .filter((s) => s.kind === "device")
            .map((s) => (
              <tr key={s.native} className={s.managed ? "row-corgi" : ""}>
                <td>
                  <div className="size">{s.label.replace(/^(Android|iOS) /, "")}</div>
                  <PlatformBadge platform={s.platform} />
                </td>
                <td>
                  <div className="name">{s.name}</div>
                  <div className="subtle mono">{s.native}</div>
                </td>
                <td className="subtle">{s.detail}</td>
                <td>
                  {s.booted ? (
                    <span className="state-on">켜짐</span>
                  ) : (
                    <span className="subtle">꺼짐</span>
                  )}
                </td>
                <td className="actions">
                  {s.managed ? (
                    <span className="badge badge-info">Corgi {s.managed}</span>
                  ) : s.created ? (
                    <span
                      className="badge badge-neutral"
                      title={`같은 크기로 이미 만든 디바이스: ${s.created}`}
                    >
                      생성됨
                    </span>
                  ) : (
                    <button type="button" className="button" onClick={() => onCreate(s)}>
                      복제
                    </button>
                  )}
                </td>
              </tr>
            ))}
        </tbody>
      </table>
    </>
  );
}
