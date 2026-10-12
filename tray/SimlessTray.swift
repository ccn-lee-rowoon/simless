// simless 메뉴바 앱 + 앱 창 — simless install 이 이 Mac 에서 `xcrun swiftc` 로 컴파일해 Simless.app 에 넣는다.
// 로직은 없다: 서버 HTTP API(127.0.0.1)의 status 를 읽어 메뉴에 보여 주고, 웹 화면을 자기 창(WKWebView)에 띄운다.
// 설정은 Info.plist 의 SimlessHTTPPort·SimlessTokenPath·SimlessLaunchLabel 에서 읽는다 (docs/design.md §14).

import AppKit
import UserNotifications
import WebKit

/// 메뉴 문구 — 서버의 언어 설정(status.language)을 따른다 (R25). 웹 화면은 공용 사전을 쓰고, 여기는 몇 줄뿐이라 따로 둔다
enum Strings {
  static var lang: String = {
    let first = Locale.preferredLanguages.first ?? ""
    for code in ["ko", "ja"] where first.hasPrefix(code) { return code }
    return "en"
  }()

  static func get(_ key: String) -> String {
    // (한국어, English, 日本語)
    let table: [String: (String, String, String)] = [
      "connected": ("Simless — 서버 연결됨 (%@)", "Simless — server connected (%@)", "Simless — サーバーに接続済み (%@)"),
      "noToken": ("서버 토큰이 없습니다 — 서버를 켜세요", "No server token — start the server", "サーバートークンがありません — サーバーを起動してください"),
      "serverDown": ("서버가 꺼져 있습니다", "The server is not running", "サーバーが停止しています"),
      "badResponse": ("서버 응답을 읽지 못했습니다", "Couldn't read the server's answer", "サーバーの応答を読み取れませんでした"),
      "connecting": ("연결 중…", "Connecting…", "接続中…"),
      "startServer": ("서버 켜기", "Start server", "サーバーを起動"),
      "dashboard": ("대시보드 열기", "Open Dashboard", "ダッシュボードを開く"),
      "quitMenubar": ("Simless 종료", "Quit Simless", "Simless を終了"),
      "close": ("창 닫기", "Close Window", "ウインドウを閉じる"),
      "minimize": ("최소화", "Minimize", "しまう"),
      "edit": ("편집", "Edit", "編集"),
      "window": ("윈도우", "Window", "ウインドウ"),
      "undo": ("실행 취소", "Undo", "取り消す"),
      "redo": ("실행 복귀", "Redo", "やり直す"),
      "cut": ("오려두기", "Cut", "カット"),
      "copy": ("복사하기", "Copy", "コピー"),
      "paste": ("붙여넣기", "Paste", "ペースト"),
      "selectAll": ("전체 선택", "Select All", "すべてを選択"),
      "reload": ("새로 고침", "Reload", "再読み込み"),
      "view": ("보기", "View", "表示"),
      "settings": ("설정…", "Settings…", "設定…"),
      // 메뉴바 메뉴에서는 «설정…» 대신 — macOS 26 이 표준 이름(설정…) 항목 옆에 톱니 아이콘을 붙인다
      "openSettings": ("설정 열기", "Open Settings", "設定を開く"),
      "settingsTitle": ("Simless 설정", "Simless Settings", "Simless 設定"),
      "setupTitle": ("Simless 시작하기", "Get started with Simless", "Simless をはじめる"),
      "skillUpdate": ("스킬 업데이트 있음 — 업데이트", "Skill update available — Update", "スキルのアップデートがあります — アップデート"),
      "skillUpdated": ("Simless 스킬을 업데이트했습니다", "Updated the Simless skill", "Simless スキルをアップデートしました"),
      // macOS 알림 (M18)
      "noticeServerDown": ("Simless 서버가 꺼져 있습니다", "The Simless server is not running", "Simless サーバーが停止しています"),
      "noticeServerDownBody": (
        "1분 넘게 연결되지 않습니다. 보호 훅이 기기 명령을 막을 수 있습니다 — 누르면 서버를 켭니다.",
        "Unreachable for over a minute. The protection hook may block device commands — click to start it.",
        "1分以上接続できません。保護フックがデバイスのコマンドをブロックする場合があります — クリックするとサーバーを起動します。"
      ),
      "noticeSkillUpdate": ("Simless 스킬 업데이트가 있습니다", "A Simless skill update is available", "Simless スキルのアップデートがあります"),
      "noticeSkillUpdateBody": (
        "새 에이전트 세션이 새 스킬을 읽도록 대시보드나 메뉴바에서 «업데이트» 를 누르세요.",
        "Click «Update» in the dashboard or the menu bar so new agent sessions read the new skill.",
        "新しいエージェントセッションが新しいスキルを読み込めるよう、ダッシュボードかメニューバーで「アップデート」をクリックしてください。"
      ),
    ]
    guard let row = table[key] else { return key }
    switch lang {
    case "ko": return row.0
    case "ja": return row.2
    default: return row.1
    }
  }
}

