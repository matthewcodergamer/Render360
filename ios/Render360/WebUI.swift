import SwiftUI
import UniformTypeIdentifiers
import WebKit

/// The Render360 website's own UI (index.html, styles, library, settings,
/// touch controller, HUD - bundled in the app under `web/`) shown over the
/// native game view, so the app looks exactly like the website. The web page
/// never runs the emulator here: runtime/native-host.js routes Play, input and
/// imports to this bridge and the native core.
struct WebUIView: UIViewRepresentable {
    let bridge: WebBridge

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.setURLSchemeHandler(BundleSchemeHandler(), forURLScheme: "r360app")
        config.userContentController.add(bridge, name: "render360")
        // Page errors and boot state go to the crash breadcrumbs (diagnostics).
        config.userContentController.addUserScript(WKUserScript(source: """
        addEventListener('error', e => webkit.messageHandlers.render360.postMessage({type:'log', level:'error', message:String(e.message)+' @'+e.filename+':'+e.lineno}));
        addEventListener('unhandledrejection', e => webkit.messageHandlers.render360.postMessage({type:'log', level:'error', message:'unhandled: '+String(e.reason && e.reason.message || e.reason)}));
        addEventListener('load', () => setTimeout(() => webkit.messageHandlers.render360.postMessage({type:'log', level:'info', message:'page ready: '+(document.querySelector('.view:not(.hidden)')||{}).id+' games='+document.querySelectorAll('#gameGrid > *').length+' status='+((document.getElementById('coreStatus')||{}).textContent||'')}), 8000));
        """, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        config.allowsInlineMediaPlayback = true
        config.preferences.javaScriptCanOpenWindowsAutomatically = false
        let web = WKWebView(frame: .zero, configuration: config)
        web.isOpaque = false
        web.backgroundColor = .clear
        web.scrollView.backgroundColor = .clear
        web.scrollView.contentInsetAdjustmentBehavior = .never
        web.scrollView.bounces = false
        if #available(iOS 16.4, *) { web.isInspectable = true }
        bridge.web = web
        web.load(URLRequest(url: URL(string: "r360app://app/index.html")!))
        return web
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {}
}

/// Serves the bundled website files (Render360.app/web/...) to the web view.
final class BundleSchemeHandler: NSObject, WKURLSchemeHandler {
    private let root = Bundle.main.bundleURL.appendingPathComponent("web", isDirectory: true)

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        guard let url = task.request.url else { return }
        var path = url.path
        if path.isEmpty || path == "/" { path = "/index.html" }
        let file = root.appendingPathComponent(String(path.dropFirst())).standardizedFileURL
        guard file.path.hasPrefix(root.standardizedFileURL.path), let data = try? Data(contentsOf: file) else {
            task.didReceive(HTTPURLResponse(url: url, statusCode: 404, httpVersion: "HTTP/1.1", headerFields: nil)!)
            task.didFinish()
            return
        }
        let types = ["html": "text/html", "js": "text/javascript", "mjs": "text/javascript", "css": "text/css",
                     "json": "application/json", "webmanifest": "application/manifest+json", "svg": "image/svg+xml",
                     "png": "image/png", "jpg": "image/jpeg", "wasm": "application/wasm"]
        let type = types[file.pathExtension.lowercased()] ?? "application/octet-stream"
        task.didReceive(HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1",
                                        headerFields: ["Content-Type": type, "Content-Length": "\(data.count)",
                                                       "Cache-Control": "no-cache"])!)
        task.didReceive(data)
        task.didFinish()
    }

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {}
}

/// runtime/native-host.js <-> native core.
final class WebBridge: NSObject, WKScriptMessageHandler, UIDocumentPickerDelegate {
    weak var web: WKWebView?
    let session: EmulatorSession
    let input: InputHub
    private var pendingImport: Int?
    private var telemetryTimer: Timer?
    private var lastFrames: UInt32 = 0
    private var keys = Set<String>()
    private var analog: (Float, Float, Float, Float) = (0, 0, 0, 0)

    init(session: EmulatorSession, input: InputHub) {
        self.session = session
        self.input = input
    }

