import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bundledSkill, installSkill, skillStatus, skillTarget } from "../src/install/skill.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function home() {
  const dir = mkdtempSync(join(tmpdir(), "simless-skill-"));
  dirs.push(dir);
  return { HOME: dir };
}

describe("에이전트 스킬 (R16·S9)", () => {
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
  });

  // 스킬 문서가 요구사항을 담고 있는지 — 문서를 고치다 빠뜨리지 않게
  test("모바일 앱 작업에 반응하고 웹 프로젝트의 반응형 확인은 맡지 않는다 (S3·S4)", async () => {
    const description = /^description: (.*)$/m.exec(await bundledSkill())?.[1] ?? "";
    expect(description).toContain("mobile app");
    expect(description).toContain("Not for web projects");
    expect(description).toContain("심리스로 확인해 줘");
  });

  test("순서 — 용도 고르기 → 점유·켜기 → Metro → argent → 보고 → 정리 (S5·S6·S8)", async () => {
    const headings = [...(await bundledSkill()).matchAll(/^### \d+\. (.*)$/gm)].map((m) => m[1]);
    expect(headings).toEqual([
      "Check and pick what to use",
      "Acquire and boot",
      "Start your own Metro (React Native · Expo apps)",
      "Drive each device with argent",
      "Report",
      "Clean up",
    ]);
  });

  test("남의 기기·Metro 를 건드리지 않고, 자기 Metro 는 비어 있는 포트에 (S7·S11)", async () => {
    const text = await bundledSkill();
    expect(text).toContain("Never touch other sessions' devices or Metro");
    expect(text).toContain("adb -s <targetId> reverse tcp:<port> tcp:<port>");
    expect(text).toContain("adb -s <targetId> reverse tcp:8081 tcp:<port>");
    expect(text).toContain("kill <your Metro PID>");
  });

  test("argent 의 Metro 하나 안내 대신 — IPv4·준비 확인·주소를 넣은 실행·붙었는지 확인·디버거 포트 (S11)", async () => {
    const text = await bundledSkill();
    expect(text).toContain("overrides the argent React Native workflow's single-Metro advice");
    expect(text).toContain("NODE_OPTIONS=--dns-result-order=ipv4first");
    expect(text).toContain("`debugger-status` with `device_id: <targetId>` and `port: <port>`");
    expect(text).toContain("not with `launch-app`");
    expect(text).toContain("expo-development-client/?url=http%3A%2F%2F127.0.0.1%3A<port>");
    expect(text).toContain("RCT_jsLocation 127.0.0.1:<port>");
    expect(text).toContain("Pass `port: <port>` to **every** argent `debugger-*`");
  });

  test("직접 빌드·설치할 때는 기기를 꼭 지정한다 — 남의 에뮬레이터에 깔리지 않게 (S7)", async () => {
    const text = await bundledSkill();
    expect(text).toContain("--deviceId <targetId>");
    expect(text).toContain("ANDROID_SERIAL=<targetId>");
  });

  test("그룹은 사용자가 요청할 때만 (S10)", async () => {
    expect(await bundledSkill()).toContain(
      "Create or edit device groups **only when the user asks**",
    );
  });
});
