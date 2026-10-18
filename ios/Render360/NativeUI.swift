import SwiftUI
import UniformTypeIdentifiers

// Native SwiftUI recreation of the Render360 website's screens (index.html,
// styles/base.css, styles/controller.css): library, game details, the boot
// card and the in-game touch controller + HUD, same layout and colors.

extension Color {
    init(hex: UInt32, alpha: Double = 1) {
        self.init(.sRGB, red: Double((hex >> 16) & 0xFF) / 255, green: Double((hex >> 8) & 0xFF) / 255,
                  blue: Double(hex & 0xFF) / 255, opacity: alpha)
    }
    static let r360Group = Color(hex: 0x1C1C1E)
    static let r360Separator = Color(hex: 0x38383A)
    static let r360Secondary = Color(hex: 0x8E8E93)
    static let r360Blue = Color(hex: 0x0A84FF)
    static let r360Green = Color(hex: 0x30D158)
}

func hex8(_ v: UInt32?) -> String { v.map { String(format: "%08X", $0) } ?? "Unknown" }

// MARK: - Box art (library/cover-resolver.js: x360db by title id)

final class CoverStore: ObservableObject {
    static let shared = CoverStore()
    @Published private(set) var images: [UInt32: UIImage] = [:]
    private var loading = Set<UInt32>()
    private let folder = GameLibrary.documents.appendingPathComponent("Covers", isDirectory: true)

    func image(for titleId: UInt32?) -> UIImage? {
        guard let id = titleId, id != 0 else { return nil }
        if let image = images[id] { return image }
        let file = folder.appendingPathComponent(String(format: "%08X.jpg", id))
        if let image = UIImage(contentsOfFile: file.path) {
            DispatchQueue.main.async { self.images[id] = image }
            return image
        }
        guard !loading.contains(id) else { return nil }
        loading.insert(id)
        let url = URL(string: String(format: "https://raw.githubusercontent.com/xenia-manager/x360db/main/titles/%08X/artwork/boxart.jpg", id))!
        URLSession.shared.dataTask(with: url) { data, response, _ in
            guard let data, (response as? HTTPURLResponse)?.statusCode == 200, let image = UIImage(data: data) else { return }
            try? FileManager.default.createDirectory(at: self.folder, withIntermediateDirectories: true)
            try? data.write(to: file)
            DispatchQueue.main.async { self.images[id] = image }
        }.resume()
        return nil
    }
}

struct CoverView: View {
    let game: GameEntry
    @ObservedObject var covers = CoverStore.shared
    var body: some View {
        ZStack {
            if let image = covers.image(for: game.titleId) {
                Image(uiImage: image).resizable().aspectRatio(contentMode: .fill)
            } else {
                LinearGradient(colors: [Color(hex: 0x2C2C2E), Color(hex: 0x1C1C1E)], startPoint: .top, endPoint: .bottom)
                    .overlay(Text(game.title).font(.system(size: 15, weight: .semibold)).foregroundStyle(.white.opacity(0.8))
                        .multilineTextAlignment(.center).padding(10))
            }
        }
        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
    }
}

// MARK: - App shell

struct NativeShell: View {
    @EnvironmentObject var library: GameLibrary
    @EnvironmentObject var input: InputHub
    @StateObject private var session = EmulatorSession()
    @State private var selected: GameEntry?
    @State private var playing: GameEntry?
    private let memory = MemoryGuard()

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()
            if let game = playing {
                PlayScreen(game: game, session: session, onPause: { playing = nil })
            } else if let game = selected {
                DetailScreen(game: game, onBack: { selected = nil }, onPlay: { play(game) })
            } else {
                LibraryScreen(onOpen: { selected = $0 })
            }
        }
        .preferredColorScheme(.dark)
        // iOS kills apps that keep the CPU busy in the background: pause the
        // guest while Render360 is not in the foreground.
        .onReceive(NotificationCenter.default.publisher(for: UIApplication.didEnterBackgroundNotification)) { _ in
            Breadcrumbs.shared.log("background: paused")
            session.setPaused(true)
        }
        .onReceive(NotificationCenter.default.publisher(for: UIApplication.willEnterForegroundNotification)) { _ in
            Breadcrumbs.shared.log("foreground")
            if playing != nil { session.setPaused(false) }
        }
        .onAppear {
            session.memory = memory
            Telemetry.shared.emulator = session
            Telemetry.shared.memory = memory
            DispatchQueue.global(qos: .utility).async { GameLibrary.shared.inspectIfNeeded() }
            if let url = ProcessInfo.processInfo.environment["R360_TELEMETRY"] {
                UserDefaults.standard.set(url, forKey: "r360.telemetryServer")
            }
            if let id = ProcessInfo.processInfo.environment["R360_AUTOPLAY"],
               let game = library.games.first(where: { $0.id == id }) { play(game) }
        }
    }

    private func play(_ game: GameEntry) {
        if let active = session.game, active.id != game.id {
            // One title per process (a stopped run's guest threads stay parked).
            selected = game
            return
        }
        UIApplication.shared.isIdleTimerDisabled = true
        input.attach(session)
        if session.state == .idle { session.start(game: game) } else { session.setPaused(false) }
        playing = game
    }
}

