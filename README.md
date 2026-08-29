# Render360 Xenia-Web — V36

**Browser-native Xbox 360 emulation research project built around Xenia-derived PPC translation and WebAssembly execution.**

> **This root `README.md` is the authoritative public status board.** Historical release notes and foundation documents are supporting evidence only.

## Overall project completion

```text
OVERALL RENDER360 — WEIGHTED ENGINEERING ESTIMATE
█████████░░░░░░░░░░░  ~46%
```

The overall percentage is an engineering estimate, not a title-compatibility score. CPU/WASM, package, sparse-memory, ordinary retail XEX preparation, strict PE loading and the controlled PE-entry handoff are closed CI contracts. Genuine extracted-title execution, kernel/XAM/runtime behavior, Xenos, EDRAM, WebGPU presentation and title compatibility remain the largest risks.

## Latest authoritative gate

**Run 338 — Actions ID `33227956792` — SUCCESS**

Aggregate commit: `ffee353216d248618d6bb30781a0dbe724046cfa`

Run 338 closes ordinary retail XEX image preparation across encrypted **NONE, BASIC and NORMAL** paths. The reusable `retail-xex-image-pipeline.mjs` validates XEX metadata, derives the title session key with Xenia-compatible retail/devkit AES semantics, decrypts the executable body with streaming AES-128-CBC, then routes the post-decryption bytes through the existing NONE, BASIC or NORMAL preparation path. NORMAL continues through the upstream Xenia LZX wasm32 decoder and is checked against the exact expected prepared image.

The same aggregate gate also replays the PE loader and the Run-335 prepared-PE entry handoff: bytes are loaded through strict PE section metadata into SparseGuestMemory, read back at the PE-derived executable entry, and fed into the relocated Xenia PPC scanner/frontend/HIR path. The handoff critic repeats at multiple Xbox guest bases so a hard-coded entry cannot pass.

DELTA compression remains a distinct patch-image feature and is intentionally fail-closed. It is not counted as ordinary retail executable preparation.

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
```

These percentages close defined CI contracts. They do **not** mean universal Xbox 360 compatibility.

## What Run 338 proves

```text
XEX2 metadata
   ↓
encryption/compression routing
   ↓
retail/devkit session-key derivation
   ↓
streaming AES-128-CBC executable-body decryption
   ↓
NONE ───────────────→ exact prepared image
BASIC ──────────────→ data + zero-fill prepared image
NORMAL → framing → upstream Xenia LZX → exact prepared image
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

The retail critic changes session keys, ciphertext and guest bases to prevent a fixed-vector or fixed-address implementation from passing. Corrupt or unsupported formats remain fail closed.

This is still controlled test content. It is **not yet a claim that an extracted commercial `default.xex` has booted**.

## Public progress board

```text
OVERALL RENDER360
█████████░░░░░░░░░░░  ~46%  weighted engineering estimate

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

REAL EXTRACTED TITLE HANDOFF / ENTRY
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

## Active implementation — one-call genuine extracted-title handoff

The next milestone replaces manual test-to-test wiring with one runtime controller around user-supplied title content:

```text
user-supplied STFS package / default.xex
  → full STFS extraction
  → XEX2 decode
  → choose NONE / BASIC / NORMAL preparation
  → decrypt retail body when required
  → strict PE decode
  → prepared PE section loader
  → SparseGuestMemory RX / R / RW mappings
  → genuine decoded entry PC
  → initial PPCContext
  → Xenia PPCScanner / frontend / finalized HIR
  → Hot WasmBackend cache / dispatch
  → execute genuine title instructions
  → FIRST_RUNTIME_BLOCKER=<exact dependency>
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
- `retail-xex-image-pipeline.mjs` — unified retail NONE/BASIC/NORMAL preparation adapter.
- `xenia_port/` — older port surface retained until migration is safe.
- `docs/` — maintained project/release documentation.
- `.github/workflows/` — aggregate regression gates.

See [`ROADMAP.md`](ROADMAP.md), [`docs/releases/V36_BRINGUP.md`](docs/releases/V36_BRINGUP.md), and [`docs/PROJECT_LAYOUT.md`](docs/PROJECT_LAYOUT.md).

## Engineering rule

Never report `REAL TITLE ENTRY`, `FIRST DRAW`, `FIRST PRESENT`, `PLAYABLE`, title FPS or title boot unless that event came from genuine execution through the corresponding emulator subsystem.

## License

Xenia-derived portions remain subject to upstream Xenia licensing terms. See [`LICENSE_XENIA.txt`](LICENSE_XENIA.txt).
