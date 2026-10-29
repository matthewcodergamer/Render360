import SwiftUI
import UniformTypeIdentifiers

@main
struct Render360App: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) var delegate
    @StateObject private var library = GameLibrary.shared
    @StateObject private var input = InputHub()

    var body: some Scene {
        WindowGroup {
            NativeShell()
                .environmentObject(library)
                .environmentObject(input)
                .preferredColorScheme(.dark)
                // AirDrop / "Open in Render360" / Files "Share" deliveries.
                .onOpenURL { url in
                    _ = try? library.importFiles([url])
                }
        }
    }
}

final class AppDelegate: NSObject, UIApplicationDelegate {
    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        Breadcrumbs.shared.startSession()
        UIDevice.current.isBatteryMonitoringEnabled = true
        // JIT is only usable when the process may map executable memory
        // (sideloaded build + StikDebug). The core is interpreter-only today;
        // the result is reported in telemetry and Settings.
        Breadcrumbs.shared.log("jit probe start")
        Breadcrumbs.shared.log("jit available=\(r360_native_jit_available())")
        Breadcrumbs.shared.log(String(format: "flat guest reserve: %.2f GiB", Double(r360_platform_probe_flat_reserve()) / 1073741824))
        Telemetry.shared.start()
        if Breadcrumbs.shared.previousRunCrashed { Telemetry.shared.sendCrashReport(Breadcrumbs.shared.previousTail) }
        return true
    }
    func applicationWillTerminate(_ application: UIApplication) { Breadcrumbs.shared.endSession() }
}

struct GameRow: View {
    let game: GameEntry
    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(game.title).font(.headline)
            Text("\(game.discs.count) disc\(game.discs.count == 1 ? "" : "s") · \(ByteCountFormatter.string(fromByteCount: game.totalBytes, countStyle: .file))\(game.ownedFullLicense ? " · full license" : "")")
                .font(.caption).foregroundStyle(.secondary)
        }
    }
}

struct ImportView: View {
    @EnvironmentObject var library: GameLibrary
    @Environment(\.dismiss) private var dismiss
    @StateObject private var mac = MacImporter()
    @State private var picking = false
    @State private var addDiscsTo: GameEntry?
    @State private var message = ""

    var body: some View {
        NavigationStack {
            Form {
                Section("From the Files app") {
                    Button("Choose files…") { addDiscsTo = nil; picking = true }
                    Text("Pick every disc of a multi-disc game together (for example Watch Dogs disc 1 and 2); they become one game.")
                        .font(.caption).foregroundStyle(.secondary)
                    if !library.games.isEmpty {
                        Menu("Add a disc to an existing game") {
                            ForEach(library.games) { g in Button(g.title) { addDiscsTo = g; picking = true } }
                        }
                    }
                }
                Section("AirDrop") {
                    Text("AirDrop the file from your Mac and choose Render360 in the share sheet.").font(.caption).foregroundStyle(.secondary)
                }
                Section("From my Mac (Wi-Fi)") {
                    TextField("http://mac-address:8360", text: $mac.serverURL)
                        .keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
                    TextField("Token (optional)", text: $mac.token).textInputAutocapitalization(.never).autocorrectionDisabled()
                    Button("Show games on the Mac") { mac.refresh() }.disabled(mac.busy)
                    if !mac.status.isEmpty { Text(mac.status).font(.caption) }
                    if mac.busy { ProgressView(value: mac.progress); Button("Pause", role: .cancel) { mac.cancel() } }
                    ForEach(mac.games) { g in
                        Button { mac.download(g, into: library) } label: {
                            VStack(alignment: .leading) {
                                Text(g.title)
                                Text("\(g.discs.count) disc(s) · \(ByteCountFormatter.string(fromByteCount: g.totalBytes, countStyle: .file))")
                                    .font(.caption).foregroundStyle(.secondary)
                            }
                        }.disabled(mac.busy)
                    }
                }
                if !message.isEmpty { Section { Text(message) } }
                Section {
                    Text("Only import games you dumped from your own discs or console. Files stay on this iPhone and are excluded from iCloud backup.")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
            .navigationTitle("Import game")
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            .fileImporter(isPresented: $picking, allowedContentTypes: [.data, .diskImage, .item], allowsMultipleSelection: true) { result in
                do {
                    let urls = try result.get()
                    let entry = try library.importFiles(urls, addTo: addDiscsTo)
                    message = "Imported \(entry.title) (\(entry.discs.count) disc\(entry.discs.count == 1 ? "" : "s"))"
                } catch {
                    message = "Import failed: \(error.localizedDescription)"
                }
            }
        }
    }
}

struct PlayView: View {
    let game: GameEntry
    @EnvironmentObject var input: InputHub
    @StateObject private var session = EmulatorSession()
    @Environment(\.dismiss) private var dismiss
    @State private var showOverlay = true
    @State private var memoryWarning: Double?
    private let memory = MemoryGuard()

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()
            MetalFrameView(frames: session.frames, perf: session.perf).ignoresSafeArea()
            GPUFrameView(session: session).ignoresSafeArea().opacity(session.renderer == "software" ? 0 : 1)
            TouchControls(input: input).ignoresSafeArea()
            VStack {
                HStack(alignment: .top) {
                    if showOverlay { PerfOverlay(stats: session.stats, renderer: session.renderer, state: session.state, memory: memory) }
                    Spacer()
                    Button { showOverlay.toggle() } label: { Image(systemName: "speedometer") }.padding(6)
                    Button {
                        session.stop()
                        // Guest threads of a stopped run cannot be unwound; the
                        // app exits to release them (next launch starts clean).
                        Breadcrumbs.shared.endSession()
                        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { exit(0) }
                    } label: { Image(systemName: "xmark.circle.fill").font(.title2) }.padding(6)
                }
                Spacer()
            }
            .padding(8)
            if case .failed(let message) = session.state {
                Text("Could not start: \(message)").padding().background(.red.opacity(0.8), in: RoundedRectangle(cornerRadius: 10))
                    .onTapGesture { dismiss() }
            }
        }
        .statusBarHidden()
        .persistentSystemOverlays(.hidden)
        .alert(session.dialog?.title ?? "", isPresented: Binding(get: { session.dialog != nil }, set: { _ in })) {
            ForEach(Array((session.dialog?.buttons ?? []).enumerated()), id: \.offset) { i, label in
                Button(label) { session.answerDialog(i) }
            }
        } message: { Text(session.dialog?.text ?? "") }
        .onAppear {
            UIApplication.shared.isIdleTimerDisabled = true
            memory.onPressure = { mb in DispatchQueue.main.async { memoryWarning = mb } }
            session.memory = memory
            Telemetry.shared.emulator = session
            Telemetry.shared.memory = memory
            input.attach(session)
            session.start(game: game)
        }
        .onDisappear { input.detach(); UIApplication.shared.isIdleTimerDisabled = false }
    }
}

