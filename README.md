# Render360 Xenia-Web — V36

**Browser-native Xbox 360 emulation research project built around Xenia-derived PPC translation and WebAssembly execution.**

> **This root `README.md` is the authoritative public status board.**  
> Historical release notes and foundation documents are supporting evidence; they do not override the verified status below.

## Authoritative verified gates

The eight CPU/browser foundations remain closed by **Xenia WASM32 Bootstrap Run 254** on implementation commit:

`3b39da31b6fc3e296e356f7143574951f7fc8861`

Run title: **Gate sparse executable content generations**

Run 254 supersedes the old Run 216 / ~55% WasmBackend board and all earlier partial-WasmBackend estimates.

The V36 strict XEX guest-mapper contract is separately closed by **Xenia WASM32 Bootstrap run 261** (Actions run ID `33212297082`) on implementation commit:

`f602d889293440a4840c3310a8e5fbf07ddc7756`

That run completed successfully. It closes the mapper/entry-validation **component contract**; it does not claim that a genuine extracted title entry has executed yet.

## Foundation status

```text
PACKAGE / XEX FOUNDATION
████████████████████  100% ✓

PPC TRANSLATION FOUNDATION
████████████████████  100% ✓

SCALAR PPC FOUNDATION
████████████████████  100% ✓

GUEST CONTROL FOUNDATION
████████████████████  100% ✓

FPU FOUNDATION
████████████████████  100% ✓

VMX / VMX128 FOUNDATION
████████████████████  100% ✓

HOT WASMBACKEND FOUNDATION
████████████████████  100% ✓
  generated scalar / FPU / VMX
  types / compares / shifts
  CFG + loops
  endian guest memory
  direct / nested / bctrl guest calls
  generated-WASM equivalence critics
  compiled-function cache
  guest-address dispatch
  code-content invalidation
  permission invalidation
  unmap invalidation
  stale-target fail-closed behavior

SPARSE XBOX MEMORY FOUNDATION
████████████████████  100% ✓
  arbitrary sparse 32-bit guest mappings
  range I/O
  shared backing + aliases
  cross-page big-endian access
  R / W / X protection
  page state + partial unmap
  executable-content generations
  writable-alias code invalidation
  execute-permission invalidation
  executable-unmap cleanup
  holes / wraparound fail closed

V36 STRICT XEX GUEST MAPPER
████████████████████  100% ✓
  RX code mapping
  R rodata mapping
  RW data mapping
  bounded chunk loading
  final permission sealing
  overlap rejection
  32-bit wraparound rejection
  executable-entry validation
  post-finalize mutation rejection
  XEX_GUEST_MAPPING=PASS
  XEX_ENTRY_VALIDATION=PASS
```

## Executable-content / invalidation contract

Run 254 locks the distinction between **actual executable-byte mutation** and ordinary mapping/protection changes:

```text
code-byte write
  → executable content generation changes
  → compiled Wasm invalidated

write through writable alias
  → executable alias located
  → executable content generation changes
  → compiled Wasm invalidated

remove execute permission
  → compiled Wasm invalidated
  → executable content generation unchanged

unmap executable memory
  → compiled Wasm invalidated
  → executable content generation unchanged
  → stale dispatch fails closed
```

This prevents protection/mapping churn from masquerading as self-modifying code while guaranteeing stale compiled WebAssembly cannot continue executing.

## Active milestone — genuine `default.xex` bring-up

Synthetic CPU probes remain regression locks, but they are no longer the primary roadmap driver. The active implementation path is now:

```text
STFS package
       ↓
locate root default.xex
       ↓
extract COMPLETE default.xex block chain
       ↓
XEX2 image decode / decompression / metadata
       ↓
real XEX guest sections
       ├── RX code
       ├── R  rodata
       └── RW data
       ↓
V36 XEX guest mapper
       ↓
validate genuine XEX entry address
       ↓
construct PPCContext / initial state
       ↓
Xenia PPCScanner / frontend
       ↓
Xenia finalized HIR
       ↓
Hot WasmBackend cache / dispatch
       ↓
EXECUTE FIRST TITLE INSTRUCTIONS
       ↓
FAIL CLOSED on first missing import / kernel / runtime service
```

The immediate prerequisite is **complete STFS extraction of the real `default.xex`**, followed by XEX2 decode into real section metadata and bytes. The existing native package path can locate `default.xex`, but real-title execution is not considered reached until the complete file flows through decode, mapping, entry validation, and PPC dispatch.

## Public board

