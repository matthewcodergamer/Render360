# Render360 Xenia-Web Roadmap — V36

## Project rule

**Port Xenia; do not imitate Xenia.**

Xenia remains the source of truth for Xbox 360 CPU, kernel, and GPU behavior. Render360 owns the browser-native integration: WebAssembly execution, sparse guest memory, browser storage/I/O, workers, WebGPU, WebGL2 fallback, WebAudio, input, PWA behavior, and diagnostics.

The root `README.md` is the authoritative public status board. This roadmap defines implementation order and must not override a newer verified gate recorded there.

## Verified baseline

The eight closed CPU/browser foundations remain locked by **Xenia WASM32 Bootstrap Run 254** on implementation commit:

`3b39da31b6fc3e296e356f7143574951f7fc8861`

Run 254 supersedes the old Run 183 / Run 216 / partial-WasmBackend estimates.

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

The strict XEX guest mapper under `src/xenia_web_bootstrap/xex_guest_mapper.{h,cpp}` is now a closed bring-up layer.

Verified by **Xenia WASM32 Bootstrap run 261** (Actions run ID `33212297082`) on implementation commit:

`f602d889293440a4840c3310a8e5fbf07ddc7756`

The run completed successfully and gates:

```text
RX code mapping                     PASS
R rodata mapping                    PASS
RW data mapping                     PASS
section byte loading                PASS
RX write rejection                  PASS
R write rejection                   PASS
RW write/read                        PASS
overlapping section rejection       PASS
32-bit wraparound rejection         PASS
entry outside executable mapping    FAIL CLOSED
entry inside executable mapping     PASS
post-finalize mutation              FAIL CLOSED
XEX_GUEST_MAPPING                   PASS
XEX_ENTRY_VALIDATION                PASS
```

This closes the **mapper contract**, not genuine title entry execution. A real extracted `default.xex` has not yet been proven through the full mapping → PPC entry path.

## Active milestone — real `default.xex` metadata and bytes

The next implementation is no longer another CPU micro-test. The real bring-up chain is:

```text
STFS package
    ↓
locate root default.xex
    ↓
extract the COMPLETE STFS file block chain
    ↓
XEX2 image decode / decompression / metadata
    ↓
derive real guest sections and permissions
    ↓
V36 XEX guest mapper
    ├── RX code
    ├── R  rodata
    └── RW data
    ↓
validate genuine XEX entry PC
    ↓
construct PPCContext / initial architectural state
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

The legacy native STFS path currently has enough knowledge to locate `default.xex` and inspect initial package data, but the next gate must prove full-chain extraction and complete image bytes rather than assuming the first block is the whole file.

## Real-title gate sequence

### Gate A — STFS full-file extraction

Required critic:

```text
root default.xex located             PASS
file size validated                  PASS
first data block validated           PASS
block chain walked                   PASS
all file blocks read exactly once    PASS
short/truncated chain                FAIL CLOSED
out-of-range block                   FAIL CLOSED
cycle/repeated block                 FAIL CLOSED
extracted byte count == file size    PASS
STFS_DEFAULT_XEX_EXTRACT             PASS
```

Use streaming/random-access reads. Do not require a second multi-megabyte or multi-gigabyte copy of the source package in browser memory.

### Gate B — XEX2 image decode and section metadata

Required output:

```text
XEX2 magic/header                     PASS
image base                            VALID
entry point                           VALID
section/page descriptors              VALID
loader/security metadata              VALID
supported compression/decode          PASS
unsupported encryption/compression    FAIL CLOSED
section ranges non-overlapping         PASS
32-bit range/wrap validation           PASS
XEX_IMAGE_DECODE                       PASS
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

Construct the initial PPC state and send the real entry address through Xenia's scanner/frontend/HIR and Hot WasmBackend dispatch. Stop at the first genuine unresolved dependency and report it explicitly.

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

Only create `src/xenia_web_kernel/` or `src/xenia_web_gpu/` when genuine title execution reaches those boundaries. Do not populate speculative stub directories.

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
full default.xex STFS extraction         ← ACTIVE
XEX2 image decode / real metadata
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
