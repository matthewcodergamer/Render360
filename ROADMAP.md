# Render360 Xenia-Web Roadmap — V36

## Project rule

**Port Xenia; do not imitate Xenia.** Xenia remains the semantic source of truth for Xbox 360 CPU, kernel and GPU behavior. Render360 owns browser-native integration: WebAssembly, sparse memory, browser storage/I/O, workers, WebGPU, WebGL2 fallback, WebAudio, input and diagnostics.

The root `README.md` is the authoritative public status board.

## Promotion rule

Development order is implementation first, critic last:

1. define a bounded subsystem contract;
2. finish the implementation;
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
GPU Run 3  bounded Xenos + EDRAM + guest-memory bridge + WebGPU/WGSL
Run 389  translated guest PPC → PM4 → Xenos → EDRAM frame + provenance critic
WebGL2 Run 1  Xenos framebuffer → WebGL2 presentation + harsh critic
Run 395  title-handoff startup-state support + full locked regression replay
XEX GPU Traffic Run 10  encrypted XEX → relocated PPC PM4 → Xenos + harsh critic
```

Run 389 is Actions ID `33238490587` on aggregate commit `b5c540e7a5dd44eeca8cc3e277bd2a01a3f153ae`. WebGL2 Run 1 is Actions ID `33238538315` on `f1bbbd9acb9c0f74f191958628211ecec4fdcc13`. Run 395 is Actions ID `33239701901` on `31dca3ef29d7d7bb616377ee58b66eb908656876`. XEX GPU Traffic Run 10 is Actions ID `33239833760` on `a87495e4d6fe72660cf0d8287c30c8bfddd7dead`.

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
FIRST GENUINE GUEST FRAME                        100% ✓
INDEPENDENT FIRST-FRAME PROVENANCE CRITIC        100% ✓
WEBGL2 XENOS FRAMEBUFFER FALLBACK                100% ✓
INDEPENDENT WEBGL2 FALLBACK HARSH CRITIC         100% ✓
ENCRYPTED XEX PIPELINE → XENOS TRAFFIC BRIDGE    100% ✓
INDEPENDENT XEX→GPU TRAFFIC HARSH CRITIC         100% ✓
```

These are bounded contracts, not universal Xbox 360 compatibility claims.

## Gate D3D — first genuine guest frame — CLOSED

Translated PowerPC guest execution writes PM4 commands into guest memory, the Xenos parser consumes them, bounded raster semantics change circular EDRAM, and the resolved RGBA framebuffer receives a generation and hash. The independent provenance critic proves corrupt/truncated guest traffic cannot satisfy the frame gate.

This is a genuine translated-guest-PPC-produced frame. It does **not** claim a commercial title has produced a frame.

## Gate D3E — WebGL2 Xenos framebuffer fallback — CLOSED

The fallback consumes the exact Xenos-resolved framebuffer already used by WebGPU, uploads only on generation changes, and fails closed on invalid state or unavailable WebGL2. It does not create a substitute framebuffer.

## Gate D4A0 — encrypted XEX title pipeline to Xenos traffic — CLOSED

The new bounded bridge proves:

```text
encrypted retail-style XEX2 fixture
        ↓
AES/session-key image preparation
        ↓
strict PE decode + relocated guest mapping
        ↓
translated Xenia PPC/HIR entry
        ↓
startup GPR state at title handoff
        ↓
PPC stores PM4 words into relocated guest memory
        ↓
exact word provenance + hash
        ↓
closed Xenos PM4 / EDRAM path
        ↓
draw + present + nonzero frame hash
```

The harsh critic independently checks corrupted primitive data, truncation, unsupported PM4 opcodes and wrapping guest ranges. All fail closed. Run 10 (`33239833760`) is green, and Run 395 (`33239701901`) proves the title-handoff implementation did not regress the locked Xenia/WASM stack.

This fixture is structurally valid and exercises the real encrypted XEX/PE/PPC pipeline, but it is **not a commercial game**.

