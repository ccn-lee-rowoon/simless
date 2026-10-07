import { useEffect } from "react";
import { t } from "../shared/i18n.ts";
import { Logo } from "./ui.tsx";

// 시작 애니메이션 (M17) — «Simulator + Seamless» 에서 남길 글자(Sim, less)만 남기고 나머지를 접어
// «Simless» 로 합친다. 앱(Simless.app)이 켜진 뒤 대시보드를 처음 열 때만 메뉴바 앱이 주소에
// `launch=1` 을 붙인다. 보이면 바로 그 표시를 지워, 서버가 다시 켜져 화면을 다시 읽어도 또 나오지 않는다.

/** 이번에 보여 줄지 — 주소의 `launch=1` 을 읽고 지운다 */
export function takeLaunchFlag(): boolean {
  const url = new URL(location.href);
  if (url.searchParams.get("launch") !== "1") return false;
  url.searchParams.delete("launch");
  history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  return true;
}

/** 전체 길이(ms) — 접기·모으기·로고 뒤 사라지기까지. 동작 줄이기면 로고만 잠깐 */
const DURATION = 2900;
const REDUCED = 700;

export function LaunchSplash({ onDone }: { onDone: () => void }) {
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;

  useEffect(() => {
    const timer = setTimeout(onDone, reduced ? REDUCED : DURATION);
    const skip = () => onDone();
    window.addEventListener("keydown", skip);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("keydown", skip);
    };
  }, [onDone, reduced]);

  return (
    <button
      type="button"
      className={reduced ? "launch launch-reduced" : "launch"}
      aria-label={t("web.launch.skip")}
      onClick={onDone}
    >
      <span className="launch-word" aria-hidden="true">
        <span className="launch-keep">Sim</span>
        <span className="launch-drop launch-drop-a">ulator</span>
        <span className="launch-gap" />
        <span className="launch-drop launch-drop-b">Seam</span>
        <span className="launch-keep">less</span>
      </span>
      <span className="launch-logo">
        <Logo size={44} />
      </span>
    </button>
  );
}