// MARK: - Library (website #libraryView)

struct LibraryScreen: View {
    @EnvironmentObject var library: GameLibrary
    let onOpen: (GameEntry) -> Void
    @State private var search = ""
    @State private var importing = false
    @State private var macImport = false
    @State private var importChoice = false
    @State private var message: String?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                HStack(alignment: .top) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Render360").font(.system(size: 34, weight: .bold))
                        HStack(spacing: 6) {
                            Circle().fill(Color.r360Green).frame(width: 9, height: 9)
                            Text("Emulator ready · Core build 75").font(.system(size: 15)).foregroundStyle(Color.r360Secondary)
                        }
                    }
                    Spacer()
                    Image(systemName: "gearshape").font(.system(size: 26)).foregroundStyle(Color.r360Secondary).padding(.trailing, 14)
                    Image(systemName: "person.crop.circle").font(.system(size: 28)).foregroundStyle(Color.r360Secondary)
                }
                .padding(.top, 18)
                HStack {
                    Text("Library").font(.system(size: 40, weight: .bold))
                    Spacer()
                    Button { macImport = true } label: {
                        ZStack(alignment: .bottomTrailing) {
                            Image(systemName: "display").font(.system(size: 24)).foregroundStyle(Color.r360Blue)
                            Text("MAC").font(.system(size: 9, weight: .heavy)).foregroundStyle(.white)
                                .padding(.horizontal, 5).padding(.vertical, 2)
                                .background(Color.r360Blue, in: Capsule()).offset(x: 10, y: 6)
                        }
                    }
                    .padding(.trailing, 26)
                    Button { importing = true } label: {
                        Image(systemName: "plus").font(.system(size: 30, weight: .regular)).foregroundStyle(Color.r360Blue)
                    }
                }
                .padding(.top, 36)
                HStack(spacing: 8) {
                    Image(systemName: "magnifyingglass").foregroundStyle(Color.r360Secondary)
                    TextField("Search Games", text: $search).font(.system(size: 18))
                }
                .padding(.horizontal, 14).frame(height: 44)
                .background(Color.r360Group, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                .padding(.top, 22)
                let games = library.games.filter { search.isEmpty || $0.title.localizedCaseInsensitiveContains(search) }
                if games.isEmpty {
                    VStack(spacing: 8) {
                        Text("No games yet").font(.system(size: 20, weight: .semibold))
                        Text("Tap + to add your own dumped game (ISO, XEX, CON, LIVE or PIRS).")
                            .font(.system(size: 15)).foregroundStyle(Color.r360Secondary).multilineTextAlignment(.center)
                    }
                    .frame(maxWidth: .infinity).padding(.top, 80)
                }
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 138, maximum: 180), spacing: 16, alignment: .top)],
                          alignment: .leading, spacing: 22) {
                    ForEach(games) { game in
                        Button { onOpen(game) } label: {
                            VStack(alignment: .leading, spacing: 6) {
                                CoverView(game: game).aspectRatio(0.7, contentMode: .fit)
                                Text(game.title).font(.system(size: 17, weight: .semibold)).foregroundStyle(.white).lineLimit(1)
                                HStack(spacing: 6) {
                                    Circle().fill(Color.r360Green).frame(width: 8, height: 8)
                                    Text("Ready · \(game.contentType ?? "GAME")").font(.system(size: 14)).foregroundStyle(Color.r360Secondary)
                                }
                            }
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(.top, 24)
                if let message { Text(message).font(.footnote).foregroundStyle(Color.r360Secondary).padding(.top, 16) }
            }
            .padding(.horizontal, 16)
        }
        .scrollDismissesKeyboard(.immediately)
        .fileImporter(isPresented: $importing, allowedContentTypes: [.data, .diskImage, .item], allowsMultipleSelection: true) { result in
            do {
                let urls = try result.get()
                message = "Importing…"
                DispatchQueue.global(qos: .userInitiated).async {
                    do {
                        let entry = try GameLibrary.shared.importFiles(urls)
                        GameLibrary.shared.inspectIfNeeded()
                        DispatchQueue.main.async { message = "Added \(entry.title)" }
                    } catch {
                        DispatchQueue.main.async { message = "Import failed: \(error.localizedDescription)" }
                    }
                }
            } catch { message = "Import failed: \(error.localizedDescription)" }
        }
        .sheet(isPresented: $macImport) { ImportView().environmentObject(library) }
    }
}

