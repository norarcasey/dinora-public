import Cocoa
import Network
import WebKit

/*
  WHERE THE WEB VIEW MEETS THE MAC.

  Every method here answers something a `WKWebView` does not answer for itself, and in every
  case the default is not an error but silence: a link that does nothing, a file button that
  opens nothing, a `confirm()` that says no without asking, a blank window when the network is
  down. None of these announces itself; each was found by somebody pressing the thing.
*/
final class Boundary: NSObject, WKNavigationDelegate, WKUIDelegate {
    private let home: URL
    private let inside: [String]
    weak var window: NSWindow?
    weak var web: WKWebView?

    /// The page that could not be reached, while the failure page stands in for it.
    private var unreached: URL?
    private var retry: Timer?
    private let network = NWPathMonitor()

    init(home: URL, inside: [String]) {
        self.home = home
        self.inside = inside.map { $0.lowercased() }
        super.init()
        // A connection coming back is the moment a failed load is worth trying again, and
        // nothing else would notice it: the failure page is ours, and has no network of its own.
        network.pathUpdateHandler = { [weak self] path in
            guard path.status == .satisfied else { return }
            DispatchQueue.main.async { self?.tryAgain() }
        }
        network.start(queue: .main)
    }

    // MARK: Where a navigation goes

    /*
      THE WINDOW STAYS ON THE APP; EVERYTHING ELSE OPENS IN THE BROWSER.

      A shell that follows every link becomes a browser with one bookmark, no address bar and
      no way back — and the person cannot see where they are. Decided on the HOST of the
      destination against `App.inside` plus the home host, for main-frame navigations of every
      kind: a click, a form, a script setting `location`. Noradar decided only on clicks, which
      let a scripted redirect strand the window; Kinora decided on every frame, which would send
      an embedded widget's own iframe load out to the browser.
    */
    func isInside(_ url: URL) -> Bool {
        if let scheme = url.scheme, ["about", "blob", "data"].contains(scheme) { return true }
        guard let host = url.host?.lowercased() else { return false }
        if host == home.host?.lowercased() { return true }
        return inside.contains { rule in
            rule.hasPrefix("*.") ? host.hasSuffix(String(rule.dropFirst(1))) : host == rule
        }
    }

    func webView(_ web: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler decide: @escaping (WKNavigationActionPolicy) -> Void) {
        // No target frame is a request for a new window, which is answered below; a subframe is
        // an embed, and loads where the page put it.
        guard action.targetFrame?.isMainFrame == true, let url = action.request.url else {
            return decide(.allow)
        }
        if isInside(url) { return decide(.allow) }
        NSWorkspace.shared.open(url)
        decide(.cancel)
    }

    /*
      `target="_blank"` and `window.open` ask for a NEW web view, and get nothing when no
      delegate answers — so from the day Noradar's dashboard moved from a tab into this window,
      every such link silently did nothing (`OPS-05`, six of them). They go to the browser,
      whatever the host: a second window here would have no address bar either.

      `window.open` returns null to the page. An OAuth popup that writes to the window it
      opened would need one; the sign-in here is an emailed code, so nothing
      does.
    */
    func webView(_ web: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url, url.absoluteString != "about:blank" {
            NSWorkspace.shared.open(url)
        }
        return nil
    }

    // MARK: A load that fails

    /*
      A LOAD THAT FAILS SAYS SO, AND TRIES AGAIN BY ITSELF.

      Offline with the service worker installed (the `pwa` layer), the shell comes from the
      worker and never reaches here — Kinora measured that a worker serves the navigation in a
      `WKWebView` (`MAC-01`). A first launch offline, the host down, or a dev server not started
      yet is a blank white window with no explanation. So the failure gets a page saying which
      host did not answer and why, and the load is tried again when the network comes back and
      every ten seconds until it works.

      A cancelled load is not a failure. Sending a link to the browser cancels it, and so does
      a second navigation replacing the first; both arrive here as errors, and painting the
      failure page over a working app for either would be the shell inventing an outage.
    */
    func webView(_ web: WKWebView, didFailProvisionalNavigation nav: WKNavigation!, withError error: Error) {
        failed(web, error)
    }

    func webView(_ web: WKWebView, didFail nav: WKNavigation!, withError error: Error) {
        failed(web, error)
    }

    func webView(_ web: WKWebView, didFinish nav: WKNavigation!) {
        // The failure page is a load too; only a real page ends the retries.
        guard web.url?.absoluteString != "about:blank" else { return }
        unreached = nil
        retry?.invalidate()
        retry = nil
    }