## Gate D4A — genuine extracted title to real GPU traffic — ACTIVE

This remains the primary milestone:

```text
STFS / XDVDFS / default.xex from a genuine title
        ↓
retail XEX preparation + PE mapping
        ↓
Xenia PPC/HIR execution
        ↓
real title kernel/runtime progress
        ↓
actual title GPU MMIO / ringbuffer writes
        ↓
closed Xenos PM4 / EDRAM path
        ↓
FIRST EXTRACTED-TITLE FRAME
```

The implementation must capture the real GPU command address/range created by title execution rather than replacing it with a test PM4 sequence. The first unsupported command/register/shader/resource becomes the next implementation target, and unknown behavior continues to fail closed.

## Immediate implementation order

```text
1. Add title-runtime GPU MMIO/ringbuffer capture at the Xenos-visible address/range.
2. Feed genuine title-produced ringbuffer words into the existing provenance bridge.
3. Record the first exact unsupported PM4 packet/register from genuine title execution.
4. Port the corresponding upstream Xenia semantic behavior.
5. Capture the first real vertex/pixel shader microcode and translate the reached subset to WGSL.
6. Add vertex/index fetch and texture/resource descriptors reached by that title.
7. Expand EDRAM/resolve formats only as real traffic requests them.
8. Present the first extracted-title frame through WebGPU and verify the same frame through WebGL2 where supported.
9. Run an extracted-title frame provenance critic before promotion.
```

Additional xboxkrnl/XAM, synchronization, filesystem, audio or input behavior is implemented only when real title execution asks for it.

## ISO / GOD input track

Render360 should not require ISO2GOD. The intended input route is:

```text
.iso → random-access XDVDFS mount → default.xex + game files
GOD/STFS → STFS/GOD mount → default.xex + game files
both → existing Render360 XEX / PE / PPC pipeline
```

Large disc images should stay as browser `File`/`Blob` objects and be read in bounded ranges rather than duplicated wholesale into Wasm memory.

## Performance track

Performance work should now be driven by real traces: keep hot execution in Wasm, minimize JS↔Wasm crossings, retain compiled PPC Wasm caching, use Wasm SIMD for VMX, batch Xenos command handling, cache translated shaders/resources, reduce EDRAM copies, use low internal resolution for mobile, and move shared queues/workers behind cross-origin-isolation capability checks.

## Compatibility ladder

```text
CPU/browser foundations                         ✓ LOCKED
STFS + XEX metadata                             ✓ LOCKED
retail XEX preparation                          ✓ LOCKED
strict PE decode + guest mapping                ✓ LOCKED
prepared entry → Xenia PPC/HIR                  ✓ LOCKED
kernel ABI + starter services                   ✓ LOCKED
threads/TLS/runtime                             ✓ LOCKED
Xenos first-frame semantic foundation           ✓ LOCKED
WebGPU/WGSL/EDRAM presentation foundation       ✓ LOCKED
first translated-guest-PPC frame                ✓ LOCKED BY PROVENANCE CRITIC
WebGL2 Xenos framebuffer fallback               ✓ LOCKED BY HARSH CRITIC
encrypted XEX pipeline → relocated Xenos traffic ✓ LOCKED BY HARSH CRITIC
genuine extracted title → actual GPU traffic     ← ACTIVE
real shader / texture / resource translation
first extracted-title frame
performance / latency optimization
ISO/XDVDFS virtual mount
small homebrew / XBLA-class bring-up
Braid-class playable target
Portal-class bring-up
Portal 2-class bring-up
```

## Status rule

Never report `REAL TITLE ENTRY`, `FIRST TITLE DRAW`, `FIRST TITLE PRESENT`, `FIRST EXTRACTED-TITLE FRAME`, `PLAYABLE`, title FPS, shader translation or title boot unless that event came from genuine extracted-title execution through the corresponding emulator subsystem.
