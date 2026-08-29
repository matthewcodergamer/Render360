# Render360 Xenia-Web — V36

**Browser-native Xbox 360 emulation research project built around Xenia-derived PPC translation and WebAssembly execution.**

> **This root `README.md` is the authoritative public status board.** Historical release notes and foundation documents are supporting evidence only.

## Overall project completion

```text
OVERALL RENDER360 — WEIGHTED ENGINEERING ESTIMATE
███████████████░░░░░  ~74%
```

The overall percentage is a weighted engineering estimate, not a title-compatibility score. CPU/WASM execution, sparse Xbox memory, STFS/XEX extraction and preparation, strict PE loading, real entry handoff, kernel import dispatch, starter xboxkrnl/XAM services, guest threads/TLS/runtime, bounded Xenos command semantics, EDRAM resolve, WebGPU/WGSL presentation, WebGL2 framebuffer presentation fallback, the first translated-guest-PPC-produced framebuffer, and the bounded encrypted-XEX-title-pipeline → Xenos traffic bridge are closed CI contracts.

The major remaining work is **genuine extracted-title GPU traffic and compatibility expansion**: capture the actual MMIO/ringbuffer stream produced by a real title, broader Xenos packet/register behavior, real shader microcode/resource/texture translation, additional EDRAM/resolve formats, title-requested kernel/XAM APIs, browser VFS/ISO input, audio/input integration, performance, and title bring-up.

## Latest authoritative title-to-GPU bridge gate

**Extracted XEX GPU Traffic Bridge Run 10 — Actions ID `33239833760` — SUCCESS**

Code/critic head: `a87495e4d6fe72660cf0d8287c30c8bfddd7dead`

The bounded bridge now proves this chain using a structurally valid encrypted retail-style XEX2 fixture:

```text
encrypted XEX2 image
        ↓
retail session-key / AES preparation
        ↓
PE decode + decoder-derived relocated guest mapping
        ↓
translated Xenia PPC/HIR title entry
        ↓
startup PPC GPR state preserved through title handoff
        ↓
PPC stw instructions produce PM4 words in relocated guest memory
        ↓
exact guest-produced words are read with provenance telemetry
        ↓
closed Xenos PM4 / register / EDRAM path
        ↓
draw + present + nonzero frame hash
```

The independent critic mutates the title-produced primitive, truncates the stream, injects an unsupported PM4 opcode and tests a wrapping 32-bit guest range. Each bad case fails closed and cannot generate a frame.

The title-handoff startup-state change also replayed the complete previously locked Xenia/WASM stack in **Xenia WASM32 Bootstrap Run 395 — Actions ID `33239701901` — SUCCESS** on commit `31dca3ef29d7d7bb616377ee58b66eb908656876`.

**Scope warning:** this closes the encrypted-XEX **pipeline-to-Xenos integration contract**. The fixture is not a commercial game. `EXTRACTED-TITLE → REAL GPU TRAFFIC` remains active until genuine game execution itself reaches GPU MMIO/ringbuffer traffic.

## Latest authoritative first-frame gate

**Xenia WASM32 Bootstrap Run 389 — Actions ID `33238490587` — SUCCESS**

Aggregate commit: `b5c540e7a5dd44eeca8cc3e277bd2a01a3f153ae`

Run 389 closes the bounded **FIRST GENUINE GUEST FRAME** contract after the earlier Run 387 failure exposed a JavaScript signed/unsigned comparison at PM4 word `0xC0003600`. The comparison was corrected by normalizing the expected PM4 word to uint32, not by weakening the GPU implementation or critic.

The verified provenance chain is:

```text
translated PPC program executes
        ↓
PPC stw instructions write PM4 words into Xbox guest memory
        ↓
exact guest-produced PM4 words are read back
        ↓
Xenos PM4 parser consumes the guest-produced stream
        ↓
register state + DRAW_INDX_2
        ↓
bounded Xenos raster semantics
        ↓
circular EDRAM target changes
        ↓
nonzero RGBA framebuffer + generation + hash
        ↓
frame becomes available to the browser presentation bridges
```

The separate harsh provenance critic also proves that corrupting the guest-produced primitive or truncating the PM4 stream prevents the frame. A browser-side fake present therefore cannot satisfy this gate.

**Scope warning:** this is a genuine **translated guest PPC → Xenos → EDRAM framebuffer** closure, but it is not yet a frame produced by an extracted commercial title.

## WebGL2 fallback closure

**WebGL2 Xenos Fallback Run 1 — Actions ID `33238538315` — SUCCESS**

Aggregate commit: `f1bbbd9acb9c0f74f191958628211ecec4fdcc13`

The fallback consumes the same Xenos-resolved RGBA framebuffer as WebGPU. It does not synthesize substitute pixels. The implementation creates a WebGL2 fullscreen-triangle presenter, uploads only when the Xenos frame generation changes, uses nearest/clamp sampling, preserves framebuffer dimensions, and fails closed when WebGL2 is unavailable or the Xenos frame contract is invalid.

