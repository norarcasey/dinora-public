import Cocoa
import WebKit

/*
  A native Mac window around the web app. It is not a second client: it loads the same
  `apps/web` build the browser and the phone load, so there is one contract, one set of rules
  and one offline story. What the shell adds is what a browser tab cannot have — a real app
  with the app's own name, icon, menus and notifications — and what a bare `WKWebView` does
  not do for itself, each of which failed silently in an app before this layer existed.

  Lifted from Noradar (`apps/mac`, `OPS-05`) and Kinora (`apps/mac`, `MAC-01` to `MAC-04`).
  The fixes they paid for are kept here with the measurement that found each one; a shell
  without them works on the first launch and fails on the second.
*/

struct TargetError: Error {
    let why: String
}

final class Shell: NSObject, NSApplicationDelegate, NSWindowDelegate {
    private let home: URL
    private let boundary: Boundary
    private let provenance = Provenance.fromBundle()
    private var window: NSWindow?
    private var web: WKWebView?
    private var notifier: Notifier?
    private var status: StatusItem?

    init(home: URL) {
        self.home = home
        self.boundary = Boundary(home: home, inside: App.inside)
        super.init()
    }

    /// `--url` or `App.home`, refused rather than guessed at when either is not a URL.
    static func target(_ argv: [String]) -> Result<URL, TargetError> {
        let raw: String
        if let at = argv.firstIndex(of: "--url") {
            guard at + 1 < argv.count else { return .failure(TargetError(why: "--url needs a URL")) }
            raw = argv[at + 1]
        } else {
            raw = App.home
        }
        guard let url = URL(string: raw), let scheme = url.scheme, ["http", "https"].contains(scheme),
              url.host != nil
        else { return .failure(TargetError(why: "not an http(s) URL: \(raw)")) }
        return .success(url)
    }

