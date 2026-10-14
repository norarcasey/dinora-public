import Cocoa

// Top-level code has to live in `main.swift` when swiftc is given several files. The app's own
// settings are in `App.swift`; this only reads the one launch argument and starts.

let arguments = Array(CommandLine.arguments.dropFirst())
let start: URL
switch Shell.target(arguments) {
case .success(let url): start = url
case .failure(let error):
    FileHandle.standardError.write(Data("\(App.name): \(error.why)\n".utf8))
    exit(2)
}

let application = NSApplication.shared
let shell = Shell(home: start)
application.delegate = shell
application.setActivationPolicy(.regular)
application.run()
