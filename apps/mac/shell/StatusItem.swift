import Cocoa

/*
  THE MENU-BAR ITEM, when `App.menuBarItem` is on.

  What it carries is the app's to decide, and both apps that have one decided the same rule:
  the item SAYS what something else decided, and decides nothing itself. Noradar's renders
  `/api/glance` from its daemon; Kinora's renders the Media Session its page already keeps. A
  menu bar claiming one thing beside a window saying another is the app printing its own bug.
  So when an app gives this a line to show, the line comes from the app's own source of truth
  (an endpoint, or a message from the page), never from a second opinion computed here.

  The icon is the app's own, taken from the bundle at the menu bar's size, in colour rather
  than as a template: a template image renders a mark on a solid plate as a solid block
  (Kinora, `MAC-09`), and an app with its own mark should not borrow an SF Symbol that a
  dozen other items already use.
*/
final class StatusItem: NSObject {
    private let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    private let openWindow: () -> Void

    init(openWindow: @escaping () -> Void) {
        self.openWindow = openWindow
        super.init()
        if let icon = NSApp.applicationIconImage.copy() as? NSImage {
            icon.size = NSSize(width: 18, height: 18)
            item.button?.image = icon
        } else {
            item.button?.title = App.name
        }
        item.button?.toolTip = App.name

        let menu = NSMenu()
        let open = NSMenuItem(title: "Open \(App.name)", action: #selector(open), keyEquivalent: "o")
        open.target = self
        menu.addItem(open)
        menu.addItem(.separator())
        menu.addItem(withTitle: "Quit \(App.name)", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        item.menu = menu
    }

    @objc private func open() { openWindow() }
}