// MARK: - Game details (website #detailView)

struct DetailScreen: View {
    @EnvironmentObject var library: GameLibrary
    let game: GameEntry
    let onBack: () -> Void
    let onPlay: () -> Void
    @State private var confirmDelete = false

    var body: some View {
        let current = library.games.first { $0.id == game.id } ?? game
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                HStack {
                    Button(action: onBack) { Text("‹ Library").font(.system(size: 20)).foregroundStyle(Color.r360Blue) }
                    Spacer()
                    Menu {
                        Toggle("I own the full game", isOn: Binding(get: { current.ownedFullLicense },
                                                                     set: { var g = current; g.ownedFullLicense = $0; library.update(g) }))
                    } label: { Text("Game Settings").font(.system(size: 20)).foregroundStyle(Color.r360Blue) }
                }
                .padding(.top, 12)
                HStack(alignment: .top, spacing: 16) {
                    VStack(spacing: 10) {
                        CoverView(game: current).frame(width: 112, height: 158)
                        Text("Choose Cover").font(.system(size: 15)).foregroundStyle(Color.r360Blue)
                    }
                    VStack(alignment: .leading, spacing: 6) {
                        Text(current.title).font(.system(size: 30, weight: .bold)).lineLimit(2).minimumScaleFactor(0.6)
                        Text("Title ID \(hex8(current.titleId))").font(.system(size: 15)).foregroundStyle(Color.r360Secondary)
                        Text("Media ID \(hex8(current.mediaId))").font(.system(size: 15)).foregroundStyle(Color.r360Secondary)
                        Text("Testing").font(.system(size: 14, weight: .semibold)).foregroundStyle(Color.r360Green)
                            .padding(.horizontal, 11).padding(.vertical, 5)
                            .background(Color.r360Green.opacity(0.14), in: Capsule()).padding(.top, 4)
                        Button(action: onPlay) {
                            Text("Play").font(.system(size: 19, weight: .semibold)).foregroundStyle(.white)
                                .frame(maxWidth: .infinity).frame(height: 56)
                                .background(Color(hex: 0x3478F6), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                        }
                        .padding(.top, 8)
                    }
                }
                .padding(.top, 26)
                GroupTitle("GAME")
                Group {
                    Row("Content", current.contentType ?? "—")
                    Row("Size", ByteCountFormatter.string(fromByteCount: current.totalBytes, countStyle: .file))
                    Row("Source", current.discs.joined(separator: "\n"))
                    Row("Storage", "Render360/Games", last: true)
                }
                .groupStyle()
                GroupTitle("MANAGE")
                VStack(spacing: 0) {
                    Button { confirmDelete = true } label: {
                        HStack { Text("Remove from Library").foregroundStyle(.red); Spacer() }.padding(.horizontal, 16).frame(height: 56)
                    }
                }
                .groupStyle()
            }
            .padding(.horizontal, 16)
        }
        .alert("Remove \(current.title)?", isPresented: $confirmDelete) {
            Button("Remove", role: .destructive) { library.delete(current); onBack() }
            Button("Cancel", role: .cancel) {}
        } message: { Text("The game files are deleted from this iPhone.") }
    }

    private func GroupTitle(_ t: String) -> some View {
        Text(t).font(.system(size: 15)).foregroundStyle(Color.r360Secondary).padding(.leading, 16).padding(.top, 34).padding(.bottom, 8)
    }
    private func Row(_ label: String, _ value: String, last: Bool = false) -> some View {
        VStack(spacing: 0) {
            HStack(alignment: .top) {
                Text(label).font(.system(size: 19))
                Spacer(minLength: 20)
                Text(value).font(.system(size: 19)).foregroundStyle(Color.r360Secondary).multilineTextAlignment(.trailing)
            }
            .padding(.horizontal, 16).padding(.vertical, 16)
            if !last { Rectangle().fill(Color.r360Separator).frame(height: 0.5).padding(.leading, 16) }
        }
    }
}

