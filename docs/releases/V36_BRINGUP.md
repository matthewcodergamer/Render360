# V36 XEX bring-up

V36 is the transition from closed CPU/browser foundations into controlled title execution, kernel HLE entry and the road to a genuine guest-produced frame.

## Authoritative V36 closure ladder

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
Run 335  prepared PE entry → mapped guest bytes → Xenia PPC/HIR
Run 338  encrypted retail NONE/BASIC/NORMAL → exact prepared image
Run 348  entry execution + first runtime-boundary telemetry
Run 369  XEX imports → real PE RVA mapping → kernel HLE execution bridge
Run 373  independent harsh critic → minimum PPC ↔ kernel ABI
```

The latest authoritative implementation gate is **Run 373**, Actions ID `33235084799`, on aggregate commit `2a860d2aacc0e21a1d9fcda39d46d8df99c79e8a`. The complete Xenia/Wasm regression job succeeded.

## Run 373 closure — minimum PPC ↔ kernel ABI

The ABI contract is promoted only because an independent adversarial critic passed in addition to the implementation test and the complete locked replay.

The verified path is:

```text
translated guest PPC
  → r3/r4 argument state in the live PPCContext
  → registered HLE thunk
  → nested service execution
  → validated guest-memory access
  → guest-visible mutation
  → r3 return value
  → return to caller
  → translated guest PPC continues
```

The harsh critic separately proves:

```text
KERNEL_ABI_CRITIC_ARGUMENTS                   PASS
KERNEL_ABI_CRITIC_GUEST_MEMORY                PASS
KERNEL_ABI_CRITIC_R3_RETURN                   PASS
KERNEL_ABI_CRITIC_CONTINUATION                PASS
KERNEL_ABI_CRITIC_RANGE_FAIL_CLOSED           PASS
KERNEL_ABI_CRITIC_WRAPAROUND_FAIL_CLOSED      PASS
KERNEL_ABI_CRITIC_RECURSION_FAIL_CLOSED       PASS
KERNEL_ABI_CRITIC_UNSUPPORTED_EXACT_BLOCKER   PASS
KERNEL_ABI_CRITIC_NO_BLANKET_SUCCESS          PASS
KERNEL_ABI_CRITIC                             PASS
```

The critic is deliberately separate from the happy-path ABI test so the subsystem does not grade itself.

## Closed V36 contracts

```text
PACKAGE / XEX FOUNDATION                         100% ✓
PPC TRANSLATION FOUNDATION                       100% ✓
SCALAR PPC FOUNDATION                            100% ✓
GUEST CONTROL FOUNDATION                         100% ✓
FPU FOUNDATION                                   100% ✓
VMX / VMX128 FOUNDATION                          100% ✓
HOT WASMBACKEND FOUNDATION                       100% ✓
SPARSE XBOX MEMORY FOUNDATION                    100% ✓
STRICT XEX GUEST MAPPER                          100% ✓
FULL STFS default.xex EXTRACTION                 100% ✓
XEX2 METADATA + DECODED MAPPER                   100% ✓
NONE / BASIC / NORMAL PREPARATION                100% ✓
UPSTREAM XENIA LZX WASM                          100% ✓
SESSION-KEY / AES-CBC FOUNDATION                 100% ✓
FULL RETAIL XEX IMAGE PREPARATION                100% ✓
STRICT XBOX PE IMAGE DECODER                     100% ✓
PREPARED PE IMAGE → GUEST MEMORY                 100% ✓
PREPARED PE ENTRY → XENIA PPC / HIR              100% ✓
ONE-CALL default.xex → XENIA ENTRY               100% ✓
ONE-CALL STFS PACKAGE → XENIA ENTRY              100% ✓
ENTRY EXECUTION / RUNTIME BOUNDARY               100% ✓
XEX IMPORT LIBRARY DISCOVERY                     100% ✓
KERNEL IMPORT DESCRIPTOR / THUNK PAIRING         100% ✓
PPC → KERNEL HLE DISPATCH                        100% ✓
AUTOMATIC XEX IMPORT → KERNEL EXECUTION          100% ✓
KERNEL EXECUTION FOUNDATION                      100% ✓
MINIMUM PPC ↔ KERNEL ABI                         100% ✓
INDEPENDENT KERNEL ABI HARSH CRITIC              100% ✓
```

These are exact contract closures, not universal Xbox 360 compatibility and not complete xboxkrnl/XAM service coverage.

## Active V36 boundary — real kernel services

The generic ABI is closed. The next work must be selected by genuine execution rather than a guessed service catalog:

```text
user-supplied STFS / default.xex
  → real import module + ordinal
  → translated PPC reaches that thunk
  → implement the minimum corresponding Xenia-derived HLE behavior
  → validate guest pointers/ranges
  → return exact guest-visible state / r3 / NTSTATUS
  → continue guest execution
  → record the next exact blocker
  → independent critic + aggregate replay before promotion
```

Expected service families are threads/TLS, heap/virtual memory, synchronization/time, filesystem/VFS, XAM startup and GPU initialization, but only execution decides the order.

## First-frame path

```text
real guest execution
  → minimum real xboxkrnl/XAM services
  → guest threads / TLS / runtime
  → Xenos ringbuffer / packets
  → command processor
  → Xenos register / shader / resource semantics
  → EDRAM / render targets
  → WebGPU / WGSL primary
  → WebGL2 fallback where practical
  → FIRST GENUINE GUEST FRAME
```

A browser-side WebGPU triangle by itself does not count. The first frame must originate from guest GPU work through the emulator path and should become a permanent critic workload before aggressive performance optimization begins.

## Promotion rule

A subsystem reaches 100% only when its implementation gate, independent adversarial critic and complete regression replay are all green. Never report `REAL TITLE ENTRY`, `FIRST DRAW`, `FIRST PRESENT`, `PLAYABLE`, title FPS or title boot until that event comes from genuine title execution through the corresponding subsystem.
