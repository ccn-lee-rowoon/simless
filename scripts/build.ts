// 단일 실행 파일 빌드 → dist/corgi (docs/design.md §2)
// 빌드에 쓰는 Bun 이 결과물에 들어가므로, mise.toml 에 고정한 버전으로 실행한다.

const outfile = "dist/corgi";

const proc = Bun.spawnSync(
  [
    process.execPath,
    "build",
    "--compile",
    "--minify",
    "--bytecode", // 시작 시간을 줄인다 — 훅이 Bash 호출마다 실행된다
    "--target=bun-darwin-arm64",
    "bin/corgi.ts",
    "--outfile",
    outfile,
  ],
  { stdout: "inherit", stderr: "inherit" },
);

if (proc.exitCode !== 0) {
  process.exit(proc.exitCode ?? 1);
}
console.log(`빌드 완료: ${outfile} (Bun ${Bun.version})`);
