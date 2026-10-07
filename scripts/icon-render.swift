// SVG → 투명 배경 PNG. qlmanage 는 투명한 곳을 흰색으로 채워 앱 아이콘에 흰 테두리가 생겼다.
// 쓰는 법: swift scripts/icon-render.swift <입력.svg> <출력.png> <크기>
import AppKit

let args = CommandLine.arguments
guard args.count == 4, let size = Int(args[3]),
  let image = NSImage(contentsOf: URL(fileURLWithPath: args[1]))
else {
  FileHandle.standardError.write("usage: icon-render.swift <in.svg> <out.png> <size>\n".data(using: .utf8)!)
  exit(1)
}
let rep = NSBitmapImageRep(
  bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size, bitsPerSample: 8,
  samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB,
  bytesPerRow: 0, bitsPerPixel: 0)!
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
NSColor.clear.set()
NSRect(x: 0, y: 0, width: size, height: size).fill(using: .copy)
image.draw(in: NSRect(x: 0, y: 0, width: size, height: size))
NSGraphicsContext.restoreGraphicsState()
try rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: args[2]))
