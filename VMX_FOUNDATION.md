# Render360 V35 VMX / VMX128 Foundation — Complete

The browser/wasm32 VMX **foundation** is complete for its defined baseline and is regression-gated through genuine PowerPC/VMX byte streams translated by upstream Xenia into finalized HIR.

## Authoritative gate

GitHub Actions run **175** (`33152187091`) completed successfully at implementation commit `fe11632ec806cb6be53da6ff419b77aa201f4b1f`.

```text
PACKAGE_XEX_FOUNDATION            PASS
PPC_TRANSLATION_FOUNDATION        PASS
SCALAR_PPC_CORRECTNESS_FOUNDATION PASS
GUEST_CONTROL_FOUNDATION          PASS
FPU_FOUNDATION                    PASS
VMX_STANDARD_BASELINE             PASS (11 cases)
VMX128_REPRESENTATIVE             PASS (1 case)
VMX_FOUNDATION                    PASS (12 cases)
wasm32 compile matrix             64 / 64 PASS
strict link                       LINKED
rooted exports                    25
real PPC/FPU/VMX suite            24 / 24 PASS
```

## What 100% means

`VMX / VMX128 foundation = 100%` means the defined vector correctness baseline needed before moving to the hot WasmBackend is complete. It does **not** claim every VMX128 opcode, saturation/permute edge case, or retail-title vector dependency is already compatibility-complete.

The gate proves real Xenia-emitted behavior for:

```text
VEC128 guest load/store                    ✓
Xenia-compatible vector byte ordering      ✓
INT8 unsigned modulo add                   ✓
INT16 modulo add                           ✓
INT32 modulo add                           ✓
INT8 / INT16 / INT32 modulo subtract       ✓
VEC128 AND / OR / XOR                      ✓
INT32 vector equality compare              ✓
INT32 vector shift left                    ✓
INT32 vector logical shift right           ✓
representative Xbox 360 VMX128 vand128     ✓
```

## Measured VMX programs

Run 175 executes these real guest instruction cases through PPC bytes -> Xenia PPCFrontend/PPCTranslator -> PPCHIRBuilder/Altivec emitters -> compiler passes -> finalized HIR -> Render360 wasm32 correctness execution -> guest-memory readback:

```text
vadduhm   0x10611040  -> 00030003 x4
vadduwm   0x10611080  -> 01020305 x4
vsububm   0x10611400  -> 03030303 x4
vsubuhm   0x10611440  -> 00030003 x4
vsubuwm   0x10611480  -> 00000003 x4
vand      0x10611404  -> 00000000 x4
vor       0x10611484  -> ffffffff x4
vxor      0x106114c4  -> ffffffff x4
vcmpequw  0x10611086  -> ffffffff x4
vslw      0x10611184  -> 2,4,8,16
vsrw      0x10611284  -> 4,8,16,32
vand128   0x14611210  -> 0f000f00 x4
```

The `vand128` case uses the genuine Xbox 360 VX128 encoding derived from Xenia's opcode contracts. Low-register `VD=3, VA=1, VB=2` produces `0x14611210` from Xenia's `vand128` base `0x14000210`.

Finalized HIR observed in this gate includes `VECTOR_ADD`, `VECTOR_SUB`, VEC128 logic, `VECTOR_COMPARE_EQ`, `VECTOR_SHL`, and `VECTOR_SHR`. Unsupported vector behavior remains fail-closed.

## Completed foundations

```text
STFS / Xbox package / XEX foundation        100% ✓
Xenia PPC translation foundation            100% ✓
Scalar PPC correctness foundation           100% ✓
Guest function / control foundation         100% ✓
FPU foundation                              100% ✓
VMX / VMX128 foundation                     100% ✓
```

## Next active foundation — Hot WasmBackend

With the representative CPU correctness foundations closed, active architecture work moves to generated WebAssembly execution:

1. lower finalized Xenia HIR arithmetic into generated WebAssembly functions;
2. lower branches/control flow;
3. lower guest loads/stores;
4. lower calls/returns;
5. lower FPU and VMX operations covered by the correctness foundations;
6. compare generated-WASM results against the existing correctness executor;
7. add compiled-function caching;
8. add executable-page versioning/invalidation;
9. create a dedicated `WASM_BACKEND_FOUNDATION=PASS` gate.

After WasmBackend closure, the priority is sparse full Xbox guest memory, real `default.xex` mapping, actual entry-point execution, kernel/XAM, then Xenos/WebGPU.
