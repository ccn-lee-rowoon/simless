import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { INSTALLER_MARK, installerVersion } from "../src/cli/commands/update.ts";
import { selfCommand } from "../src/install/launchd.ts";
import {
  compareVersions,
  currentBinary,
  installedVersions,
  installSelf,
  KEEP_VERSIONS,
  linkPointsIntoVersions,
  previousBinary,
  versionBinary,
  versionOf,
} from "../src/install/self.ts";
import { tempEnv } from "./helpers.ts";

const envs: ReturnType<typeof tempEnv>[] = [];
afterEach(() => {
  for (const e of envs.splice(0)) e.cleanup();
});

/** 받은 실행 파일처럼 — 어디에 있든 상관없다 */
function downloaded(env: ReturnType<typeof tempEnv>, name: string, body: string): string {
  const path = join(env.env.HOME, name);
  writeFileSync(path, `#!/bin/sh\necho ${body}\n`, { mode: 0o755 });
  return path;
}

describe("설치한 simless 를 버전 폴더에 두고 링크로 (R19)", () => {
  test("받은 파일을 버전 폴더에 복사하고 ~/.local/bin/simless 가 가리키게 — 받은 파일은 지워도 된다", async () => {
    const e = tempEnv();
    envs.push(e);
    const file = downloaded(e, "Downloads-simless", "0.3.0");
    const result = await installSelf(e.paths, "0.3.0", file, { PATH: "/usr/bin" });

    expect(result.binary).toBe(versionBinary(e.paths, "0.3.0"));
    expect(readFileSync(result.binary, "utf8")).toContain("0.3.0");
    expect(lstatSync(e.paths.binLink).isSymbolicLink()).toBe(true);
    expect(readlinkSync(e.paths.binLink)).toBe(result.binary);
    expect(linkPointsIntoVersions(e.paths)).toBe(true);
    expect(result.previous).toBeUndefined();
    // PATH 에 링크 폴더가 없으면 알려 준다
    expect(result.notOnPath).toBe(join(e.env.HOME, ".local", "bin"));
    // 받은 파일을 지워도 링크는 그대로 동작한다
    await Bun.$`rm ${file}`.quiet();
    expect(currentBinary(e.paths)).toBeDefined();
  });

  test("새 버전을 설치하면 링크만 바꾸고 바로 전 버전을 기억한다 — 되돌리기 대상", async () => {
    const e = tempEnv();
    envs.push(e);
    const linkDir = join(e.env.HOME, ".local", "bin");
    await installSelf(e.paths, "0.3.0", downloaded(e, "a", "0.3.0"), { PATH: linkDir });
    const result = await installSelf(e.paths, "0.4.0", downloaded(e, "b", "0.4.0"), {
      PATH: linkDir,
    });

    expect(result.notOnPath).toBeUndefined();
    expect(readlinkSync(e.paths.binLink)).toBe(versionBinary(e.paths, "0.4.0"));
    expect(versionOf(e.paths, result.previous ?? "")).toBe("0.3.0");
    expect(versionOf(e.paths, previousBinary(e.paths) ?? "")).toBe("0.3.0");
    expect(installedVersions(e.paths)).toEqual(["0.4.0", "0.3.0"]);
  });

  test("같은 파일로 다시 설치하면 복사하지 않고 링크만 맞춘다 — 되돌리기", async () => {
    const e = tempEnv();
    envs.push(e);
    await installSelf(e.paths, "0.3.0", downloaded(e, "a", "0.3.0"));
    await installSelf(e.paths, "0.4.0", downloaded(e, "b", "0.4.0"));
    const back = await installSelf(e.paths, "0.3.0", versionBinary(e.paths, "0.3.0"));

    expect(readlinkSync(e.paths.binLink)).toBe(versionBinary(e.paths, "0.3.0"));
    expect(versionOf(e.paths, back.previous ?? "")).toBe("0.4.0");
  });

  test(`버전 폴더는 최근 ${KEEP_VERSIONS}개만 — 지금 것과 바로 전 것은 남긴다`, async () => {
    const e = tempEnv();
    envs.push(e);
    for (const v of ["0.1.0", "0.2.0", "0.3.0", "0.4.0"])
      await installSelf(e.paths, v, downloaded(e, v, v));
    expect(installedVersions(e.paths)).toEqual(["0.4.0", "0.3.0", "0.2.0"]);
    expect(existsSync(join(e.paths.versionsDir, "0.1.0"))).toBe(false);

    // 오래된 버전으로 되돌린 상태에서 새 것을 깔아도 되돌릴 대상은 남는다
    await installSelf(e.paths, "0.2.0", versionBinary(e.paths, "0.2.0"));
    const result = await installSelf(e.paths, "0.5.0", downloaded(e, "0.5.0", "0.5.0"));
    expect(versionOf(e.paths, result.previous ?? "")).toBe("0.2.0");
    expect(installedVersions(e.paths)).toContain("0.2.0");
  });

  test("설치 파일 알아보기 — 맨 위 표시와 버전 줄이 있어야 한다 (simless update <파일>)", () => {
    const e = tempEnv();
    envs.push(e);
    const good = join(e.env.HOME, "simless-0.3.0-install.sh");
    writeFileSync(
      good,
      `#!/bin/bash\n${INSTALLER_MARK}\nSIMLESS_VERSION=0.3.0\nSIMLESS_SHA256=abc\n`,
    );
    expect(installerVersion(good)).toBe("0.3.0");
    const other = join(e.env.HOME, "other.sh");
    writeFileSync(other, "#!/bin/bash\nSIMLESS_VERSION=9.9.9\n");
    expect(installerVersion(other)).toBeUndefined();
  });

  test("버전 비교", () => {
    expect(compareVersions("0.10.0", "0.9.9")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
    expect(compareVersions("0.2.0", "0.3.0")).toBeLessThan(0);
  });

  test("개발 중(bun link)에는 서버·훅·MCP 에 bun + 스크립트를 적는다", () => {
    expect(selfCommand()).toEqual([process.execPath, Bun.main]);
  });
});

describe("install 이 예전 경로를 가리키는 연결을 새 명령으로 고친다 (R19)", () => {
  test("--mcp 로 한 에이전트만 넣어도, 이미 넣어 둔 다른 에이전트의 MCP 는 고치고 없는 것은 넣지 않는다", async () => {
    const e = tempEnv();
    envs.push(e);
    const entry = new URL("../bin/simless.ts", import.meta.url).pathname;
    // 설치 파일 방식으로 넣어 둔 Copilot MCP — 개발 방식으로 돌아오면 예전 경로가 된다
    const copilot = join(e.env.HOME, ".copilot", "mcp-config.json");
    mkdirSync(join(e.env.HOME, ".copilot"), { recursive: true });
    writeFileSync(
      copilot,
      JSON.stringify({
        mcpServers: { simless: { type: "stdio", command: "/old/simless", args: ["mcp"] } },
      }),
    );
    const proc = Bun.spawn(
      [
        process.execPath,
        entry,
        "install",
        "--no-launchd",
        "--no-skill",
        "--no-app",
        "--mcp",
        "--agents",
        "cursor",
      ],
      { env: { ...e.env, PATH: "" }, stdout: "pipe", stderr: "pipe" },
    );
    expect(await proc.exited).toBe(0);

    const servers = (path: string) => JSON.parse(readFileSync(path, "utf8")).mcpServers.simless;
    expect(servers(copilot)).toEqual({
      type: "stdio",
      command: process.execPath,
      args: [entry, "mcp"],
    });
    expect(servers(join(e.env.HOME, ".cursor", "mcp.json")).args).toEqual([entry, "mcp"]);
    // 넣어 두지 않은 에이전트는 그대로
    expect(existsSync(join(e.env.HOME, ".gemini", "settings.json"))).toBe(false);
  });

  test("한 에이전트를 고치지 못해도 알리고 설치는 이어 간다 — 지운 Codex 의 설정이 남은 경우", async () => {
    const e = tempEnv();
    envs.push(e);
    const entry = new URL("../bin/simless.ts", import.meta.url).pathname;
    // 예전 simless 항목이 남아 있는데 codex 명령은 실패한다 — 진짜 codex 를 부르지 않게 가짜를 앞에 둔다
    const bin = join(e.env.HOME, "fake-bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "codex"), "#!/bin/sh\necho codex broken >&2\nexit 1\n", {
      mode: 0o755,
    });
    mkdirSync(join(e.env.HOME, ".codex"), { recursive: true });
    writeFileSync(
      join(e.env.HOME, ".codex", "config.toml"),
      '[mcp_servers.simless]\ncommand = "/old/simless"\nargs = ["mcp"]\n',
    );
    const copilot = join(e.env.HOME, ".copilot", "mcp-config.json");
    mkdirSync(join(e.env.HOME, ".copilot"), { recursive: true });
    writeFileSync(
      copilot,
      JSON.stringify({ mcpServers: { simless: { command: "/old/simless", args: ["mcp"] } } }),
    );
    const proc = Bun.spawn(
      [process.execPath, entry, "install", "--no-launchd", "--no-skill", "--no-app"],
      { env: { ...e.env, PATH: bin }, stdout: "pipe", stderr: "pipe" },
    );
    const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    expect(code).toBe(0);
    expect(stderr).toContain("Codex");
    expect(stderr).toContain("codex broken");
    // 실패한 Codex 와 상관없이 Copilot 도 고쳤다
    expect(JSON.parse(readFileSync(copilot, "utf8")).mcpServers.simless.command).toBe(
      process.execPath,
    );
  });
});
