import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { normalize } from "../src/hook/adapters.ts";
import { offlineDecision } from "../src/hook/index.ts";
import { extractTargets } from "../src/hook/targets.ts";
import { SimlessServer } from "../src/server/app.ts";
import { listen } from "../src/server/socket.ts";
import { call } from "../src/shared/client.ts";
import { HOOK_MATCHERS } from "../src/shared/hook-scope.ts";
import { VERSION } from "../src/shared/version.ts";
import { type FakeDriver, fakeDriver, seedDevice, session, tempEnv } from "./helpers.ts";

const UDID = "5B6D77EF-2AE9-47D0-9A62-70A1ABBC5FA2";

describe("도구 중립 훅 — 도구 이름이 아니라 기기 ID 를 본다 (P10)", () => {
  const bash = (command: string, known: string[] = []) =>
    extractTargets("Bash", { command }, new Set(known));
  const mcp = (tool: string, input: unknown, known: string[] = []) =>
    extractTargets(tool, input, new Set(known));
  const only = (ids: string[]) => ({ ids, boots: [], allAndroid: false, allIos: false });

  test("어느 셸 명령이든 UDID·에뮬레이터 시리얼·관리 AVD ID 가 보이면 후보, 없으면 통과", () => {
    expect(bash(`maestro --device ${UDID} test flow.yaml`)).toEqual(only([UDID]));
    expect(bash("npx agent-device snapshot -i --serial emulator-5556")).toEqual(
      only(["emulator-5556"]),
    );
    expect(bash("some-tool run --avd simless_ab12", ["simless_ab12"])).toEqual(
      only(["simless_ab12"]),
    );
    // 도구 이름만 있고 기기 ID 가 없으면 — 글로 언급하든 실행하든 서버에 묻지 않는다
    expect(bash("grep -rn agent-device README.md")).toBeUndefined();
    expect(bash("maestro test .maestro/login.yaml")).toBeUndefined();
    expect(bash("some-tool run --avd simless_ab12")).toBeUndefined();
  });

  test("어느 MCP 서버의 도구든 인자 글자에서 찾는다 — 인자 이름은 보지 않는다", () => {
    expect(mcp("mcp__argent__gesture-tap", { udid: UDID, x: 0.5, y: 0.5 })).toEqual(only([UDID]));
    expect(mcp("mcp__maestro__run", { device_id: "emulator-5554", yaml: "- launchApp" })).toEqual(
      only(["emulator-5554"]),
    );
    expect(mcp("mcp__any-tool__open", { target: { serial: "emulator-5554" } })?.ids).toEqual([
      "emulator-5554",
    ]);
    expect(
      mcp("mcp__argent__stop-all-simulator-servers", { devices: ["simless_ab12", "", 3] }, [
        "simless_ab12",
      ])?.ids,
    ).toEqual(["simless_ab12"]);
    // `--device X` 처럼 글 안에 든 것도
    expect(mcp("mcp__x__exec", { args: `--udid ${UDID} --verbose` })?.ids).toEqual([UDID]);
  });

  test("기기를 가리키지 않는 호출·Simless 자신의 MCP·MCP 가 아닌 도구는 통과", () => {
    expect(mcp("mcp__argent__list-devices", {})).toBeUndefined();
    expect(mcp("mcp__argent__flow-execute", { name: "login" })).toBeUndefined();
    expect(mcp("mcp__simless__simless_use", { devices: [UDID] })).toBeUndefined();
    expect(mcp("Write", { file_path: "/x", content: UDID })).toBeUndefined();
  });

  test("에이전트 훅은 셸과 모든 MCP 도구에 건다", () => {
    expect(HOOK_MATCHERS.claude).toBe("Bash|mcp__.*");
    expect(HOOK_MATCHERS.codex).toBe("^Bash$|^mcp__.*");
    expect(HOOK_MATCHERS.gemini).toBe("^run_shell_command$|^mcp_");
    // Copilot 은 MCP 도구 이름에만 «-» 가 있다
    expect(new RegExp(`^(${HOOK_MATCHERS.copilot})$`).test("argent-gesture-tap")).toBe(true);
    expect(new RegExp(`^(${HOOK_MATCHERS.copilot})$`).test("view")).toBe(false);
  });

  test("다른 에이전트의 MCP 호출을 공통 이름으로 — 어느 서버든", () => {
    expect(
      normalize("copilot", "pre-tool-use", { tool_name: "maestro-run", tool_input: {} })?.tool,
    ).toBe("mcp__maestro__run");
    expect(normalize("copilot", "pre-tool-use", { tool_name: "view", tool_input: {} })?.tool).toBe(
      "view",
    );
    expect(
      normalize("cursor", "before-mcp", {
        mcp_server_name: "agent-device",
        tool_name: "open",
        tool_input: JSON.stringify({ udid: UDID }),
      }),
    ).toMatchObject({ tool: "mcp__agent-device__open", input: { udid: UDID } });
    expect(
      normalize("gemini", "before-tool", {
        tool_name: "mcp_argent_screenshot",
        mcp_context: { server_name: "argent", tool_name: "screenshot" },
        tool_input: { udid: UDID },
      })?.tool,
    ).toBe("mcp__argent__screenshot");
  });
});

