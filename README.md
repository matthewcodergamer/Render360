# Render360 Xenia-Web — V35

**Browser-native Xbox 360 emulation research project built around Xenia-derived PPC translation and WebAssembly execution.**

> **This root `README.md` is the authoritative public status board.**  
> Files such as `V28_RELEASE_NOTES.md`, `V35_RELEASE_NOTES.md`, `FPU_FOUNDATION.md`, `VMX_FOUNDATION.md`, `WASM_BACKEND_FOUNDATION.md`, and the architecture documents are supporting or historical documentation. They do not replace the status below.

## Authoritative verified gate

The current foundation closure is based on **Xenia WASM32 Bootstrap Run 254**, which completed successfully on implementation commit:

`3b39da31b6fc3e296e356f7143574951f7fc8861`

Run title: **Gate sparse executable content generations**

This supersedes the old Run 216 / ~55% WasmBackend board.

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
  CFG + loops
  endian guest memory
  direct / nested / bctrl guest calls
  generated-WASM equivalence testing
  compiled-function cache
  guest-address dispatch
  executable-code invalidation
  stale-target fail-closed behavior

SPARSE XBOX MEMORY FOUNDATION
████████████████████  100% ✓
  arbitrary sparse 32-bit guest mappings
  shared backing + aliases
  cross-page big-endian access
  R / W / X protection
  executable-content generations
  writable-alias code invalidation
  execute-permission invalidation
  executable-unmap invalidation
  unmapped/protected access fails closed
```

## Executable-content / invalidation contract

Run 254 closes the distinction between **actual executable-byte mutation** and ordinary mapping/protection changes:

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

The sparse-memory critic exercises executable mappings at high Xbox-style 32-bit guest addresses rather than relying on the old bounded probe window.

## Active milestone — real `default.xex` execution

The project now moves away from making synthetic CPU probes the primary milestone. The active implementation path is:

```text
STFS / XEX parser
       ↓
default.xex
       ↓
sparse Xbox address space
       ↓
map real XEX sections at guest addresses
       ↓
apply RX / RW / R protections
       ↓
establish PPCContext
       ↓
set genuine XEX entry address
       ↓
Xenia PPCScanner / frontend
       ↓
Xenia finalized HIR
       ↓
Hot WasmBackend cache
       ↓
EXECUTE TITLE CODE
       ↓
capture first real missing import / kernel service
```

The first genuine title failure becomes the next implementation target—such as an unresolved `xboxkrnl` import, XAM startup, TLS, thread creation, heap initialization, filesystem access, or another runtime service.

## Bring-up order after first title code

```text
real XEX entry execution
       ↓
minimum xboxkrnl / XAM services
       ↓
reach GPU initialization
       ↓
shared Xenos semantic layer
       ↓
WebGPU primary backend
       ↓
WebGL2 fallback
       ↓
first genuine guest-produced framebuffer
```

A smaller XBLA / Braid-class title remains the first practical compatibility target before Portal-class software and larger games.

## Current engineering rule

A subsystem reaches **100% foundation** only when its defined aggregate CI gate proves the contract. Percentages are not advanced to make the repository look current, and an older release-note or foundation document must not override this root status board.

## Documentation

- [`ROADMAP.md`](ROADMAP.md) — broader implementation roadmap
- [`XENIA_WEB_BOOTSTRAP.md`](XENIA_WEB_BOOTSTRAP.md) — Xenia/WebAssembly bootstrap details
- [`WASM_BACKEND_FOUNDATION.md`](WASM_BACKEND_FOUNDATION.md) — WasmBackend implementation history and probes
- [`FPU_FOUNDATION.md`](FPU_FOUNDATION.md) — floating-point foundation
- [`VMX_FOUNDATION.md`](VMX_FOUNDATION.md) — VMX / VMX128 foundation
- [`BROWSER_NATIVE_ARCHITECTURE.md`](BROWSER_NATIVE_ARCHITECTURE.md) — browser-native architecture
- [`BROWSER_ARCHITECTURE.md`](BROWSER_ARCHITECTURE.md) — browser architecture notes
- [`UPSTREAM_PORT_MAP.md`](UPSTREAM_PORT_MAP.md) — upstream Xenia port map

Older `V*_RELEASE_NOTES.md` files are retained as historical records only.

## License

Xenia-derived portions remain subject to the upstream Xenia licensing terms. See [`LICENSE_XENIA.txt`](LICENSE_XENIA.txt).
