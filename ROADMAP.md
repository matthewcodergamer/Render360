# Render360 Xenia-Web Roadmap — V36

## Project rule

**Port Xenia; do not imitate Xenia.**

Xenia remains the source of truth for Xbox 360 CPU, kernel, and GPU behavior. Render360 owns the browser-native integration: WebAssembly execution, sparse guest memory, browser storage/I/O, workers, WebGPU, WebGL2 fallback, WebAudio, input, PWA behavior, and diagnostics.

The root `README.md` is the authoritative public status board. This roadmap defines implementation order and must not override a newer verified gate recorded there.

## Locked baseline

The eight closed CPU/browser foundations remain locked by **Xenia WASM32 Bootstrap Run 254** on implementation commit:

`3b39da31b6fc3e296e356f7143574951f7fc8861`

```text
PACKAGE / XEX FOUNDATION          100% ✓
PPC TRANSLATION FOUNDATION        100% ✓
SCALAR PPC FOUNDATION             100% ✓
GUEST CONTROL FOUNDATION          100% ✓
FPU FOUNDATION                    100% ✓
VMX / VMX128 FOUNDATION           100% ✓
HOT WASMBACKEND FOUNDATION        100% ✓
SPARSE XBOX MEMORY FOUNDATION     100% ✓
```

These are defined regression contracts, not claims of universal game compatibility.

## V36 mapper closure

The strict XEX guest mapper under `src/xenia_web_bootstrap/xex_guest_mapper.{h,cpp}` is closed by **Xenia WASM32 Bootstrap run 261** (Actions run ID `33212297082`) on implementation commit:

`f602d889293440a4840c3310a8e5fbf07ddc7756`

It proves RX/R/RW mapping, bounded section loading, final permission sealing, overlap/wraparound rejection, executable-entry validation, and post-finalize fail-closed behavior.

This closes the mapper contract, not genuine title entry execution.

## V36 strict STFS `default.xex` extraction closure

The full pull-driven STFS entry extractor is now closed by **Xenia WASM32 Bootstrap run 265** (Actions run ID `33218179582`) on implementation commit:

`0ba0587bc335ad8391f43cdc8c750da36d149005`

The complete aggregate run succeeded, including the rebuilt package/XEX WASM core and all locked Xenia/WasmBackend/XEX-mapper regressions.

The extractor now proves:

```text
root default.xex located                    PASS
fragmented file chain followed              PASS
complete payload reconstructed byte-for-byte PASS
extracted bytes == declared file length     PASS
expected block count == blocks consumed     PASS
declared valid/allocated blocks validated   PASS
24-bit repeated/cyclic block detection      FAIL CLOSED
early/truncated chain                        FAIL CLOSED
out-of-range source request                  FAIL CLOSED
STFS_DEFAULT_XEX_EXTRACT                     PASS
STFS_CHAIN_CYCLE_FAIL_CLOSED                 PASS
STFS_DECLARED_BLOCK_TRUNCATION_FAIL_CLOSED   PASS
```

The implementation remains pull-driven: the browser supplies only requested package ranges through the bounded WASM staging buffer. It does not require another package-sized copy in WebAssembly memory.

## Active milestone — XEX2 image decode / real metadata

The next implementation is now the bridge from the exact extracted `default.xex` bytes into real XEX2 image metadata and then the already-closed mapper:

```text
STFS package
    ↓
full default.xex extraction                  ✓
    ↓
XEX2 header + security/file-format decode    ← ACTIVE
    ↓
supported decrypt/decompress path
    ↓
real image base / entry / page descriptors
    ↓
derive real guest sections + permissions
    ↓
V36 XEX guest mapper                         ✓ component
    ↓
validate genuine XEX entry PC
    ↓
construct PPCContext / initial state
    ↓
Xenia PPCScanner + frontend
    ↓
finalized HIR
    ↓
Hot WasmBackend cache / dispatch
    ↓
execute first genuine title instructions
    ↓
FAIL CLOSED on first missing import / kernel / runtime service
```

### Gate A — STFS full-file extraction — CLOSED

Authoritative gate: run 265 / `0ba0587bc335ad8391f43cdc8c750da36d149005`.

### Gate B — XEX2 image decode and section metadata — ACTIVE

Required output:

```text
XEX2 magic/header                     PASS
header table bounds                   PASS
security-info bounds                  PASS
image base                            VALID
entry point                           VALID
page/section descriptors              VALID
loader/security metadata              VALID
file-format metadata                  VALID
supported compression/decode          PASS
unsupported encryption/compression    FAIL CLOSED
section ranges non-overlapping        PASS
32-bit range/wrap validation          PASS
XEX_IMAGE_DECODE                      PASS
```

Prefer Xenia's existing XEX/XEX2 structures and semantics wherever practical instead of inventing a parallel parser.

### Gate C — real mapper integration

Feed decoded sections into the already-closed V36 mapper:

```text
real section address → map_section
real payload chunks  → load
real permissions     → final protection
real entry PC        → set_entry
                      → finalize
```

The critic must consume XEX-derived metadata rather than hard-coded synthetic addresses.

### Gate D — first entry execution

Construct initial PPC state and send the genuine entry address through Xenia's scanner/frontend/HIR and Hot WasmBackend dispatch. Stop at the first real unresolved dependency and report it explicitly.

Do not add broad success stubs to push execution farther. Missing behavior must fail closed.

## What happens after first failure

The first real failure chooses the roadmap:

```text
unresolved xboxkrnl import → minimum required xboxkrnl HLE/export
unresolved XAM import      → minimum required XAM surface
TLS requirement            → TLS initialization
thread creation            → KernelState / guest thread runtime
heap or virtual memory     → required kernel memory service
filesystem access          → browser-backed VFS path
GPU initialization         → Xenos command/ringbuffer bring-up
```

Only create `src/xenia_web_kernel/` or `src/xenia_web_gpu/` when genuine title execution reaches those boundaries.

## GPU path

After title execution reaches GPU initialization:

```text
Xenos ringbuffer / command processor
        ↓
shared Xenos semantic layer
        ↓
shader + resource + register semantics
        ↓
EDRAM / render-target behavior
        ↓
WebGPU + WGSL primary backend
        ↓
WebGL2 + GLSL ES fallback where feasible
        ↓
first genuine guest-produced framebuffer
```

Three.js may remain useful for host diagnostics but is not guest Xbox rendering.

## Compatibility ladder

```text
8 CPU/browser foundations                ✓ LOCKED
V36 strict XEX mapper contract           ✓ LOCKED
full default.xex STFS extraction         ✓ LOCKED
XEX2 image decode / real metadata        ← ACTIVE
real XEX sections mapped
real XEX entry validated
first title PPC instruction executed
first missing kernel/runtime service
minimum xboxkrnl / XAM
threads / TLS / runtime
first Xenos packets
first guest shader
first guest draw
first guest framebuffer
small XBLA title bring-up
Braid-class playable
Portal-class bring-up
```

## Repository organization

New bring-up work belongs under `src/xenia_web_bootstrap/` until a real subsystem boundary is reached. Existing working root-level tests and historical documents remain in place until their CI and script references can be migrated atomically. See `docs/PROJECT_LAYOUT.md`.

## Status rule

Never report `REAL TITLE ENTRY`, `FIRST DRAW`, `FIRST PRESENT`, `PLAYABLE`, guest FPS, shader translation, or title boot unless the event came from genuine execution through the corresponding emulator subsystem. Synthetic critics may close a component contract, but they do not stand in for actual title execution.