private extension View {
    func groupStyle() -> some View {
        background(Color.r360Group, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
    }
}

// MARK: - In game (website #runtimeView: boot card, controller layer, HUD)

struct PlayScreen: View {
    let game: GameEntry
    @ObservedObject var session: EmulatorSession
    @EnvironmentObject var input: InputHub
    let onPause: () -> Void
    @State private var pauseSheet = false

    var body: some View {
        GeometryReader { geo in
            ZStack {
                Color.black
                MetalFrameView(frames: session.frames, perf: session.perf)
                    .opacity(session.renderer == "software" ? 1 : 0)
                GPUFrameView(session: session).opacity(session.renderer == "software" ? 0 : 1)
                if !session.firstFrame { BootCard(game: game, session: session) }
                XeniOSControls(size: geo.size, input: input, onPause: { session.setPaused(true); pauseSheet = true })
                    .opacity(input.controllerName == nil ? 1 : 0)
                HUD(session: session).position(x: geo.size.width - (geo.size.width > geo.size.height ? 175 : 125),
                                               y: geo.size.width > geo.size.height ? 60 : 210)
            }
        }
        .ignoresSafeArea()
        .statusBarHidden()
        .persistentSystemOverlays(.hidden)
        .confirmationDialog("Paused", isPresented: $pauseSheet, titleVisibility: .visible) {
            Button("Resume") { session.setPaused(false) }
            Button("Return to Game Details") { onPause() }
        }
        .alert(session.dialog?.title ?? "", isPresented: Binding(get: { session.dialog != nil }, set: { _ in })) {
            ForEach(Array((session.dialog?.buttons ?? []).enumerated()), id: \.offset) { i, label in
                Button(label) { session.answerDialog(i) }
            }
        } message: { Text(session.dialog?.text ?? "") }
    }
}

/// The website's boot card (spinner, title, progress line, stage).
struct BootCard: View {
    let game: GameEntry
    @ObservedObject var session: EmulatorSession
    var body: some View {
        VStack(spacing: 0) {
            ProgressView().progressViewStyle(.circular).tint(.white).scaleEffect(1.4).padding(.bottom, 22)
            Text(game.title).font(.system(size: 18, weight: .bold))
            Text(session.bootMessage).font(.system(size: 12)).foregroundStyle(Color.r360Secondary)
                .multilineTextAlignment(.center).padding(.top, 7).frame(maxWidth: 420)
            Text(session.bootStage).font(.system(size: 10, weight: .semibold, design: .monospaced))
                .foregroundStyle(Color(hex: 0x636366)).padding(.top, 9)
        }
        .padding(24)
    }
}

/// HUD box (website #performanceHud as in the screenshots).
struct HUD: View {
    @ObservedObject var session: EmulatorSession
    var body: some View {
        let s = session.stats
        VStack(alignment: .leading, spacing: 1) {
            HStack { Text("apple").bold(); Spacer(); Text("[Metal]").bold() }
            HStack { Text("1.00x"); Spacer(); Text(session.firstFrame ? "REAL FRAME" : "BOOTING").foregroundStyle(Color(hex: 0xAEAEB2)); Spacer(); Text("30Hz") }
            HStack { Text("FPS:"); Spacer(); Text(String(format: "%.1f", s.gameFps)).bold(); Text(String(format: "%.1f / %.1f", s.gameLow1Fps, s.gameAverageFps)).foregroundStyle(Color(hex: 0x8E8E93)) }
            HStack { Text("Frm:"); Spacer(); Text(s.gameFps > 0 ? String(format: "%.1f ms", 1000 / s.gameFps) : "—").bold(); Text("\(r360_title_gpu_vd_swap_calls()) swaps").foregroundStyle(Color(hex: 0x8E8E93)) }
            HStack { Text("CPU:"); Spacer(); Text(String(format: "%.0f MIPS", s.mips)).foregroundStyle(Color(hex: 0x5AC8FA)); Text("\(r360_xenos_packets()) PM4").foregroundStyle(Color(hex: 0x8E8E93)) }
            HStack { Text("Mem:"); Spacer(); Text(String(format: "%.2f GB", MemoryGuard.footprintMB / 1024)).foregroundStyle(Color(hex: 0x30D158)); Text("\(r360_xenos_draws()) draws").foregroundStyle(Color(hex: 0x8E8E93)) }
        }
        .font(.system(size: 11, design: .monospaced))
        .foregroundStyle(.white)
        .padding(8)
        .frame(width: 240)
        .background(Color.black.opacity(0.82), in: RoundedRectangle(cornerRadius: 6))
        .overlay(RoundedRectangle(cornerRadius: 6).stroke(Color(hex: 0x3A3A3C)))
        .allowsHitTesting(false)
    }
}

/// The website's touch controller: positions from the landscape / portrait
/// screenshots of styles/controller.css, colors from its --x16-* palette.
struct ControllerLayer: View {
    let size: CGSize
    @ObservedObject var input: InputHub
    let onPause: () -> Void
    @State private var held: Set<String> = []
    @State private var stick = CGSize.zero