describe("훅 대상 뽑기 (P4·P6)", () => {
  const bash = (command: string) => extractTargets("Bash", { command });

  test("디바이스와 상관없는 명령·기기를 가리키지 않는 도구는 바로 통과", () => {
    expect(bash("ls -la && git status")).toBeUndefined();
    expect(bash("simless use bakw")).toBeUndefined();
    expect(extractTargets("mcp__argent__list-devices", {})).toBeUndefined();
    expect(extractTargets("Read", { file_path: "/x" })).toBeUndefined();
  });

  test("adb -s 시리얼·UDID 는 대상 후보, 기기 지정 없는 adb shell 은 켜진 Android 전부", () => {
    expect(bash("adb -s emulator-5554 shell input tap 1 2")).toMatchObject({
      ids: expect.arrayContaining(["emulator-5554"]),
      allAndroid: false,
    });
    expect(bash("adb shell getprop")?.allAndroid).toBe(true);
    expect(bash("ANDROID_SERIAL=emulator-5554 adb shell ls")?.allAndroid).toBe(false);
    expect(bash("adb devices")?.allAndroid).toBe(false);
    expect(bash("cd app && adb reverse tcp:8081 tcp:8081")?.allAndroid).toBe(true);
  });

  test("simctl booted 은 켜진 iOS 전부, simctl boot·emulator -avd 는 켜기", () => {
    expect(bash("xcrun simctl openurl booted myapp://home")?.allIos).toBe(true);
    expect(bash("xcrun simctl boot UDID-1")?.boots).toEqual(["UDID-1"]);
    expect(bash("$ANDROID_HOME/emulator/emulator -avd simless_ab12 -no-audio")?.boots).toEqual([
      "simless_ab12",
    ]);
    expect(bash("emulator @Pixel_6a")?.boots).toEqual(["Pixel_6a"]);
    expect(bash("xcrun simctl list devices")).toMatchObject({ allIos: false, boots: [] });
  });

  test("파일·커밋 메시지로 가는 heredoc 본문은 글이라 보지 않는다 — 실행되는 heredoc 은 본다 (P4)", () => {
    // 문서를 고치는 스크립트를 파일로 쓰기만 한다 — 본문에 adb 와 AVD ID 가 있어도 통과
    expect(
      bash("cat > /tmp/fix.py <<'EOF'\nnote = 'run adb -s emulator-5554 for simless_ab12'\nEOF"),
    ).toBeUndefined();
    expect(
      bash("git commit -q -F - <<EOF\nfix: adb reverse on simless_ab12\nEOF\necho done"),
    ).toBeUndefined();
    expect(bash("tee notes.md <<-EOF\n\tadb shell on simless_ab12\n\tEOF")).toBeUndefined();
    // 본문 밖의 명령은 그대로 본다
    const after = bash("cat > a.txt <<EOF\nsimless_ab12\nEOF\nadb -s emulator-5554 shell ls")?.ids;
    expect(after).toContain("emulator-5554");
    expect(after).not.toContain("simless_ab12");

    // 셸·인터프리터로 들어가는 본문은 실행되므로 본다
    expect(bash("bash <<EOF\nadb -s emulator-5554 shell ls\nEOF")?.ids).toContain("emulator-5554");
    expect(
      bash("python3 - <<'PY'\nimport os; os.system('adb -s emulator-5554 shell ls')\nPY")?.ids,
    ).toContain("emulator-5554");
    expect(bash("cat <<EOF | sh\nadb shell ls\nEOF")?.allAndroid).toBe(true);
    expect(bash('eval "$(cat <<EOF\nadb -s emulator-5554 shell ls\nEOF\n)"')?.ids).toContain(
      "emulator-5554",
    );
    // 끝 표시가 없으면 끝까지 본문
    expect(bash("cat > a.txt <<EOF\nadb -s emulator-5554 shell ls")).toBeUndefined();
  });

  test("heredoc 앞에서 끝난 명령의 실행기는 보지 않는다 — 뒤의 명령·파이프·따옴표 안은 본다 (P4)", () => {
    const message = "fix: 기기를 지정하지 않은 adb shell 처럼\nEOF";
    // `;`·`&&`·`||` 앞의 bun·bash 는 본문을 받지 못한다 — 커밋 메시지는 글
    expect(
      bash(
        `bun run check >/dev/null 2>&1; echo $?; git add -A && git commit -F - <<'EOF'\n${message}`,
      ),
    ).toBeUndefined();
    expect(bash(`bash build.sh && git commit -F - <<'EOF'\n${message}`)).toBeUndefined();
    expect(bash(`bun test || tee log.md <<EOF\n${message}`)).toBeUndefined();
    // 따옴표 안의 ; 는 나누는 자리가 아니다
    expect(bash(`bash -c 'a; b' <<EOF\nadb shell ls\nEOF`)?.allAndroid).toBe(true);
    expect(bash(`python3 -c "x; y" - <<EOF\nadb shell ls\nEOF`)?.allAndroid).toBe(true);
    // 리다이렉션의 & 로 나누지 않는다
    expect(bash("bash 2>&1 <<EOF\nadb shell ls\nEOF")?.allAndroid).toBe(true);
    // 뒤의 명령은 본문을 쓴 파일을 실행할 수 있다
    expect(bash("cat > a.sh <<EOF\nadb shell ls\nEOF")).toBeUndefined();
    expect(bash("cat > a.sh <<EOF; bash a.sh\nadb shell ls\nEOF")?.allAndroid).toBe(true);
    expect(bash("echo x; cat <<EOF | sh\nadb shell ls\nEOF")?.allAndroid).toBe(true);
    // 따옴표가 닫히지 않은 채 heredoc 이 나오면 줄 전체를 본다
    expect(bash('bash -c "x; $(cat <<EOF\nadb shell ls\nEOF\n)"')?.allAndroid).toBe(true);
  });
});

