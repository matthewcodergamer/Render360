import Foundation

/// Swift port of PerfStats (render360-perf-overlay.mjs) so the phone reports
/// the same numbers as the web overlay and the 30 FPS bar means the same thing:
/// judged on guest frames (VdSwap presents per second), average >= 30 and
/// 1% low >= 25 over the last 60 s, emulation speed >= 100%, at most one frame
/// over 50 ms per minute. Emulation speed is 100% plus the headroom when the
/// guest had idle time; without idle time it is game FPS / 30.
final class PerfStats {
    struct Snapshot: Codable {
        var gameFps: Double = 0
        var gameAverageFps: Double = 0
        var gameLow1Fps: Double = 0
        var stuttersPerMinute: Double = 0
        var emulationSpeedPercent: Double = 0
        var idlePercent: Double = 0
        var mips: Double = 0
        var interpretedPercent: Double = 0
        var presentedFps: Double = 0
        var barAverage = false, barLow1 = false, barSpeed = false, barStutter = false, barPass = false
        var windowSeconds: Double = 0
    }

    private let windowMs: Double
    private var guestFrameTimes: [Double] = []   // ms, one per new guest frame
    private var presentTimes: [Double] = []
    private var counterSamples: [(t: Double, instructions: Double, interpreted: Double, idleMs: Double)] = []
    private var lastSubmitted: UInt32 = 0
    private let lock = NSLock()

    init(windowMs: Double = 60000) { self.windowMs = windowMs }

    static func nowMs() -> Double { Double(DispatchTime.now().uptimeNanoseconds) / 1e6 }

    /// Guest frames submitted so far (cumulative VdSwap count).
    func submitted(_ t: Double, frames: UInt32) {
        lock.lock(); defer { lock.unlock() }
        if frames > lastSubmitted {
            for _ in 0..<min(frames - lastSubmitted, 8) { guestFrameTimes.append(t) }
        }
        lastSubmitted = frames
        trim(t)
    }

    func framePresented(_ t: Double) {
        lock.lock(); defer { lock.unlock() }
        presentTimes.append(t)
        trim(t)
    }

    /// Core counters (cumulative): guest instructions, interpreted instructions, guest idle ms.
    func counters(_ t: Double, instructions: Double, interpreted: Double, idleMs: Double) {
        lock.lock(); defer { lock.unlock() }
        counterSamples.append((t, instructions, interpreted, idleMs))
        trim(t)
    }

    private func trim(_ t: Double) {
        let cutoff = t - windowMs
        if let i = guestFrameTimes.firstIndex(where: { $0 >= cutoff }), i > 0 { guestFrameTimes.removeFirst(i) }
        if let i = presentTimes.firstIndex(where: { $0 >= cutoff }), i > 0 { presentTimes.removeFirst(i) }
        if let i = counterSamples.firstIndex(where: { $0.t >= t - 5000 }), i > 0 { counterSamples.removeFirst(i) }
    }

    func snapshot(_ t: Double = PerfStats.nowMs()) -> Snapshot {
        lock.lock(); defer { lock.unlock() }
        var s = Snapshot()
        let g = guestFrameTimes
        s.gameFps = Double(g.filter { $0 > t - 1000 }.count)
        s.presentedFps = Double(presentTimes.filter { $0 > t - 1000 }.count)
        let span = g.count > 1 ? max(1, t - g[0]) : 0
        s.windowSeconds = span / 1000
        s.gameAverageFps = span > 0 ? Double(g.count - 1) * 1000 / span : s.gameFps
        var deltas: [Double] = []
        if g.count > 1 { for i in 1..<g.count where g[i] > g[i - 1] { deltas.append(g[i] - g[i - 1]) } }
        if !deltas.isEmpty {
            let worst = deltas.sorted(by: >).prefix(max(1, Int(ceil(Double(deltas.count) / 100))))
            s.gameLow1Fps = 1000 / (worst.reduce(0, +) / Double(worst.count))
        }
        let stutters = Double(deltas.filter { $0 > 50 }.count)
        let minutes = max(1.0 / 60, min(windowMs, span > 0 ? span : 1000) / 60000)
        s.stuttersPerMinute = stutters / minutes
        let cs = counterSamples
        if cs.count > 1 {
            let last = cs[cs.count - 1]
            var first = cs.first(where: { $0.t >= t - 1000 }) ?? cs[0]
            if first.t == last.t { first = cs[cs.count - 2] }
            let dt = max(1, last.t - first.t)
            let di = last.instructions - first.instructions
            s.mips = di / dt / 1000
            s.interpretedPercent = di > 0 ? 100 * (last.interpreted - first.interpreted) / di : 0
            s.idlePercent = min(100, 100 * (last.idleMs - first.idleMs) / dt)
        }
        s.emulationSpeedPercent = s.idlePercent > 0 ? 100 / max(0.01, 1 - s.idlePercent / 100)
                                                    : min(100, 100 * s.gameFps / 30)
        s.barAverage = s.gameAverageFps >= 30
        s.barLow1 = s.gameLow1Fps >= 25
        s.barSpeed = s.emulationSpeedPercent >= 100
        s.barStutter = s.stuttersPerMinute <= 1
        s.barPass = s.barAverage && s.barLow1 && s.barSpeed && s.barStutter && span >= 10000
        return s
    }
}
