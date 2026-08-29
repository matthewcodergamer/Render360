# Render360 Xenia-Web — V36

**Browser-native Xbox 360 emulation research project built around Xenia-derived PPC translation and WebAssembly execution.**

> **This root `README.md` is the authoritative public status board.** Historical release notes and foundation documents are supporting evidence only.

## Overall project completion

```text
OVERALL RENDER360 — WEIGHTED ENGINEERING ESTIMATE
██████████░░░░░░░░░░  ~52%
```

The overall percentage is an engineering estimate, not a title-compatibility score. CPU/WASM, sparse memory, package/STFS extraction, retail XEX preparation, strict PE loading, package-to-entry handoff, controlled entry execution, XEX import discovery, the automatic kernel-execution bridge, and the minimum PPC↔kernel ABI contract are now closed CI contracts. Real xboxkrnl/XAM service coverage, guest threads/TLS, Xenos, EDRAM, WebGPU presentation and title compatibility remain major implementation work.

## Latest authoritative gate

**Run 373 — Actions ID `33235084799` — SUCCESS**

Aggregate commit: `2a860d2aacc0e21a1d9fcda39d46d8df99c79e8a`

Run 373 closes the **minimum kernel ABI contract** under an independent harsh critic. The implementation is not allowed to grade itself: a separate `test-kernel-abi-critic.mjs` adversarial gate must pass before promotion, and the complete locked regression matrix must remain green.

The critic proves all of the following through the live PPC/HIR execution path:

- PPC argument flow through `r3`/`r4` into the nested HLE service;
- guest-visible memory mutation through the normal guest load/store path;
- HLE return state flowing back through `r3`;
- translated guest PPC continuing after the HLE return;
- cross-boundary guest-pointer/range rejection;
- 32-bit guest-address wraparound rejection;
- recursive HLE-target rejection;
- exact unsupported module/ordinal blocker telemetry;
- no blanket-success behavior.

Run 373 also replays the complete locked stack successfully: STFS/XEX, NONE/BASIC/NORMAL preparation, retail session-key/AES-CBC, upstream Xenia LZX, strict PE metadata, PE-to-guest mapping, prepared-entry handoff, one-call `default.xex`, one-call STFS package handoff, PPC/HIR, WasmBackend, SparseGuestMemory, runtime-boundary telemetry, PPC→kernel HLE dispatch and automatic XEX-import→kernel execution integration.

This closes the ABI foundation. It does **not** mean every xboxkrnl/XAM API is implemented. The next work is the first real kernel service surface selected by genuine execution blockers, followed by guest runtime/thread/TLS requirements and then Xenos bring-up.

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
```

These percentages close defined CI contracts. They do **not** mean universal Xbox 360 compatibility or complete xboxkrnl/XAM coverage.

## What Run 373 proves

```text
translated guest PPC
   ↓
real PPCContext argument registers
   ↓
registered xboxkrnl / XAM HLE thunk
   ↓
independent HLE ABI service body
   ↓
validated guest pointer/range
   ↓
guest-visible memory read/write
   ↓
r3 return ABI
   ↓
return to translated guest PPC
   ↓
continue execution
   ↓
next exact blocker
```

The critic also deliberately supplies malformed boundary, wraparound, recursive-target and unsupported-import cases. A broad success stub cannot satisfy the gate.

This is still controlled test content. It is **not yet a claim that a commercial title has booted**.

## Critic promotion rule

A subsystem is promoted to 100% only when:

1. its implementation gate is green;
2. an independent adversarial critic proves the exact contract and fail-closed cases;
3. the complete locked regression matrix remains green.

If any of those three conditions fail, the subsystem stays below 100% regardless of how good the happy path looks.

## Public progress board

```text
OVERALL RENDER360
██████████░░░░░░░░░░  ~52%  weighted engineering estimate

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
MINIMUM PPC ↔ KERNEL ABI
████████████████████  100% ✓
INDEPENDENT ABI HARSH CRITIC
████████████████████  100% ✓

REAL xboxkrnl / XAM SERVICES
██░░░░░░░░░░░░░░░░░░  ← ACTIVE: implement only exports reached by genuine execution
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

Partial bars are planning indicators only. A subsystem reaches 100% only when its implementation gate, independent critic and aggregate replay are all green.

## Active implementation — first real kernel services

The ABI bridge is closed. The next controller path is:

```text
user-supplied STFS / default.xex
  → decoded XEX import libraries
  → exact xboxkrnl.exe / xam.xex thunk + ordinal
  → translated guest PPC reaches kernel thunk
  → validated arguments + guest pointers
  → implement only that real HLE export
  → return exact r3 / NTSTATUS / guest-visible state
  → continue translated guest PPC
  → stop at the next exact missing dependency
```

Genuine execution chooses the service order: thread/TLS, heap/virtual memory, filesystem, XAM startup, synchronization, time, or whichever dependency appears first. Each newly promoted service layer should receive its own adversarial critic rather than relying only on a happy-path test.

No copyrighted title binary belongs in this repository. Genuine-title testing consumes legally obtained runtime content supplied by the user.

## Road to the first genuine frame

```text
Guest PPC title execution
  → first real xboxkrnl/XAM services
  → guest threads / TLS / runtime
  → Xenos packets / ringbuffer
  → command processor
  → shared Xenos semantic layer
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
- `test-kernel-abi-critic.mjs` — independent adversarial judge for the minimum PPC↔kernel ABI contract.
- `xenia_port/` — older port surface retained until migration is safe.
- `docs/` — maintained project/release documentation.
- `.github/workflows/` — aggregate regression gates.

See [`ROADMAP.md`](ROADMAP.md), [`docs/releases/V36_BRINGUP.md`](docs/releases/V36_BRINGUP.md), and [`docs/PROJECT_LAYOUT.md`](docs/PROJECT_LAYOUT.md).

## Engineering rule

Never report `REAL TITLE ENTRY`, `FIRST DRAW`, `FIRST PRESENT`, `PLAYABLE`, title FPS or title boot unless that event came from genuine execution through the corresponding emulator subsystem.

## License

Xenia-derived portions remain subject to upstream Xenia licensing terms. See [`LICENSE_XENIA.txt`](LICENSE_XENIA.txt).
