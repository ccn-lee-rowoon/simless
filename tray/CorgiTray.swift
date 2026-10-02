// Corgi 메뉴바 앱 — corgi install 이 이 Mac 에서 `xcrun swiftc` 로 컴파일해 Corgi.app 에 넣는다.
// 로직은 없다: 서버 HTTP API(127.0.0.1)의 status 를 읽어 보여 주고, 대시보드(웹 UI)를 연다.
// 설정은 Info.plist 의 CorgiHTTPPort·CorgiTokenPath·CorgiLaunchLabel 에서 읽는다.

import AppKit

struct DeviceRow {
  let label: String
  let name: String
  let booted: Bool
  let holder: String?
}

/// 웰시코기 얼굴 실루엣 — 끝이 둥근 큰 귀, 웃는 입, 뚫린 눈·코 (18×18 단위)
func corgiTemplate(size: CGFloat) -> NSImage {
  let (w, h) = (size, size)
  let image = NSImage(size: NSSize(width: w, height: h), flipped: true) { r in
    let s = r.height / 18
    let ox = (r.width - 18 * s) / 2
    func p(_ x: CGFloat, _ y: CGFloat) -> NSPoint { NSPoint(x: ox + x * s, y: y * s) }
    NSColor.black.setFill()
    // 둥근 끝의 큰 귀
    for (base1, tip, base2, c1, c2) in [
      (p(3.6, 8.2), p(2.8, 1.2), p(8.2, 5.2), p(1.4, 4.0), p(4.6, 0.2)),
      (p(14.4, 8.2), p(15.2, 1.2), p(9.8, 5.2), p(16.6, 4.0), p(13.4, 0.2)),
    ] {
      let ear = NSBezierPath()
      ear.move(to: base1)
      ear.curve(to: tip, controlPoint1: c1, controlPoint2: tip)
      ear.curve(to: base2, controlPoint1: c2, controlPoint2: base2)
      ear.close(); ear.fill()
    }
    // 얼굴
    let face = NSBezierPath()
    face.move(to: p(2.6, 9.6))
    face.curve(to: p(9, 4.6), controlPoint1: p(2.6, 6.2), controlPoint2: p(5.6, 4.6))
    face.curve(to: p(15.4, 9.6), controlPoint1: p(12.4, 4.6), controlPoint2: p(15.4, 6.2))
    face.curve(to: p(9, 15.4), controlPoint1: p(15.4, 12.8), controlPoint2: p(12.4, 15.4))
    face.curve(to: p(2.6, 9.6), controlPoint1: p(5.6, 15.4), controlPoint2: p(2.6, 12.8))
    face.close(); face.fill()
    NSGraphicsContext.current?.compositingOperation = .destinationOut
    // 눈·코
    NSBezierPath(ovalIn: NSRect(x: ox + 5.2 * s, y: 7.8 * s, width: 1.9 * s, height: 2.1 * s)).fill()
    NSBezierPath(ovalIn: NSRect(x: ox + 10.9 * s, y: 7.8 * s, width: 1.9 * s, height: 2.1 * s)).fill()
    NSBezierPath(ovalIn: NSRect(x: ox + 7.7 * s, y: 10.4 * s, width: 2.6 * s, height: 1.7 * s)).fill()
    // 웃는 입 — 코 아래 W 자, 혀와 얼굴 사이를 가른다
    let mouth = NSBezierPath()
    mouth.move(to: p(5.9, 12.4))
    mouth.curve(to: p(9, 12.6), controlPoint1: p(6.9, 13.9), controlPoint2: p(8.4, 13.9))
    mouth.curve(to: p(12.1, 12.4), controlPoint1: p(9.6, 13.9), controlPoint2: p(11.1, 13.9))
    mouth.lineWidth = 0.9 * s; mouth.lineCapStyle = .round
    mouth.stroke()
    return true
  }
  image.isTemplate = true
  return image
}

final class TrayController: NSObject, NSMenuDelegate {
  private let statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
  private let menu = NSMenu()
  private var devices: [DeviceRow] = []
  private var serverVersion: String?
  private var lastError: String?

  private let info = Bundle.main.infoDictionary ?? [:]
  private var port: Int { (info["CorgiHTTPPort"] as? Int) ?? 8791 }
  private var tokenPath: String { (info["CorgiTokenPath"] as? String) ?? "" }
  private var launchLabel: String { (info["CorgiLaunchLabel"] as? String) ?? "corgi.server" }

  override init() {
    super.init()
    if let button = statusItem.button {
      button.image = Self.icon()
      button.toolTip = "Corgi"
    }
    menu.delegate = self
    statusItem.menu = menu
    refresh()
  }

