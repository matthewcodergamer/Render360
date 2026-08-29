# Render360 Xenia-Web — V36

**Browser-native Xbox 360 emulation research project built around Xenia-derived PPC translation and WebAssembly execution.**

> **This root `README.md` is the authoritative public status board.** Historical release notes and foundation documents are supporting evidence only.

## Overall project completion

```text
OVERALL RENDER360 — WEIGHTED ENGINEERING ESTIMATE
█████████░░░░░░░░░░░  ~44%
```

The overall percentage is an engineering estimate, not a title-compatibility score. CPU/WASM, package, sparse-memory and the controlled XEX/PE loading pipeline are substantially closed; genuine extracted-title execution, kernel/XAM/runtime behavior, Xenos, EDRAM, WebGPU presentation and title compatibility remain the largest risks.

## Latest authoritative gate

**Run 328 — Actions ID `33227084124` — SUCCESS**

Aggregate commit: `7383622e60d77c16b3fb6435411ce03847cc0aec`

Run 328 closes the prepared-PE-to-guest-memory boundary. The strict PE decoder now feeds a real loader that derives guest section addresses from `image_base + section RVA`, copies section bytes from the prepared executable, preserves zero-filled virtual tails, converts PE characteristics into final RX/RW guest permissions, and validates the decoder-derived entry before finalization.

The first attempt, Run 326, correctly failed because mapper reset erased the caller-facing staging buffer before the PE decoder consumed it. Commit `01f081fd5b72c48ab24d94c9525e71b6505da644` fixes the contract: mapper reset clears mapping state without destroying staged prepared-image bytes. The critic was not weakened.

Run 328 also replayed the complete existing stack successfully: **79/79 wasm32 translation/bootstrap units**, strict link, upstream Xenia LZX, XEX session-key/AES-CBC semantics, prepared-entry PPC/HIR execution, WasmBackend, SparseGuestMemory and the V36 XEX mapper.

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
STRICT XBOX PE IMAGE DECODER                     100% ✓
PREPARED PE IMAGE → GUEST MEMORY                 100% ✓
```

These percentages close defined CI contracts. They do **not** mean universal Xbox 360 compatibility.

## What Run 328 proves

```text
prepared Xbox PE image
        ↓
strict MZ / PE32 / PPC-BE / Xbox validation
        ↓
real PE section table
        ↓
image_base + section RVA
        ↓
raw section bytes copied from prepared image
        ↓
zero-filled virtual tails preserved
        ↓
PE characteristics → RX / RW guest permissions
        ↓
SparseGuestMemory mappings
        ↓
image_base + entry RVA
        ↓
validated executable guest entry
```

The critic verifies that `.text` bytes really originate in PE raw data, `.data` bytes really originate in PE raw data, RX rejects writes, RW remains writable, virtual tails are zero-filled, and malformed non-readable executable mappings fail closed.

This is still controlled test content. It is **not yet a claim that an extracted commercial `default.xex` has booted**.

## Public progress board

```text
OVERALL RENDER360
█████████░░░░░░░░░░░  ~44%  weighted engineering estimate

CPU / WASM / MEMORY FOUNDATIONS
████████████████████  100% ✓
PACKAGE + STFS + XEX METADATA
████████████████████  100% ✓
XEX PREPARATION / LZX / CRYPTO FOUNDATIONS
████████████████████  100% ✓
STRICT XBOX PE IMAGE DECODE
████████████████████  100% ✓
PREPARED IMAGE → REAL GUEST SECTION MAPPING
████████████████████  100% ✓
UNENCRYPTED NORMAL PREPARED-ENTRY PIPELINE
████████████████████  100% ✓

FULL RETAIL XEX IMAGE PREPARATION
█████████████████░░░  ~85%  planning estimate; combined encrypted path + DELTA remain
REAL EXTRACTED TITLE HANDOFF / ENTRY
██████░░░░░░░░░░░░░░  ← ACTIVE NEXT
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

The next milestone combines the already-verified pieces around title content supplied by the user at runtime:

```text
user-supplied STFS package / default.xex
  → full STFS extraction
  → XEX2 decode
  → image preparation
  → strict PE decode
  → prepared PE section loader
  → SparseGuestMemory RX / R / RW mappings
  → genuine decoded entry PC
  → initial PPCContext
  → Xenia PPCScanner / frontend / finalized HIR
  → Hot WasmBackend cache / dispatch
  → execute genuine title instructions
  → report FIRST_RUNTIME_BLOCKER=<exact dependency>
```

No copyrighted title binary belongs in this repository. The genuine-title gate consumes legally obtained content supplied at runtime and must report the first actual blocker instead of hiding it behind broad success stubs.

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

Portal and Portal 2 remain later compatibility targets. The immediate target is **genuine extracted title instructions → exact first runtime blocker → minimum runtime → Xenos → first guest frame**.

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
