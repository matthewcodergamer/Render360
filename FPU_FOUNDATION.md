# Render360 FPU Foundation — Complete

The browser/wasm32 FPU **foundation** is complete for its defined scope and is regression-gated through real PowerPC programs translated by upstream Xenia into finalized HIR.

## Authoritative gate

GitHub Actions run **168** (`33149796414`) completed successfully at commit `2533a1fa855bdc4b1df2a348edc31f1ba169bb8c`.

Measured gate:

```text
PACKAGE_XEX_FOUNDATION            PASS
PPC_TRANSLATION_FOUNDATION        PASS
GUEST_CONTROL_FOUNDATION          PASS
SCALAR_PPC_CORRECTNESS_FOUNDATION PASS
FPU_FOUNDATION                    PASS
wasm32 compile matrix             64 / 64 PASS
strict link                       LINKED
rooted exports                    25
real PPC correctness suite        24 / 24 PASS
```

## What 100% means here

`FPU foundation = 100%` means the defined browser correctness baseline required before moving to VMX/WasmBackend work is complete. It does **not** claim perfect Xbox 360 floating-point compatibility or invent behavior that upstream Xenia itself has not implemented.

The foundation now proves:

```text
FPR state / load / store                    ✓
FLOAT64 ADD                                 ✓
FLOAT64 SUB                                 ✓
FLOAT64 MUL                                 ✓
FLOAT64 DIV                                 ✓
fcmpu floating comparison -> CR             ✓
fctiwz float -> signed int, round-to-zero   ✓
fcfid signed int64 -> FLOAT64               ✓
frsp FLOAT64 -> FLOAT32 -> FLOAT64 rounding ✓
current Xenia UpdateFPSCR path               ✓
FPSCR readback through mffs                  ✓
```

## Measured programs

The dedicated FPU closure gate executes genuine PPC byte streams through:

```text
PPC bytes
  -> Xenia PPCFrontend / PPCTranslator
  -> PPCHIRBuilder / ppc_emit_fpu
  -> Xenia HIR + compiler passes
  -> finalized-HIR correctness executor
  -> live PPCContext / Xenia Memory
```

Key measured results include:

- `6.0 / 2.0 = 3.0` through `lfd -> fdiv -> stfd` with exact guest-memory result `0x4008000000000000`.
- `fcmpu cr0,f1,f2` for `1.0 < 2.0` produces the expected CR0 less-than state.
- `fctiwz` converts `3.75` to signed integer `3` using Xenia's emitted round-to-zero conversion path.
- `fcfid` converts a signed 64-bit integer representation back to FLOAT64.
- `frsp` executes Xenia's FLOAT64 -> FLOAT32 -> FLOAT64 conversion chain and verifies the rounded guest-memory bit pattern.
- `fdiv` executes Xenia `UpdateFPSCR`, and `mffs` reads the resulting current upstream FPSCR state back through an FPR and guest memory.

## FPSCR compatibility boundary

Render360 intentionally follows upstream Xenia. Current Xenia `UpdateFPSCR` still contains TODOs for deeper overflow/NaN/exception-detail modeling. Therefore this foundation gates the FPSCR behavior Xenia currently emits and does not fabricate missing hardware exception flags.

Those deeper compatibility details may be expanded later when required by real titles or when upstream Xenia behavior provides the appropriate contract, without reopening the completed baseline foundation.

## Completed CPU foundations

```text
STFS / Xbox package / XEX foundation        100% ✓
Xenia PPC translation foundation            100% ✓
Scalar PPC correctness foundation           100% ✓
Guest function / control foundation         100% ✓
FPU foundation                              100% ✓
```

## Next active foundation — VMX / VMX128

The next completion target is VMX/VMX128. Current proven vector behavior is:

```text
VEC128 guest load                 ✓
Xenia-compatible vector byte swap ✓
unsigned INT8 VECTOR_ADD          ✓
VEC128 guest store                ✓
```

The next VMX closure sequence is:

1. halfword and word modulo arithmetic;
2. vector subtraction;
3. vector AND / OR / XOR;
4. integer vector comparisons;
5. common vector shifts;
6. measured Xbox 360 VMX128 forms used by real compiled title code;
7. dedicated `VMX_FOUNDATION=PASS` CI gate.

After VMX/VMX128 foundation closure, active architecture work moves to the Render360 `WasmBackend`, translated-function caching/invalidation, sparse full Xbox guest memory, real `default.xex` section mapping and actual XEX entry-point execution.
