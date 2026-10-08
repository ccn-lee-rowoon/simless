// 단일 실행 파일 빌드 → dist/simless, 그리고 팀원에게 주는 설치 파일 → dist/simless-<버전>-install.sh
// (docs/design.md §2·§19). 빌드에 쓰는 Bun 이 결과물에 들어가므로, mise.toml 에 고정한 버전으로 실행한다.
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { INSTALLER_MARK } from "../src/cli/commands/update.ts";
import { VERSION } from "../src/shared/version.ts";

const outfile = "dist/simless";

const proc = Bun.spawnSync(
  [
    process.execPath,
    "build",
    "--compile",
    "--minify",
    "--bytecode", // 시작 시간을 줄인다 — 훅이 Bash 호출마다 실행된다
    "--target=bun-darwin-arm64",
    "bin/simless.ts",
    "--outfile",
    outfile,
  ],
  { stdout: "inherit", stderr: "inherit" },
);

if (proc.exitCode !== 0) {
  process.exit(proc.exitCode ?? 1);
}
console.log(`빌드 완료: ${outfile} (Bun ${Bun.version})`);

// 설치 파일 — 실행 파일을 gzip·base64 로 안에 넣은 bash 스크립트 하나.
// 받은 실행 파일을 바로 실행하면 «다운로드한 파일» 표시 때문에 Gatekeeper 가 죽이지만(서명 없음),
// bash 로 돌리는 스크립트가 임시 폴더에 꺼낸 파일에는 그 표시가 없다 — 2026-10-08 확인 (결정 기록).
// 꺼낸 simless 가 `install` 로 자기를 버전 폴더에 넣으므로, 같은 파일로 처음 설치도 업데이트도 한다.
const payload = Bun.gzipSync(readFileSync(outfile));
const sha256 = new Bun.CryptoHasher("sha256").update(payload).digest("hex");
const installer = `dist/simless-${VERSION}-install.sh`;
const header = `#!/bin/bash
${INSTALLER_MARK}
SIMLESS_VERSION=${VERSION}
SIMLESS_SHA256=${sha256}
# Simless ${VERSION} 설치·업데이트 — 받은 곳 어디서든: bash simless-${VERSION}-install.sh
# 안에 든 simless 를 확인(sha256)하고 꺼내 \`simless install\` 한다. 끝나면 이 파일은 지워도 된다.
set -euo pipefail
if [ "$(uname -s)" != Darwin ] || [ "$(uname -m)" != arm64 ]; then
  echo "Simless 는 Apple Silicon Mac 에서만 설치할 수 있습니다 / Simless needs an Apple Silicon Mac" >&2
  exit 1
fi
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
line="$(awk '/^__SIMLESS_PAYLOAD__$/ { print NR + 1; exit }' "$0")"
tail -n +"$line" "$0" | base64 -D > "$work/simless.gz"
if ! echo "\${SIMLESS_SHA256}  \${work}/simless.gz" | shasum -a 256 -c - > /dev/null 2>&1; then
  echo "설치 파일이 손상됐습니다 — 다시 받아 주세요 / The installer is damaged — download it again" >&2
  exit 1
fi
gunzip "$work/simless.gz"
chmod +x "$work/simless"
echo "Simless \${SIMLESS_VERSION} 설치 중… / Installing Simless \${SIMLESS_VERSION}…"
"$work/simless" install "$@"
exit $?
__SIMLESS_PAYLOAD__
`;
// 76자마다 줄을 바꿔 둔다 — 메신저·편집기가 아주 긴 한 줄을 다루다 깨지지 않게
const body = payload.toBase64().replace(/.{76}/g, "$&\n");
writeFileSync(installer, `${header}${body}\n`);
chmodSync(installer, 0o755);
console.log(`설치 파일: ${installer} (sha256 ${sha256.slice(0, 12)}…)`);