describe("서버가 꺼졌을 때 (P9)", () => {
  const index = {
    devices: [
      {
        id: "ab12",
        name: "Small",
        platform: "android" as const,
        native: "simless_ab12",
        targetId: "emulator-5554",
      },
      { id: "cd34", name: "SE", platform: "ios" as const, native: "UDID-1" },
    ],
  };
  const targets = { ids: [] as string[], boots: [] as string[], allAndroid: false, allIos: false };

  test("관리 디바이스(ID·마지막 시리얼)로 보이면 막는다", () => {
    expect(offlineDecision(index, { ...targets, ids: ["emulator-5554"] }).allow).toBe(false);
    expect(offlineDecision(index, { ...targets, ids: ["UDID-1"] }).allow).toBe(false);
    expect(offlineDecision(index, { ...targets, allAndroid: true }).allow).toBe(false);
  });

  test("관리 디바이스가 아니거나, 켜져 있던 iOS 가 없으면 통과", () => {
    expect(offlineDecision(index, { ...targets, ids: ["Pixel_6a"] }).allow).toBe(true);
    expect(offlineDecision(index, { ...targets, allIos: true }).allow).toBe(true);
    expect(offlineDecision(undefined, { ...targets, ids: ["UDID-1"] }).allow).toBe(true);
  });
});

