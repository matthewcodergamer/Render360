import Foundation

/// One game in Documents/Games/<id>/: its discs (Watch Dogs has two) plus a
/// small game.json. Game files stay on the device; every file is excluded
/// from iCloud/iTunes backup.
struct GameEntry: Codable, Identifiable, Equatable {
    var id: String
    var title: String
    var discs: [String]              // file names inside the game folder, disc order
    var ownedFullLicense = false     // XAM license mask (Xenia default: trial)
    var addedAt = Date()

    var folder: URL { GameLibrary.gamesRoot.appendingPathComponent(id, isDirectory: true) }
    var discURLs: [URL] { discs.map { folder.appendingPathComponent($0) } }
    var totalBytes: Int64 {
        discURLs.reduce(0) { $0 + ((try? $1.resourceValues(forKeys: [.fileSizeKey]).fileSize).map(Int64.init) ?? 0) }
    }
}

final class GameLibrary: ObservableObject {
    static let shared = GameLibrary()
    static var documents: URL { FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0] }
    static var gamesRoot: URL { documents.appendingPathComponent("Games", isDirectory: true) }

    @Published private(set) var games: [GameEntry] = []

    init() { reload() }

    func reload() {
        let fm = FileManager.default
        try? fm.createDirectory(at: Self.gamesRoot, withIntermediateDirectories: true)
        Self.excludeFromBackup(Self.gamesRoot)
        var found: [GameEntry] = []
        for dir in (try? fm.contentsOfDirectory(at: Self.gamesRoot, includingPropertiesForKeys: nil)) ?? [] {
            let meta = dir.appendingPathComponent("game.json")
            if let data = try? Data(contentsOf: meta), let entry = try? JSONDecoder().decode(GameEntry.self, from: data),
               entry.discURLs.allSatisfy({ fm.fileExists(atPath: $0.path) }) {
                found.append(entry)
            }
        }
        games = found.sorted { $0.title.localizedCaseInsensitiveCompare($1.title) == .orderedAscending }
    }

    static func excludeFromBackup(_ url: URL) {
        var u = url
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try? u.setResourceValues(values)
    }

    /// Disc order from names ("Disc 1", "disc2", "_d1"...), else alphabetical.
    static func discOrder(_ names: [String]) -> [String] {
        func discNumber(_ s: String) -> Int? {
            let lower = s.lowercased()
            for marker in ["disc", "disk", "cd", "_d"] {
                if let r = lower.range(of: marker) {
                    let digits = lower[r.upperBound...].drop { $0 == " " || $0 == "_" || $0 == "-" }.prefix { $0.isNumber }
                    if let n = Int(digits) { return n }
                }
            }
            return nil
        }
        return names.sorted { a, b in
            switch (discNumber(a), discNumber(b)) {
            case let (x?, y?) where x != y: return x < y
            default: return a.localizedStandardCompare(b) == .orderedAscending
            }
        }
    }

    /// Creates (or extends, for another disc of the same title) a game entry
    /// from files already moved into its folder.
    @discardableResult
    func register(id: String, title: String, discFiles: [String]) -> GameEntry {
        let folder = Self.gamesRoot.appendingPathComponent(id, isDirectory: true)
        var entry = games.first { $0.id == id } ?? GameEntry(id: id, title: title, discs: [])
        entry.discs = Self.discOrder(Array(Set(entry.discs + discFiles)))
        for disc in entry.discs { Self.excludeFromBackup(folder.appendingPathComponent(disc)) }
        Self.excludeFromBackup(folder)
        if let data = try? JSONEncoder().encode(entry) { try? data.write(to: folder.appendingPathComponent("game.json")) }
        reload()
        return entry
    }

    func update(_ entry: GameEntry) {
        if let data = try? JSONEncoder().encode(entry) { try? data.write(to: entry.folder.appendingPathComponent("game.json")) }
        reload()
    }

    func delete(_ entry: GameEntry) {
        try? FileManager.default.removeItem(at: entry.folder)
        reload()
    }

    static func makeID(_ title: String) -> String {
        let base = title.lowercased().map { $0.isLetter || $0.isNumber ? $0 : "-" }
        return String(base).split(separator: "-").joined(separator: "-").prefix(40) + "-" + String(UUID().uuidString.prefix(6))
    }

    /// Imports files from the Files app or AirDrop (open-in). Files that look
    /// like discs of one title ("Watch Dogs Disc 1/2") become one entry.
    /// `addTo` adds the files as further discs of an existing game.
    func importFiles(_ urls: [URL], addTo existing: GameEntry? = nil) throws -> GameEntry {
        guard !urls.isEmpty else { throw CocoaError(.fileNoSuchFile) }
        let title = existing?.title ?? Self.titleFromDiscName(urls[0].deletingPathExtension().lastPathComponent)
        let id = existing?.id ?? Self.makeID(title)
        let folder = Self.gamesRoot.appendingPathComponent(id, isDirectory: true)
        let fm = FileManager.default
        try fm.createDirectory(at: folder, withIntermediateDirectories: true)
        var names: [String] = []
        for url in urls {
            let scoped = url.startAccessingSecurityScopedResource()
            defer { if scoped { url.stopAccessingSecurityScopedResource() } }
            let dest = folder.appendingPathComponent(url.lastPathComponent)
            if fm.fileExists(atPath: dest.path) { try fm.removeItem(at: dest) }
            // Inbox files (AirDrop/open-in) can be moved; picked files are copied.
            // Inbox (AirDrop / open-in) and picker copies (tmp) are ours to move.
            if url.path.contains("/Inbox/") || url.path.hasPrefix(fm.temporaryDirectory.path) || url.path.contains("/tmp/") {
                try fm.moveItem(at: url, to: dest)
            } else {
                try fm.copyItem(at: url, to: dest)
            }
            names.append(dest.lastPathComponent)
            Breadcrumbs.shared.log("import \(dest.lastPathComponent)")
        }
        return register(id: id, title: title, discs: names)
    }

    private func register(id: String, title: String, discs: [String]) -> GameEntry {
        register(id: id, title: title, discFiles: discs)
    }

    /// "Watch Dogs (Disc 1)" -> "Watch Dogs".
    static func titleFromDiscName(_ name: String) -> String {
        var t = name
        for pattern in ["\\s*[\\(\\[]?\\s*(disc|disk|cd)\\s*\\d+\\s*[\\)\\]]?", "_d\\d+$"] {
            t = t.replacingOccurrences(of: pattern, with: "", options: [.regularExpression, .caseInsensitive])
        }
        t = t.trimmingCharacters(in: .whitespaces)
        return t.isEmpty ? name : t
    }
}