    private struct Spec { let key: String; let x, y, w, h: CGFloat; let fill, edge: UInt32; let round: Bool }

    private var landscape: Bool { size.width > size.height }

    private var specs: [Spec] {
        // Fractions of the screen (center x, center y, width, height).
        if landscape {
            return [
                Spec(key: "BACK", x: 0.441, y: 0.161, w: 0.068, h: 0.097, fill: 0x1C1C1F, edge: 0x3A3A3E, round: false),
                Spec(key: "START", x: 0.532, y: 0.161, w: 0.073, h: 0.097, fill: 0x1C1C1F, edge: 0x3A3A3E, round: false),
                Spec(key: "LB", x: 0.672, y: 0.169, w: 0.073, h: 0.097, fill: 0x151B26, edge: 0x2B3550, round: false),
                Spec(key: "RB", x: 0.761, y: 0.169, w: 0.073, h: 0.097, fill: 0x151B26, edge: 0x2B3550, round: false),
                Spec(key: "LT", x: 0.206, y: 0.466, w: 0.104, h: 0.094, fill: 0x151C1D, edge: 0x263A3A, round: false),
                Spec(key: "RT", x: 0.857, y: 0.466, w: 0.103, h: 0.094, fill: 0x1E1616, edge: 0x402A27, round: false),
                Spec(key: "Y", x: 0.749, y: 0.523, w: 0.056, h: 0.121, fill: 0x2A2216, edge: 0x6B5A2A, round: true),
                Spec(key: "X", x: 0.695, y: 0.621, w: 0.056, h: 0.121, fill: 0x141C26, edge: 0x2B4050, round: true),
                Spec(key: "B", x: 0.801, y: 0.621, w: 0.056, h: 0.121, fill: 0x241418, edge: 0x4D2E3B, round: true),
                Spec(key: "A", x: 0.748, y: 0.720, w: 0.056, h: 0.121, fill: 0x152019, edge: 0x2A4A35, round: true)]
        }
        return [
            Spec(key: "BACK", x: 0.626, y: 0.131, w: 0.135, h: 0.034, fill: 0x1C1C1F, edge: 0x3A3A3E, round: false),
            Spec(key: "START", x: 0.756, y: 0.131, w: 0.135, h: 0.034, fill: 0x1C1C1F, edge: 0x3A3A3E, round: false),
            Spec(key: "LT", x: 0.123, y: 0.700, w: 0.145, h: 0.027, fill: 0x151C1D, edge: 0x263A3A, round: false),
            Spec(key: "RT", x: 0.876, y: 0.699, w: 0.145, h: 0.027, fill: 0x1E1616, edge: 0x402A27, round: false),
            Spec(key: "Y", x: 0.862, y: 0.752, w: 0.075, h: 0.035, fill: 0x2A2216, edge: 0x6B5A2A, round: true),
            Spec(key: "X", x: 0.793, y: 0.781, w: 0.075, h: 0.035, fill: 0x141C26, edge: 0x2B4050, round: true),
            Spec(key: "B", x: 0.932, y: 0.781, w: 0.075, h: 0.035, fill: 0x241418, edge: 0x4D2E3B, round: true),
            Spec(key: "A", x: 0.862, y: 0.810, w: 0.075, h: 0.035, fill: 0x152019, edge: 0x2A4A35, round: true)]
    }

