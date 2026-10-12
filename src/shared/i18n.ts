import { en } from "./i18n/en.ts";
import { ja } from "./i18n/ja.ts";
import { ko } from "./i18n/ko.ts";

// 한국어·영어·일본어 문구 (R25). 서버·CLI·웹 화면이 같은 사전을 쓴다 — 키는 ko.ts 가 정본이고,
// en.ts·ja.ts 는 같은 키를 모두 갖춰야 컴파일된다. 문구 안의 {이름} 은 params 로 채운다.

export type Lang = "ko" | "en" | "ja";
export const LANGS = ["ko", "en", "ja"] as const satisfies readonly Lang[];
export type LanguageSetting = "system" | Lang;
export type MessageKey = keyof typeof ko;
export type Params = Record<string, string | number>;

const dictionaries: Record<Lang, Record<MessageKey, string>> = { ko, en, ja };

let current: Lang = "en";

/** 이 프로세스의 언어 — 서버는 설정에서, CLI 는 시작할 때, 웹 화면은 상태 응답에서 정한다 */
export function setLanguage(lang: Lang): void {
  current = lang;
}

export function language(): Lang {
  return current;
}

export function t(key: MessageKey, params: Params = {}, lang: Lang = current): string {
  const template = dictionaries[lang][key] ?? dictionaries.en[key] ?? key;
  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    params[name] === undefined ? whole : String(params[name]),
  );
}

/** 설정값 → 실제 언어. system 이면 선호 언어 목록(macOS 언어 설정·브라우저)에서 처음 맞는 것, 없으면 영어 */
export function resolveLanguage(setting: LanguageSetting, preferred: readonly string[]): Lang {
  if (setting !== "system") return setting;
  for (const tag of preferred) {
    const base = tag.toLowerCase().split(/[-_]/)[0];
    if ((LANGS as readonly string[]).includes(base ?? "")) return base as Lang;
  }
  return "en";
}
