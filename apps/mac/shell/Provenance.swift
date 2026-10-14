import CryptoKit
import Foundation

/*
  WHETHER THE INSTALLED BUNDLE IS STILL WHAT THIS REPOSITORY WOULD BUILD.

  The web app cannot go stale here — the window loads it from the server, so a deploy is an
  update. The bundle can: it is the one compiled thing, built by `pnpm app:install` on this
  laptop, and a bundle built last month looks exactly like one built today. Noradar found that
  on 22 Sep 2026, when an install left the old binary drawing the old icon.

  The stamp covers the files compiled or copied INTO the bundle and nothing else, so a commit
  to `apps/web` leaves it current — an alarm that fires on every commit is ignored before it
  is ever right. `apps/mac/src/bundle.ts` writes it; this reads it back and hashes the same
  bytes the same way.
*/
enum Freshness {
    case fresh
    case stale
    /// The checkout is not where it was at install time. Its own state, never `fresh`.
    case unknown(String)
}

struct Provenance {
    let commit: String
    let builtAt: String
    let root: String
    let hash: String
    let files: [String]

    static func fromBundle() -> Provenance? {
        func string(_ key: String) -> String? { Bundle.main.object(forInfoDictionaryKey: key) as? String }
        guard let root = string("ShellSourceRoot"), let hash = string("ShellSourceHash"),
              let files = Bundle.main.object(forInfoDictionaryKey: "ShellSourceFiles") as? [String]
        else { return nil }
        return Provenance(commit: string("ShellBuiltFromCommit") ?? "unknown",
                          builtAt: string("ShellBuiltAt") ?? "unknown",
                          root: root, hash: hash, files: files)
    }

    /// `sourceHash` in `bundle.ts`, byte for byte: the path and the length go in before each
    /// file, so moving a byte from one file to the next cannot give the same digest.
    func currentHash() -> String? {
        var hasher = SHA256()
        for path in files {
            guard let data = FileManager.default.contents(atPath: (root as NSString).appendingPathComponent(path))
            else { return nil }
            hasher.update(data: Data("\(path)\n\(data.count)\n".utf8))
            hasher.update(data: data)
        }
        return hasher.finalize().map { String(format: "%02x", $0) }.joined()
    }

    func freshness() -> Freshness {
        guard FileManager.default.fileExists(atPath: root) else { return .unknown("\(root) is gone") }
        guard let now = currentHash() else { return .unknown("a source file is missing") }
        return now == hash ? .fresh : .stale
    }
}