    var body: some View {
        ZStack {
            // Pause (website #pauseButton).
            let pause = landscape ? CGRect(x: 0.160, y: 0.161, width: 0.103, height: 0.097)
                                  : CGRect(x: 0.085, y: 0.131, width: 0.111, height: 0.034)
            Button(action: onPause) {
                Text("Pause").font(.system(size: landscape ? 21 : 15, weight: .semibold)).foregroundStyle(.white.opacity(0.9))
                    .frame(width: pause.width * size.width, height: pause.height * size.height)
                    .background(Color(hex: 0x33281B), in: Capsule())
                    .overlay(Capsule().stroke(Color(hex: 0x846939), lineWidth: 1.5))
            }
            .position(x: pause.minX * size.width, y: pause.minY * size.height)
            ForEach(specs, id: \.key) { s in
                let w = s.w * size.width, h = s.round ? s.w * size.width : s.h * size.height
                let label = s.key == "BACK" ? "Back" : s.key == "START" ? "Start" : s.key
                let down = held.contains(s.key)
                Text(label).font(.system(size: landscape ? 21 : 13, weight: .semibold)).foregroundStyle(.white.opacity(0.9))
                    .frame(width: w, height: h)
                    .background(Color(hex: s.fill).opacity(down ? 1 : 0.92), in: s.round ? AnyShape(Circle()) : AnyShape(Capsule()))
                    .overlay((s.round ? AnyShape(Circle()) : AnyShape(Capsule())).stroke(Color(hex: s.edge), lineWidth: 1.5))
                    .brightness(down ? 0.15 : 0)
                    .scaleEffect(down ? 0.94 : 1)
                    .contentShape(Rectangle())
                    .gesture(DragGesture(minimumDistance: 0)
                        .onChanged { _ in if !held.contains(s.key) { held.insert(s.key); sync() } }
                        .onEnded { _ in held.remove(s.key); sync() })
                    .position(x: s.x * size.width, y: s.y * size.height)
            }
            MovePad(landscape: landscape, value: $stick, onChange: sync)
                .frame(width: (landscape ? 0.163 : 0.213) * size.width, height: (landscape ? 0.266 : 0.098) * size.height)
                .position(x: (landscape ? 0.202 : 0.135) * size.width, y: (landscape ? 0.685 : 0.780) * size.height)
        }
        .frame(width: size.width, height: size.height)
    }

