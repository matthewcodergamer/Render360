# Render360 Xenia-Web Roadmap — V36

## Project rule

**Port Xenia; do not imitate Xenia.** Xenia remains the semantic source of truth for Xbox 360 CPU, kernel and GPU behavior. Render360 owns the browser-native integration: WebAssembly, sparse memory, browser storage/I/O, workers, WebGPU, WebGL2 fallback, WebAudio, input and diagnostics.

The root `README.md` is the authoritative public status board.

## Promotion rule

Development order is implementation first, critic last:

1. define a bounded subsystem contract;
2. finish that implementation;
3. pass its implementation tests;
4. let a separate adversarial critic attack it;
5. replay previously locked foundations;
6. only then promote the bounded contract to 100%.

## Verified closure ladder

```text
Run 254  eight CPU/browser foundations
Run 261  strict XEX guest mapper
Run 265  full default.xex STFS extraction
Run 276  XEX2 metadata + decoded mapper integration
Run 282  NONE/NONE preparation
Run 288  BASIC preparation
Run 294  NORMAL framing/deblocking
Run 299  upstream Xenia LZX in wasm32
Run 303  XEX session-key / AES-CBC foundation
Run 315  prepared NORMAL image → relocated guest entry → Xenia PPC/HIR
Run 321  strict Xbox PE image decoder
Run 328  prepared PE image → SparseGuestMemory → decoder-derived entry
Run 335  prepared PE entry → mapped guest bytes → Xenia PPC/HIR
Run 338  encrypted retail NONE/BASIC/NORMAL → exact prepared image
Run 348  entry execution + first runtime-boundary telemetry
Run 369  XEX imports → real PE RVA mapping → kernel HLE execution bridge
Run 373  independent harsh critic → PPC/kernel ABI + guest state + continuation
Run 379  starter xboxkrnl/XAM services + guest threads/TLS/runtime
Run 381  full locked Xenia/WASM replay remains green after GPU implementation lands
GPU Run 3  bounded Xenos + EDRAM + guest-memory bridge + WebGPU/WGSL + harsh critic
```

GPU Run 3 is Actions ID `33237507899` on aggregate commit `8355d007b4b265eeab572b9ba27abe41900cd6bc`. Xenia WASM32 Run 381 is Actions ID `33237342332` and is also green.

## Closed V36 contracts

```text
CPU / WASM / MEMORY FOUNDATIONS                  100% ✓
PACKAGE / STFS / XEX FOUNDATION                  100% ✓
XEX2 METADATA + GUEST MAPPER                     100% ✓
NONE / BASIC / NORMAL PREPARATION                100% ✓
UPSTREAM XENIA LZX WASM                          100% ✓
XEX SESSION-KEY / AES-CBC                        100% ✓
FULL RETAIL XEX IMAGE PREPARATION                100% ✓
STRICT XBOX PE IMAGE DECODER                     100% ✓
PREPARED PE IMAGE → GUEST MEMORY                 100% ✓
PREPARED PE ENTRY → XENIA PPC / HIR              100% ✓
ONE-CALL default.xex → XENIA ENTRY               100% ✓
ONE-CALL STFS PACKAGE → XENIA ENTRY              100% ✓
ENTRY EXECUTION / RUNTIME BOUNDARY               100% ✓
XEX IMPORT LIBRARY DISCOVERY                     100% ✓
KERNEL IMPORT DESCRIPTOR / THUNK PAIRING         100% ✓
PPC → KERNEL HLE DISPATCH                        100% ✓
AUTOMATIC XEX IMPORT → KERNEL EXECUTION          100% ✓
KERNEL EXECUTION FOUNDATION                      100% ✓
MINIMUM PPC ↔ KERNEL ABI                         100% ✓
REAL xboxkrnl / XAM STARTER SERVICES             100% ✓
GUEST THREADS / TLS / RUNTIME FOUNDATION         100% ✓
XENOS FIRST-FRAME SEMANTIC FOUNDATION            100% ✓
INDEPENDENT XENOS HARSH CRITIC                   100% ✓
WEBGPU / WGSL / EDRAM PRESENTATION FOUNDATION    100% ✓
GUEST MEMORY → XENOS → EDRAM FRAME BRIDGE       100% ✓
```

These are bounded contracts, not universal Xbox 360 compatibility claims.

## Gate D3A — Xenos first-frame semantic foundation — CLOSED

The bounded semantic module now supports the minimum path needed to carry a real guest command stream forward:

```text
big-endian guest command words
        ↓
PM4 ringbuffer parser
        ↓
type-0 register writes / type-2 NOP
        ↓
PM4_DRAW_INDX (0x22) / PM4_DRAW_INDX_2 (0x36)
        ↓
register + draw + present telemetry
        ↓
bounded raster event
        ↓
2048-tile circular EDRAM addressing
        ↓
RGBA resolve + deterministic frame generation/hash
```