/// 앱 아이콘과 같은 모양 — 폰 하나에 눈·입을 살짝 (M12). src/web/icon.svg 를 1024 칸 기준
/// 168…856 범위로 잘라 그린다. 18px 에서도 보이게 홈 바는 빼고 눈·입을 굵게. 단색 템플릿
func devicesTemplate(size: CGFloat) -> NSImage {
  let image = NSImage(size: NSSize(width: size, height: size), flipped: true) { r in
    let s = r.height / 688
    func p(_ x: CGFloat, _ y: CGFloat) -> NSPoint { NSPoint(x: (x - 168) * s, y: (y - 168) * s) }
    let unit = r.height / 18
    NSColor.black.setStroke()

    let body = NSBezierPath(
      roundedRect: NSRect(x: (322 - 168) * s, y: (196 - 168) * s, width: 380 * s, height: 632 * s),
      xRadius: 86 * s, yRadius: 86 * s)
    body.lineWidth = 1.5 * unit
    body.stroke()

    let eyes = NSBezierPath()
    eyes.move(to: p(444, 440))
    eyes.line(to: p(444, 454))
    eyes.move(to: p(580, 440))
    eyes.line(to: p(580, 454))
    eyes.lineWidth = 1.9 * unit
    eyes.lineCapStyle = .round
    eyes.stroke()

    // 미소 — q(60,52)→(120,0) 을 3차 곡선으로
    let mouth = NSBezierPath()
    mouth.move(to: p(452, 572))
    mouth.curve(to: p(572, 572), controlPoint1: p(492, 606.67), controlPoint2: p(532, 606.67))
    mouth.lineWidth = 1.5 * unit
    mouth.lineCapStyle = .round
    mouth.stroke()
    return true
  }
  image.isTemplate = true
  return image
}

