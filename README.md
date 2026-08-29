# Render360 Xenia-Web — V36

**Browser-native Xbox 360 emulation research project built around Xenia-derived PPC translation and WebAssembly execution.**

> **This root `README.md` is the authoritative public status board.** Historical release notes and foundation documents are supporting evidence only.

## Overall project completion

```text
OVERALL RENDER360 — WEIGHTED ENGINEERING ESTIMATE
██████████░░░░░░░░░░  ~48%
```

The overall percentage is an engineering estimate, not a title-compatibility score. CPU/WASM, package/STFS extraction, sparse memory, ordinary retail XEX preparation, strict PE loading and the controlled package-to-entry handoff are now closed CI contracts. Genuine runtime dependency handling, kernel/XAM services, guest threads/TLS, Xenos, EDRAM, WebGPU presentation and title compatibility remain the largest risks.

## Latest authoritative gate

**Run 342 — Actions ID `33231158003` — SUCCESS**

Aggregate commit: `04bab276e98efdf41f16913fa666997b0cd93692`

Run 342 closes the first one-call package-to-entry controller. A complete controlled STFS package is mounted through the pull-driven package reader, `default.xex` is discovered and reconstructed, the XEX is routed through the verified encrypted retail preparation path, the prepared Xbox PE image is mapped into `SparseGuestMemory`, and bytes are read back from the decoder-derived executable entry before entering Xenia's PPC scanner/frontend/finalized HIR path.

Run 341 immediately before it closed the direct one-call `default.xex` controller after Run 340 correctly rejected a malformed test fixture whose XEX image span did not contain the PE-derived entry. The critic was fixed by correcting the fixture's declared image span; the decoder was not weakened.

Run 342 also replays the complete existing stack successfully: STFS/XEX, NONE/BASIC/NORMAL preparation, retail session-key/AES-CBC, upstream Xenia LZX, strict PE metadata, PE-to-guest mapping, prepared-entry handoff, PPC/HIR, WasmBackend and SparseGuestMemory.

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
```

These percentages close defined CI contracts. They do **not** mean universal Xbox 360 compatibility.

## What Run 342 proves

```text
STFS package bytes
   ↓
pull-driven mount / directory walk
   ↓
exact default.xex reconstruction
   ↓
XEX2 header/body split
   ↓
retail NONE / BASIC / NORMAL preparation
   ↓
session-key + streaming AES-CBC where required
   ↓
NORMAL framing + upstream Xenia LZX where required
   ↓
strict Xbox PE decode
   ↓
PE section bytes → SparseGuestMemory RX / R / RW mappings
   ↓
PE-derived executable entry
   ↓
bytes read back from mapped guest memory
   ↓
Xenia PPC scanner / frontend / finalized HIR
```

The controller critic repeats with changed keys and relocated Xbox image bases so fixed ciphertext, fixed prepared bytes or a hard-coded guest address cannot pass.

This is still controlled test content. It is **not yet a claim that a commercial title has booted**.

## Public progress board

```text
OVERALL RENDER360
██████████░░░░░░░░░░  ~48%  weighted engineering estimate

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

ENTRY EXECUTION / FIRST RUNTIME BLOCKER
████████░░░░░░░░░░░░  ← ACTIVE NEXT
KERNEL / xboxkrnl / XAM
░░░░░░░░░░░░░░░░░░░░
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

## Active implementation — execution telemetry and exact blocker

The next milestone extends the now-closed package controller beyond successful translation:

```text
user-supplied STFS package / default.xex
  → verified package/XEX preparation
  → verified PE guest mapping
  → genuine decoded entry PC
  → initial PPCContext
  → Xenia PPCScanner / frontend / finalized HIR
  → Hot WasmBackend cache / dispatch
  → execute entry instructions
  → FIRST_RUNTIME_BLOCKER=<exact dependency or boundary>
```

The controller must expose execution status and the exact first unsupported dependency. A clean guest return in a controlled workload must be distinguishable from an unresolved call, unsupported HIR operation, missing xboxkrnl/XAM import, TLS/thread setup, memory/VFS request or the first GPU/Xenos initialization boundary.

No copyrighted title binary belongs in this repository. Genuine-title testing consumes legally obtained runtime content supplied by the user.

## What comes after the first genuine failure

The failure chooses the implementation order: `xboxkrnl` import → minimum required HLE export; XAM → minimum XAM surface; TLS/thread creation → guest runtime; heap/virtual memory → required memory services; VFS → browser-backed filesystem; GPU initialization → Xenos command/ringbuffer work.

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

Once the first genuine frame exists, keep that guest-frame workload permanently in CI and then optimize aggressively: compiled Wasm reuse, VMX/Wasm SIMD, fewer JS↔Wasm transitions, streamed title data, workers/shared queues where isolation permits, low internal resolution, shader/resource caches and EDRAM traffic optimization.

Portal and Portal 2 remain later compatibility targets. The immediate target is **genuine entry execution → exact first runtime blocker → minimum runtime → Xenos → first guest frame**.

## Repository organization

- `src/xenia_web_bootstrap/` — active browser-native title bring-up and verified integration layers.
- `src/xenia_web_shims/` — browser/WASM portability shims.
- `retail-xex-image-pipeline.mjs` — unified retail NONE/BASIC/NORMAL preparation adapter.
- `render360-title-controller.mjs` — one-call `default.xex` preparation/map/entry handoff.
- `render360-package-controller.mjs` — one-call STFS package extraction through title handoff.
- `xenia_port/` — older port surface retained until migration is safe.
- `docs/` — maintained project/release documentation.
- `.github/workflows/` — aggregate regression gates.

See [`ROADMAP.md`](ROADMAP.md), [`docs/releases/V36_BRINGUP.md`](docs/releases/V36_BRINGUP.md), and [`docs/PROJECT_LAYOUT.md`](docs/PROJECT_LAYOUT.md).

## Engineering rule

Never report `REAL TITLE ENTRY`, `FIRST DRAW`, `FIRST PRESENT`, `PLAYABLE`, title FPS or title boot unless that event came from genuine execution through the corresponding emulator subsystem.

## License

Xenia-derived portions remain subject to upstream Xenia licensing terms. See [`LICENSE_XENIA.txt`](LICENSE_XENIA.txt).
