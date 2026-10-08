import { describe, expect, test } from "bun:test";
import { banner, titleLine } from "../src/cli/banner.ts";

const entry = new URL("../bin/simless.ts", import.meta.url).pathname;
const ESC = "\x1b[";

describe("CLI 로고 (M12)", () => {
  test("터미널이면 폰 얼굴·SIMLESS·슬로건·버전을 민트색으로", () => {
    const logo = banner("1.2.3", { isTTY: true, columns: 100, env: {} }) ?? "";
    expect(logo).toContain("│ ╹  ╹ │");
    expect(logo).toContain("█▀▀ █ █▀▄▀█");
    expect(logo).toContain("v1.2.3");
    expect(logo).toContain("seamless");
    expect(logo).toContain(`${ESC}38;5;79m`); // 256색
    const truecolor = banner("1.2.3", { isTTY: true, env: { COLORTERM: "truecolor" } }) ?? "";
    expect(truecolor).toContain(`${ESC}38;2;94;234;192m`);
  });

  test("터미널이 아니거나 TERM=dumb 이면 찍지 않는다 — 에이전트·파이프", () => {
    expect(banner("1.2.3", { isTTY: false, env: {} })).toBeUndefined();
    expect(banner("1.2.3", { isTTY: true, env: { TERM: "dumb" } })).toBeUndefined();
  });

  test("NO_COLOR 면 색 없이, 좁은 터미널이면 한 줄", () => {
    const plain = banner("1.2.3", { isTTY: true, env: { NO_COLOR: "1" } }) ?? "";
    expect(plain).toContain("╭──────╮");
    expect(plain).not.toContain(ESC);
    const narrow = banner("1.2.3", { isTTY: true, columns: 40, env: { NO_COLOR: "1" } }) ?? "";
    expect(narrow.trim()).toBe("Simless 1.2.3");
    // 폭을 모르면(0) 큰 로고
    expect(banner("1.2.3", { isTTY: true, columns: 0, env: {} })).toContain("╭──────╮");
  });

  test("help 맨 위는 색 없는 한 줄 제목뿐 — 로고는 없다", async () => {
    expect(titleLine("1.2.3")).toBe("Simless 1.2.3 — Make simulator management seamless.");
    const help = Bun.spawn([process.execPath, entry, "--help"], { stdout: "pipe" });
    const text = await new Response(help.stdout).text();
    expect(text.split("\n")[0]).toMatch(/^Simless \d+\.\d+\.\d+ — /);
    expect(text).not.toContain("╭──────╮");
    expect(text).not.toContain(ESC);
  });
});
