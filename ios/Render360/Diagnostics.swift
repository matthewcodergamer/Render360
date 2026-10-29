import Foundation
import UIKit

/// Crash breadcrumbs: Documents/Diagnostics/breadcrumbs.log, one fsynced line
/// per event, so the last lines survive a crash or a jetsam kill (which
/// writes no crash report for the app). running.flag marks a live session; if
/// it is still there at the next launch, the previous run did not end cleanly.
final class Breadcrumbs {
    static let shared = Breadcrumbs()
    let folder: URL
    let file: URL
    private let flag: URL
    private(set) var previousRunCrashed = false
    private(set) var previousTail: [String] = []

    init() {
        folder = GameLibrary.documents.appendingPathComponent("Diagnostics", isDirectory: true)
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        file = folder.appendingPathComponent("breadcrumbs.log")
        flag = folder.appendingPathComponent("running.flag")
    }

    func startSession() {
        let fm = FileManager.default
        previousRunCrashed = fm.fileExists(atPath: flag.path)
        if let text = try? String(contentsOf: file) {
            previousTail = Array(text.split(separator: "\n").suffix(40).map(String.init))
            // Keep the log bounded: last ~2000 lines.
            let lines = text.split(separator: "\n")
            if lines.count > 4000 { try? lines.suffix(2000).joined(separator: "\n").appending("\n").write(to: file, atomically: true, encoding: .utf8) }
        }
        try? Data().write(to: flag)
        r360_breadcrumb_open(file.path)
        r360_install_crash_handlers()
        log("launch \(Bundle.main.bundleIdentifier ?? "") \(UIDevice.current.model) iOS \(UIDevice.current.systemVersion) previousCrashed=\(previousRunCrashed)")
    }

    func endSession() {
        log("clean exit")
        try? FileManager.default.removeItem(at: flag)
    }

    func log(_ line: String) { r360_breadcrumb(line) }
}

/// Watches os_proc_available_memory() and logs/acts before iOS kills the app.
/// The interpreter-only core has no large GPU caches yet; its big consumer is
/// the HIR translation cache, which the core already bounds. Under pressure
/// the guard records breadcrumbs (so a jetsam kill is attributed) and tells
/// the UI; the lowest free memory of a run is kept for telemetry.
final class MemoryGuard {
    private(set) var lowestAvailableMB: Double = .infinity
    private var lastWarnMB = Double.infinity
    private var lastCheck = 0.0
    var onPressure: ((Double) -> Void)?

    static var availableMB: Double { Double(r360_platform_available_memory()) / 1048576 }
    static var footprintMB: Double { Double(r360_platform_footprint()) / 1048576 }

    func check() {
        let t = PerfStats.nowMs()
        guard t - lastCheck > 250 else { return }
        lastCheck = t
        let avail = Self.availableMB
        lowestAvailableMB = min(lowestAvailableMB, avail)
        // Same thresholds as the GTA V port's phone budget: act below 240 MB free.
        if avail < 240, avail < lastWarnMB - 32 {
            lastWarnMB = avail
            Breadcrumbs.shared.log(String(format: "memory low: %.0f MB free, footprint %.0f MB", avail, Self.footprintMB))
            onPressure?(avail)
        } else if avail > lastWarnMB + 96 {
            lastWarnMB = .infinity
        }
    }
}

/// Free Apple ID builds expire after 7 days: read the expiry from
/// embedded.mobileprovision to show the days left.
enum SigningInfo {
    static var expiry: Date? {
        guard let url = Bundle.main.url(forResource: "embedded", withExtension: "mobileprovision"),
              let data = try? Data(contentsOf: url) else { return nil }
        // The profile is CMS-signed; the plist sits in it as plain XML.
        let text = String(decoding: data, as: UTF8.self)
        guard let start = text.range(of: "<?xml"), let end = text.range(of: "</plist>") else { return nil }
        let xml = Data(text[start.lowerBound..<end.upperBound].utf8)
        guard let plist = try? PropertyListSerialization.propertyList(from: xml, format: nil) as? [String: Any] else { return nil }
        return plist["ExpirationDate"] as? Date
    }

    static var daysLeft: Int? {
        guard let expiry else { return nil }
        return Calendar.current.dateComponents([.day], from: Date(), to: expiry).day
    }
}

