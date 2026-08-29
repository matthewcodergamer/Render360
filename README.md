# Render360 Xenia-Web — V36

**Browser-native Xbox 360 emulation research project built around Xenia-derived PPC translation and WebAssembly execution.**

> **This root `README.md` is the authoritative public status board.** Historical release notes and foundation documents are supporting evidence only.

## Overall project completion

```text
OVERALL RENDER360 — WEIGHTED ENGINEERING ESTIMATE
██████████░░░░░░░░░░  ~50%
```

The overall percentage is an engineering estimate, not a title-compatibility score. CPU/WASM, sparse memory, package/STFS extraction, retail XEX preparation, strict PE loading, package-to-entry handoff, controlled entry execution, XEX import discovery and the first automatic kernel-execution bridge are now closed CI contracts. Full xboxkrnl/XAM service coverage, guest threads/TLS, Xenos, EDRAM, WebGPU presentation and title compatibility remain major implementation work.

## Latest authoritative gate

**Run 369 — Actions ID `33232933395` — SUCCESS**

Aggregate commit: `2c190baaa129b97f66ddfcbf6a4b4e3c75d8f8ed`

Run 369 closes the **kernel execution foundation** for the controlled bring-up path. The aggregate gate proves that XEX import records are decoded through real PE RVA mapping, paired into function descriptors/thunks, registered automatically with the Wasm kernel bridge, and reached from translated PPC execution.

The kernel critic proves both sides:

- a registered implemented kernel thunk returns through the PPC execution path and guest execution continues to a clean return;
- an unimplemented kernel thunk stops fail-closed and reports the exact imported module, ordinal and thunk address instead of being mislabeled as a generic runtime failure.

Run 369 also replays the complete locked stack successfully: STFS/XEX, NONE/BASIC/NORMAL preparation, retail session-key/AES-CBC, upstream Xenia LZX, strict PE metadata, PE-to-guest mapping, prepared-entry handoff, one-call `default.xex`, one-call STFS package handoff, PPC/HIR, WasmBackend, SparseGuestMemory, runtime-boundary telemetry, PPC→kernel HLE dispatch and automatic XEX-import→kernel execution integration.

This closes the bridge into kernel HLE. It does **not** mean every xboxkrnl/XAM API is implemented. The next work is the minimum real kernel ABI/service surface selected by the first genuine title blocker.

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
```

These percentages close defined CI contracts. They do **not** mean universal Xbox 360 compatibility or complete xboxkrnl/XAM coverage.

## What Run 369 proves

```text
STFS package / default.xex
   ↓
retail XEX preparation
   ↓
strict PE decode + guest section mapping
   ↓
XEX import-library decode
   ↓
guest VA → RVA → PE section → raw offset
   ↓
import descriptor / thunk pairing
   ↓
automatic kernel-thunk registration
   ↓
PE-derived guest entry PC
   ↓
Xenia PPC scanner / frontend / finalized HIR
   ↓
controlled execution
   ├── implemented kernel thunk → return → continue guest execution
   └── unimplemented kernel thunk → exact module + ordinal + thunk blocker
```

The critics use controlled synthetic title content and fail-closed malformed/unbacked mapping cases. No broad success stub can satisfy the contract.

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
████████████████████  100% ✓
KERNEL EXECUTION FOUNDATION
████████████████████  100% ✓

MINIMUM xboxkrnl / XAM ABI + SERVICES
████░░░░░░░░░░░░░░░░  ← ACTIVE: implement only services reached by real execution
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

## Active implementation — minimum kernel ABI and first real services

The bridge is closed. The next controller path is:

```text
user-supplied STFS / default.xex
  → decoded XEX import libraries
  → exact xboxkrnl.exe / xam.xex thunk + ordinal
  → translated guest PPC reaches kernel thunk
  → dispatch through shared PPCContext
  → execute the minimum implemented HLE service
  → return ABI result to guest
  → continue guest instructions
  → stop at the next exact missing dependency
```

The immediate ABI contracts are integer return values/NTSTATUS through `r3`, argument passing through the PPC GPR ABI, guest pointer/range validation against sparse memory, and exact fail-closed handling for unsupported exports. After that, genuine title execution chooses the service order: thread/TLS, heap/virtual memory, filesystem, XAM startup, or whichever dependency appears first.

No copyrighted title binary belongs in this repository. Genuine-title testing consumes legally obtained runtime content supplied by the user.

## Road to the first genuine frame

```text
Guest PPC title execution
  → minimum xboxkrnl/XAM services
  → guest threads / TLS / runtime
  → Xenos packets / ringbuffer
  → command processor
  → shared Xenos semantics
  → shaders / registers / resources
  → EDRAM / render targets
  → WebGPU + WGSL primary
  → WebGL2 fallback where practical
  → FIRST GENUINE GUEST FRAME
```

The first-frame milestone must originate from guest GPU work. A browser-side WebGPU triangle by itself does **not** count as a guest frame.

Once the first genuine frame exists, keep that workload permanently in CI and optimize from real traces: compiled Wasm reuse, VMX/Wasm SIMD, fewer JS↔Wasm transitions, streamed title data, workers/shared queues where isolation permits, low internal resolution, shader/resource caches and EDRAM traffic optimization.

A smaller homebrew/XBLA-class title remains the sensible first genuine bring-up target before larger Portal-class software.

## Repository organization

- `src/xenia_web_bootstrap/` — active browser-native title bring-up, execution and kernel bridge layers.
- `src/xenia_web_shims/` — browser/WASM portability shims.
- `retail-xex-image-pipeline.mjs` — unified retail NONE/BASIC/NORMAL preparation adapter.
- `render360-xex-imports.mjs` — Xenia-compatible XEX import-library parser.
- `render360-kernel-imports.mjs` — import descriptor/thunk planning and kernel blocker identification.
- `render360-title-controller.mjs` — one-call `default.xex` preparation, mapping, import registration and entry execution telemetry.
- `render360-package-controller.mjs` — one-call STFS package extraction through title handoff.
- `xenia_port/` — older port surface retained until migration is safe.
- `docs/` — maintained project/release documentation.
- `.github/workflows/` — aggregate regression gates.

See [`ROADMAP.md`](ROADMAP.md), [`docs/releases/V36_BRINGUP.md`](docs/releases/V36_BRINGUP.md), and [`docs/PROJECT_LAYOUT.md`](docs/PROJECT_LAYOUT.md).

## Engineering rule

Never report `REAL TITLE ENTRY`, `FIRST DRAW`, `FIRST PRESENT`, `PLAYABLE`, title FPS or title boot unless that event came from genuine execution through the corresponding emulator subsystem.

## License

Xenia-derived portions remain subject to upstream Xenia licensing terms. See [`LICENSE_XENIA.txt`](LICENSE_XENIA.txt).