    private func failed(_ web: WKWebView, _ error: Error) {
        let ns = error as NSError
        if ns.domain == NSURLErrorDomain && ns.code == NSURLErrorCancelled { return }
        // 102: "frame load interrupted", which is what a policy decision to cancel reports.
        if ns.domain == "WebKitErrorDomain" && ns.code == 102 { return }
        let url = (ns.userInfo[NSURLErrorFailingURLErrorKey] as? URL) ?? web.url ?? home
        guard isInside(url) else { return }
        unreached = url
        log("could not load \(url.absoluteString): \(ns.domain) \(ns.code) \(ns.localizedDescription)")
        web.loadHTMLString(Self.failurePage(url, ns.localizedDescription), baseURL: nil)
        if retry == nil {
            retry = Timer.scheduledTimer(withTimeInterval: 10, repeats: true) { [weak self] _ in
                self?.tryAgain()
            }
        }
    }

    private func tryAgain() {
        guard let unreached, let web else { return }
        web.load(URLRequest(url: unreached))
    }

    /// Reload from the View menu: the page that failed, not the failure page.
    func reload(_ web: WKWebView) {
        if let unreached { web.load(URLRequest(url: unreached)) } else { web.reload() }
    }

    /// Our own HTML, in the system's colours so it is right in dark and light without knowing
    /// the app's. Every value from outside is escaped: an error description is the OS's words
    /// and a URL can carry anything.
    static func failurePage(_ url: URL, _ reason: String) -> String {
        let host = escape(url.host ?? url.absoluteString)
        return """
        <!doctype html><meta charset=utf-8><title>\(escape(App.name))</title>
        <style>
          :root { color-scheme: light dark }
          body { margin: 0; height: 100vh; display: grid; place-items: center;
                 background: Canvas; color: CanvasText; font: 14px/1.5 -apple-system, sans-serif }
          main { max-width: 38ch; text-align: center; padding: 24px }
          h1 { font-size: 17px; margin: 0 0 8px }
          p { margin: 0 0 16px; opacity: .7 }
          a { font: inherit; color: LinkText }
        </style>
        <main>
          <h1>\(escape(App.name)) could not be reached</h1>
          <p>\(host) did not answer: \(escape(reason))</p>
          <p>It will try again when the connection comes back, and every ten seconds until then.</p>
          <a href="\(escape(url.absoluteString))">Try now</a>
        </main>
        """
    }

    private static func escape(_ text: String) -> String {
        text.replacingOccurrences(of: "&", with: "&amp;")
            .replacingOccurrences(of: "<", with: "&lt;")
            .replacingOccurrences(of: ">", with: "&gt;")
            .replacingOccurrences(of: "\"", with: "&quot;")
    }

    // MARK: What a browser draws for the page

    /*
      `<input type="file">` opens no panel unless the host provides one — there is no default.
      Kinora's Import rendered, pressed, and did nothing. The completion handler runs exactly
      once, cancel included: not calling it leaves the input waiting, and the next press is
      dead too.
    */
    func webView(_ web: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        guard let window else { return completionHandler(nil) }
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.canChooseDirectories = parameters.allowsDirectories
        panel.canChooseFiles = !parameters.allowsDirectories
        panel.beginSheetModal(for: window) { response in
            completionHandler(response == .OK ? panel.urls : nil)
        }
    }

    /*
      `alert`, `confirm` and `prompt`. Unanswered, a `WKWebView` returns at once — `confirm()`
      is false and `prompt()` is null without anything drawn — so "Discard this?" is answered
      no on the person's behalf and they see a button that does nothing. Each is a sheet on the
      window. With the window closed there is nobody to ask, and the answer is the cautious one.
    */
    func webView(_ web: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        ask(message, buttons: ["OK"]) { _ in completionHandler() }
    }

    func webView(_ web: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        ask(message, buttons: ["OK", "Cancel"]) { ok in completionHandler(ok) }
    }

    func webView(_ web: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String,
                 defaultText: String?, initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping (String?) -> Void) {
        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 260, height: 24))
        field.stringValue = defaultText ?? ""
        ask(prompt, buttons: ["OK", "Cancel"], accessory: field) { ok in
            completionHandler(ok ? field.stringValue : nil)
        }
    }

    private func ask(_ message: String, buttons: [String], accessory: NSView? = nil,
                     done: @escaping (Bool) -> Void) {
        guard let window, window.isVisible else { return done(false) }
        let alert = NSAlert()
        alert.messageText = App.name
        alert.informativeText = message
        for title in buttons { alert.addButton(withTitle: title) }
        alert.accessoryView = accessory
        if let accessory { alert.window.initialFirstResponder = accessory }
        alert.beginSheetModal(for: window) { response in done(response == .alertFirstButtonReturn) }
    }
}
