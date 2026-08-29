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
Run 303  XEX session-key / AES-CBC foundation
Run 315  prepared NORMAL image → relocated entry → Xenia PPC/HIR
Run 321  strict Xbox PE image decoder
Run 328  prepared PE sections → SparseGuestMemory → decoder-derived entry
```

Run 328 is Actions ID `33227084124`, aggregate commit `7383622e60d77c16b3fb6435411ce03847cc0aec`, and completed successfully.

## Run 315 closure

Run 312 exposed a real relocation bug: the end-to-end prepared-image critic reached the decoder-derived entry but `r360_ppc_probe_load_at` returned zero. The fix publishes the decoder-derived 64 KiB guest window before the Xenia wasm32 Memory/Processor bootstrap is initialized. The same unchanged critic then passed in Run 315.

The verified Run 315 chain is:

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

## Run 321 closure — strict Xbox PE decode

Run 321, Actions ID `33225734355`, implementation commit `23ee276d520bef8f97f1f56bfcbee351baf87ba9`, validates the executable layout after image preparation rather than assuming a synthetic flat code buffer.

The PE critic requires:

```text
MZ / PE signatures                       PASS
PowerPC big-endian machine 0x01F2        PASS
PE32 optional header                     PASS
Xbox subsystem 14                        PASS
section table and raw bounds             PASS
section virtual bounds                   PASS
entry inside executable section          PASS
malformed metadata                       FAIL CLOSED
XEX_PE_IMAGE                             PASS
```

## Run 328 closure — prepared PE to guest memory

The new `xex_pe_guest_loader` reuses the strict PE decoder and the existing XEX guest mapper instead of inventing another memory subsystem.

Run 326 exposed a genuine integration defect: the prepared PE was staged in the mapper input buffer, but `ResetXexGuestMapper()` erased that staging buffer before the decoder consumed it. Commit `01f081fd5b72c48ab24d94c9525e71b6505da644` changes reset semantics so it clears guest mapping state without destroying caller-facing staged bytes. The critic remained unchanged in substance and Run 328 went fully green.

The verified mapping chain is:

```text
prepared PE bytes
  → strict PE decoder
  → image_base + section RVA
  → PE section characteristics
  → RX / RW SparseGuestMemory maps
  → raw section bytes copied from prepared image
  → zero-filled virtual tails
  → image_base + entry RVA
  → executable entry validation
  → final guest protections
```

Run 328 compiled **79/79 wasm32 units**, strict-linked with 115 exported bootstrap functions, passed Xenia LZX and XEX AES/session-key semantics, then replayed all locked CPU/WasmBackend/SparseGuestMemory/XEX-mapper foundations.

The dedicated critic closes:

```text
PREPARED_PE_SECTION_BYTES=PASS
PREPARED_PE_ZERO_FILL=PASS
PREPARED_PE_RX_PERMISSION=PASS
PREPARED_PE_RW_PERMISSION=PASS
PREPARED_PE_ENTRY=PASS
PREPARED_IMAGE_TO_GUEST_MAPPING=PASS
PREPARED_PE_PERMISSION_FAIL_CLOSED=PASS
```

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
STRICT XBOX PE IMAGE DECODER                 100% ✓
PREPARED PE IMAGE → GUEST MEMORY             100% ✓
```

These are contract closures, not universal game compatibility.

## Remaining image-preparation boundary

The complete retail preparation layer is not yet universally closed. Combined encrypted retail `decrypt → framing → LZX` integration and DELTA/patch images remain separate work. Unsupported paths must fail closed.

That edge does not block the next main bring-up target: genuine user-supplied title handoff.

## Active next milestone — real extracted title

```text
user-supplied STFS/title content
  → extract default.xex
  → decode XEX metadata
  → prepare image
  → strict PE decode
  → prepared PE section loader
  → SparseGuestMemory RX / R / RW mappings
  → genuine decoded entry PC
  → construct initial PPCContext
  → Xenia scanner/frontend/finalized HIR
  → Hot WasmBackend
  → execute genuine title instructions
  → FIRST_RUNTIME_BLOCKER=<exact unresolved dependency>
```

No copyrighted title binary should be stored in the repository. The real-title gate consumes runtime input.

The first actual failure chooses the next subsystem: xboxkrnl, XAM, TLS, threads, memory services, browser VFS, or Xenos initialization. Broad success stubs are not acceptable.

## First-frame path

```text
real title / guest-frame execution
  → minimum runtime services
  → Xenos ringbuffer / command processor
  → shared Xenos semantics
  → shader/register/resource handling
  → EDRAM/render targets
  → WebGPU/WGSL
  → WebGL2 fallback where feasible
  → FIRST GENUINE GUEST FRAME
```

A browser-side WebGPU test by itself is not a guest frame. The first-frame workload must originate from guest PPC/Xenos work through the emulator path. Once achieved, keep it permanently in CI before performance work begins.

## Promotion rule

Metadata decode is not title execution. A controlled prepared-entry critic is not a commercial-title boot. Never mark `REAL TITLE ENTRY`, `FIRST DRAW`, `FIRST PRESENT`, `PLAYABLE` or title FPS complete until the corresponding event comes from genuine title execution.
