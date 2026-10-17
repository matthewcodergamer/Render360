import MetalKit
import SwiftUI

/// Presents the guest frontbuffer (FrameStore) with Metal: upload RGBA8 into a
/// texture, draw an aspect-fit quad. Presentation is capped at 30 FPS
/// (preferredFramesPerSecond), the target of the 30 FPS bar.
struct MetalFrameView: UIViewRepresentable {
    let frames: FrameStore
    let perf: PerfStats

    func makeCoordinator() -> Renderer { Renderer(frames: frames, perf: perf) }

    func makeUIView(context: Context) -> MTKView {
        let view = MTKView(frame: .zero, device: context.coordinator.device)
        view.colorPixelFormat = .bgra8Unorm
        view.preferredFramesPerSecond = 30
        view.clearColor = MTLClearColor(red: 0, green: 0, blue: 0, alpha: 1)
        view.delegate = context.coordinator
        view.framebufferOnly = true
        view.contentScaleFactor = UIScreen.main.nativeScale
        return view
    }

    func updateUIView(_ uiView: MTKView, context: Context) {}

    final class Renderer: NSObject, MTKViewDelegate {
        let device = MTLCreateSystemDefaultDevice()!
        private let queue: MTLCommandQueue
        private let pipeline: MTLRenderPipelineState
        private let sampler: MTLSamplerState
        private var texture: MTLTexture?
        private var shown: UInt64 = 0
        private let frames: FrameStore
        private let perf: PerfStats

        init(frames: FrameStore, perf: PerfStats) {
            self.frames = frames
            self.perf = perf
            queue = device.makeCommandQueue()!
            let source = """
            #include <metal_stdlib>
            using namespace metal;
            struct VOut { float4 pos [[position]]; float2 uv; };
            vertex VOut vmain(uint vid [[vertex_id]], constant float2& scale [[buffer(0)]]) {
              float2 p = float2(vid & 1, vid >> 1);
              VOut o; o.pos = float4((p * 2.0 - 1.0) * scale, 0, 1); o.uv = float2(p.x, 1.0 - p.y); return o;
            }
            fragment float4 fmain(VOut in [[stage_in]], texture2d<float> t [[texture(0)]], sampler s [[sampler(0)]]) {
              return float4(t.sample(s, in.uv).rgb, 1.0);
            }
            """
            let library = try! device.makeLibrary(source: source, options: nil)
            let desc = MTLRenderPipelineDescriptor()
            desc.vertexFunction = library.makeFunction(name: "vmain")
            desc.fragmentFunction = library.makeFunction(name: "fmain")
            desc.colorAttachments[0].pixelFormat = .bgra8Unorm
            pipeline = try! device.makeRenderPipelineState(descriptor: desc)
            let sd = MTLSamplerDescriptor()
            sd.minFilter = .linear; sd.magFilter = .linear
            sampler = device.makeSamplerState(descriptor: sd)!
        }

        func mtkView(_ view: MTKView, drawableSizeWillChange size: CGSize) {}

        func draw(in view: MTKView) {
            frames.withFrame(newerThan: shown) { ptr, w, h, gen in
                if texture?.width != w || texture?.height != h {
                    let td = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: .rgba8Unorm, width: w, height: h, mipmapped: false)
                    td.usage = .shaderRead
                    texture = device.makeTexture(descriptor: td)
                }
                texture?.replace(region: MTLRegionMake2D(0, 0, w, h), mipmapLevel: 0, withBytes: ptr, bytesPerRow: w * 4)
                shown = gen
                perf.framePresented(PerfStats.nowMs())
            }
            guard let pass = view.currentRenderPassDescriptor, let drawable = view.currentDrawable,
                  let cmd = queue.makeCommandBuffer(), let enc = cmd.makeRenderCommandEncoder(descriptor: pass) else { return }
            if let texture {
                let vw = Float(view.drawableSize.width), vh = Float(view.drawableSize.height)
                let fa = Float(texture.width) / Float(texture.height), va = vw / max(vh, 1)
                var scale = fa > va ? SIMD2<Float>(1, va / fa) : SIMD2<Float>(fa / va, 1)
                enc.setRenderPipelineState(pipeline)
                enc.setVertexBytes(&scale, length: MemoryLayout<SIMD2<Float>>.size, index: 0)
                enc.setFragmentTexture(texture, index: 0)
                enc.setFragmentSamplerState(sampler, index: 0)
                enc.drawPrimitives(type: .triangleStrip, vertexStart: 0, vertexCount: 4)
            }
            enc.endEncoding()
            cmd.present(drawable)
            cmd.commit()
        }
    }
}