final class AppController: NSObject, NSMenuDelegate, NSWindowDelegate, WKNavigationDelegate,
  WKScriptMessageHandler, UNUserNotificationCenterDelegate
{
  private let statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
  private let menu = NSMenu()
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
  /// 들어 있는 스킬의 지문 — 이 값마다 «스킬 업데이트» 알림을 한 번만 (M18)
  private var skillHash: String?
  /// 서버에 처음 연결하지 못한 때 — 1분이 넘으면 «서버 꺼짐» 알림 한 번 (M18)
  private var downSince: Date?
  private var downNotified = false
  private var pollTimer: Timer?
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
      button.toolTip = "Simless"
    }
    menu.delegate = self
    statusItem.menu = menu
    refresh { [weak self] in self?.openSetupIfNeeded(attempt: 0) }
    setUpNotifications()
  }

  // MARK: macOS 알림 (M18)

  /// 사람이 손을 써야 하는데 놓치기 쉬운 것만 — 서버가 꺼짐, 스킬 업데이트. 15초마다 서버를 본다
  private func setUpNotifications() {
    let center = UNUserNotificationCenter.current()
    center.delegate = self
    center.requestAuthorization(options: [.alert, .sound]) { _, _ in }
    pollTimer = Timer.scheduledTimer(withTimeInterval: 15, repeats: true) { [weak self] _ in
      self?.refresh { self?.checkNotices() }
    }
  }

  private func checkNotices() {
    if serverVersion == nil {
      let since = downSince ?? Date()
      downSince = since
      if !downNotified && Date().timeIntervalSince(since) >= 60 {
        downNotified = true
        post(id: "server-down", title: Strings.get("noticeServerDown"), body: Strings.get("noticeServerDownBody"))
      }
      return
    }
    downSince = nil
    downNotified = false
    UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: ["server-down"])
    let key = "simless.notifiedSkillHash"
    if skillUpdate, let hash = skillHash, !hash.isEmpty,
       UserDefaults.standard.string(forKey: key) != hash {
      UserDefaults.standard.set(hash, forKey: key)
      post(id: "skill-update", title: Strings.get("noticeSkillUpdate"), body: Strings.get("noticeSkillUpdateBody"))
    }
  }

  private func post(id: String, title: String, body: String) {
    let content = UNMutableNotificationContent()
    content.title = title
    content.body = body
    content.sound = .default
    UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: id, content: content, trigger: nil))
  }

  /// 앱이 앞에 있어도 배너로 보인다
  func userNotificationCenter(
    _ center: UNUserNotificationCenter, willPresent notification: UNNotification,
    withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
  ) {
    completionHandler([.banner, .sound])
  }

  /// 누르면 — 서버 꺼짐은 서버를 켜고, 스킬 업데이트는 대시보드(업데이트 띠)를 연다
  func userNotificationCenter(
    _ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
    withCompletionHandler completionHandler: @escaping () -> Void
  ) {
    DispatchQueue.main.async { [weak self] in
      if response.notification.request.identifier == "server-down" {
        self?.startServer()
      } else {
        self?.openDashboard()
      }
    }
    completionHandler()
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
          self.skillHash = result["skillHash"] as? String
          self.lastError = nil
        } else {
          self.serverVersion = nil
          self.lastError = Strings.get(error == nil ? "badResponse" : "serverDown")
        }
        completion?()
      }
    }.resume()
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
      menu.addItem(disabled("Simless — \(lastError ?? Strings.get("connecting"))"))
      menu.addItem(action(Strings.get("startServer"), #selector(startServer)))
    }
    menu.addItem(.separator())

    if skillUpdate {
      menu.addItem(action(Strings.get("skillUpdate"), #selector(updateSkill)))
      menu.addItem(.separator())
    }

    let dashboard = action(Strings.get("dashboard"), #selector(openDashboard))
    dashboard.keyEquivalent = "d"
    menu.addItem(dashboard)
    // ⌘, 와 표준 설정 동작이면 macOS 26 이 톱니 아이콘을 붙인다 — 메뉴바 메뉴에서는 글자만
    menu.addItem(action(Strings.get("openSettings"), #selector(openSettingsFromTray)))
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

  /// 서버 켜기 — launchd 에서 내려가 있으면(bootout) kickstart 가 실패하므로 다시 등록하고 켠다
  @objc private func startServer() {
    let domain = "gui/\(getuid())"
    if launchctl(["kickstart", "\(domain)/\(launchLabel)"]) != 0 {
      let plist = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent("Library/LaunchAgents/\(launchLabel).plist").path
      _ = launchctl(["bootstrap", domain, plist])
      _ = launchctl(["kickstart", "\(domain)/\(launchLabel)"])
    }
    DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in self?.refresh() }
  }

  private func launchctl(_ arguments: [String]) -> Int32 {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/bin/launchctl")
    process.arguments = arguments
    do {
      try process.run()
      process.waitUntilExit()
      return process.terminationStatus
    } catch {
      return -1
    }
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
    web.navigationDelegate = self
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
        title: "Simless — \(key)", query: query, size: NSSize(width: 820, height: 700),
        autosave: "SimlessSession")
    }
    show(sessionWindows[key])
  }

  /// 설정 창 — 메인 창과 따로 (macOS 앱의 설정 창처럼)
  @objc private func openSettingsFromTray() {
    openSettings()
  }

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
    window.title = "Simless"
    window.minSize = NSSize(width: 880, height: 560)
    window.contentView = web
    window.isReleasedWhenClosed = false
    window.delegate = self
    window.center()
    window.setFrameAutosaveName("SimlessDashboard") // 크기·위치를 기억한다
    self.window = window
    self.webView = web
  }

  /// 앱이 켜진 뒤 대시보드를 처음 열 때만 시작 애니메이션 — 처음 불러오기에 성공할 때까지 `launch=1` (M17)
  private var launchPending = true

  private func load() {
    let query = launchPending ? "?launch=1" : ""
    guard let token = token(), let url = URL(string: "http://127.0.0.1:\(port)/\(query)#token=\(token)") else {
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
    if webView === self.webView { launchPending = false }
  }

  /// 창 안에서는 이 앱의 화면(127.0.0.1:<포트>)만 연다 — 그 밖의 주소로는 옮겨 가지 않고,
  /// 사람이 누른 링크면 기본 브라우저로 연다 (SECURITY.md §3)
  func webView(
    _ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
    decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
  ) {
    guard let url = navigationAction.request.url else { return decisionHandler(.cancel) }
    let local = (url.host == "127.0.0.1" || url.host == "localhost") && url.port == port
    if local || url.scheme == "about" { return decisionHandler(.allow) }
    if navigationAction.navigationType == .linkActivated, ["http", "https"].contains(url.scheme ?? "") {
      NSWorkspace.shared.open(url)
    }
    decisionHandler(.cancel)
  }

  func webView(
    _ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error
  ) {
    // 보조 창(설정·세션)은 대시보드를 다시 열지 않는다
    guard webView === self.webView else { return }
    // 서버가 꺼져 있다 — 켜고 다시
    startServer()
    retryLoad()
  }

  @objc func reload() {
    retries = 0
    // 같은 주소(#token 만 붙은)를 다시 load 하면 같은 페이지 안 이동으로 끝나 새로 받지 않는다 —
    // 이미 떠 있으면 캐시를 건너뛰고 다시 받는다
    if webView?.url != nil { webView?.reloadFromOrigin() } else { load() }
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