/// Wireless telemetry, as in the GTA V port: the phone POSTs one JSON line per
/// second to the Mac (tools/telemetry-server.py), which serves /status. The
/// line is also appended to Documents/Diagnostics/telemetry.jsonl for runs
/// without the Mac.
final class Telemetry {
    static let shared = Telemetry()
    var macURL: String { UserDefaults.standard.string(forKey: "r360.telemetryServer") ?? "" }
    private var timer: DispatchSourceTimer?
    private let queue = DispatchQueue(label: "r360.telemetry")
    private let sessionID = String(UUID().uuidString.prefix(8))
    private var log: FileHandle?
    weak var emulator: EmulatorSession?
    var memory: MemoryGuard?

    func start() {
        let url = Breadcrumbs.shared.folder.appendingPathComponent("telemetry.jsonl")
        if !FileManager.default.fileExists(atPath: url.path) { FileManager.default.createFile(atPath: url.path, contents: nil) }
        log = try? FileHandle(forWritingTo: url)
        _ = try? log?.seekToEnd()
        let t = DispatchSource.makeTimerSource(queue: queue)
        t.schedule(deadline: .now() + 1, repeating: 1)
        t.setEventHandler { [weak self] in self?.tick() }
        t.resume()
        timer = t
    }

    func status() -> [String: Any] {
        let s = emulator?.perf.snapshot() ?? PerfStats.Snapshot()
        let thermal = ["nominal", "fair", "serious", "critical"][min(3, ProcessInfo.processInfo.thermalState.rawValue)]
        var game = "", state = "idle"
        if let e = emulator {
            game = e.game?.title ?? ""
            switch e.state {
            case .idle: state = "idle"
            case .booting: state = "booting"
            case .running: state = "running"
            case .stopped(let b): state = "stopped: \(b)"
            case .failed(let m): state = "failed: \(m)"
            }
        }
        return [
            "session": sessionID, "time": Date().timeIntervalSince1970, "device": "iPhone 11",
            "game": game, "state": state,
            "fps": s.gameFps, "fpsAvg": s.gameAverageFps, "low1": s.gameLow1Fps, "presentedFps": s.presentedFps,
            "stuttersPerMin": s.stuttersPerMinute, "speedPercent": s.emulationSpeedPercent, "idlePercent": s.idlePercent,
            "mips": s.mips, "interpretedPercent": s.interpretedPercent, "bar30": s.barPass,
            "guestInstructionsM": Double(r360_hir_total_instructions_millions()), "guestFrames": Double(r360_title_gpu_vd_swap_calls()),
            "memFootprintMB": MemoryGuard.footprintMB, "memAvailableMB": MemoryGuard.availableMB,
            "memLowestAvailableMB": memory?.lowestAvailableMB.isFinite == true ? memory!.lowestAvailableMB : MemoryGuard.availableMB,
            "thermal": thermal, "battery": Double(UIDevice.current.batteryLevel),
            "jit": r360_native_jit_available() == 1, "signingDaysLeft": SigningInfo.daysLeft ?? -1,
        ]
    }

    private func tick() {
        guard let data = try? JSONSerialization.data(withJSONObject: status()) else { return }
        log?.write(data); log?.write(Data("\n".utf8))
        guard !macURL.isEmpty, var comps = URLComponents(string: macURL + "/telemetry") else { return }
        comps.queryItems = [URLQueryItem(name: "s", value: sessionID)]
        guard let url = comps.url else { return }
        var r = URLRequest(url: url, timeoutInterval: 2)
        r.httpMethod = "POST"
        r.setValue("application/json", forHTTPHeaderField: "Content-Type")
        r.httpBody = data
        URLSession.shared.dataTask(with: r).resume()
    }

    /// Sends the previous run's breadcrumbs to the Mac (after a crash).
    func sendCrashReport(_ lines: [String]) {
        guard !macURL.isEmpty, let url = URL(string: macURL + "/crash?s=\(sessionID)") else { return }
        var r = URLRequest(url: url, timeoutInterval: 5)
        r.httpMethod = "POST"
        r.httpBody = Data(lines.joined(separator: "\n").utf8)
        URLSession.shared.dataTask(with: r).resume()
    }
}
