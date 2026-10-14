import Cocoa

/*
  THE MAIN MENU, built rather than loaded, because nothing here has a nib.

  Without one a Mac app has no ⌘Q, no ⌘W and no ⌘C/⌘V: Noradar's window could not copy a sha,
  and Kinora's sign-in form could not take a pasted address. The items are the standard
  selectors wherever one exists, so the system's own behaviour runs and not a copy of it.

  View has Back and Forward because this window has no address bar, and a swipe is not the
  only way anybody goes back; and zoom, because a browser has it and its absence is noticed.
*/
enum Menus {
    static func build(target shell: Shell, provenance: Provenance?) -> NSMenu {
        let bar = NSMenu()

        let app = NSMenu()
        app.addItem(withTitle: "About \(App.name)",
                    action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        if let line = provenanceItem(provenance, shell) { app.addItem(line) }
        app.addItem(.separator())
        app.addItem(withTitle: "Hide \(App.name)", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        let others = app.addItem(withTitle: "Hide Others",
                                 action: #selector(NSApplication.hideOtherApplications(_:)), keyEquivalent: "h")
        others.keyEquivalentModifierMask = [.command, .option]
        app.addItem(withTitle: "Show All", action: #selector(NSApplication.unhideAllApplications(_:)), keyEquivalent: "")
        app.addItem(.separator())
        app.addItem(withTitle: "Quit \(App.name)", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        add(app, titled: App.name, to: bar)

        let edit = NSMenu(title: "Edit")
        edit.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        let redo = edit.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "z")
        redo.keyEquivalentModifierMask = [.command, .shift]
        edit.addItem(.separator())
        edit.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        add(edit, titled: "Edit", to: bar)

        let view = NSMenu(title: "View")
        item(view, "Reload", #selector(Shell.reload), "r", shell)
        item(view, "Reload Ignoring Cache", #selector(Shell.reloadFromOrigin), "r", shell, [.command, .shift])
        view.addItem(.separator())
        item(view, "Back", #selector(Shell.goBack), "[", shell)
        item(view, "Forward", #selector(Shell.goForward), "]", shell)
        view.addItem(.separator())
        item(view, "Actual Size", #selector(Shell.actualSize), "0", shell)
        item(view, "Zoom In", #selector(Shell.zoomIn), "+", shell)
        item(view, "Zoom Out", #selector(Shell.zoomOut), "-", shell)
        view.addItem(.separator())
        let full = view.addItem(withTitle: "Enter Full Screen",
                                action: #selector(NSWindow.toggleFullScreen(_:)), keyEquivalent: "f")
        full.keyEquivalentModifierMask = [.command, .control]
        add(view, titled: "View", to: bar)

        let window = NSMenu(title: "Window")
        window.addItem(withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        window.addItem(withTitle: "Zoom", action: #selector(NSWindow.performZoom(_:)), keyEquivalent: "")
        window.addItem(.separator())
        window.addItem(withTitle: "Close", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        add(window, titled: "Window", to: bar)
        NSApp.windowsMenu = window

        return bar
    }

    /*
      Whether this bundle is still what the repository would build, in the app menu so it is
      there whenever the window is. Stale is a line you can click to copy the fix; unknown is
      its own words, never folded into current — not being able to check is not having checked.
    */
    private static func provenanceItem(_ provenance: Provenance?, _ shell: Shell) -> NSMenuItem? {
        guard let provenance else { return nil }
        switch provenance.freshness() {
        case .fresh:
            return disabled("Built from \(provenance.commit) · \(provenance.builtAt)")
        case .stale:
            let line = NSMenuItem(title: "Built from \(provenance.commit) — sources changed since",
                                  action: #selector(Shell.copyInstall), keyEquivalent: "")
            line.target = shell
            line.toolTip = "Click to copy “pnpm app:install”"
            return line
        case .unknown(let why):
            return disabled("Built from \(provenance.commit) · cannot check — \(why)")
        }
    }

    private static func disabled(_ title: String) -> NSMenuItem {
        let line = NSMenuItem(title: title, action: nil, keyEquivalent: "")
        line.isEnabled = false
        return line
    }

    private static func item(_ menu: NSMenu, _ title: String, _ action: Selector, _ key: String,
                             _ target: AnyObject, _ mask: NSEvent.ModifierFlags = [.command]) {
        let entry = menu.addItem(withTitle: title, action: action, keyEquivalent: key)
        entry.target = target
        entry.keyEquivalentModifierMask = mask
    }

    private static func add(_ menu: NSMenu, titled title: String, to bar: NSMenu) {
        let holder = NSMenuItem(title: title, action: nil, keyEquivalent: "")
        holder.submenu = menu
        bar.addItem(holder)
    }
}
