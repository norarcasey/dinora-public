import Cocoa
import UserNotifications

/*
  NOTIFICATIONS UNDER THE APP'S OWN NAME, from the web API the page already uses.

  A `WKWebView` defines a `Notification` that answers `denied` for ever with no public way for
  the host to grant it — Kinora measured that on macOS 26 (`MAC-04`), after building on the
  opposite assumption. So `notify.js` replaces it in the page and forwards each call here, and
  this posts through `UNUserNotificationCenter`, which only a real bundle can do: Noradar
  measured on 14 Sep 2026 that an `osacompile` applet exits 0 and posts nothing, five times of
  five. The page keeps its own rules about when to notify; this owns exactly two decisions,
  what macOS is asked and what it answered.

  Kinora's `Notifications.swift`, with its names taken out.
*/

/// What the page asked for, as `notify.js` posts it. Parsing is total: a body this cannot read
/// becomes `.malformed`, which fails the page's `error` handler, never an empty banner.
enum NotifyRequest {
    case permission
    case request(handle: Int)
    case show(handle: Int, tag: String, title: String, body: String, silent: Bool)
    case close(handle: Int, tag: String)
    /// The script replaced the engine's own `Notification`. Logged, because the day a WebKit
    /// ships one that works, this line is the only thing that would say so.
    case displaced
    case notDefined
    case malformed(handle: Int?)

    init(body: Any) {
        guard let dict = body as? [String: Any], let kind = dict["kind"] as? String else {
            self = .malformed(handle: nil)
            return
        }
        let handle = dict["handle"] as? Int
        switch kind {
        case "permission": self = .permission
        case "displaced": self = .displaced
        case "notDefined": self = .notDefined
        case "request": self = handle.map { .request(handle: $0) } ?? .malformed(handle: nil)
        case "show":
            guard let handle, let title = dict["title"] as? String else {
                self = .malformed(handle: handle)
                return
            }
            self = .show(handle: handle, tag: dict["tag"] as? String ?? "", title: title,
                         body: dict["body"] as? String ?? "", silent: dict["silent"] as? Bool ?? false)
        case "close":
            guard let handle else {
                self = .malformed(handle: nil)
                return
            }
            self = .close(handle: handle, tag: dict["tag"] as? String ?? "")
        default: self = .malformed(handle: handle)
        }
    }
}

/*
  EVERY ARGUMENT SENT BACK INTO THE PAGE IS AN INTEGER IT MINTED OR A WORD FROM A CLOSED SET.
  Never a title, a body or a tag: a string built from page text and handed to
  `evaluateJavaScript` is the one place page content could become code, and the way not to
  have that problem is for nothing to travel that way. `bundle.test.ts` holds the set of
  `tell(...)` calls in this file to exactly that.
*/
final class Notifier: NSObject, UNUserNotificationCenterDelegate {
    static let channel = "shellNotify"
    static let namespace = "__shellNotifier"
    private static let handleKey = "shellHandle"

    /// Nil is a process with no bundle identity — the binary run straight out of a build
    /// directory — where `.current()` traps rather than failing politely.
    private let center: UNUserNotificationCenter?
    private let tell: (String) -> Void
    private let openWindow: () -> Void
    /// Which handle owns each identifier. A tag replaces in the web API and in macOS both, so a
    /// late close() from the replaced object must not take the replacement down.
    private var owner: [String: Int] = [:]

    init(tell: @escaping (String) -> Void, openWindow: @escaping () -> Void) {
        self.tell = tell
        self.openWindow = openWindow
        self.center = Bundle.main.bundleIdentifier == nil ? nil : .current()
        super.init()
        center?.delegate = self
        if center == nil { log("no bundle identity, so no notification centre: notifications are off") }
    }

    func handle(_ request: NotifyRequest) {
        switch request {
        case .permission: refresh()
        case .request(let handle): ask(handle)
        case .show(let handle, let tag, let title, let body, let silent):
            show(handle: handle, tag: tag, title: title, body: body, silent: silent)
        case .close(let handle, let tag): close(handle: handle, tag: tag)
        case .displaced: log("replaced the engine's own Notification API, which a WKWebView denies for ever")
        case .notDefined: log("COULD NOT define Notification in the page; notifications will not work")
        case .malformed(let handle):
            log("a notification message could not be read")
            if let handle { tell("failed(\(handle))") }
        }
    }

