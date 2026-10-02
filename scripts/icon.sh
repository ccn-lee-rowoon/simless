#!/bin/sh
# src/web/corgi.svg → assets/Corgi.icns (Corgi.app 아이콘). SVG 를 고치면 다시 실행한다.
set -eu
cd "$(dirname "$0")/.."
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
qlmanage -t -s 1024 -o "$work" src/web/corgi.svg >/dev/null 2>&1
png="$work/corgi.svg.png"
iconset="$work/Corgi.iconset"
mkdir "$iconset"
for size in 16 32 128 256 512; do
  sips -z $size $size "$png" --out "$iconset/icon_${size}x${size}.png" >/dev/null
  double=$((size * 2))
  sips -z $double $double "$png" --out "$iconset/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns "$iconset" -o assets/Corgi.icns
echo "assets/Corgi.icns ($(du -h assets/Corgi.icns | cut -f1))"
