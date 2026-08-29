# Render360 Xenia-Web — V36

**Browser-native Xbox 360 emulation research project built around Xenia-derived PPC translation and WebAssembly execution.**

> **This root `README.md` is the authoritative public status board.** Historical release notes and foundation documents are supporting evidence only.

## Overall project completion

```text
OVERALL RENDER360 — WEIGHTED ENGINEERING ESTIMATE
██████████░░░░░░░░░░  ~50%
```

The overall percentage is an engineering estimate, not a title-compatibility score. CPU/WASM, package/STFS extraction, retail XEX preparation, strict PE loading, package-to-entry handoff and controlled entry-execution boundary reporting are closed CI contracts. Kernel/XAM services, guest threads/TLS, Xenos, EDRAM, WebGPU presentation and title compatibility remain the largest risks.

## Latest authoritative gate

**Run 348 — Actions ID `33231592519` — SUCCESS**

Aggregate commit: `fcd86e25d4be01b2daf7e640e87127b3471c5cf7`

Run 348 closes the controlled entry-execution/runtime-boundary contract. The package/title controllers now expose execution status after finalized Xenia HIR. The critic proves both sides: a mapped PE-derived guest entry executes and returns cleanly with the expected PPC result, while a deliberate indirect call to an unmapped guest target translates but stops at a runtime dependency boundary instead of being mislabeled as successful execution.

Run 348 also replays the complete existing stack successfully: STFS/XEX, NONE/BASIC/NORMAL preparation, retail session-key/AES-CBC, upstream Xenia LZX, strict PE metadata, PE-to-guest mapping, prepared-entry handoff, one-call `default.xex`, one-call STFS package handoff, PPC/HIR, WasmBackend and SparseGuestMemory.

The next kernel-facing implementation is already in flight: Xenia-compatible XEX import-library decoding. The dedicated `xboxkrnl.exe` / `xam.xex` import critic has passed its early step in Run 350; aggregate promotion waits for the full run.

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
```

These percentages close defined CI contracts. They do **not** mean universal Xbox 360 compatibility.

## What Run 348 proves

```text
STFS package
   ↓
default.xex reconstruction
   ↓
retail image preparation
   ↓
strict PE decode + guest section mappings
   ↓
PE-derived entry PC
   ↓
bytes read from SparseGuestMemory
   ↓
Xenia PPC scanner / frontend / finalized HIR
   ↓
controlled HIR execution
   ├── clean guest return → reported as return
   └── unresolved guest call boundary → reported as runtime dependency
```

The runtime-boundary critic uses changed keys and relocated Xbox image bases elsewhere in the stack, and the unresolved-call workload deliberately targets an unmapped guest address so a broad success stub cannot pass.

This is still controlled test content. It is **not yet a claim that a commercial title has booted**.

## Public progress board

```text
OVERALL RENDER360
██████████░░░░░░░░░░  ~50%  weighted engineering estimate

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
████████████░░░░░░░░  ← ACTIVE; critic step PASS, aggregate pending
KERNEL / xboxkrnl / XAM
██░░░░░░░░░░░░░░░░░░  ← NEXT AFTER IMPORT GATE
GUEST THREADS / TLS / RUNTIME
░░░░░░░░░░░░░░░░░░░░
XENOS SEMANTIC LAYER
░░░░░░░░░░░░░░░░░░░░
WEBGPU / WGSL / EDRAM
░░░░░░░░░░░░░░░░░░░░
WEBGL2 FALLBACK
░░░░░░░░░░░░░░░░░░░░
FIRST GENUINE GUEST FRAME
░░░░░░░░░░░░░░░░░░░░
```

Partial bars are planning indicators only. A subsystem reaches 100% only when its exact aggregate critic is green.

## Active implementation — XEX imports into minimum kernel HLE

The title controller now owns the point where XEX import metadata can be joined to runtime-boundary telemetry:

```text
user-supplied STFS / default.xex
  → XEX import-library table
  → identify xboxkrnl.exe / xam.xex / other modules
  → import table entries / thunk addresses
  → execute title entry
  → unresolved guest call
  → match call/thunk to imported module + ordinal
  → FIRST_RUNTIME_BLOCKER=<module, ordinal, guest address>
  → implement only that minimum HLE service
```

The import parser follows Xenia's current format: a padded import string table followed by variable-size `xex2_import_library` records. Malformed string indexes, sizes and tables fail closed.

No copyrighted title binary belongs in this repository. Genuine-title testing consumes legally obtained runtime content supplied by the user.

## After the first imported service

The real title chooses the implementation order: `xboxkrnl` export → minimum required HLE; XAM → minimum XAM surface; TLS/thread creation → guest runtime; heap/virtual memory → required memory services; VFS → browser-backed filesystem; GPU initialization → Xenos command/ringbuffer work.

The rendering path remains:

```text
Guest PPC title execution
  → minimum runtime services
  → Xenos packets / ringbuffer
  → command processor
  → shared Xenos semantics
  → shaders / registers / resources
  → EDRAM / render targets
  → WebGPU + WGSL primary
  → WebGL2 fallback where practical
  → FIRST GENUINE GUEST FRAME
```

The first-frame milestone should be a tiny guest-generated graphics workload whose PPC/Xenos work reaches the emulator graphics path. A browser-side WebGPU triangle by itself does **not** count as a guest frame.

Once the first genuine frame exists, keep that workload permanently in CI and then optimize aggressively: compiled Wasm reuse, VMX/Wasm SIMD, fewer JS↔Wasm transitions, streamed title data, workers/shared queues where isolation permits, low internal resolution, shader/resource caches and EDRAM traffic optimization.

Portal and Portal 2 remain later compatibility targets. The immediate target is **real import discovery → minimum kernel/runtime → Xenos → first guest frame**.

## Repository organization

- `src/xenia_web_bootstrap/` — active browser-native title bring-up and verified integration layers.
- `src/xenia_web_shims/` — browser/WASM portability shims.
- `retail-xex-image-pipeline.mjs` — unified retail NONE/BASIC/NORMAL preparation adapter.
- `render360-xex-imports.mjs` — Xenia-compatible XEX import-library parser.
- `render360-title-controller.mjs` — one-call `default.xex` preparation/map/entry execution telemetry.
- `render360-package-controller.mjs` — one-call STFS package extraction through title handoff.
- `xenia_port/` — older port surface retained until migration is safe.
- `docs/` — maintained project/release documentation.
- `.github/workflows/` — aggregate regression gates.

See [`ROADMAP.md`](ROADMAP.md), [`docs/releases/V36_BRINGUP.md`](docs/releases/V36_BRINGUP.md), and [`docs/PROJECT_LAYOUT.md`](docs/PROJECT_LAYOUT.md).

## Engineering rule

Never report `REAL TITLE ENTRY`, `FIRST DRAW`, `FIRST PRESENT`, `PLAYABLE`, title FPS or title boot unless that event came from genuine execution through the corresponding emulator subsystem.

## License

Xenia-derived portions remain subject to upstream Xenia licensing terms. See [`LICENSE_XENIA.txt`](LICENSE_XENIA.txt).
