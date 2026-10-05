// simless 메뉴바 앱 + 앱 창 — simless install 이 이 Mac 에서 `xcrun swiftc` 로 컴파일해 simless.app 에 넣는다.
// 로직은 없다: 서버 HTTP API(127.0.0.1)의 status 를 읽어 메뉴에 보여 주고, 웹 화면을 자기 창(WKWebView)에 띄운다.
// 설정은 Info.plist 의 SimlessHTTPPort·SimlessTokenPath·SimlessLaunchLabel 에서 읽는다 (docs/design.md §14).

import AppKit
import WebKit

struct DeviceRow {
  let label: String
  let name: String
  let holder: String?
}

/// 메뉴 문구 — 서버의 언어 설정(status.language)을 따른다 (R25). 웹 화면은 공용 사전을 쓰고, 여기는 몇 줄뿐이라 따로 둔다
enum Strings {
  static var lang = Locale.preferredLanguages.first?.hasPrefix("ko") == true ? "ko" : "en"

  static func get(_ key: String) -> String {
    let table: [String: (String, String)] = [
      "connected": ("simless — 서버 연결됨 (%@)", "simless — server connected (%@)"),
      "noToken": ("서버 토큰이 없습니다 — 서버를 켜세요", "No server token — start the server"),
      "serverDown": ("서버가 꺼져 있습니다", "The server is not running"),
      "badResponse": ("서버 응답을 읽지 못했습니다", "Couldn't read the server's answer"),
      "connecting": ("연결 중…", "Connecting…"),
      "startServer": ("서버 켜기", "Start server"),
      "noneBooted": ("켜진 디바이스가 없습니다", "No devices running"),
      "booted": ("켜진 디바이스", "Running devices"),
      "using": ("%@ 사용 중", "in use by %@"),
      "human": ("사람", "person"),
      "dashboard": ("대시보드 열기", "Open Dashboard"),
      "quitMenubar": ("simless 종료", "Quit simless"),
      "close": ("창 닫기", "Close Window"),
      "minimize": ("최소화", "Minimize"),
      "edit": ("편집", "Edit"),
      "window": ("윈도우", "Window"),
      "undo": ("실행 취소", "Undo"),
      "redo": ("실행 복귀", "Redo"),
      "cut": ("오려두기", "Cut"),
      "copy": ("복사하기", "Copy"),
      "paste": ("붙여넣기", "Paste"),
      "selectAll": ("전체 선택", "Select All"),
      "reload": ("새로 고침", "Reload"),
      "view": ("보기", "View"),
      "settings": ("설정…", "Settings…"),
      "settingsTitle": ("simless 설정", "simless Settings"),
      "setupTitle": ("simless 시작하기", "Get started with simless"),
      "skillUpdate": ("스킬 업데이트 있음 — 업데이트", "Skill update available — Update"),
      "skillUpdated": ("simless 스킬을 업데이트했습니다", "Updated the simless skill"),
    ]
    guard let pair = table[key] else { return key }
    return lang == "ko" ? pair.0 : pair.1
  }
}

/// 앱 아이콘과 같은 모양 — 폭이 다른 기기 세 대 (M12). 18×18 단위, 단색 템플릿
func devicesTemplate(size: CGFloat) -> NSImage {
  let image = NSImage(size: NSSize(width: size, height: size), flipped: true) { r in
    let s = r.height / 18
    NSColor.black.setStroke()
    for (x, y, w, h, radius) in [
      (1.4, 7.6, 3.6, 7.8, 1.0),
      (6.3, 5.5, 4.6, 9.9, 1.1),
      (12.2, 2.6, 5.3, 12.8, 1.3),
    ] as [(CGFloat, CGFloat, CGFloat, CGFloat, CGFloat)] {
      let path = NSBezierPath(
        roundedRect: NSRect(x: x * s, y: y * s, width: w * s, height: h * s),
        xRadius: radius * s, yRadius: radius * s)
      path.lineWidth = 1.35 * s
      path.stroke()
    }
    return true
  }
  image.isTemplate = true
  return image
}

