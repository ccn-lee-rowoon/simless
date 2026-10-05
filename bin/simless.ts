#!/usr/bin/env bun
// 개발용 진입점 — `bun link` 가 가리킨다. 배포용 단일 실행 파일도 이 파일에서 빌드한다.
// 최상위 await 를 쓰지 않는다: --bytecode 빌드가 CJS 만 지원한다.
import { main } from "../src/main.ts";

main(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
});