    private func sync() {
        var pad = PadState()
        let bits: [String: UInt32] = ["A": 0x1000, "B": 0x2000, "X": 0x4000, "Y": 0x8000, "LB": 0x100, "RB": 0x200,
                                      "START": 0x10, "BACK": 0x20]
        for key in held { pad.buttons |= bits[key] ?? 0 }
        pad.leftTrigger = held.contains("LT") ? 255 : 0
        pad.rightTrigger = held.contains("RT") ? 255 : 0
        pad.lx = Float(stick.width)
        pad.ly = Float(-stick.height)  // screen Y down, XInput Y up
        input.touch = pad
    }
}

/// The website's "Move" pad: rounded slab with chevrons, analog stick input.
struct MovePad: View {
    let landscape: Bool
    @Binding var value: CGSize
    let onChange: () -> Void
    var body: some View {
        GeometryReader { g in
            let w = g.size.width, h = g.size.height
            ZStack {
                RoundedRectangle(cornerRadius: min(w, h) / 2, style: .continuous).fill(Color(hex: 0x1E1B1E))
                    .overlay(RoundedRectangle(cornerRadius: min(w, h) / 2, style: .continuous).stroke(Color(hex: 0x4C464F), lineWidth: 1.5))
                Text("Move").font(.system(size: landscape ? 21 : 13, weight: .semibold)).foregroundStyle(.white.opacity(0.74))
                Image(systemName: "chevron.up").position(x: w / 2, y: h * 0.14)
                Image(systemName: "chevron.down").position(x: w / 2, y: h * 0.86)
                Image(systemName: "chevron.left").position(x: w * 0.14, y: h / 2)
                Image(systemName: "chevron.right").position(x: w * 0.86, y: h / 2)
            }
            .font(.system(size: landscape ? 26 : 16, weight: .regular))
            .foregroundStyle(.white.opacity(0.8))
            .offset(x: value.width * 6, y: value.height * 6)
            .contentShape(Rectangle())
            .gesture(DragGesture(minimumDistance: 0)
                .onChanged { v in
                    var dx = (v.location.x - w / 2) / (w * 0.42), dy = (v.location.y - h / 2) / (h * 0.42)
                    let len = (dx * dx + dy * dy).squareRoot()
                    if len > 1 { dx /= len; dy /= len }
                    value = CGSize(width: dx, height: dy); onChange()
                }
                .onEnded { _ in value = .zero; onChange() })
        }
    }
}

// MARK: - XeniOS touch controls (port of xenios-jp/XeniOS
// src/xenia/hid/touch/touch_layout_ios_defaults.cc, BSD-3, "FPS Compact")

struct XeniOSControls: View {
    let size: CGSize
    @ObservedObject var input: InputHub
    let onPause: () -> Void
    @State private var held: Set<String> = []
    @State private var move = CGSize.zero
    @State private var look = CGSize.zero
    @State private var lastMoveTap = Date.distantPast
    @State private var thumbs: Set<String> = []

    // Normalized frames {x, y, width, height} (top-left origin), XeniOS defaults.
    private struct Button360 { let id, label, key: String; let frame: CGRect }
    private let buttons: [Button360] = [
        .init(id: "back_button", label: "Back", key: "BACK", frame: CGRect(x: 0.390, y: 0.045, width: 0.080, height: 0.112)),
        .init(id: "start_button", label: "Start", key: "START", frame: CGRect(x: 0.495, y: 0.045, width: 0.085, height: 0.112)),
        .init(id: "lb", label: "LB", key: "LB", frame: CGRect(x: 0.660, y: 0.050, width: 0.085, height: 0.112)),
        .init(id: "rb", label: "RB", key: "RB", frame: CGRect(x: 0.765, y: 0.050, width: 0.085, height: 0.112)),
        .init(id: "aim_button", label: "LT", key: "LT", frame: CGRect(x: 0.095, y: 0.405, width: 0.120, height: 0.110)),
        .init(id: "swap_button", label: "Y", key: "Y", frame: CGRect(x: 0.760, y: 0.455, width: 0.065, height: 0.115)),
        .init(id: "reload_button", label: "X", key: "X", frame: CGRect(x: 0.700, y: 0.585, width: 0.065, height: 0.115)),
        .init(id: "melee_button", label: "B", key: "B", frame: CGRect(x: 0.820, y: 0.585, width: 0.065, height: 0.115)),
        .init(id: "jump_button", label: "A", key: "A", frame: CGRect(x: 0.760, y: 0.715, width: 0.065, height: 0.115)),
        .init(id: "fire_button", label: "RT", key: "RT", frame: CGRect(x: 0.860, y: 0.405, width: 0.120, height: 0.110)),
    ]
    private let pauseFrame = CGRect(x: 0.040, y: 0.045, width: 0.120, height: 0.112)
    private let moveFrame = CGRect(x: 0.055, y: 0.56, width: 0.190, height: 0.315)

    private func rect(_ f: CGRect) -> CGRect {
        CGRect(x: f.minX * size.width, y: f.minY * size.height, width: f.width * size.width, height: f.height * size.height)
    }

