import GameController
import SwiftUI

/// XInput gamepad bits (XINPUT_GAMEPAD_*), as render360-guest-fibers.mjs.
enum XButton: UInt32 {
    case up = 0x1, down = 0x2, left = 0x4, right = 0x8, start = 0x10, back = 0x20, ls = 0x40, rs = 0x80
    case lb = 0x100, rb = 0x200, a = 0x1000, b = 0x2000, x = 0x4000, y = 0x8000
}

/// Merges a hardware controller (MFi / Xbox / PlayStation via
/// GameController.framework) with the on-screen touch controls and feeds the
/// result to the emulator 60 times a second.
final class InputHub: ObservableObject {
    @Published private(set) var controllerName: String?
    var touch = PadState()
    private weak var session: EmulatorSession?
    private var link: CADisplayLink?

    init() {
        NotificationCenter.default.addObserver(forName: .GCControllerDidConnect, object: nil, queue: .main) { [weak self] _ in self?.refresh() }
        NotificationCenter.default.addObserver(forName: .GCControllerDidDisconnect, object: nil, queue: .main) { [weak self] _ in self?.refresh() }
        GCController.startWirelessControllerDiscovery {}
        refresh()
    }

    func attach(_ session: EmulatorSession) {
        self.session = session
        link?.invalidate()
        let l = CADisplayLink(target: self, selector: #selector(tick))
        l.preferredFramesPerSecond = 60
        l.add(to: .main, forMode: .common)
        link = l
    }

    func detach() { link?.invalidate(); link = nil }

    private func refresh() {
        let pad = GCController.controllers().first { $0.extendedGamepad != nil }
        controllerName = pad?.vendorName ?? (pad != nil ? "Controller" : nil)
        Breadcrumbs.shared.log("controller \(controllerName ?? "none")")
    }

    @objc private func tick() {
        var p = touch
        if let g = GCController.controllers().first(where: { $0.extendedGamepad != nil })?.extendedGamepad {
            func on(_ b: GCControllerButtonInput?, _ x: XButton) { if b?.isPressed == true { p.buttons |= x.rawValue } }
            on(g.buttonA, .a); on(g.buttonB, .b); on(g.buttonX, .x); on(g.buttonY, .y)
            on(g.leftShoulder, .lb); on(g.rightShoulder, .rb)
            on(g.buttonMenu, .start); on(g.buttonOptions, .back)
            on(g.leftThumbstickButton, .ls); on(g.rightThumbstickButton, .rs)
            on(g.dpad.up, .up); on(g.dpad.down, .down); on(g.dpad.left, .left); on(g.dpad.right, .right)
            p.leftTrigger = max(p.leftTrigger, UInt8(g.leftTrigger.value * 255))
            p.rightTrigger = max(p.rightTrigger, UInt8(g.rightTrigger.value * 255))
            if abs(g.leftThumbstick.xAxis.value) + abs(g.leftThumbstick.yAxis.value) > 0.05 {
                p.lx = g.leftThumbstick.xAxis.value; p.ly = g.leftThumbstick.yAxis.value   // Y up, as XInput
            }
            if abs(g.rightThumbstick.xAxis.value) + abs(g.rightThumbstick.yAxis.value) > 0.05 {
                p.rx = g.rightThumbstick.xAxis.value; p.ry = g.rightThumbstick.yAxis.value
            }
        }
        session?.setPad(p)
    }
}

/// On-screen controls: left stick, d-pad, A/B/X/Y, shoulders, triggers,
/// Start/Back. Hidden while a hardware controller is connected.
struct TouchControls: View {
    @ObservedObject var input: InputHub
    @State private var held: Set<XButton> = []
    @State private var stick = CGSize.zero
    @State private var lt = false
    @State private var rt = false

    private func sync() {
        var p = PadState()
        for b in held { p.buttons |= b.rawValue }
        p.leftTrigger = lt ? 255 : 0; p.rightTrigger = rt ? 255 : 0
        p.lx = Float(stick.width); p.ly = Float(-stick.height)
        input.touch = p
    }

