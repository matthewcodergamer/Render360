# Render360 Xenia-Web — V36

**Browser-native Xbox 360 emulation research project built around Xenia-derived PPC translation and WebAssembly execution.**

> **This root `README.md` is the authoritative public status board.** Historical release notes and foundation documents are supporting evidence only.

## Overall project completion

```text
OVERALL RENDER360 — WEIGHTED ENGINEERING ESTIMATE
█████████░░░░░░░░░░░  ~43%
```

The overall percentage is an engineering estimate, not a title-compatibility score. CPU/WASM, package, sparse-memory and much of the XEX bring-up path are closed; genuine extracted-title execution, kernel/XAM/runtime behavior, Xenos, EDRAM, WebGPU presentation and title compatibility remain the largest risks.

## Latest authoritative gate

**Run 315 — Actions ID `33224960329` — SUCCESS**

Implementation commit: `4ad739c56d2c4032dbc8329b5c5594e17def8ce7`

Run 315 closes the Run-312 `load-at-entry failed 0` regression without weakening the critic. The decoder-derived guest base is published before the bounded Xenia wasm32 Memory/Processor bootstrap is initialized, allowing prepared PPC bytes to be loaded and translated at relocated Xbox addresses.

The aggregate gate also replayed the existing foundations successfully, including **77/77 wasm32 translation units**, strict link, upstream Xenia LZX, XEX session-key/AES-CBC semantics, WasmBackend, SparseGuestMemory and the V36 XEX mapper.

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
UNENCRYPTED NORMAL → PREPARED ENTRY PIPELINE     100% ✓
```

These percentages close defined CI contracts. They do **not** mean universal Xbox 360 compatibility.

## What Run 315 proves

```text
valid XEX-style metadata
        ↓
NORMAL block/hash/chunk framing
        ↓
upstream Xenia LZX in wasm32
        ↓
exact prepared executable bytes
        ↓
decoder-derived guest mapping
        ↓
relocated Xbox entry address
        ↓
Xenia PPC scanner / frontend / HIR
        ↓
prepared PPC entry translated/executed
```

The critic exercises more than one relocated guest base and keeps corrupt framing/LZX cases fail closed. This is a real cross-module integration contract, but its test image is still controlled test content; it is **not yet a claim that an extracted commercial `default.xex` has booted**.

## Public progress board

```text
OVERALL RENDER360
█████████░░░░░░░░░░░  ~43%  weighted engineering estimate

CPU / WASM / MEMORY FOUNDATIONS
████████████████████  100% ✓
PACKAGE + STFS + XEX METADATA
████████████████████  100% ✓
XEX MAPPER / SPARSE-MEMORY INTEGRATION
████████████████████  100% ✓
NONE / BASIC / NORMAL FRAMING / LZX
████████████████████  100% ✓
XEX SESSION-KEY / AES-CBC FOUNDATION
████████████████████  100% ✓
UNENCRYPTED NORMAL PREPARED-ENTRY PIPELINE
████████████████████  100% ✓

FULL RETAIL XEX IMAGE PREPARATION
█████████████████░░░  ~85%  planning estimate; combined encrypted path + DELTA remain
REAL EXTRACTED TITLE ENTRY EXECUTION
█████░░░░░░░░░░░░░░░  ← ACTIVE NEXT
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

## Active implementation — genuine extracted-title handoff

The next milestone stops expanding synthetic CPU tests and connects the completed pieces to title content supplied by the user at runtime:

```text
STFS package
  → extract default.xex
  → decode XEX2 metadata
  → prepare executable image
  → decode PE/section layout as required
  → stream sections into SparseGuestMemory
  → apply final RX / R / RW permissions
  → validate genuine XEX entry PC
  → construct initial PPCContext
  → Xenia PPCScanner / frontend / finalized HIR
  → Hot WasmBackend
  → execute until first unresolved runtime dependency
  → FAIL CLOSED + report exact dependency
```

No copyrighted title binary belongs in this repository. A genuine-title gate must consume legally obtained content supplied at runtime and report the first actual blocker instead of hiding it behind broad success stubs.

## What comes after the first genuine failure

The failure decides the next implementation: `xboxkrnl` import → minimum required HLE export; XAM → minimum XAM surface; TLS/thread creation → guest runtime; VFS → browser-backed filesystem; GPU initialization → Xenos command/ringbuffer work.

The rendering path remains:

```text
Xenos command processor
  → shared Xenos semantics
  → shaders / registers / resources
  → EDRAM / render targets
  → WebGPU + WGSL primary
  → WebGL2 fallback where practical
  → FIRST GENUINE GUEST FRAME
```

Performance optimization follows genuine execution: keep hot loops in Wasm, use Wasm SIMD for VMX, preserve compiled-function caching/invalidation, minimize JS↔Wasm crossings, stream large title data, use workers/shared queues where browser isolation allows, and begin rendering at a low internal resolution before heavier visual features.

Portal and Portal 2 remain later compatibility targets. The immediate target is **genuine extracted title instructions → first real runtime failure → Xenos → first guest frame**.

## Repository organization

- `src/xenia_web_bootstrap/` — active browser-native title bring-up and verified integration layers.
- `src/xenia_web_shims/` — browser/WASM portability shims.
- `xenia_port/` — older port surface retained until migration is safe.
- `docs/` — maintained project/release documentation.
- `.github/workflows/` — aggregate regression gates.

See [`ROADMAP.md`](ROADMAP.md), [`docs/releases/V36_BRINGUP.md`](docs/releases/V36_BRINGUP.md), and [`docs/PROJECT_LAYOUT.md`](docs/PROJECT_LAYOUT.md).

## Engineering rule

Never report `REAL TITLE ENTRY`, `FIRST DRAW`, `FIRST PRESENT`, `PLAYABLE`, title FPS or title boot unless that event came from genuine execution through the corresponding emulator subsystem.

## License

Xenia-derived portions remain subject to upstream Xenia licensing terms. See [`LICENSE_XENIA.txt`](LICENSE_XENIA.txt).