struct PerfOverlay: View {
    let stats: PerfStats.Snapshot
    var renderer = ""
    let state: EmulatorSession.State
    let memory: MemoryGuard
    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(String(format: "Game FPS %.0f  avg %.1f  1%% low %.1f  stutters %.1f/min", stats.gameFps, stats.gameAverageFps, stats.gameLow1Fps, stats.stuttersPerMinute))
            Text(String(format: "Emulation speed %.0f%%  idle %.0f%%  %.0f MIPS  interpreted %.1f%%", stats.emulationSpeedPercent, stats.idlePercent, stats.mips, stats.interpretedPercent))
            Text(String(format: "Memory %.0f MB used · %.0f MB free (lowest %.0f)", MemoryGuard.footprintMB, MemoryGuard.availableMB,
                        memory.lowestAvailableMB.isFinite ? memory.lowestAvailableMB : MemoryGuard.availableMB))
            Text(String(format: "Guest %.0fM instructions · %.0f frames%@", Double(r360_hir_total_instructions_millions()),
                        Double(r360_title_gpu_vd_swap_calls()), r360_title_gpu_vd_swap_calls() == 0 ? " · booting (first frame takes a few minutes)" : ""))
            Text("Renderer: \(renderer)")
            Text("30 FPS bar: \(stats.barPass ? "PASS" : "not met") · \(stateText) · thermal \(["nominal", "fair", "serious", "critical"][min(3, ProcessInfo.processInfo.thermalState.rawValue)])")
        }
        .font(.system(size: 11, design: .monospaced))
        .foregroundStyle(.white)
        .padding(6)
        .background(.black.opacity(0.6), in: RoundedRectangle(cornerRadius: 6))
    }
    private var stateText: String {
        switch state {
        case .idle: return "idle"
        case .booting: return "booting"
        case .running: return "running (interpreter)"
        case .stopped(let b): return "stopped: \(b)"
        case .failed: return "failed"
        }
    }
}

struct SettingsView: View {
    @Environment(\.dismiss) private var dismiss
    @State private var telemetry = UserDefaults.standard.string(forKey: "r360.telemetryServer") ?? ""
    var body: some View {
        NavigationStack {
            Form {
                Section("Telemetry to the Mac") {
                    TextField("http://mac-address:8361", text: $telemetry)
                        .keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
                        .onSubmit { UserDefaults.standard.set(telemetry, forKey: "r360.telemetryServer") }
                    Text("Run tools/telemetry-server.py on the Mac, then open /status there.").font(.caption).foregroundStyle(.secondary)
                }
                Section("This build") {
                    LabeledContent("Signing expires", value: SigningInfo.expiry.map { $0.formatted(date: .abbreviated, time: .shortened) } ?? "unknown")
                    LabeledContent("JIT", value: r360_native_jit_available() == 1 ? "available (not used yet)" : "not available — interpreter")
                    LabeledContent("Free memory", value: String(format: "%.0f MB", MemoryGuard.availableMB))
                }
                Section("Diagnostics") {
                    ShareLink(item: Breadcrumbs.shared.file) { Label("Share breadcrumbs", systemImage: "square.and.arrow.up") }
                }
            }
            .navigationTitle("Settings")
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") {
                UserDefaults.standard.set(telemetry, forKey: "r360.telemetryServer"); dismiss()
            } } }
        }
    }
}