    func applicationDidFinishLaunching(_ note: Notification) {
        /*
          Built before anything else, because it sets the notification centre's delegate: a
          click on a banner that launched the app is delivered during launch, and to nobody if
          the delegate is not set by the time launching finishes.
        */
        let notifier = Notifier(tell: { [weak self] call in self?.reachBack(call) },
                                openWindow: { [weak self] in self?.showWindow() })
        self.notifier = notifier

        let config = WKWebViewConfiguration()
        /*
          PERSISTENT, said out loud rather than inherited. The session, the row cache and the
          service worker all live in this store; Kinora measured (`MAC-01`) that with an
          ephemeral one every launch reads as a first run — signed out, nothing cached, no
          offline start — and looks exactly like an app that forgets you.
        */
        config.websiteDataStore = .default()
        if let script = Self.resource("notify", "js") {
            config.userContentController.add(Relay(notifier), name: Notifier.channel)
            config.userContentController.addUserScript(
                WKUserScript(source: script, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        } else {
            // Without it the page keeps the engine's own Notification, which answers denied for
            // ever (Kinora, macOS 26): the page will say notifications are off, and that is true.
            log("notify.js is missing from the bundle; notifications will not work")
        }

        let frame = NSRect(x: 0, y: 0, width: 1200, height: 820)
        let web = WKWebView(frame: frame, configuration: config)
        web.navigationDelegate = boundary
        web.uiDelegate = boundary
        web.allowsBackForwardNavigationGestures = true
        self.web = web

        let window = NSWindow(contentRect: frame,
                              styleMask: [.titled, .closable, .miniaturizable, .resizable],
                              backing: .buffered, defer: false)
        window.title = App.name
        window.contentView = web
        window.minSize = NSSize(width: 420, height: 480)
        /*
          A window made in code releases itself on close, and under ARC this property is then a
          pointer to a freed window: the next Open is a crash. Noradar found it the day closing
          and reopening became the ordinary way to use the app (`OPS-05`). Hidden, not released,
          also keeps the page alive behind a closed window — a sync still finishing, a
          notification still able to arrive.
        */
        window.isReleasedWhenClosed = false
        window.delegate = self
        // Centred FIRST: the autosave name restores the saved frame as it is set, and a
        // `center()` after it moved the window back to the middle on every launch.
        window.center()
        window.setFrameAutosaveName("\(App.name)Main")
        self.window = window
        boundary.window = window
        boundary.web = web

        NSApp.mainMenu = Menus.build(target: self, provenance: provenance)
        if App.menuBarItem {
            status = StatusItem(openWindow: { [weak self] in self?.showWindow() })
        }

        web.load(URLRequest(url: home))
        showWindow()
    }

    // MARK: The window

    func showWindow() {
        // Regular before ordering front, or the window comes up behind whatever is in front
        // and without a menu bar of its own.
        NSApp.setActivationPolicy(.regular)
        window?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    /// Closing the window is not quitting. The app is still what receives a notification, and
    /// the page behind the window may still be working.
    func applicationShouldTerminateAfterLastWindowClosed(_ app: NSApplication) -> Bool { false }

    func windowWillClose(_ note: Notification) {
        guard App.menuBarItem else { return }
        // Asynchronously: changing the policy inside windowWillClose runs while AppKit is still
        // tearing the window down. Without a menu-bar item the Dock icon is the way back, so
        // the app stays `.regular`.
        DispatchQueue.main.async { NSApp.setActivationPolicy(.accessory) }
    }

    /// The Dock icon clicked, or `open -a` on an app already running.
    func applicationShouldHandleReopen(_ app: NSApplication, hasVisibleWindows visible: Bool) -> Bool {
        showWindow()
        return true
    }

    /// Two things can change while this runs and nothing tells the app: Notifications in
    /// System Settings, and the sources the bundle was built from. Coming forward is the
    /// cheapest moment reliably after either, so both are read again then — the menu is rebuilt
    /// so its build line is today's answer, not the one from launch.
    func applicationDidBecomeActive(_ note: Notification) {
        notifier?.refresh()
        NSApp.mainMenu = Menus.build(target: self, provenance: provenance)
    }

    func applicationSupportsSecureRestorableState(_ app: NSApplication) -> Bool { true }

    // MARK: What the menus call

    @objc func reload() {
        guard let web else { return }
        boundary.reload(web)
    }

    @objc func reloadFromOrigin() { web?.reloadFromOrigin() }
    @objc func goBack() { web?.goBack() }
    @objc func goForward() { web?.goForward() }
    @objc func zoomIn() { web.map { $0.pageZoom = min($0.pageZoom + 0.1, 3) } }
    @objc func zoomOut() { web.map { $0.pageZoom = max($0.pageZoom - 0.1, 0.5) } }
    @objc func actualSize() { web?.pageZoom = 1 }

    /// Nothing is run on anybody's behalf: the command goes to the clipboard.
    @objc func copyInstall() {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString("pnpm app:install", forType: .string)
    }

    // MARK: Helpers

    /// One call on the notifier's namespace in the page. Optional-chained, because a banner
    /// clicked while the page is mid-load would otherwise throw about a state that is merely
    /// early.
    private func reachBack(_ call: String) {
        web?.evaluateJavaScript("\(Notifier.namespace)?.\(call)")
    }

    static func resource(_ name: String, _ ext: String) -> String? {
        guard let at = Bundle.main.url(forResource: name, withExtension: ext) else { return nil }
        return try? String(contentsOf: at, encoding: .utf8)
    }
}

/// `WKUserContentController` holds its handlers strongly. A relay keeps that from being the
/// thing that decides the notifier's lifetime.
final class Relay: NSObject, WKScriptMessageHandler {
    private weak var notifier: Notifier?
    init(_ notifier: Notifier) { self.notifier = notifier }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        notifier?.handle(NotifyRequest(body: message.body))
    }
}

/// Said on stderr. `open -a Dinora --stderr /tmp/dinora.err` is how these are read; a Dock
/// launch throws them away.
func log(_ line: String) {
    FileHandle.standardError.write(Data("\(App.name.lowercased()): \(line)\n".utf8))
}