The independent WebGL2 critic proves Xenos-frame provenance, unavailable-context failure, invalid-frame bounds rejection, and the absence of a separate fake-frame source.

## Closed foundations and bring-up contracts

```text
PACKAGE / XEX FOUNDATION                         100% ✓
PPC TRANSLATION FOUNDATION                       100% ✓
SCALAR PPC FOUNDATION                            100% ✓
GUEST CONTROL FOUNDATION                         100% ✓
FPU FOUNDATION                                   100% ✓
VMX / VMX128 FOUNDATION                          100% ✓
HOT WASMBACKEND FOUNDATION                       100% ✓
SPARSE XBOX MEMORY FOUNDATION                    100% ✓
V36 STRICT XEX GUEST MAPPER                      100% ✓
FULL default.xex STFS EXTRACTION                 100% ✓
XEX2 IMAGE METADATA DECODE                       100% ✓
XEX DECODED-METADATA → MAPPER INTEGRATION       100% ✓
XEX PREPARE NONE/NONE                            100% ✓
XEX PREPARE BASIC                                100% ✓
XEX NORMAL FRAMING                               100% ✓
XENIA LZX WASM FOUNDATION                        100% ✓
XEX SESSION-KEY / AES-CBC FOUNDATION             100% ✓
FULL RETAIL XEX IMAGE PREPARATION                100% ✓
STRICT XBOX PE IMAGE DECODER                     100% ✓
PREPARED PE IMAGE → GUEST MEMORY                 100% ✓
PREPARED PE ENTRY → XENIA PPC / HIR              100% ✓
ONE-CALL default.xex → XENIA ENTRY HANDOFF       100% ✓
ONE-CALL STFS PACKAGE → XENIA ENTRY HANDOFF      100% ✓
ENTRY EXECUTION / RUNTIME BOUNDARY TELEMETRY     100% ✓
XEX IMPORT LIBRARY / KERNEL DEPENDENCY DISCOVERY 100% ✓
KERNEL IMPORT DESCRIPTOR / THUNK PAIRING         100% ✓
PPC → KERNEL HLE DISPATCH BRIDGE                 100% ✓
AUTOMATIC XEX IMPORT → KERNEL EXECUTION BRIDGE   100% ✓
KERNEL EXECUTION FOUNDATION                      100% ✓
MINIMUM PPC ↔ KERNEL ABI CONTRACT                100% ✓
INDEPENDENT KERNEL ABI HARSH CRITIC              100% ✓
REAL xboxkrnl / XAM STARTER SERVICES             100% ✓
INDEPENDENT KERNEL SERVICES HARSH CRITIC         100% ✓
GUEST THREADS / TLS / RUNTIME FOUNDATION         100% ✓
INDEPENDENT GUEST RUNTIME HARSH CRITIC           100% ✓
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

These percentages close defined CI contracts. They do **not** mean universal Xbox 360 compatibility.

## Critic promotion rule

A subsystem is promoted to 100% only when:

1. the implementation is finished for a bounded, written contract;
2. its implementation test is green;
3. an independent adversarial critic proves the contract and fail-closed cases;
4. the complete locked regression matrix remains green.

The critic is the final judge, not the main development loop. Build first, then let the critic try to break the finished bounded implementation.

## Public progress board

```text
OVERALL RENDER360
███████████████░░░░░  ~74%  weighted engineering estimate

CPU / WASM / MEMORY FOUNDATIONS
████████████████████  100% ✓
PACKAGE + STFS + XEX METADATA
████████████████████  100% ✓
FULL RETAIL XEX IMAGE PREPARATION
████████████████████  100% ✓
STRICT XBOX PE IMAGE DECODE
████████████████████  100% ✓
PREPARED IMAGE → REAL GUEST SECTION MAPPING
████████████████████  100% ✓
PREPARED PE ENTRY → XENIA PPC / HIR
████████████████████  100% ✓
ONE-CALL STFS PACKAGE → XENIA ENTRY HANDOFF
████████████████████  100% ✓
ENTRY EXECUTION / RUNTIME BOUNDARY TELEMETRY
████████████████████  100% ✓
KERNEL EXECUTION + PPC ABI FOUNDATION
████████████████████  100% ✓
REAL xboxkrnl / XAM STARTER SERVICES
████████████████████  100% ✓
GUEST THREADS / TLS / RUNTIME FOUNDATION
████████████████████  100% ✓
XENOS FIRST-FRAME SEMANTIC FOUNDATION
████████████████████  100% ✓
WEBGPU / WGSL / EDRAM PRESENTATION FOUNDATION
████████████████████  100% ✓
GUEST MEMORY → XENOS → EDRAM FRAME BRIDGE
████████████████████  100% ✓
FIRST GENUINE GUEST FRAME
████████████████████  100% ✓
WEBGL2 FALLBACK
████████████████████  100% ✓
ENCRYPTED XEX PIPELINE → XENOS TRAFFIC BRIDGE
████████████████████  100% ✓

