import Foundation
import Combine
import QuartzCore

/// Latest guest frame (RGBA8), handed from the guest thread to the Metal view.
final class FrameStore {
    private let lock = NSLock()
    private var pixels = [UInt8]()
    private(set) var width = 0, height = 0, generation: UInt64 = 0

    func store(_ src: UnsafeRawPointer, width: Int, height: Int) {
        lock.lock(); defer { lock.unlock() }
        let count = width * height * 4
        if pixels.count != count { pixels = [UInt8](repeating: 0, count: count) }
        pixels.withUnsafeMutableBytes { $0.baseAddress!.copyMemory(from: src, byteCount: count) }
        self.width = width; self.height = height
        generation &+= 1
    }

    /// Runs `body` with the newest frame if it is newer than `since`.
    func withFrame(newerThan since: UInt64, _ body: (UnsafeRawPointer, Int, Int, UInt64) -> Void) {
        lock.lock(); defer { lock.unlock() }
        guard generation != since, width > 0 else { return }
        pixels.withUnsafeBytes { body($0.baseAddress!, width, height, generation) }
    }
}

/// Gamepad state shared between the UI (touch / GameController) and the guest thread.
struct PadState: Equatable {
    var buttons: UInt32 = 0          // XINPUT_GAMEPAD_* bits
    var leftTrigger: UInt8 = 0, rightTrigger: UInt8 = 0
    var lx: Float = 0, ly: Float = 0, rx: Float = 0, ry: Float = 0
}

/// One running title. The core runs on its own threads; this object only
/// starts it and reacts in the host slices (frames, input, stats, stop).
final class EmulatorSession: ObservableObject {
    enum State: Equatable { case idle, booting, running, stopped(String), failed(String) }

    @Published private(set) var state: State = .idle
    @Published private(set) var stats = PerfStats.Snapshot()
    @Published var dialog: GuestDialog?
    // The website's boot card: hidden at the first guest frame.
    @Published private(set) var firstFrame = false
    @Published private(set) var bootMessage = "Preparing Xbox 360 runtime…"
    @Published private(set) var bootStage = "LAUNCH"

    let frames = FrameStore()
    let perf = PerfStats()
    private(set) var game: GameEntry?
    private var stopRequested = false
    private var padLock = NSLock()
    private var pad = PadState()
    private var lastSentPad = PadState(buttons: .max)
    private var lastFrames: UInt32 = 0
    private var dialogAnswer: Int?
    private var statsTimer: Timer?
    private(set) var bootResult = R360BootResult()
    var memory: MemoryGuard?
    /// Metal layer of the GPU renderer (GPUFrameView); nil: software frames.
    var gpuLayer: CAMetalLayer?
    @Published private(set) var renderer = "starting"
    private var useGPU = false
    private var drawableLock = NSLock()
    private var drawable = (w: UInt32(0), h: UInt32(0))
    private var lastPresent = 0.0

    func setDrawableSize(_ size: CGSize) {
        drawableLock.lock(); drawable = (UInt32(size.width), UInt32(size.height)); drawableLock.unlock()
    }

    struct GuestDialog: Identifiable {
        let id = UUID()
        let title: String, text: String
        let buttons: [String]
        let focused: Int
    }

    func setPad(_ newPad: PadState) {
        padLock.lock(); pad = newPad; padLock.unlock()
    }

    func answerDialog(_ button: Int) {
        padLock.lock(); dialogAnswer = button; padLock.unlock()
        dialog = nil
    }

    func stop() { stopRequested = true; setPaused(false) }

    /// Pause holds the guest thread at its next host slice (the website's Pause).
    private let pauseCondition = NSCondition()
    private var paused = false
    func setPaused(_ on: Bool) {
        pauseCondition.lock(); paused = on; pauseCondition.broadcast(); pauseCondition.unlock()
    }

    /// The core holds one title per process (a stopped run leaves parked
    /// guest threads), so boot exactly once even if the view appears twice.
    private static var booted = false

