import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { z } from "zod";

/** 파일이 없으면 fallback. 형식이 틀리면 덮어쓰지 않도록 오류를 낸다. */
export function readJson<T extends z.ZodType>(
  path: string,
  schema: T,
  fallback: z.infer<T>,
): z.infer<T> {
  if (!existsSync(path)) return fallback;
  const parsed = schema.safeParse(JSON.parse(readFileSync(path, "utf8")));
  if (!parsed.success) throw new Error(`상태 파일 형식이 잘못됐습니다: ${path}`);
  return parsed.data;
}

/** 임시 파일에 쓰고 rename 한다 — 쓰는 중에 죽어도 파일이 반쯤 남지 않는다. */
export function writeJson(path: string, data: unknown, mode = 0o600): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`, { mode });
  renameSync(temp, path);
}
