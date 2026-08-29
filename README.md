# Render360 Xenia-Web — V36

**Browser-native Xbox 360 emulation research project built around Xenia-derived PPC translation and WebAssembly execution.**

> **This root `README.md` is the authoritative public status board.** Historical release notes and foundation documents are supporting evidence only.

## Overall project completion

```text
OVERALL RENDER360 — WEIGHTED ENGINEERING ESTIMATE
████████████░░░░░░░░  ~60%
```

The overall percentage is an engineering estimate, not a title-compatibility score. CPU/WASM, sparse memory, package/STFS extraction, retail XEX preparation, strict PE loading, package-to-entry handoff, controlled entry execution, import discovery, kernel dispatch/ABI, the bounded first-frame xboxkrnl/XAM starter-service surface, and the bounded guest thread/TLS/runtime foundation are now closed CI contracts. Xenos semantics, EDRAM, shader/resource translation, WebGPU presentation, browser VFS expansion, later title-specific kernel APIs and title compatibility remain major implementation work.

## Latest authoritative gate

**Run 379 — Actions ID `33236768472` — SUCCESS**

Aggregate commit: `a350df341289352326bfe188ce58460a17ce8414`

Run 379 closes the two remaining bounded pre-GPU foundations in the **main strict Xenia wasm**, not in a sidecar build:

- **REAL xboxkrnl / XAM STARTER SERVICES — 100% ✓** for the explicitly tested first-frame service surface;
- **GUEST THREADS / TLS / RUNTIME FOUNDATION — 100% ✓** for the explicitly tested cooperative runtime contract.

The runtime/service implementation is compiled into `xenia_ppc_bootstrap.wasm`, exported by the strict linker, judged by two independent harsh critics against that same main wasm, and followed by the complete locked regression replay.

The service critic proves Xenia-matched starter semantics for `KeQueryPerformanceFrequency`, `RtlLowerChar`, `RtlUpperChar`, `KeTlsAlloc`, `KeTlsFree`, `KeTlsGetValue`, `KeTlsSetValue`, and the bounded XAM `XGetLanguage` starter path. Unknown modules/ordinals fail closed instead of becoming blanket success.

The runtime critic proves generation-tagged guest thread handles, deterministic stack alignment, per-thread TLS isolation, suspend/resume/current-thread transitions, termination/exit telemetry, stale-handle rejection, TLS exhaustion/free behavior, and a bounded cooperative runnable-thread selection path.

Run 379 also replays every earlier package/XEX, retail image preparation, PE mapping, PPC/HIR, WasmBackend, SparseGuestMemory, kernel import/ABI and harsh-critic gate successfully.

**Scope warning:** 100% here means the exact first-frame runtime contracts above are closed. It does **not** mean every xboxkrnl/XAM export, every scheduler primitive, every synchronization object or every commercial title requirement is implemented. A later title requesting an export outside this surface becomes a new exact blocker.

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
```

These percentages close defined CI contracts. They do **not** mean universal Xbox 360 compatibility or complete xboxkrnl/XAM coverage.

## Critic promotion rule

A subsystem is promoted to 100% only when:

1. the implementation is finished for a bounded, written contract;
2. its implementation test is green;
3. an independent adversarial critic proves the contract and fail-closed cases;
4. the complete locked regression matrix remains green.

The critic is the final judge, not the main development loop. Build the subsystem first; run the critic after the implementation is complete enough to be judged.

## Public progress board

```text
OVERALL RENDER360
████████████░░░░░░░░  ~60%  weighted engineering estimate

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