  /// 메뉴바 아이콘 — 다른 메뉴바 아이콘처럼 단색(템플릿). macOS 가 메뉴바 색에 맞춰 칠한다
  private static func icon() -> NSImage {
    corgiTemplate(size: 18)
  }

  private func token() -> String? {
    guard let text = try? String(contentsOfFile: tokenPath, encoding: .utf8) else { return nil }
    return text.trimmingCharacters(in: .whitespacesAndNewlines)
  }

  /// 서버의 status 를 읽는다 — 서버가 꺼져 있으면 lastError
  func refresh(completion: (() -> Void)? = nil) {
    guard let token = token(), let url = URL(string: "http://127.0.0.1:\(port)/api/call") else {
      lastError = "서버 토큰이 없습니다 — 서버를 켜세요"
      completion?()
      return
    }
    var request = URLRequest(url: url, timeoutInterval: 5)
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "content-type")
    request.setValue(token, forHTTPHeaderField: "x-corgi-token")
    request.httpBody = try? JSONSerialization.data(withJSONObject: ["method": "status", "params": [:]])
    URLSession.shared.dataTask(with: request) { [weak self] data, _, error in
      DispatchQueue.main.async {
        guard let self else { return }
        if let data,
           let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let result = json["result"] as? [String: Any] {
          self.serverVersion = result["serverVersion"] as? String
          self.devices = ((result["devices"] as? [[String: Any]]) ?? []).map(Self.row)
          self.lastError = nil
        } else {
          self.serverVersion = nil
          self.lastError = error == nil ? "서버 응답을 읽지 못했습니다" : "서버가 꺼져 있습니다"
        }
        completion?()
      }
    }.resume()
  }

  private static func row(_ d: [String: Any]) -> DeviceRow {
    let holder = d["holder"] as? [String: Any]
    let who = holder.map { ($0["human"] as? Bool) == true ? "사람" : (($0["agent"] as? String) ?? "?") }
    return DeviceRow(
      label: (d["label"] as? String) ?? "",
      name: (d["name"] as? String) ?? "",
      booted: (d["booted"] as? Bool) ?? false,
      holder: who
    )
  }

  // MARK: 메뉴

  func menuWillOpen(_ menu: NSMenu) {
    rebuild()
    refresh { [weak self] in self?.rebuild() }
  }

  private func rebuild() {
    menu.removeAllItems()
    if let version = serverVersion {
      menu.addItem(disabled("Corgi — 서버 연결됨 (\(version))"))
    } else {
      menu.addItem(disabled("Corgi — \(lastError ?? "연결 중…")"))
      menu.addItem(action("서버 켜기", #selector(startServer)))
    }
    menu.addItem(.separator())

    if serverVersion != nil {
      if devices.isEmpty {
        menu.addItem(disabled("만든 디바이스가 없습니다"))
      } else {
        for device in devices {
          let state = device.booted ? "켜짐" : "꺼짐"
          let who = device.holder.map { " · \($0) 사용 중" } ?? ""
          let item = disabled("\(device.booted ? "●" : "○")  \(device.label)  \(device.name)  — \(state)\(who)")
          menu.addItem(item)
        }
      }
      menu.addItem(.separator())
    }

    let dashboard = action("대시보드 열기", #selector(openDashboard))
    dashboard.keyEquivalent = "d"
    menu.addItem(dashboard)
    menu.addItem(.separator())
    let quit = action("Corgi 메뉴바 종료", #selector(quit))
    quit.keyEquivalent = "q"
    menu.addItem(quit)
  }

  private func disabled(_ title: String) -> NSMenuItem {
    let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
    item.isEnabled = false
    return item
  }

  private func action(_ title: String, _ selector: Selector) -> NSMenuItem {
    let item = NSMenuItem(title: title, action: selector, keyEquivalent: "")
    item.target = self
    return item
  }

  @objc private func openDashboard() {
    guard let token = token(), let url = URL(string: "http://127.0.0.1:\(port)/#token=\(token)") else {
      startServer()
      return
    }
    NSWorkspace.shared.open(url)
  }

  @objc private func startServer() {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/bin/launchctl")
    process.arguments = ["kickstart", "gui/\(getuid())/\(launchLabel)"]
    try? process.run()
    DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in self?.refresh() }
  }

  @objc private func quit() {
    NSApp.terminate(nil)
  }

  /// 이미 떠 있는데 앱을 다시 열면 메뉴를 보여 준다
  func showMenu() {
    statusItem.button?.performClick(nil)
  }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
  private var tray: TrayController?

  func applicationDidFinishLaunching(_ notification: Notification) {
    tray = TrayController()
  }

  func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
    tray?.showMenu()
    return false
  }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory) // Dock 아이콘 없이 메뉴바에만
app.run()
