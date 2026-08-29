# V36 XEX bring-up

V36 is the transition from closed CPU/browser foundations to genuine title-image bring-up.

## Authoritative V36 gates

```text
Run 254  eight CPU/browser foundations
Run 261  strict XEX guest mapper
Run 265  full default.xex STFS extraction
Run 276  XEX2 metadata + mapper integration
Run 282  NONE/NONE image preparation
Run 288  BASIC image preparation
Run 294  NORMAL framing/deblocking
Run 299  upstream Xenia LZX/libmspack in wasm32
Run 315  prepared NORMAL image → relocated entry → Xenia PPC/HIR
```

Run 315 is Actions ID `33224960329`, implementation commit `4ad739c56d2c4032dbc8329b5c5594e17def8ce7`, and completed successfully.

## Run 315 closure

Run 312 exposed a real relocation bug: the end-to-end prepared-image critic reached the decoder-derived entry but `r360_ppc_probe_load_at` returned zero. The fix publishes the decoder-derived 64 KiB guest window before the Xenia wasm32 Memory/Processor bootstrap is initialized. The same unchanged critic then passed in Run 315.

The verified chain is:

```text
XEX-style metadata
  → NORMAL SHA-1/chunk framing
  → upstream Xenia LZX
  → exact prepared image
  → decoder-derived mapping
  → relocated guest entry
  → Xenia PPC scanner/frontend/HIR
  → prepared entry PPC execution
```

Run 315 also replayed the XEX session-key/AES-CBC semantic critic and all earlier locked foundations. The wasm32 compile matrix was 77/77 with strict linking.

## Closed V36 contracts

```text
PACKAGE / XEX                                100% ✓
PPC TRANSLATION                              100% ✓
SCALAR PPC                                   100% ✓
GUEST CONTROL                                100% ✓
FPU                                          100% ✓
VMX / VMX128                                 100% ✓
HOT WASMBACKEND                              100% ✓
SPARSE XBOX MEMORY                           100% ✓
STRICT XEX GUEST MAPPER                      100% ✓
FULL STFS default.xex EXTRACTION             100% ✓
XEX2 METADATA                                100% ✓
DECODED METADATA → MAPPER                    100% ✓
NONE/NONE PREPARATION                        100% ✓
BASIC PREPARATION                            100% ✓
NORMAL FRAMING                               100% ✓
UPSTREAM XENIA LZX WASM                      100% ✓
SESSION-KEY / AES-CBC FOUNDATION             100% ✓
UNENCRYPTED NORMAL PREPARED ENTRY PIPELINE   100% ✓
```

These are contract closures, not universal game compatibility.

## Remaining image-preparation boundary

The complete retail preparation layer is not yet universally closed. Combined encrypted retail `decrypt → framing → LZX` integration and DELTA/patch images remain separate work. Unsupported paths must fail closed.

That remaining edge does not change the next main bring-up target: genuine user-supplied title handoff.

## Active next milestone — real extracted title

```text
user-supplied STFS/title content
  → extract default.xex
  → decode XEX metadata
  → prepare image
  → decode executable/PE section layout
  → stream real section bytes into SparseGuestMemory
  → seal RX / R / RW permissions
  → validate genuine entry PC
  → construct PPCContext
  → Xenia scanner/frontend/finalized HIR
  → Hot WasmBackend
  → execute
  → report first unresolved runtime dependency
```

No copyrighted title binary should be stored in the repository. The real-title gate consumes runtime input.

The first actual failure chooses the next subsystem: xboxkrnl, XAM, TLS, threads, memory services, browser VFS, or Xenos initialization. Broad success stubs are not acceptable.

## First-frame path

```text
real title execution
  → minimum runtime services
  → Xenos ringbuffer / command processor
  → shared Xenos semantics
  → shader/register/resource handling
  → EDRAM/render targets
  → WebGPU/WGSL
  → WebGL2 fallback where feasible
  → first genuine guest framebuffer
```

## Promotion rule

Metadata decode is not title execution. A synthetic prepared-entry critic is not a commercial-title boot. Never mark `REAL TITLE ENTRY`, `FIRST DRAW`, `FIRST PRESENT`, `PLAYABLE` or title FPS complete until the corresponding event comes from genuine title execution.