    /// What macOS says today, asked rather than remembered. The raw status goes in the log
    /// line, because a real refusal and the fail-closed branch below say the same word and
    /// want different fixes.
    func refresh() {
        guard let center else { return announce("denied", status: nil) }
        center.getNotificationSettings { settings in
            let status = settings.authorizationStatus
            DispatchQueue.main.async { self.announce(Self.word(status), status: status) }
        }
    }

    private func announce(_ state: String, status: UNAuthorizationStatus?) {
        log("permission is \(state) (authorizationStatus \(status.map { String($0.rawValue) } ?? "none"))")
        tell("permission('\(state)')")
    }

    /// The prompt, on the page's own call. The answer is read back from the settings after
    /// the ask rather than from the callback's boolean: `false`, an error and a second ask
    /// after a refusal all mean one thing to the page.
    private func ask(_ handle: Int) {
        guard let center else { return settle(handle, "denied") }
        center.requestAuthorization(options: [.alert, .sound]) { _, error in
            if let error { log("asking for notification permission failed: \(error.localizedDescription)") }
            center.getNotificationSettings { settings in
                let state = Self.word(settings.authorizationStatus)
                DispatchQueue.main.async { self.settle(handle, state) }
            }
        }
    }

    private func settle(_ handle: Int, _ state: String) {
        log("asked macOS; it answered \(state)")
        tell("resolve(\(handle), '\(state)')")
    }

    /// The web's `tag` becomes the request identifier, which gives it replace-in-place for
    /// free. `show` fires when macOS took it, not when the message left the page.
    private func show(handle: Int, tag: String, title: String, body: String, silent: Bool) {
        guard let center else { return tell("failed(\(handle))") }
        let identifier = tag.isEmpty ? "untagged.\(handle)" : tag
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        if !silent { content.sound = .default }
        content.userInfo = [Self.handleKey: handle]
        center.add(UNNotificationRequest(identifier: identifier, content: content, trigger: nil)) { error in
            DispatchQueue.main.async {
                if let error {
                    log("macOS refused a notification: \(error.localizedDescription)")
                    return self.tell("failed(\(handle))")
                }
                self.owner[identifier] = handle
                self.tell("shown(\(handle))")
            }
        }
    }

    private func close(handle: Int, tag: String) {
        let identifier = tag.isEmpty ? "untagged.\(handle)" : tag
        guard owner[identifier] == handle else { return }
        owner[identifier] = nil
        center?.removeDeliveredNotifications(withIdentifiers: [identifier])
        center?.removePendingNotificationRequests(withIdentifiers: [identifier])
    }

    /// An unknown status is `denied`: wrong in the direction where somebody goes and looks.
    private static func word(_ status: UNAuthorizationStatus) -> String {
        switch status {
        case .authorized, .provisional, .ephemeral: return "granted"
        case .denied: return "denied"
        case .notDetermined: return "default"
        @unknown default: return "denied"
        }
    }

    /// Shown while the app is in front too, as a browser does: the window can be up on one
    /// screen while the thing being reported finishes behind it.
    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                withCompletionHandler done: @escaping (UNNotificationPresentationOptions) -> Void) {
        done([.banner, .list, .sound])
    }

    /// The click raises the window, because `window.focus()` in the page reaches nothing here,
    /// then runs the page's handler. A dismissal raises nothing.
    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                withCompletionHandler done: @escaping () -> Void) {
        let handle = response.notification.request.content.userInfo[Self.handleKey] as? Int
        let identifier = response.notification.request.identifier
        let clicked = response.actionIdentifier == UNNotificationDefaultActionIdentifier
        DispatchQueue.main.async {
            self.owner[identifier] = nil
            if clicked {
                self.openWindow()
                if let handle { self.tell("clicked(\(handle))") }
            }
            done()
        }
    }
}
