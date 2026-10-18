import Foundation

/// "Import from my Mac": lists tools/serve-games.py's /games.json and
/// downloads a game's discs with HTTP Range requests into Documents/Games.
/// A download writes <disc>.part and continues from its size, so an
/// interrupted download (Wi-Fi drop, app killed) resumes where it stopped.
final class MacImporter: NSObject, ObservableObject, URLSessionDataDelegate {
    struct Catalogue: Decodable { let games: [RemoteGame] }
    struct RemoteGame: Decodable, Identifiable {
        let id: String, title: String
        let discs: [RemoteDisc]
        var totalBytes: Int64 { discs.reduce(0) { $0 + $1.size } }
    }
    struct RemoteDisc: Decodable { let name: String, path: String, size: Int64 }

    @Published var serverURL: String = UserDefaults.standard.string(forKey: "r360.macServer") ?? "http://192.168.1.2:8360"
    @Published var token: String = UserDefaults.standard.string(forKey: "r360.macToken") ?? ""
    @Published private(set) var games: [RemoteGame] = []
    @Published private(set) var status = ""
    @Published private(set) var progress: Double = 0
    @Published private(set) var busy = false

    private var session: URLSession!
    private var handle: FileHandle?
    private var expected: Int64 = 0, received: Int64 = 0, total: Int64 = 0, doneBefore: Int64 = 0
    private var completion: ((Error?) -> Void)?
    private var cancelled = false

    override init() {
        super.init()
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 60
        config.waitsForConnectivity = true
        session = URLSession(configuration: config, delegate: self, delegateQueue: nil)
    }

    private func request(_ path: String) -> URLRequest? {
        guard var comps = URLComponents(string: serverURL.trimmingCharacters(in: .whitespaces) + path) else { return nil }
        if !token.isEmpty { comps.queryItems = (comps.queryItems ?? []) + [URLQueryItem(name: "token", value: token)] }
        guard let url = comps.url else { return nil }
        var r = URLRequest(url: url)
        if !token.isEmpty { r.setValue(token, forHTTPHeaderField: "X-Render360-Token") }
        return r
    }

    func refresh() {
        UserDefaults.standard.set(serverURL, forKey: "r360.macServer")
        UserDefaults.standard.set(token, forKey: "r360.macToken")
        guard let r = request("/games.json") else { status = "Invalid address"; return }
        status = "Connecting…"
        URLSession.shared.dataTask(with: r) { data, response, error in
            DispatchQueue.main.async {
                if let error { self.status = "Can't reach the Mac: \(error.localizedDescription)"; return }
                guard (response as? HTTPURLResponse)?.statusCode == 200, let data,
                      let cat = try? JSONDecoder().decode(Catalogue.self, from: data) else {
                    self.status = "The Mac answered with an error (wrong token?)"; return
                }
                self.games = cat.games
                self.status = cat.games.isEmpty ? "No games in the served folder" : "\(cat.games.count) game(s) on the Mac"
            }
        }.resume()
    }

    func cancel() { cancelled = true; session.getAllTasks { $0.forEach { $0.cancel() } } }

    func download(_ game: RemoteGame, into library: GameLibrary) {
        guard !busy else { return }
        busy = true; cancelled = false
        let id = "mac-" + game.id
        let folder = GameLibrary.gamesRoot.appendingPathComponent(id, isDirectory: true)
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        GameLibrary.excludeFromBackup(folder)
        total = game.totalBytes; doneBefore = 0
        Breadcrumbs.shared.log("mac download \(game.title) \(total) bytes")
        func next(_ index: Int) {
            if index == game.discs.count {
                DispatchQueue.main.async {
                    library.register(id: id, title: game.title, discFiles: game.discs.map { $0.name })
                    self.busy = false; self.status = "Imported \(game.title)"; self.progress = 1
                }
                return
            }
            let disc = game.discs[index]
            let dest = folder.appendingPathComponent(disc.name)
            if let size = try? dest.resourceValues(forKeys: [.fileSizeKey]).fileSize, Int64(size) == disc.size {
                doneBefore += disc.size; next(index + 1); return
            }
            fetch(disc, to: dest) { error in
                if let error {
                    DispatchQueue.main.async {
                        self.busy = false
                        self.status = self.cancelled ? "Paused – tap Download to resume" : "Download stopped: \(error.localizedDescription) – tap Download to resume"
                    }
                    return
                }
                self.doneBefore += disc.size
                next(index + 1)
            }
        }
        next(0)
    }

    private func fetch(_ disc: RemoteDisc, to dest: URL, completion: @escaping (Error?) -> Void) {
        let part = dest.appendingPathExtension("part")
        let fm = FileManager.default
        if !fm.fileExists(atPath: part.path) { fm.createFile(atPath: part.path, contents: nil) }
        GameLibrary.excludeFromBackup(part)
        guard let h = try? FileHandle(forWritingTo: part) else { completion(CocoaError(.fileWriteUnknown)); return }
        let have = (try? h.seekToEnd()).map(Int64.init) ?? 0
        handle = h; received = have; expected = disc.size
        self.completion = { error in
            try? h.close()
            if error == nil {
                try? fm.removeItem(at: dest)
                do { try fm.moveItem(at: part, to: dest) } catch { completion(error); return }
                GameLibrary.excludeFromBackup(dest)
            }
            completion(error)
        }
        if have >= disc.size { self.completion?(nil); return }
        guard var r = request("/files/" + (disc.path.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? disc.path)) else {
            completion(URLError(.badURL)); return
        }
        r.setValue("bytes=\(have)-", forHTTPHeaderField: "Range")
        session.dataTask(with: r).resume()
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
                    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        let code = (response as? HTTPURLResponse)?.statusCode ?? 0
        if code == 200, received > 0 {
            // Server ignored Range: start the file over.
            try? handle?.truncate(atOffset: 0); received = 0
        }
        completionHandler(code == 200 || code == 206 ? .allow : .cancel)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        handle?.write(data)
        received += Int64(data.count)
        let p = total > 0 ? Double(doneBefore + received) / Double(total) : 0
        DispatchQueue.main.async {
            self.progress = p
            self.status = String(format: "Downloading… %.0f%% (%.0f / %.0f MB)", p * 100,
                                 Double(self.doneBefore + self.received) / 1e6, Double(self.total) / 1e6)
        }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        let done = completion; completion = nil
        if error == nil, received != expected { done?(URLError(.networkConnectionLost)); return }
        done?(error)
    }
}