Malformed lengths, unsupported opcodes, unsupported primitives and oversized ring submissions fail closed. The harsh critic separately attacks these cases and ensures a present cannot appear before a decoded draw.

This is intentionally a first-frame semantic subset. More packet types, shader microcode, texture/resource formats and render-backend behavior are added from real execution blockers rather than guessed in advance.

## Gate D3B — WebGPU / WGSL / EDRAM presentation foundation — CLOSED

The browser bridge now contains:

```text
Xenos resolved RGBA frame
        ↓
generation-tracked frame view
        ↓
WebGPU rgba8unorm texture upload
        ↓
WGSL vertex + fragment presentation stages
        ↓
canvas presentation
```

The WGSL/presentation gate is structural in CI because GitHub runners do not provide the target iPhone/Safari GPU environment. Device-level browser validation remains part of later real-device bring-up, but the bounded bridge contract is closed.

## Gate D3C — guest memory to Xenos frame bridge — CLOSED

`render360-xenos-controller.mjs` consumes Xbox big-endian command words from a `WebAssembly.Memory`, range-validates them, converts them to host words, submits them to the Xenos module, and returns only a frame generated downstream of decoded GPU commands. Out-of-range guest command streams fail closed.

## Gate D3D — first genuine guest frame — ACTIVE

This is now the next primary milestone:

```text
translated guest/title PPC
        ↓
actual GPU MMIO / ringbuffer state produced by guest execution
        ↓
closed guest-memory → Xenos bridge
        ↓
closed PM4 / register / EDRAM path
        ↓
closed WebGPU / WGSL presenter
        ↓
FIRST GENUINE GUEST-PRODUCED FRAMEBUFFER
```

The remaining work is **provenance and real integration**, not another browser-side rendering demo. The current CI command stream is controlled test data placed in guest memory. To close D3D, translated guest execution itself must create or expose the GPU command stream that results in the frame.

The first-frame critic must prove:

```text
translated guest execution occurred
actual guest GPU command address/range captured
nonzero decoded PM4 packet count
at least one supported draw reached Xenos
EDRAM generation changed only because of that draw
frame generation/hash changed
frame was presented through the browser GPU bridge
removing/corrupting the guest GPU stream prevents the frame
```

Only after that provenance chain passes can `FIRST GENUINE GUEST FRAME` become 100%.

## Immediate implementation order

```text
1. Add GPU MMIO / ringbuffer handoff at the existing guest execution boundary.
2. Feed the real guest-produced command address/range into render360-xenos-controller.mjs.
3. Record exact unsupported PM4/register/shader blocker telemetry.
4. Implement the first real blocker from Xenia semantics.
5. Repeat until a supported draw reaches EDRAM.
6. Present through render360-webgpu-xenos.mjs.
7. Run the provenance critic.
8. Promote FIRST GENUINE GUEST FRAME only if it passes.
```

Additional xboxkrnl/XAM, synchronization, memory or filesystem behavior is implemented only if genuine execution asks for it along this route.

## ISO / GOD input track

This does not block the first-frame controlled workload. The future title input route remains:

```text
.iso → random-access XDVDFS mount → default.xex + game files
GOD/STFS → STFS/GOD mount → default.xex + game files
both → existing Render360 XEX / PE / PPC pipeline
```

Do not require ISO2GOD. Large disc images should stay as browser `File`/`Blob` objects and be read in bounded ranges.

## Performance after first genuine frame

Once D3D closes, optimize from measured traces: keep hot execution in Wasm, minimize JS↔Wasm crossings, move the GPU sidecar toward shared/integrated memory where browser isolation permits, retain compiled PPC Wasm caching, use Wasm SIMD for VMX, start at low internal resolution, cache translated shaders/resources, and reduce EDRAM copies.

## Compatibility ladder

```text
CPU/browser foundations                         ✓ LOCKED
STFS + XEX metadata                             ✓ LOCKED
retail XEX preparation                          ✓ LOCKED
strict PE decode + guest mapping                ✓ LOCKED
prepared entry → Xenia PPC/HIR                  ✓ LOCKED
kernel ABI + starter services                   ✓ LOCKED
threads/TLS/runtime                             ✓ LOCKED
Xenos first-frame semantic foundation           ✓ LOCKED BY HARSH CRITIC
WebGPU/WGSL/EDRAM presentation foundation       ✓ LOCKED
guest-memory → Xenos frame bridge               ✓ LOCKED
FIRST GENUINE GUEST FRAME                       ← ACTIVE
expand Xenos/shaders/resources from real traces
WebGL2 fallback
performance / latency optimization
ISO/XDVDFS virtual mount
small homebrew / XBLA-class bring-up
Braid-class playable target
Portal-class bring-up
Portal 2-class bring-up
```

## Status rule

Never report `REAL TITLE ENTRY`, `FIRST DRAW`, `FIRST PRESENT`, `FIRST GENUINE GUEST FRAME`, `PLAYABLE`, title FPS, shader translation or title boot unless that event came from genuine execution through the corresponding emulator subsystem.
