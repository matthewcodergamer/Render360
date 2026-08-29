# Render360 Xenia-Web — V36

**Browser-native Xbox 360 emulation research project built around Xenia-derived PPC translation and WebAssembly execution.**

> **This root `README.md` is the authoritative public status board.** Historical release notes and foundation documents are supporting evidence only.

## Overall project completion

```text
OVERALL RENDER360 — WEIGHTED ENGINEERING ESTIMATE
██████████████░░░░░░  ~68%
```

The overall percentage is an engineering estimate, not a title-compatibility score. CPU/WASM, sparse memory, package/STFS extraction, retail XEX preparation, strict PE loading, package-to-entry handoff, controlled entry execution, import discovery, kernel dispatch/ABI, the bounded first-frame xboxkrnl/XAM starter-service surface, guest thread/TLS/runtime, bounded Xenos command semantics, EDRAM resolve behavior, and the WebGPU/WGSL presentation bridge are now closed CI contracts. A genuine title-produced frame, broad shader/resource translation, fuller Xenos behavior, browser VFS expansion, later title-specific kernel APIs and compatibility remain major work.

## Latest authoritative GPU gate

**Xenos WebGPU Foundations Run 3 — Actions ID `33237507899` — SUCCESS**

Aggregate commit: `8355d007b4b265eeab572b9ba27abe41900cd6bc`

This gate closes two explicitly bounded GPU foundations and the bridge between guest memory and them:

- **XENOS FIRST-FRAME SEMANTIC FOUNDATION — 100% ✓**
- **WEBGPU / WGSL / EDRAM PRESENTATION FOUNDATION — 100% ✓**
- **GUEST MEMORY → XENOS → EDRAM FRAME BRIDGE — 100% ✓**

The implementation parses bounded Xenos PM4 command streams, handles type-0 register writes and type-2 NOPs, recognizes the Xenia-matched `PM4_DRAW_INDX` (`0x22`) and `PM4_DRAW_INDX_2` (`0x36`) draw opcodes, tracks register/draw/present telemetry, implements circular 2048-tile EDRAM addressing, produces a deterministic EDRAM-backed RGBA frame after a decoded draw, and rejects malformed/unsupported packets fail-closed.

The browser bridge consumes Xbox big-endian command words from guest memory, submits them to the Xenos semantic module, resolves the resulting frame, and exposes a WebGPU presenter with WGSL vertex/fragment stages and generation-based texture uploads.

The independent Xenos critic proves deterministic output, no fake present before a draw, truncated-packet rejection, unsupported-primitive rejection, ring bounds, circular EDRAM addressing and fail-closed unsupported PM4 behavior.

**Full-stack regression remained green too:** Xenia WASM32 Bootstrap **Run 381 — Actions ID `33237342332` — SUCCESS** after the Xenos implementation landed, preserving all previously locked CPU/WASM/package/XEX/kernel/runtime contracts.

**Scope warning:** these 100% values are first-frame foundations. They do not mean the complete Xbox 360 Xenos GPU, every shader instruction, every texture/resource format, every resolve mode or every commercial title's rendering path is implemented.

Most importantly, **FIRST GENUINE GUEST FRAME is not being falsely promoted yet.** The current CI workload feeds a controlled guest-memory PM4 stream into the real Render360 Xenos path. The final frame milestone requires the command stream to originate from translated guest/title execution through the emulator GPU boundary.

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
██████████████░░░░░░  ~68%  weighted engineering estimate

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
XEX IMPORT LIBRARIES / KERNEL DEPENDENCY DISCOVERY
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
█████░░░░░░░░░░░░░░░  ← ACTIVE: connect translated guest/title GPU traffic to the closed Xenos bridge
WEBGL2 FALLBACK
░░░░░░░░░░░░░░░░░░░░
```

The partial first-frame bar means infrastructure is present; it does not claim a genuine title-produced frame has happened.

## Current GPU path

```text
translated guest/title execution
  → guest-memory Xenos command stream
  → big-endian command-word bridge
  → PM4 ringbuffer parser
  → register state
  → DRAW_INDX / DRAW_INDX_2 event
  → bounded Xenos raster semantics
  → circular EDRAM target
  → RGBA resolve
  → generation-tracked frame
  → WebGPU texture upload
  → WGSL presentation
```

CI currently proves the path beginning with a controlled guest-memory command stream. The next implementation target is to make the existing translated title/runtime path write or expose the actual Xenos ringbuffer/MMIO state that feeds this bridge. When that produces a frame from guest execution, the first-frame critic can judge provenance and the **FIRST GENUINE GUEST FRAME** bar can be promoted.

## GPU implementation files

- `src/xenia_web_bootstrap/xenos_gpu_foundation.cpp` — bounded PM4/register/draw/EDRAM semantic module.
- `render360-xenos-controller.mjs` — big-endian guest-memory → Xenos command bridge.
- `render360-webgpu-xenos.mjs` — frame view, WGSL present shader and WebGPU presenter.
- `test-xenos-semantic-foundation.mjs` — implementation gate.
- `test-xenos-guest-memory-bridge.mjs` — guest-memory provenance bridge gate.
- `test-webgpu-wgsl-edram-foundation.mjs` — WebGPU/WGSL bridge gate.
- `test-xenos-harsh-critic.mjs` — independent adversarial Xenos critic.
- `.github/workflows/xenos-foundations.yml` — dedicated GPU foundation CI gate.

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

Large disc images should be mounted virtually and read in bounded ranges rather than copied wholesale into Wasm memory. ISO/XDVDFS is separate from the current first-frame push.

## Road to playable software

```text
translated title → actual Xenos ringbuffer/MMIO traffic
  → FIRST GENUINE GUEST FRAME
  → permanent first-frame provenance/regression critic
  → expand shaders / textures / resources / resolve modes from real blockers
  → WebGL2 fallback where practical
  → performance work from real traces
  → small homebrew / XBLA-class bring-up
  → Braid-class target
  → Portal-class bring-up
  → Portal 2-class bring-up
```

Once the first genuine frame exists, optimize from measured traces: compiled Wasm reuse, VMX/Wasm SIMD, fewer JS↔Wasm transitions, streamed title data, workers/shared queues where isolation permits, low internal resolution, shader/resource caches, and EDRAM traffic reduction.

## Engineering rule

Never report `REAL TITLE ENTRY`, `FIRST DRAW`, `FIRST PRESENT`, `FIRST GENUINE GUEST FRAME`, `PLAYABLE`, title FPS or title boot unless that event came from genuine execution through the corresponding emulator subsystem.

## License

Xenia-derived portions remain subject to upstream Xenia licensing terms. See [`LICENSE_XENIA.txt`](LICENSE_XENIA.txt).
