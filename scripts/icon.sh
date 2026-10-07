#!/bin/sh
# src/web/icon.svg → assets/simless.icns (Simless.app 아이콘). SVG 를 고치면 다시 실행한다.
set -eu
cd "$(dirname "$0")/.."
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
# 바탕(둥근 사각형) 바깥은 투명하게 — qlmanage 는 흰색으로 채워 흰 테두리가 생긴다
png="$work/icon.png"
xcrun swift scripts/icon-render.swift src/web/icon.svg "$png" 1024
iconset="$work/simless.iconset"
mkdir "$iconset"
for size in 16 32 128 256 512; do
  sips -z $size $size "$png" --out "$iconset/icon_${size}x${size}.png" >/dev/null
  double=$((size * 2))
  sips -z $double $double "$png" --out "$iconset/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns "$iconset" -o assets/simless.icns
echo "assets/simless.icns ($(du -h assets/simless.icns | cut -f1))"