    var body: some View {
        ZStack {
            // look_zone: swipe anywhere else to look (right stick), lowest priority.
            Color.clear.contentShape(Rectangle())
                .gesture(DragGesture(minimumDistance: 2)
                    .onChanged { v in
                        look = CGSize(width: max(-1, min(1, v.translation.width / 70)),
                                      height: max(-1, min(1, v.translation.height / 70)))
                        sync()
                    }
                    .onEnded { _ in look = .zero; sync() })
            let p = rect(pauseFrame)
            Button(action: onPause) {
                Image(systemName: "pause.fill").font(.system(size: min(p.height * 0.4, 22)))
                    .frame(width: p.width, height: p.height)
                    .background(.black.opacity(0.45), in: RoundedRectangle(cornerRadius: p.height / 3, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: p.height / 3, style: .continuous).stroke(.white.opacity(0.35)))
                    .foregroundStyle(.white.opacity(0.92))
            }
            .position(x: p.midX, y: p.midY)
            ForEach(buttons, id: \.id) { b in
                let r = rect(b.frame)
                let d = min(r.width, r.height)
                let down = held.contains(b.key)
                Text(b.label).font(.system(size: d * 0.36, weight: .bold)).foregroundStyle(.white.opacity(0.92))
                    .frame(width: r.width, height: r.height)
                    .background(Ellipse().fill(.black.opacity(down ? 0.65 : 0.40)))
                    .overlay(Ellipse().stroke(.white.opacity(down ? 0.7 : 0.35), lineWidth: 1.5))
                    .scaleEffect(down ? 0.93 : 1)
                    .opacity(0.92)
                    .contentShape(Ellipse())
                    .gesture(DragGesture(minimumDistance: 0)
                        .onChanged { _ in
                            guard !held.contains(b.key) else { return }
                            held.insert(b.key); sync()
                            // melee_button: hold for right thumbstick click.
                            if b.key == "B" {
                                DispatchQueue.main.asyncAfter(deadline: .now() + 0.30) {
                                    if held.contains("B") { thumbs.insert("RS"); sync() }
                                }
                            }
                        }
                        .onEnded { _ in held.remove(b.key); if b.key == "B" { thumbs.remove("RS") }; sync() })
                    .position(x: r.midX, y: r.midY)
            }
            let m = rect(moveFrame)
            let md = min(m.width, m.height)
            ZStack {
                Circle().fill(.black.opacity(0.32)).overlay(Circle().stroke(.white.opacity(0.30), lineWidth: 1.5))
                // move_with_dpad_ring
                ForEach(0..<4) { i in
                    Image(systemName: "chevron.up").font(.system(size: md * 0.11, weight: .semibold))
                        .foregroundStyle(.white.opacity(0.45)).offset(y: -md * 0.40).rotationEffect(.degrees(Double(i) * 90))
                }
                Circle().fill(.white.opacity(0.55)).frame(width: md * 0.38, height: md * 0.38)
                    .offset(x: move.width * md * 0.30, y: move.height * md * 0.30)
            }
            .frame(width: md, height: md)
            .opacity(0.80)
            .contentShape(Circle())
            .gesture(DragGesture(minimumDistance: 0)
                .onChanged { v in
                    if v.translation == .zero {
                        // double-tap forward: left thumbstick click
                        if Date().timeIntervalSince(lastMoveTap) < 0.30 { thumbs.insert("LS") }
                        lastMoveTap = Date()
                    }
                    var dx = (v.location.x - md / 2) / (md * 0.48), dy = (v.location.y - md / 2) / (md * 0.48)
                    let len = (dx * dx + dy * dy).squareRoot()
                    if len > 1 { dx /= len; dy /= len }
                    // deadzone 0.14
                    move = len < 0.14 ? .zero : CGSize(width: dx, height: dy)
                    sync()
                }
                .onEnded { _ in move = .zero; thumbs.remove("LS"); sync() })
            .position(x: m.midX, y: m.midY)
        }
        .frame(width: size.width, height: size.height)
    }

    private func sync() {
        var pad = PadState()
        let bits: [String: UInt32] = ["A": 0x1000, "B": 0x2000, "X": 0x4000, "Y": 0x8000, "LB": 0x100, "RB": 0x200,
                                      "START": 0x10, "BACK": 0x20, "LS": 0x40, "RS": 0x80]
        for key in held.union(thumbs) { pad.buttons |= bits[key] ?? 0 }
        pad.leftTrigger = held.contains("LT") ? 255 : 0
        pad.rightTrigger = held.contains("RT") ? 255 : 0
        pad.lx = Float(move.width); pad.ly = Float(-move.height)
        pad.rx = Float(look.width); pad.ry = Float(-look.height)
        input.touch = pad
    }
}