XENOS SEMANTIC LAYER
██░░░░░░░░░░░░░░░░░░  ← ACTIVE: first guest GPU packets / ringbuffer / command semantics
WEBGPU / WGSL / EDRAM
░░░░░░░░░░░░░░░░░░░░
WEBGL2 FALLBACK
░░░░░░░░░░░░░░░░░░░░
FIRST GENUINE GUEST FRAME
░░░░░░░░░░░░░░░░░░░░
```

Partial bars are planning indicators only. A subsystem reaches 100% only after its bounded implementation and critics are green.

## Active implementation — Xenos to first guest frame

The main pre-GPU bring-up chain is now closed far enough to make the GPU boundary the primary development target:

```text
user-supplied title / controlled guest workload
  → package / XEX / PE preparation
  → PPC / HIR / Wasm execution
  → bounded kernel services + guest thread/TLS runtime
  → first Xenos packet / register traffic
  → ringbuffer / command processor
  → shader + resource semantics
  → EDRAM / render targets
  → WebGPU / WGSL
  → FIRST GENUINE GUEST-PRODUCED FRAME
```

The first frame must originate from guest GPU work. A JavaScript or browser-side triangle by itself does not count.

Additional xboxkrnl/XAM, filesystem, synchronization or runtime behavior is added when genuine execution demands it. Those later additions do not retroactively invalidate the closed first-frame foundation; they become new title-compatibility contracts with their own critics.

## ISO / GOD input direction

Render360 should not require ISO2GOD. The intended browser input architecture is:

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

Large disc images should be mounted virtually and read in bounded ranges rather than copied wholesale into Wasm memory. ISO/XDVDFS remains a future input-layer milestone and is separate from the current Xenos-first-frame push.

## Road to playable software

```text
Xenos packets / ringbuffer
  → command processor
  → shared Xenos semantics
  → shaders / registers / resources
  → EDRAM / render targets
  → WebGPU + WGSL primary
  → FIRST GENUINE GUEST FRAME
  → permanent first-frame regression critic
  → performance work from real traces
  → small homebrew / XBLA-class bring-up
  → Braid-class target
  → Portal-class bring-up
  → Portal 2-class bring-up
```

Once the first genuine frame exists, optimize from measured traces: compiled Wasm reuse, VMX/Wasm SIMD, fewer JS↔Wasm transitions, streamed title data, workers/shared queues where isolation permits, low internal resolution, shader/resource caches, and EDRAM traffic reduction.

## Repository organization

- `src/xenia_web_bootstrap/` — active browser-native title bring-up, execution, kernel/runtime and GPU-boundary layers.
- `src/xenia_web_bootstrap/kernel_runtime_foundation.cpp` — bounded xboxkrnl/XAM starter services plus guest thread/TLS/runtime foundation.
- `src/xenia_web_shims/` — browser/WASM portability shims.
- `retail-xex-image-pipeline.mjs` — unified retail NONE/BASIC/NORMAL preparation adapter.
- `render360-xex-imports.mjs` — Xenia-compatible XEX import-library parser.
- `render360-kernel-imports.mjs` — import descriptor/thunk planning and kernel blocker identification.
- `render360-title-controller.mjs` — one-call `default.xex` preparation, mapping, import registration and entry execution telemetry.
- `render360-package-controller.mjs` — one-call STFS package extraction through title handoff.
- `test-kernel-abi-critic.mjs` — independent adversarial judge for the minimum PPC↔kernel ABI contract.
- `test-kernel-services-critic.mjs` — independent starter xboxkrnl/XAM service critic.
- `test-guest-runtime-critic.mjs` — independent guest thread/TLS/runtime critic.
- `.github/workflows/kernel-runtime-critics.yml` — fast isolated harsh-critic gate.
- `.github/workflows/xenia-wasm32-bootstrap.yml` — authoritative full-stack replay.

See [`ROADMAP.md`](ROADMAP.md), [`docs/releases/V36_BRINGUP.md`](docs/releases/V36_BRINGUP.md), and [`docs/PROJECT_LAYOUT.md`](docs/PROJECT_LAYOUT.md).

## Engineering rule

Never report `REAL TITLE ENTRY`, `FIRST DRAW`, `FIRST PRESENT`, `PLAYABLE`, title FPS or title boot unless that event came from genuine execution through the corresponding emulator subsystem.

## License

Xenia-derived portions remain subject to upstream Xenia licensing terms. See [`LICENSE_XENIA.txt`](LICENSE_XENIA.txt).
