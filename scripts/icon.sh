#!/bin/sh
# src/web/icon.svg → assets/simless.icns (simless.app 아이콘). SVG 를 고치면 다시 실행한다.
set -eu
cd "$(dirname "$0")/.."
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
qlmanage -t -s 1024 -o "$work" src/web/icon.svg >/dev/null 2>&1
png="$work/icon.svg.png"
iconset="$work/simless.iconset"
mkdir "$iconset"
for size in 16 32 128 256 512; do
  sips -z $size $size "$png" --out "$iconset/icon_${size}x${size}.png" >/dev/null
  double=$((size * 2))
  sips -z $double $double "$png" --out "$iconset/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns "$iconset" -o assets/simless.icns
echo "assets/simless.icns ($(du -h assets/simless.icns | cut -f1))"