describe("hook.check — 점유했는지 (P1·P5·P8)", () => {
  const env = tempEnv();
  let driver: FakeDriver;
  let server: SimlessServer;
  let stop = () => {};
  const check = (key: string, params: unknown) =>
    call<{ allow: boolean; reason?: string }>(
      env.paths.socket,
      "hook.check",
      params,
      session(key),
    ).then((r) => r.result);

  beforeAll(async () => {
    driver = fakeDriver();
    server = new SimlessServer({ ...env, drivers: [driver] });
    seedDevice(server, driver, "ab12", "Small");
    seedDevice(server, driver, "pix6", "Pixel 6a", false, false); // simless 목록에 없음
    stop = (await listen(env.paths.socket, VERSION, server.handle)).stop;
  });
  afterAll(() => {
    stop();
    env.cleanup();
  });

  test("simless 목록에 없는 기기는 통과, 점유하지 않은 관리 디바이스는 막고 점유 방법을 알려 준다", async () => {
    expect(await check("A", { ids: ["Pixel_6a_pix6"] })).toMatchObject({ allow: true });
    const denied = await check("A", { ids: ["simless_ab12"] });
    expect(denied.allow).toBe(false);
    expect(denied.reason).toContain("simless use ab12");
  });

  test("점유한 세션은 통과, 다른 세션은 누가 쓰는지와 함께 막힌다", async () => {
    await call(env.paths.socket, "lease.acquire", { devices: ["ab12"] }, session("A"));
    expect(await check("A", { ids: ["simless_ab12"] })).toMatchObject({ allow: true });
    expect(await check("B", { ids: ["simless_ab12"] })).toMatchObject({
      allow: false,
      reason: expect.stringContaining("test-agent"),
    });
  });

  test("켜진 기기의 시리얼·기기 지정 없는 adb 도 대상, 켜기는 점유해도 simless 로", async () => {
    // 켜기는 상태를 바꾸는 요청이라 서버가 켜짐 상태 기억을 버린다
    await call(env.paths.socket, "device.up", { devices: ["ab12"] }, session("A"));
    const serial = (await server.runtimeStates(await server.devices())).get("ab12")?.targetId ?? "";
    expect(serial).toStartWith("emulator-");
    expect(await check("B", { ids: [serial] })).toMatchObject({ allow: false });
    expect(await check("B", { allAndroid: true })).toMatchObject({ allow: false });
    expect(await check("A", { boots: ["simless_ab12"] })).toMatchObject({
      allow: false,
      reason: expect.stringContaining("simless use"),
    });
  });
});

describe("simless hook claude pre-tool-use", () => {
  const entry = new URL("../bin/simless.ts", import.meta.url).pathname;

  async function hook(input: unknown, extraEnv: Record<string, string>) {
    const proc = Bun.spawn([process.execPath, entry, "hook", "claude", "pre-tool-use"], {
      env: { ...process.env, ...extraEnv },
      stdin: new Blob([JSON.stringify(input)]),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    return { stdout, exitCode };
  }

  test("디바이스와 상관없는 호출은 아무것도 출력하지 않고 통과", async () => {
    const env = tempEnv();
    const result = await hook({ tool_name: "Bash", tool_input: { command: "ls" } }, env.env);
    env.cleanup();
    expect(result).toEqual({ stdout: "", exitCode: 0 });
  });

  test("서버가 꺼져 있고 관리 디바이스로 보이면 deny JSON 을 낸다", async () => {
    const env = tempEnv();
    mkdirSync(env.env.SIMLESS_STATE_DIR, { recursive: true });
    writeFileSync(
      env.paths.managedIndex,
      JSON.stringify({
        devices: [{ id: "ab12", name: "Small", platform: "android", native: "simless_ab12" }],
      }),
    );
    const result = await hook(
      { tool_name: "mcp__argent__gesture-tap", tool_input: { udid: "simless_ab12" } },
      env.env,
    );
    env.cleanup();
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny" },
    });
  });
});

describe("훅 입력의 작업 폴더 (P3·M13)", () => {
  test("에이전트가 준 cwd(절대 경로)를 세션 폴더로 — 훅 프로세스의 폴더는 처음 폴더일 수 있다", () => {
    const bash = { tool_name: "Bash", tool_input: { command: "adb devices" } };
    expect(
      normalize("claude", "pre-tool-use", { ...bash, cwd: "/repo/.claude/worktrees/x" }),
    ).toMatchObject({ tool: "Bash", cwd: "/repo/.claude/worktrees/x" });
    expect(
      normalize("codex", "pre-tool-use", { ...bash, cwd: "/r", session_id: "t1" }),
    ).toMatchObject({
      cwd: "/r",
      sessionKey: "s:codex:t1",
    });
    expect(normalize("cursor", "before-shell", { command: "adb devices", cwd: "/c" })?.cwd).toBe(
      "/c",
    );
  });

  test("cwd 가 없거나 상대 경로면 넣지 않는다", () => {
    const bash = { tool_name: "Bash", tool_input: { command: "adb devices" } };
    expect(normalize("claude", "pre-tool-use", bash)?.cwd).toBeUndefined();
    expect(normalize("claude", "pre-tool-use", { ...bash, cwd: "repo" })?.cwd).toBeUndefined();
    expect(normalize("claude", "pre-tool-use", { ...bash, cwd: 3 })?.cwd).toBeUndefined();
  });
});
