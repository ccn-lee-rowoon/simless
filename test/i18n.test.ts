import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { SimlessServer } from "../src/server/app.ts";
import { listen } from "../src/server/socket.ts";
import type { SettingsResult, StatusResult } from "../src/shared/api.ts";
import { call } from "../src/shared/client.ts";
import { en } from "../src/shared/i18n/en.ts";
import { ja } from "../src/shared/i18n/ja.ts";
import { ko } from "../src/shared/i18n/ko.ts";
import { language, resolveLanguage, setLanguage, t } from "../src/shared/i18n.ts";
import { VERSION } from "../src/shared/version.ts";
import { fakeDriver, session, tempEnv } from "./helpers.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
  setLanguage("en");
});

describe("i18n (R25)", () => {
  test("세 사전의 키가 같고, 자리 표시자도 같다", () => {
    const holes = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    for (const dict of [en, ja]) {
      expect(Object.keys(dict).sort()).toEqual(Object.keys(ko).sort());
      for (const key of Object.keys(ko) as (keyof typeof ko)[]) {
        expect([key, holes(dict[key])]).toEqual([key, holes(ko[key])]);
      }
    }
  });

  test("t 는 자리 표시자를 채우고, 언어를 바꾸면 그 언어로", () => {
    expect(t("err.noDevice", { ref: "x" }, "ko")).toBe("없는 디바이스: x");
    setLanguage("en");
    expect(t("err.noDevice", { ref: "x" })).toBe("No such device: x");
    setLanguage("ja");
    expect(t("err.noDevice", { ref: "x" })).toContain("x");
    expect(t("err.noDevice", { ref: "x" })).not.toBe(t("err.noDevice", { ref: "x" }, "en"));
  });

  test("system 이면 선호 언어 목록에서 처음 맞는 것, 없으면 영어", () => {
    expect(resolveLanguage("system", ["ja-JP", "ko-KR", "en-US"])).toBe("ja");
    expect(resolveLanguage("system", ["fr-FR", "ko-KR"])).toBe("ko");
    expect(resolveLanguage("system", ["en_US.UTF-8"])).toBe("en");
    expect(resolveLanguage("system", ["fr-FR"])).toBe("en");
    expect(resolveLanguage("ko", ["en-US"])).toBe("ko");
    expect(resolveLanguage("ja", ["ko-KR"])).toBe("ja");
  });
});

describe("설정 (M11)", () => {
  async function start(languages: string[]) {
    const env = tempEnv();
    const server = new SimlessServer({
      ...env,
      drivers: [fakeDriver()],
      systemLanguages: () => languages,
    });
    const listener = await listen(env.paths.socket, VERSION, server.handle);
    cleanups.push(() => listener.stop(), env.cleanup);
    const H = <T>(method: string, params: unknown = {}) =>
      call<T>(env.paths.socket, method, params, session("web", { human: true })).then(
        (r) => r.result,
      );
    return { server, env, H };
  }

  test("언어를 system 으로 두면 macOS 언어를 따르고, 바꾸면 파일에 쓰고 바로 반영한다", async () => {
    const { env, H } = await start(["ko-KR", "en-US"]);
    expect((await H<StatusResult>("status")).language).toBe("ko");
    expect(language()).toBe("ko");
    const settings = await H<SettingsResult>("settings.set", {
      language: "en",
      idleReleaseMinutes: 45,
    });
    expect(settings).toMatchObject({ language: "en", idleReleaseMinutes: 45 });
    expect((await H<StatusResult>("status")).language).toBe("en");
    expect(JSON.parse(readFileSync(env.paths.config, "utf8"))).toMatchObject({
      language: "en",
      idleReleaseMinutes: 45,
    });
  });

  test("잘못된 값은 INVALID", async () => {
    const { H } = await start([]);
    expect(await H("settings.set", { language: "fr" }).catch((e) => e)).toMatchObject({
      code: "INVALID",
    });
  });
});