EXTRACTED-TITLE → REAL GPU TRAFFIC
██░░░░░░░░░░░░░░░░░░  ← ACTIVE: requires genuine title trace
REAL TITLE SHADERS / TEXTURES / RESOURCES
░░░░░░░░░░░░░░░░░░░░
FIRST EXTRACTED-TITLE FRAME
░░░░░░░░░░░░░░░░░░░░
```

## Current verified GPU path

```text
encrypted XEX2 fixture / mapped translated guest PPC
  → relocated guest-memory PM4 command production
  → exact big-endian guest command words + provenance hash
  → PM4 parser
  → Xenos register state
  → DRAW_INDX / DRAW_INDX_2
  → bounded raster semantics
  → circular EDRAM target
  → RGBA resolve + generation/hash
  → WebGPU/WGSL presentation
        or
  → WebGL2 framebuffer fallback
```

The next active integration replaces the structurally valid encrypted-XEX fixture with GPU traffic reached while executing a genuine extracted title through the already-closed package/XEX/PE/kernel/runtime path.

## GPU implementation files

- `src/xenia_web_bootstrap/xenos_gpu_foundation.cpp` — bounded PM4/register/draw/EDRAM semantic module.
- `render360-xenos-controller.mjs` — big-endian guest-memory → Xenos command bridge.
- `render360-title-gpu-traffic.mjs` — relocated mapped-XEX PPC guest-memory → Xenos traffic bridge with provenance telemetry.
- `render360-webgpu-xenos.mjs` — frame view, WGSL present shader and WebGPU presenter.
- `render360-webgl2-xenos.mjs` — WebGL2 framebuffer fallback consuming the same Xenos frame.
- `test-xenos-semantic-foundation.mjs` — Xenos implementation gate.
- `test-xenos-guest-memory-bridge.mjs` — guest-memory bridge gate.
- `test-webgpu-wgsl-edram-foundation.mjs` — WebGPU/WGSL bridge gate.
- `test-xenos-harsh-critic.mjs` — independent Xenos critic.
- `test-first-genuine-guest-frame.mjs` — translated-PPC frame-production gate.
- `test-first-frame-provenance-critic.mjs` — independent no-fake-frame provenance critic.
- `test-webgl2-xenos-fallback.mjs` — WebGL2 implementation gate.
- `test-webgl2-fallback-critic.mjs` — independent WebGL2 critic.
- `test-extracted-xex-gpu-traffic.mjs` — encrypted-XEX title pipeline → relocated guest PM4 → Xenos implementation gate.
- `test-extracted-xex-gpu-traffic-critic.mjs` — independent corruption/truncation/unsupported-opcode/wraparound critic.

## ISO / GOD input direction

Render360 should not require ISO2GOD. The intended browser input architecture remains:

```text
Xbox 360 .iso
  → random-access XDVDFS reader using File/Blob ranges
  → virtual game filesystem
  → default.xex + supporting files

GOD / STFS container
  → STFS/GOD reader
  → virtual game filesystem
  → default.xex + supporting files

both
  → existing Render360 XEX / PE / PPC pipeline
```

Large disc images should be mounted virtually and read in bounded ranges rather than copied wholesale into Wasm memory.

## Road to playable software

```text
first translated-guest-PPC framebuffer                  ✓ LOCKED
WebGL2 Xenos framebuffer fallback                       ✓ LOCKED
encrypted XEX pipeline → relocated Xenos traffic         ✓ LOCKED BY HARSH CRITIC
genuine extracted title → real GPU ringbuffer/MMIO       ← ACTIVE
expand Xenos packets/registers from the first blocker
translate real Xenos shader microcode → WGSL
textures / vertex fetch / resources / resolves
first extracted-title-produced framebuffer
performance work from real traces
ISO/XDVDFS virtual mount
small homebrew / XBLA-class bring-up
Braid-class target
Portal-class bring-up
Portal 2-class bring-up
```

Now optimization should be driven by measured title traces: compiled Wasm reuse, VMX/Wasm SIMD, fewer JS↔Wasm transitions, streamed title data, workers/shared queues where isolation permits, low internal resolution, shader/resource caches, and reduced EDRAM copies.

## Engineering rule

Never report `REAL TITLE ENTRY`, `FIRST TITLE DRAW`, `FIRST TITLE PRESENT`, `FIRST EXTRACTED-TITLE FRAME`, `PLAYABLE`, title FPS or title boot unless that event came from genuine extracted-title execution through the corresponding emulator subsystem.

## License

Xenia-derived portions remain subject to upstream Xenia licensing terms. See [`LICENSE_XENIA.txt`](LICENSE_XENIA.txt).