    func start(game: GameEntry) {
        guard state == .idle, !Self.booted else { return }
        Self.booted = true
        self.game = game
        state = .booting
        Breadcrumbs.shared.log("boot \(game.title) discs=\(game.discs.count)")
        let thread = Thread { [weak self] in self?.runCore(game) }
        thread.name = "r360-boot"
        thread.stackSize = 16 << 20
        thread.qualityOfService = .userInteractive
        thread.start()
        statsTimer = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] _ in
            guard let self else { return }
            self.stats = self.perf.snapshot()
            let frames = r360_title_gpu_vd_swap_calls(), draws = r360_xenos_draws()
            if frames > 0 && draws > 0 { self.firstFrame = true }
            let threads = r360_fiber_count() > 0 ? r360_fiber_count() - 1 : 0
            self.bootMessage = String(format: "Running · %u frames presented (%.1f/s) · %u GPU draws · %u guest threads · %.0f MIPS",
                                      frames, self.stats.gameFps, draws, threads, self.stats.mips)
            self.bootStage = "EXECUTE"
        }
    }

    private func runCore(_ game: GameEntry) {
        // GPU renderer when the view's layer exists (wait briefly for layout).
        for _ in 0..<40 where gpuLayer == nil { Thread.sleep(forTimeInterval: 0.05) }
        if let layer = gpuLayer, UserDefaults.standard.object(forKey: "r360.softwareRenderer") as? Bool != true {
            useGPU = r360_gpu_backend_start(Unmanaged.passUnretained(layer).toOpaque()) == 1
            let why = useGPU ? "" : String(cString: r360_gpu_backend_error())
            Breadcrumbs.shared.log("renderer \(useGPU ? "gpu (wgpu/Metal)" : "software: \(why)")")
        }
        DispatchQueue.main.async { self.renderer = self.useGPU ? "Metal GPU" : "software" }
        let paths = game.discURLs.map { $0.path }
        var cStrings = paths.map { strdup($0) }
        defer { cStrings.forEach { free($0) } }
        var result = R360BootResult()
        let ok: UInt32 = cStrings.withUnsafeMutableBufferPointer { buf -> UInt32 in
            var options = R360BootOptions()
            options.path = UnsafePointer(buf[0])
            let discs = buf.map { UnsafePointer<CChar>($0) }
            return discs.withUnsafeBufferPointer { dbuf -> UInt32 in
                options.discs = UnsafePointer(dbuf.baseAddress.map { UnsafeRawPointer($0).assumingMemoryBound(to: UnsafePointer<CChar>?.self) })
                options.disc_count = UInt32(discs.count)
                options.license_full = game.ownedFullLicense ? 1 : 0
                options.dialog_button = -1
                options.slice_ms = 20
                options.on_slice = { user in
                    Unmanaged<EmulatorSession>.fromOpaque(user!).takeUnretainedValue().onSlice()
                }
                options.user = Unmanaged.passUnretained(self).toOpaque()
                // Host answers for XamShowMessageBoxUI (the player picks).
                r360_xam_dialog_set_host_answers(1)
                DispatchQueue.main.async { self.state = .running }
                return r360_native_boot(&options, &result)
            }
        }
        bootResult = result
        let boundary = withUnsafeBytes(of: result.runtime_boundary) { String(cString: $0.bindMemory(to: CChar.self).baseAddress!) }
        let error = withUnsafeBytes(of: result.error) { String(cString: $0.bindMemory(to: CChar.self).baseAddress!) }
        Breadcrumbs.shared.log("run ended ok=\(ok) boundary=\(boundary) error=\(error)")
        DispatchQueue.main.async {
            self.statsTimer?.invalidate()
            self.state = ok == 1 ? .stopped(boundary) : .failed(error)
        }
    }

    /// Called on the running guest thread about every 20 ms of host time.
    private func onSlice() -> UInt32 {
        let t = PerfStats.nowMs()
        // Frames: decode the VdSwap frontbuffer (as render360-title-frontbuffer.mjs).
        let swaps = r360_title_gpu_vd_swap_calls()
        perf.submitted(t, frames: swaps)
        if useGPU {
            // Replay every slice; present new guest frames at most 30 per second.
            let due = swaps != lastFrames && t - lastPresent >= 33
            drawableLock.lock(); let d = drawable; drawableLock.unlock()
            if r360_gpu_backend_frame(due ? 1 : 0, d.w, d.h) == 1, due {
                lastFrames = swaps; lastPresent = t
                perf.framePresented(t)
            }
        } else if swaps != lastFrames {
            lastFrames = swaps
            if r360_xenos_frontbuffer_snapshot_capture() == 1,
               let ptr = UnsafeRawPointer(bitPattern: r360_xenos_frontbuffer_snapshot_buffer()) {
                let w = Int(r360_xenos_frontbuffer_snapshot_width()), h = Int(r360_xenos_frontbuffer_snapshot_height())
                if w > 0, h > 0, Int(r360_xenos_frontbuffer_snapshot_size()) == w * h * 4 {
                    frames.store(ptr, width: w, height: h)
                }
            }
        }
        perf.counters(t, instructions: r360_perf_counter(0), interpreted: r360_perf_counter(1), idleMs: r360_fiber_idle_ms())
        // Input: XInput state for user 0.
        padLock.lock(); let p = pad; let answer = dialogAnswer; dialogAnswer = nil; padLock.unlock()
        if p != lastSentPad {
            lastSentPad = p
            func axis(_ v: Float) -> UInt32 { UInt32(bitPattern: Int32(max(-32768, min(32767, (v * 32767).rounded())))) & 0xFFFF }
            let left = axis(p.lx) | (axis(p.ly) << 16), right = axis(p.rx) | (axis(p.ry) << 16)
            let triggers = UInt32(p.leftTrigger) | (UInt32(p.rightTrigger) << 8)
            r360_input_set_gamepad(0, 1, p.buttons, triggers, left, right)
        }
        // System message boxes.
        if let answer { r360_xam_dialog_answer(UInt32(answer)) }
        if r360_xam_dialog_pending() != 0, dialog == nil {
            func str(_ w: UInt32) -> String {
                guard let ptr = UnsafeRawPointer(bitPattern: r360_xam_dialog_string_ptr(w)) else { return "" }
                return String(decoding: UnsafeRawBufferPointer(start: ptr, count: Int(r360_xam_dialog_string_len(w))), as: UTF8.self)
            }
            let count = r360_xam_dialog_button_count()
            let d = GuestDialog(title: str(0), text: str(1), buttons: (0..<count).map { str(2 + $0) },
                                focused: Int(r360_xam_dialog_active_button()))
            DispatchQueue.main.async { if self.dialog == nil { self.dialog = d } }
        }
        memory?.check()
        pauseCondition.lock()
        while paused && !stopRequested { pauseCondition.wait() }
        pauseCondition.unlock()
        return stopRequested ? 1 : 0
    }
}