    // Website key names (runtime-host.js) -> XInput bits.
    private static let keyBits: [String: UInt32] = [
        "A": 0x1000, "B": 0x2000, "X": 0x4000, "Y": 0x8000, "LB": 0x100, "RB": 0x200,
        "START": 0x10, "BACK": 0x20, "UP": 0x1, "DOWN": 0x2, "LEFT": 0x4, "RIGHT": 0x8, "LS": 0x40, "RS": 0x80]

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any], let type = body["type"] as? String else { return }
        let id = body["id"] as? Int
        switch type {
        case "importGame":
            pendingImport = id
            presentPicker()
        case "listGames":
            let id = id
            DispatchQueue.global(qos: .userInitiated).async {
                GameLibrary.shared.reload()
                let list = GameLibrary.shared.games.compactMap { try? self.inspect($0) }
                DispatchQueue.main.async { self.reply(id, ok: true, list) }
            }
        case "play":
            play(id: id, body: body)
        case "key":
            let key = (body["key"] as? String ?? "").uppercased()
            if body["pressed"] as? Bool == true { keys.insert(key) } else { keys.remove(key) }
            pushInput()
        case "analog":
            analog = (Float(body["lx"] as? Double ?? 0), Float(body["ly"] as? Double ?? 0),
                      Float(body["rx"] as? Double ?? 0), Float(body["ry"] as? Double ?? 0))
            pushInput()
        case "log":
            Breadcrumbs.shared.log("web \(body["level"] as? String ?? ""): \(body["message"] as? String ?? "")")
        case "pause": session.setPaused(true)
        case "resume": session.setPaused(false)
        default: break
        }
    }

    private func pushInput() {
        var pad = PadState()
        for key in keys { pad.buttons |= Self.keyBits[key] ?? 0 }
        pad.leftTrigger = keys.contains("LT") ? 255 : 0
        pad.rightTrigger = keys.contains("RT") ? 255 : 0
        // Browser stick Y points down; XInput Y points up (pushGuestControllerState).
        pad.lx = analog.0; pad.ly = -analog.1; pad.rx = analog.2; pad.ry = -analog.3
        input.touch = pad
    }

    private func reply(_ id: Int?, ok: Bool, _ value: Any?) {
        guard let id else { return }
        let json = value.flatMap { try? JSONSerialization.data(withJSONObject: $0, options: [.fragmentsAllowed]) }
            .flatMap { String(data: $0, encoding: .utf8) } ?? "null"
        web?.evaluateJavaScript("render360NativeReply(\(id), \(ok), \(json))")
    }

    func event(_ type: String, _ detail: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: detail),
              let json = String(data: data, encoding: .utf8) else { return }
        web?.evaluateJavaScript("render360NativeEvent('\(type)', \(json))")
    }

    // MARK: Import (Files app / iCloud Drive / AirDrop'd files)

    private func presentPicker() {
        let picker = UIDocumentPickerViewController(forOpeningContentTypes: [.data, .diskImage, .item], asCopy: true)
        picker.allowsMultipleSelection = true
        picker.delegate = self
        web?.window?.rootViewController?.topMost.present(picker, animated: true)
    }

    func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
        reply(pendingImport, ok: true, nil)
        pendingImport = nil
    }

    func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        let id = pendingImport
        pendingImport = nil
        DispatchQueue.global(qos: .userInitiated).async {
            do {
                let entry = try GameLibrary.shared.importFiles(urls)
                let info = try self.inspect(entry)
                DispatchQueue.main.async { self.reply(id, ok: true, info) }
            } catch {
                DispatchQueue.main.async { self.reply(id, ok: false, error.localizedDescription) }
            }
        }
    }

    /// Metadata the web library stores (inspectFile's fields).
    func inspect(_ entry: GameEntry) throws -> [String: Any] {
        guard let disc = entry.discURLs.first else { throw CocoaError(.fileNoSuchFile) }
        var info = R360GameInfo()
        let ok = r360_native_inspect(disc.path, &info)
        func str<T>(_ tuple: T) -> String {
            withUnsafeBytes(of: tuple) { String(cString: $0.bindMemory(to: CChar.self).baseAddress!) }
        }
        var out: [String: Any] = [
            "nativeId": entry.id, "name": ok == 1 ? str(info.name) : entry.title,
            "titleId": info.title_id, "mediaId": info.media_id, "displayType": str(info.display_type),
            "sourceType": str(info.source_type), "sourceName": disc.lastPathComponent,
            "size": entry.totalBytes, "discs": entry.discs.count]
        if ok != 1 { out["inspectionWarning"] = str(info.error) }
        return out
    }

    // MARK: Play

    private func play(id: Int?, body: [String: Any]) {
        guard let nativeId = body["nativeId"] as? String,
              var game = GameLibrary.shared.games.first(where: { $0.id == nativeId }) else {
            reply(id, ok: false, "This game's files are missing from the app. Import it again.")
            return
        }
        if let active = session.game, session.state != .idle {
            if active.id == nativeId {  // returning to the running title
                session.setPaused(false)
                reply(id, ok: true, ["resumed": true])
                return
            }
            reply(id, ok: false, "\(active.title) is still loaded. Close Render360 from the app switcher, then start \(game.title).")
            return
        }
        game.ownedFullLicense = body["fullLicense"] as? Bool ?? game.ownedFullLicense
        Telemetry.shared.emulator = session
        input.attach(session)
        session.start(game: game)
        startTelemetry()
        reply(id, ok: true, ["started": true])
    }

    /// The website HUD's telemetry fields (Render360Runtime.sampleTelemetry).
    private func startTelemetry() {
        telemetryTimer?.invalidate()
        telemetryTimer = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { [weak self] _ in
            guard let self else { return }
            let s = self.session.perf.snapshot()
            let frames = r360_title_gpu_vd_swap_calls()
            if frames != self.lastFrames {
                self.lastFrames = frames
                self.event("framePresented", ["generation": frames, "at": PerfStats.nowMs()])
            }
            self.event("telemetry", [
                "fps": s.gameFps, "frameMs": s.gameFps > 0 ? 1000 / s.gameFps : 0, "realFrame": frames > 0,
                "swaps": frames, "draws": r360_xenos_draws(), "pm4Packets": r360_xenos_packets(),
                "ramBytes": MemoryGuard.footprintMB * 1048576, "workerHz": s.mips,
                "scale": 1, "backend": "METAL", "mips": s.mips, "interpretedPercent": s.interpretedPercent])
            switch self.session.state {
            case .failed(let message):
                self.event("fatalError", ["message": message])
                self.telemetryTimer?.invalidate()
            case .stopped(let boundary):
                self.event("bootStage", ["stage": "blocked", "message": "Title stopped: \(boundary)"])
                self.telemetryTimer?.invalidate()
            default: break
            }
        }
    }
}

private extension UIViewController {
    var topMost: UIViewController { presentedViewController?.topMost ?? self }
}