    var body: some View {
        GeometryReader { geo in
            let s = min(geo.size.width, geo.size.height)
            ZStack {
                HStack(alignment: .bottom) {
                    VStack(spacing: s * 0.03) {
                        HStack { pad("LT", trigger: true, left: true); pad("LB", .lb) }
                        Stick(value: $stick, onChange: sync).frame(width: s * 0.34, height: s * 0.34)
                        DPad(held: $held, onChange: sync).frame(width: s * 0.26, height: s * 0.26)
                    }
                    Spacer()
                    VStack(spacing: s * 0.03) {
                        HStack { pad("RB", .rb); pad("RT", trigger: true, left: false) }
                        FaceButtons(held: $held, onChange: sync).frame(width: s * 0.36, height: s * 0.36)
                    }
                }
                .padding(.horizontal, s * 0.05).padding(.bottom, s * 0.04)
                VStack {
                    Spacer()
                    HStack(spacing: s * 0.08) { pad("Back", .back); pad("Start", .start) }.padding(.bottom, s * 0.04)
                }
            }
        }
        .opacity(input.controllerName == nil ? 0.55 : 0)
        .allowsHitTesting(input.controllerName == nil)
    }

    @ViewBuilder private func pad(_ label: String, _ b: XButton? = nil, trigger: Bool = false, left: Bool = true) -> some View {
        HoldButton(label: label) { down in
            if trigger { if left { lt = down } else { rt = down } }
            else if let b { if down { held.insert(b) } else { held.remove(b) } }
            sync()
        }
    }
}

struct HoldButton: View {
    let label: String
    var round = false
    let changed: (Bool) -> Void
    @State private var down = false
    var body: some View {
        Text(label)
            .font(.system(size: 15, weight: .semibold, design: .rounded))
            .foregroundStyle(.white)
            .frame(minWidth: round ? 52 : 64, minHeight: round ? 52 : 34)
            .background(down ? Color.white.opacity(0.45) : Color.black.opacity(0.45), in: round ? AnyShape(Circle()) : AnyShape(Capsule()))
            .overlay((round ? AnyShape(Circle()) : AnyShape(Capsule())).stroke(.white.opacity(0.6), lineWidth: 1))
            .gesture(DragGesture(minimumDistance: 0)
                .onChanged { _ in if !down { down = true; changed(true) } }
                .onEnded { _ in down = false; changed(false) })
            .accessibilityLabel(label)
    }
}

struct FaceButtons: View {
    @Binding var held: Set<XButton>
    let onChange: () -> Void
    var body: some View {
        GeometryReader { g in
            let d = g.size.width / 3
            ZStack {
                face("Y", .y).position(x: g.size.width / 2, y: d / 2)
                face("X", .x).position(x: d / 2, y: g.size.height / 2)
                face("B", .b).position(x: g.size.width - d / 2, y: g.size.height / 2)
                face("A", .a).position(x: g.size.width / 2, y: g.size.height - d / 2)
            }
        }
    }
    private func face(_ l: String, _ b: XButton) -> some View {
        HoldButton(label: l, round: true) { down in if down { held.insert(b) } else { held.remove(b) }; onChange() }
    }
}

struct DPad: View {
    @Binding var held: Set<XButton>
    let onChange: () -> Void
    var body: some View {
        GeometryReader { g in
            let d = g.size.width / 3
            ZStack {
                dir("▲", .up).position(x: g.size.width / 2, y: d / 2)
                dir("◀", .left).position(x: d / 2, y: g.size.height / 2)
                dir("▶", .right).position(x: g.size.width - d / 2, y: g.size.height / 2)
                dir("▼", .down).position(x: g.size.width / 2, y: g.size.height - d / 2)
            }
        }
    }
    private func dir(_ l: String, _ b: XButton) -> some View {
        HoldButton(label: l, round: true) { down in if down { held.insert(b) } else { held.remove(b) }; onChange() }
    }
}

/// Analog stick: drag inside the circle; value is -1...1 per axis (y down).
struct Stick: View {
    @Binding var value: CGSize
    let onChange: () -> Void
    var body: some View {
        GeometryReader { g in
            let r = g.size.width / 2
            ZStack {
                Circle().fill(.black.opacity(0.4)).overlay(Circle().stroke(.white.opacity(0.6)))
                Circle().fill(.white.opacity(0.6)).frame(width: r * 0.8, height: r * 0.8)
                    .offset(x: value.width * r * 0.6, y: value.height * r * 0.6)
            }
            .contentShape(Circle())
            .gesture(DragGesture(minimumDistance: 0)
                .onChanged { v in
                    var dx = (v.location.x - r) / (r * 0.6), dy = (v.location.y - r) / (r * 0.6)
                    let len = sqrt(dx * dx + dy * dy)
                    if len > 1 { dx /= len; dy /= len }
                    value = CGSize(width: dx, height: dy); onChange()
                }
                .onEnded { _ in value = .zero; onChange() })
        }
        .accessibilityLabel("Left stick")
    }
}
