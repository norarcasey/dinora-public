import Foundation

/*
  THE ONE FILE HERE THE APP EDITS.

  Everything else in `apps/mac/shell` is the shell every app gets — the window, the menus, the
  boundary between the web view and the Mac, the notification bridge — and is kept as the
  layer laid it down, so a fix found in one app can be carried to the next by copying a file.
  What differs between apps is here, and it is small on purpose: a hosted app's behaviour lives
  in `apps/web`, which this window loads and does not duplicate.
*/
enum App {
    static let name = "Dinora"

    /// Where the window opens. `open -a Dinora --args --url http://localhost:5173/` points an
    /// installed build at a dev server instead, without a second bundle — quit it first, because
    /// `open` hands arguments only to a process it starts, and quit it again to come back here: a
    /// later plain `open -a` reopens the window it has. `localhost`, not `127.0.0.1`: Vite listens
    /// on what `localhost` resolves to first, which on this Mac is `[::1]` alone (`SKILL-1`).
    static let home = "https://dinora.example.com/"

    /*
      Hosts that stay inside the window, beyond the host of `home`, which always does.

      Everything else a page navigates the window to opens in the browser, because this window
      has no address bar and no way back from a page that is not the app. `"*.example.com"`
      matches every subdomain and not the bare domain; list both if both are wanted. Port is
      ignored, so a dev server's API on another port of localhost is the same host.

      Frames are not policed: an embedded widget (a bank's consent, a payment form) loads inside
      its iframe whatever its host. Only the WINDOW is kept to the app.
    */
    static let inside: [String] = []

    /*
      A menu-bar item, off until the app has something to say in it.

      On, the Dock icon goes while the window is closed and the item is the way back — the
      pattern Noradar (`OPS-05`) and Kinora (`MAC-03`) both arrived at, because a Dock slot held
      all day to show nothing is the thing being replaced. Off, the app behaves like any other
      Mac app: closing the window keeps it running in the Dock, and clicking the icon brings it
      back. An item that only says Open and Quit is a Dock icon moved somewhere smaller, so turn
      this on together with whatever the item will show (see `StatusItem.swift`).
    */
    static let menuBarItem = false
}
