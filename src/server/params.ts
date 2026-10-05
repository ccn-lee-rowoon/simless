import { z } from "zod";
import { HandlerError } from "./socket.ts";

/** 메서드 매개변수 검사 — 틀리면 INVALID 와 zod 의 설명 (docs/protocol.md «오류 코드») */
export function parse<T extends z.ZodType>(schema: T, params: unknown): z.infer<T> {
  const parsed = schema.safeParse(params ?? {});
  if (!parsed.success) throw new HandlerError("INVALID", z.prettifyError(parsed.error));
  return parsed.data;
}