```text
PACKAGE / XEX FOUNDATION
████████████████████  100% ✓
PPC TRANSLATION FOUNDATION
████████████████████  100% ✓
SCALAR PPC FOUNDATION
████████████████████  100% ✓
GUEST CONTROL FOUNDATION
████████████████████  100% ✓
FPU FOUNDATION
████████████████████  100% ✓
VMX / VMX128 FOUNDATION
████████████████████  100% ✓
HOT WASMBACKEND FOUNDATION
████████████████████  100% ✓
SPARSE XBOX MEMORY FOUNDATION
████████████████████  100% ✓
V36 STRICT XEX GUEST MAPPER
████████████████████  100% ✓

FULL default.xex STFS EXTRACTION
██░░░░░░░░░░░░░░░░░░  ← ACTIVE NEXT
XEX2 IMAGE DECODE / REAL METADATA
░░░░░░░░░░░░░░░░░░░░
REAL XEX ENTRY EXECUTION
░░░░░░░░░░░░░░░░░░░░
KERNEL / xboxkrnl / XAM
░░░░░░░░░░░░░░░░░░░░
XENOS SEMANTIC LAYER
░░░░░░░░░░░░░░░░░░░░
WEBGPU / WGSL / EDRAM
░░░░░░░░░░░░░░░░░░░░
WEBGL2 FALLBACK
░░░░░░░░░░░░░░░░░░░░
FIRST GENUINE FRAME
░░░░░░░░░░░░░░░░░░░░
```

## Bring-up order

```text
full default.xex extraction
       ↓
XEX2 decode / real metadata
       ↓
real section mapping
       ↓
real entry PC
       ↓
execute until first genuine failure
       ↓
minimum required xboxkrnl / XAM
       ↓
guest threads / TLS / runtime
       ↓
Xenos ringbuffer / command processing
       ↓
WebGPU / WGSL / EDRAM
       ↓
WebGL2 fallback where feasible
       ↓
first genuine guest-produced frame
       ↓
small XBLA / Braid-class title
       ↓
Portal-class software
```

The first real title failure becomes the next implementation target automatically. No broad unknown-import “return success” stubs should be used to fake progress.

## Repository organization

Current maintained ownership is intentionally incremental:

- `src/xenia_web_bootstrap/` — browser-native Xenia/PPC bring-up, SparseGuestMemory, Hot WasmBackend probes, and V36 XEX guest mapper.
- `src/xenia_web_shims/` — browser/WASM portability shims.
- `xenia_port/` — older imported/ported Xenia-facing surface retained until references can be migrated safely.
- `docs/` — maintained project organization and release documentation.
- `.github/workflows/` — aggregate regression gates.

Working root tests and historical documents are not mass-moved merely for cosmetic organization. References and CI must be migrated atomically. See [`docs/PROJECT_LAYOUT.md`](docs/PROJECT_LAYOUT.md).

## Current engineering rule

A subsystem reaches **100%** only when its defined aggregate CI gate proves that exact contract. A synthetic component critic may close that component, but it cannot be used to claim genuine title execution, a guest frame, playability, or FPS.

## Documentation

- [`ROADMAP.md`](ROADMAP.md) — V36 real-title implementation order and gates
- [`docs/releases/V36_BRINGUP.md`](docs/releases/V36_BRINGUP.md) — V36 mapper closure and title bring-up boundary
- [`docs/PROJECT_LAYOUT.md`](docs/PROJECT_LAYOUT.md) — stable repository ownership/layout policy
- [`XENIA_WEB_BOOTSTRAP.md`](XENIA_WEB_BOOTSTRAP.md) — Xenia/WebAssembly bootstrap details
- [`WASM_BACKEND_FOUNDATION.md`](WASM_BACKEND_FOUNDATION.md) — WasmBackend implementation history and probes
- [`FPU_FOUNDATION.md`](FPU_FOUNDATION.md) — floating-point foundation
- [`VMX_FOUNDATION.md`](VMX_FOUNDATION.md) — VMX / VMX128 foundation
- [`BROWSER_NATIVE_ARCHITECTURE.md`](BROWSER_NATIVE_ARCHITECTURE.md) — browser-native architecture
- [`UPSTREAM_PORT_MAP.md`](UPSTREAM_PORT_MAP.md) — upstream Xenia port map

Older root `V*_RELEASE_NOTES.md` files are retained as historical records only.

## License

Xenia-derived portions remain subject to the upstream Xenia licensing terms. See [`LICENSE_XENIA.txt`](LICENSE_XENIA.txt).