final class AppController: NSObject, NSMenuDelegate, NSWindowDelegate, WKNavigationDelegate,
  WKScriptMessageHandler
{
  private let statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
  private let menu = NSMenu()
  private var devices: [DeviceRow] = []
  private var serverVersion: String?
  private var lastError: String?
  private var window: NSWindow?
  private var webView: WKWebView?
  private var settingsWindow: NSWindow?
  /// 첫 실행 설정 창 (M14)
  private var setupWindow: NSWindow?
  /// 서버가 «설정 안 끝남» 이라고 하면 앱을 띄울 때 한 번 연다
  private var setupNeeded = false
  /// 넣어 둔 스킬이 예전 것 (S9)
  private var skillUpdate = false
  /// 세션 기록 창 — 세션 키마다 하나 (M13)
  private var sessionWindows: [String: NSWindow] = [:]
  private var retries = 0

  private let info = Bundle.main.infoDictionary ?? [:]
  private var port: Int { (info["SimlessHTTPPort"] as? Int) ?? 8791 }
  private var tokenPath: String { (info["SimlessTokenPath"] as? String) ?? "" }
  private var launchLabel: String { (info["SimlessLaunchLabel"] as? String) ?? "simless.server" }

  override init() {
    super.init()
    if let button = statusItem.button {
      button.image = devicesTemplate(size: 18)
      button.toolTip = "simless"
    }
    menu.delegate = self
    statusItem.menu = menu
    refresh { [weak self] in self?.openSetupIfNeeded(attempt: 0) }
  }

  /// 처음 뜰 때 설정을 안 끝냈으면 설정 창을 연다. 서버가 아직 안 떴으면(로그인 직후) 잠시 뒤 다시
  private func openSetupIfNeeded(attempt: Int) {
    if serverVersion == nil {
      guard attempt < 5 else { return }
      DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in
        self?.refresh { self?.openSetupIfNeeded(attempt: attempt + 1) }
      }
      return
    }
    if setupNeeded { openSetup() }
  }

  private func token() -> String? {
    guard let text = try? String(contentsOfFile: tokenPath, encoding: .utf8) else { return nil }
    return text.trimmingCharacters(in: .whitespacesAndNewlines)
  }

  /// 서버의 status 를 읽는다 — 서버가 꺼져 있으면 lastError
  func refresh(completion: (() -> Void)? = nil) {
    guard let token = token(), let url = URL(string: "http://127.0.0.1:\(port)/api/call") else {
      lastError = Strings.get("noToken")
      completion?()
      return
    }
    var request = URLRequest(url: url, timeoutInterval: 5)
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "content-type")
    request.setValue(token, forHTTPHeaderField: "x-simless-token")
    request.httpBody = try? JSONSerialization.data(withJSONObject: ["method": "status", "params": [:]])
    URLSession.shared.dataTask(with: request) { [weak self] data, _, error in
      DispatchQueue.main.async {
        guard let self else { return }
        if let data,
           let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let result = json["result"] as? [String: Any] {
          if let lang = result["language"] as? String { Strings.lang = lang }
          self.serverVersion = result["serverVersion"] as? String
          self.setupNeeded = (result["setupNeeded"] as? Bool) == true
          self.skillUpdate = (result["skillUpdate"] as? Bool) == true
          let all = (result["devices"] as? [[String: Any]]) ?? []
          self.devices = all.filter { ($0["booted"] as? Bool) == true }.map(Self.row)
          self.lastError = nil
        } else {
          self.serverVersion = nil
          self.lastError = Strings.get(error == nil ? "badResponse" : "serverDown")
        }
        completion?()
      }
    }.resume()
  }

  private static func row(_ d: [String: Any]) -> DeviceRow {
    let holder = d["holder"] as? [String: Any]
    let who = holder.map {
      ($0["human"] as? Bool) == true ? Strings.get("human") : (($0["agent"] as? String) ?? "?")
    }
    return DeviceRow(
      label: (d["label"] as? String) ?? "",
      name: (d["name"] as? String) ?? "",
      holder: who
    )
  }

  // MARK: 메뉴바 메뉴

  func menuWillOpen(_ menu: NSMenu) {
    rebuild()
    refresh { [weak self] in self?.rebuild() }
  }

  private func rebuild() {
    menu.removeAllItems()
    if let version = serverVersion {
      menu.addItem(disabled(String(format: Strings.get("connected"), version)))
    } else {
      menu.addItem(disabled("simless — \(lastError ?? Strings.get("connecting"))"))
      menu.addItem(action(Strings.get("startServer"), #selector(startServer)))
    }
    menu.addItem(.separator())

    if serverVersion != nil {
      if devices.isEmpty {
        menu.addItem(disabled(Strings.get("noneBooted")))
      } else {
        menu.addItem(disabled(Strings.get("booted")))
        for device in devices {
          let who = device.holder.map { " · " + String(format: Strings.get("using"), $0) } ?? ""
          menu.addItem(disabled("●  \(device.label)  \(device.name)\(who)"))
        }
      }
      menu.addItem(.separator())
    }

    if skillUpdate {
      menu.addItem(action(Strings.get("skillUpdate"), #selector(updateSkill)))
      menu.addItem(.separator())
    }

    let dashboard = action(Strings.get("dashboard"), #selector(openDashboard))
    dashboard.keyEquivalent = "d"
    menu.addItem(dashboard)
    let settings = action(Strings.get("settings"), #selector(openSettings))
    settings.keyEquivalent = ","
    menu.addItem(settings)
    menu.addItem(.separator())
    let quit = action(Strings.get("quitMenubar"), #selector(quit))
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

  @objc private func startServer() {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/bin/launchctl")
    process.arguments = ["kickstart", "gui/\(getuid())/\(launchLabel)"]
    try? process.run()
    DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in self?.refresh() }
  }

  /// 서버에 스킬 업데이트를 부탁한다 — 넣어 둔 모든 곳을 새 스킬로
  @objc private func updateSkill() {
    guard let token = token(), let url = URL(string: "http://127.0.0.1:\(port)/api/call") else { return }
    var request = URLRequest(url: url, timeoutInterval: 30)
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "content-type")
    request.setValue(token, forHTTPHeaderField: "x-simless-token")
    request.httpBody = try? JSONSerialization.data(
      withJSONObject: ["method": "setup.apply", "params": ["item": "skill", "enabled": true]])
    URLSession.shared.dataTask(with: request) { [weak self] _, _, _ in
      DispatchQueue.main.async {
        self?.statusItem.button?.toolTip = Strings.get("skillUpdated")
        self?.refresh()
      }
    }.resume()
  }

  @objc private func quit() {
    NSApp.terminate(nil)
  }

  // MARK: 앱 창 (R11)

  /// 대시보드 창을 연다 — 창이 열려 있는 동안만 Dock 아이콘이 보인다
  @objc func openDashboard() {
    if window == nil { makeWindow() }
    NSApp.setActivationPolicy(.regular)
    installMainMenu()
    window?.makeKeyAndOrderFront(nil)
    NSApp.activate(ignoringOtherApps: true)
    if webView?.url == nil { load() }
  }

  /// 웹 화면이 window.webkit.messageHandlers.simless 로 «설정 창 열기» 를 알린다 (M11)
  func userContentController(
    _ userContentController: WKUserContentController, didReceive message: WKScriptMessage
  ) {
    guard let body = message.body as? [String: Any] else { return }
    if body["close"] as? String == "setup" {
      setupWindow?.close()
      return
    }
    switch body["open"] as? String {
    case "settings": openSettings()
    case "setup": openSetup()
    case "dashboard": openDashboard()
    case "session": if let key = body["key"] as? String { openSession(key) }
    default: break
    }
  }

  private func webConfiguration() -> WKWebViewConfiguration {
    let config = WKWebViewConfiguration()
    config.userContentController.add(self, name: "simless")
    return config
  }

  /// 웹 화면을 띄운 보조 창 하나 — 설정·세션 기록
  private func makeAuxWindow(title: String, query: String, size: NSSize, autosave: String) -> NSWindow {
    let web = WKWebView(frame: .zero, configuration: webConfiguration())
    web.setValue(false, forKey: "drawsBackground")
    let window = NSWindow(
      contentRect: NSRect(origin: .zero, size: size),
      styleMask: [.titled, .closable, .resizable, .miniaturizable],
      backing: .buffered, defer: false)
    window.title = title
    window.contentView = web
    window.isReleasedWhenClosed = false
    window.delegate = self
    window.center()
    window.setFrameAutosaveName(autosave)
    if let token = token(), let url = URL(string: "http://127.0.0.1:\(port)/?\(query)#token=\(token)") {
      web.load(URLRequest(url: url))
    }
    return window
  }

  private func show(_ window: NSWindow?) {
    NSApp.setActivationPolicy(.regular)
    installMainMenu()
    window?.makeKeyAndOrderFront(nil)
    NSApp.activate(ignoringOtherApps: true)
  }

  /// 세션 기록 창 — 같은 세션이면 이미 연 창을 앞으로
  func openSession(_ key: String) {
    if sessionWindows[key] == nil {
      let query = "window=session&key=" + (key.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? key)
      sessionWindows[key] = makeAuxWindow(
        title: "simless — \(key)", query: query, size: NSSize(width: 820, height: 700),
        autosave: "SimlessSession")
    }
    show(sessionWindows[key])
  }

  /// 설정 창 — 메인 창과 따로 (macOS 앱의 설정 창처럼)
  @objc func openSettings() {
    if settingsWindow == nil {
      settingsWindow = makeAuxWindow(
        title: Strings.get("settingsTitle"), query: "window=settings",
        size: NSSize(width: 760, height: 720), autosave: "SimlessSettings")
    }
    show(settingsWindow)
  }

  /// 첫 실행 설정 창 — 처음 열 때 자동으로, 나중엔 설정 창의 버튼으로 (M14)
  @objc func openSetup() {
    if setupWindow == nil {
      setupWindow = makeAuxWindow(
        title: Strings.get("setupTitle"), query: "window=setup",
        size: NSSize(width: 820, height: 780), autosave: "SimlessSetup")
    }
    show(setupWindow)
  }

  private func makeWindow() {
    let web = WKWebView(frame: .zero, configuration: webConfiguration())
    web.navigationDelegate = self
    web.setValue(false, forKey: "drawsBackground") // 불러오는 동안 흰 화면이 번쩍이지 않게
    let window = NSWindow(
      contentRect: NSRect(x: 0, y: 0, width: 1280, height: 820),
      styleMask: [.titled, .closable, .miniaturizable, .resizable],
      backing: .buffered, defer: false)
    window.title = "simless"
    window.minSize = NSSize(width: 880, height: 560)
    window.contentView = web
    window.isReleasedWhenClosed = false
    window.delegate = self
    window.center()
    window.setFrameAutosaveName("SimlessDashboard") // 크기·위치를 기억한다
    self.window = window
    self.webView = web
  }

  private func load() {
    guard let token = token(), let url = URL(string: "http://127.0.0.1:\(port)/#token=\(token)") else {
      // 서버가 처음 켜질 때 토큰을 만든다 — 켜고 잠시 뒤 다시
      startServer()
      retryLoad()
      return
    }
    webView?.load(URLRequest(url: url))
  }

  private func retryLoad() {
    guard retries < 5 else { return }
    retries += 1
    DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in self?.load() }
  }

  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    retries = 0
  }

  func webView(
    _ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error
  ) {
    // 서버가 꺼져 있다 — 켜고 다시
    startServer()
    retryLoad()
  }

  @objc func reload() {
    retries = 0
    load()
  }

  func windowWillClose(_ notification: Notification) {
    let closing = notification.object as? NSWindow
    if closing === settingsWindow {
      // 다음에 열 때 설정을 새로 읽도록 닫으면 버린다
      settingsWindow = nil
    }
    if closing === setupWindow { setupWindow = nil }
    sessionWindows = sessionWindows.filter { $0.value !== closing }
    // 창이 하나도 안 남으면 메뉴바 앱으로 돌아간다 (Dock 아이콘 없음)
    let all = [window, settingsWindow, setupWindow] + sessionWindows.values.map { Optional($0) }
    let others = all.contains { $0 !== closing && $0?.isVisible == true }
    if !others { NSApp.setActivationPolicy(.accessory) }
  }

  /// 앱 메뉴 — 창이 열린 동안 ⌘Q·⌘W·복사·붙여넣기가 동작하게 한다
  private func installMainMenu() {
    if NSApp.mainMenu?.items.count ?? 0 > 1 { return }
    let main = NSMenu()

    let appItem = NSMenuItem()
    let appMenu = NSMenu()
    appMenu.addItem(withTitle: Strings.get("settings"), action: #selector(openSettings), keyEquivalent: ",")
      .target = self
    appMenu.addItem(.separator())
    appMenu.addItem(withTitle: Strings.get("quitMenubar"), action: #selector(quit), keyEquivalent: "q")
      .target = self
    appItem.submenu = appMenu
    main.addItem(appItem)

    let editItem = NSMenuItem()
    let edit = NSMenu(title: Strings.get("edit"))
    edit.addItem(withTitle: Strings.get("undo"), action: Selector(("undo:")), keyEquivalent: "z")
    let redo = edit.addItem(withTitle: Strings.get("redo"), action: Selector(("redo:")), keyEquivalent: "z")
    redo.keyEquivalentModifierMask = [.command, .shift]
    edit.addItem(.separator())
    edit.addItem(withTitle: Strings.get("cut"), action: #selector(NSText.cut(_:)), keyEquivalent: "x")
    edit.addItem(withTitle: Strings.get("copy"), action: #selector(NSText.copy(_:)), keyEquivalent: "c")
    edit.addItem(withTitle: Strings.get("paste"), action: #selector(NSText.paste(_:)), keyEquivalent: "v")
    edit.addItem(
      withTitle: Strings.get("selectAll"), action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
    editItem.submenu = edit
    main.addItem(editItem)

    let viewItem = NSMenuItem()
    let view = NSMenu(title: Strings.get("view"))
    view.addItem(withTitle: Strings.get("reload"), action: #selector(reload), keyEquivalent: "r").target = self
    viewItem.submenu = view
    main.addItem(viewItem)

    let windowItem = NSMenuItem()
    let windowMenu = NSMenu(title: Strings.get("window"))
    windowMenu.addItem(
      withTitle: Strings.get("close"), action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
    windowMenu.addItem(
      withTitle: Strings.get("minimize"), action: #selector(NSWindow.performMiniaturize(_:)),
      keyEquivalent: "m")
    windowItem.submenu = windowMenu
    main.addItem(windowItem)

    NSApp.mainMenu = main
  }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
  private var app: AppController?

  func applicationDidFinishLaunching(_ notification: Notification) {
    app = AppController()
  }

  /// 이미 떠 있는데 앱을 다시 열거나(더블클릭·Spotlight) Dock 아이콘을 누르면 창을 연다
  func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
    app?.openDashboard()
    return false
  }

  /// 창을 닫아도 메뉴바 앱은 계속 돈다
  func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
    false
  }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory) // 평소엔 Dock 아이콘 없이 메뉴바에만
app.run()
