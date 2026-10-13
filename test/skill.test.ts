import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  bundledFiles,
  bundledSkill,
  installSkill,
  skillStatus,
  skillTarget,
} from "../src/install/skill.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
/** 설치되는 스킬 전체(SKILL.md + references/) — 안내가 어느 파일에 있든 찾는다 */
async function skillText(): Promise<string> {
  return [...(await bundledFiles()).values()].join("\n");
}

function home() {
  const dir = mkdtempSync(join(tmpdir(), "simless-skill-"));
  dirs.push(dir);
  return { HOME: dir };
}

describe("에이전트 스킬 (R16·S9)", () => {
  test("특정 앱에 묶이지 않는다 — 앱 이름·번들 ID·저장소 이름을 쓰지 않는다 (R16)", async () => {
    // 스킬은 모든 모바일 앱 프로젝트에서 쓴다. 예시는 MyApp 처럼 지어낸 이름으로
    for (const text of [
      await skillText(),
      await Bun.file("integrations/rules/simless.md").text(),
    ]) {
      // 번들 ID·패키지는 com.example 만, dev client 스킴은 지어낸 exp+myapp 이나 <자리 표시자> 만
      const bundleIds = [...text.matchAll(/\bcom\.[a-z0-9]+\.[a-z0-9.]+/gi)].map((m) => m[0]);
      expect(
        bundleIds.filter(
          (id) =>
            !id.startsWith("com.example.") &&
            !id.startsWith("com.apple.") &&
            !id.startsWith("com.android.") &&
            !id.startsWith("com.google."),
        ),
      ).toEqual([]);
      const schemes = [...text.matchAll(/exp\+[A-Za-z0-9.-]+/g)].map((m) => m[0]);
      expect(schemes.filter((s) => s !== "exp+myapp")).toEqual([]);
    }
  });

  test("들어 있는 스킬은 simless 스킬 문서다 (이름·트리거 포함)", async () => {
    const text = await bundledSkill();
    expect(text).toStartWith("---\nname: simless\n");
    expect(text).toContain("심리스로 확인해 줘");
  });

  test("없음 → 설치 → 같음, 내용이 바뀌면 예전 버전", async () => {
    const env = home();
    expect(await skillStatus(env)).toBe("missing");
    const target = await installSkill(env);
    expect(target).toBe(join(env.HOME, ".claude", "skills", "simless", "SKILL.md"));
    expect(await skillStatus(env)).toBe("current");
    writeFileSync(skillTarget(env), "old");
    expect(await skillStatus(env)).toBe("outdated");
    await installSkill(env);
    expect(readFileSync(target, "utf8")).toBe(await bundledSkill());
    // 앱 기능 찾기 참고 파일도 같이 — 하나라도 다르거나 남은 파일이 있으면 outdated (M15)
    const dir = dirname(target);
    expect(readFileSync(join(dir, "references/find-features-expo.md"), "utf8")).toContain(
      "# Finding app features — Expo",
    );
    writeFileSync(join(dir, "references/find-features-ios.md"), "old");
    expect(await skillStatus(env)).toBe("outdated");
    await installSkill(env);
    expect(await skillStatus(env)).toBe("current");
    writeFileSync(join(dir, "references/gone.md"), "left over");
    expect(await skillStatus(env)).toBe("outdated");
    await installSkill(env);
    expect(existsSync(join(dir, "references/gone.md"))).toBe(false);
    // 예전 폴더 이름(reference/)이 남아 있으면 outdated, 설치하면 지운다
    mkdirSync(join(dir, "reference"));
    writeFileSync(join(dir, "reference/app-ios.md"), "old");
    expect(await skillStatus(env)).toBe("outdated");
    await installSkill(env);
    expect(existsSync(join(dir, "reference"))).toBe(false);
    expect(await skillStatus(env)).toBe("current");
  });

  // 스킬 문서가 요구사항을 담고 있는지 — 문서를 고치다 빠뜨리지 않게
  test("React Native (Expo) 앱 작업에 반응하고 웹 프로젝트의 반응형 확인은 맡지 않는다 (S3·S4)", async () => {
    const description = /^description: (.*)$/m.exec(await bundledSkill())?.[1] ?? "";
    expect(description).toContain("React Native (Expo) mobile app");
    expect(await bundledSkill()).toContain("Supported apps: React Native with Expo (dev client).");
    expect(description).toContain("Not for web projects");
    expect(description).toContain("심리스로 확인해 줘");
  });

  test("순서 — 용도 고르기 → 점유·켜기 → Metro → 설치·실행 → 프로젝트 도구에 넘기기 → 정리 (S5·S6·S8)", async () => {
    const headings = [...(await bundledSkill()).matchAll(/^### \d+\. (.*)$/gm)].map((m) => m[1]);
    expect(headings).toEqual([
      "Check and pick what to use",
      "Acquire and boot",
      "Start your own Metro (React Native · Expo apps)",
      "Install and launch onto your Metro",
      "Hand off to the project's tools",
      "Clean up — recommend releasing",
    ]);
  });

  test("남의 기기·Metro 를 건드리지 않고, 자기 Metro 는 비어 있는 포트에 (S7·S11)", async () => {
    const text = await skillText();
    expect(text).toContain("Never touch other sessions' devices or Metro");
    expect(text).toContain("adb -s <targetId> reverse tcp:<port> tcp:<port>");
    expect(text).toContain("adb -s <targetId> reverse tcp:8081 tcp:<port>");
    expect(text).toContain("kill <your Metro PID>");
  });

  test("도구의 Metro 하나 안내 대신 — IPv4·준비 확인·주소를 넣은 실행·붙었는지 확인·도구에 포트 (S11)", async () => {
    const text = await skillText();
    const skill = await bundledSkill();
    expect(text).toContain("overrides any tool's single-Metro advice");
    expect(text).toContain("NODE_OPTIONS=--dns-result-order=ipv4first");
    expect(text).toContain(
      "curl -s http://127.0.0.1:<port>/status | grep -q 'packager-status:running'",
    );
    expect(text).toContain("not with a plain launch");
    expect(text).toContain("expo-development-client/?url=http%3A%2F%2F127.0.0.1%3A<port>");
    expect(text).toContain("RCT_jsLocation 127.0.0.1:<port>");
    // 스킴은 slug 로 만들지 않고 앱이 등록한 것을 찾는다 — 환경마다 slug 가 바뀌는 앱에서 실제로 틀렸다
    expect(text).toContain("Find the dev client scheme the app actually registers");
    expect(text).toContain("unable to resolve Intent");
    expect(text).toContain("Don't tap the listed servers");
    // iOS 빌드: 자기 Metro 를 다시 쓰고 127.0.0.1 로 열기, --no-bundler 금지, 번들 미리 만들기, 고정 sleep 대신 기다리기
    expect(text).toContain(
      "REACT_NATIVE_PACKAGER_HOSTNAME=127.0.0.1 npx expo run:ios --device <targetId> --port <port>",
    );
    // Expo 는 ANDROID_SERIAL 을 무시하고 첫 기기에 열고, run:android --device 는 AVD 이름 (Expo CLI 57 코드로 확인)
    expect(text).toContain("ignores `ANDROID_SERIAL`");
    // 원칙: 127.0.0.1 만, LAN IP 는 쓰지 않는다
    expect(text).toContain("never the Mac's LAN IP");
    // 슬림 방식 셋 — UI·App·Custom, 이름은 어느 언어에서나 그대로 (M15, device-slim 과 같게)
    expect(text).toContain("## Choosing how to slim");
    expect(text).toContain("UI, App, Custom");
    expect(text).toContain("--slim-keep <id,…> --app");
    expect(text).toContain("--slim-keep <id,…>");
    expect(text).toContain("simless slim <device> --keep <id,…>");
    // 앱에 필요한 기능 찾기 — device-slim 스킬 없이도 (M15)
    expect(skill).toContain("## Finding what the app needs");
    // 참고 파일은 agent-skills 의 device-slim 것을 쓰고, 스킬이 모두 링크한다
    for (const path of (await bundledFiles()).keys()) {
      if (path !== "SKILL.md") expect(skill).toContain(`(${path})`);
    }
    expect(text).toContain(".device-slim.json");
    expect(text).toContain(
      "| Remote push notifications | `aps-environment` entitlement, notification library | `store` |",
    );
    expect(text).toContain(
      "| Location | `ACCESS_FINE_LOCATION` / `ACCESS_COARSE_LOCATION` | `location` |",
    );
    expect(text).toContain(
      "through a Metro you start on this Mac, on this Mac's simulators and emulators",
    );
    expect(text).toContain("Physical devices");
    expect(text).toContain("npx expo run:android --device <AVD name> --port <port>");
    expect(text).not.toContain("run:android --device <targetId>");
    expect(text).toContain("Don't use `--no-bundler`.");
    expect(text).toContain("launchAsset.url");
    expect(text).toContain("grep -q 'iOS Bundled' <metro.log>");
  });

  test("Android 실측 보충 — --android 는 에뮬레이터가 하나일 때만, 앱에서 확인, 딥링크 재기동, reverse 사라짐, 점유는 따로 (S7·S11)", async () => {
    const text = await skillText();
    expect(text).toContain(
      "NODE_OPTIONS=--dns-result-order=ipv4first npx expo start --dev-client --port <port> --android",
    );
    expect(text).toContain("Check it attached — in the app, not in the Metro log.");
    expect(text).toContain("Connected to: http://…:<port>");
    expect(text).toContain("An Android deep link can restart the app");
    expect(text).toContain("These mappings disappear");
    expect(text).toContain("Run `simless use` on its own");
    expect(text).toContain("ask the user before restarting it");
    expect(text).toContain("simless --json use … 2>/dev/null | jq");
    expect(text).toContain("A screenshot is entirely black");
    expect(text).toContain("debugger, profiler and reload tools default to 8081");
  });

  test("직접 빌드·설치할 때는 기기를 꼭 지정한다 — 남의 에뮬레이터에 깔리지 않게 (S7)", async () => {
    const text = await skillText();
    expect(text).toContain("--deviceId <targetId>");
    expect(text).toContain("ANDROID_SERIAL=<targetId>");
  });

  test("테스트에 맞는 기기 — 레이아웃은 아무 기기나, 기능 테스트는 slimOff 를 보고, 맞는 기기가 없으면 묻는다 (S13)", async () => {
    const text = await skillText();
    expect(text).toContain("#### Does the test need device features?");
    expect(text).toContain("**UI and layout checks** need nothing");
    expect(text).toContain("A device fits when **none of those IDs is in its `slimOff`**");
    expect(text).toContain("wait for it (`--wait`) and tell the user");
    expect(text).toContain("No device fits → **ask the user**");
  });

  test("스킬 형식 — description·본문 길이 한도, 참고 파일은 본문에서 한 단계만, 진행 체크리스트 (S9)", async () => {
    const skill = await bundledSkill();
    const description = /^description: (.*)$/m.exec(skill)?.[1] ?? "";
    // Agent Skills 규격 — 넘으면 잘리거나 로드되지 않는다. 본문은 500줄 아래(Anthropic 가이드)
    expect(description.length).toBeLessThanOrEqual(1024);
    expect(skill.split("\n").length).toBeLessThan(500);
    // 참고 파일끼리 링크하지 않는다 — 에이전트가 따라가면 일부만 읽고 넘어가기 쉽다
    for (const [path, text] of await bundledFiles()) {
      if (path === "SKILL.md") continue;
      expect([...text.matchAll(/\]\(([^)\s#]+\.md)/g)].map((m) => `${path} → ${m[1]}`)).toEqual([]);
    }
    expect(skill).toContain("**Progress** — copy this list");
    expect(skill).toContain(
      "Read [references/troubleshooting.md](references/troubleshooting.md) when",
    );
  });

  test("도구 중립 — 특정 도구 이름 없이 넘길 것·기기 명시·켜기는 Simless·해제 권유 (S6·S8·P10)", async () => {
    // 화면 조작·테스트 도구는 프로젝트가 고른다 — 스킬·규칙이 특정 도구에 묶이지 않게
    for (const text of [await skillText(), await Bun.file("integrations/rules/simless.md").text()])
      expect(
        [...text.matchAll(/\b(argent|maestro|agent-device|appium|detox)\b/gi)].map((m) => m[0]),
      ).toEqual([]);
    const skill = await bundledSkill();
    expect(skill).toContain("Use what the project names");
    expect(skill).toContain("**Name the device on every call**");
    expect(skill).toContain("**Don't let a tool boot, create or shut down devices**");
    expect(skill).toContain("close them before you release");
    expect(skill).toContain("When your device work is done, **recommend releasing**");
  });

  test("그룹은 사용자가 요청할 때만 (S10)", async () => {
    expect(await bundledSkill()).toContain(
      "Create or edit device groups **only when the user asks**",
    );
  });
});
