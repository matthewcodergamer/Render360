# Render360 Xenia-Web — V32 runtime / V33 CPU bootstrap

Render360 is a browser/iOS-oriented Xbox 360 emulator port built around **real Xenia behavior**, not a JavaScript imitation of an Xbox 360.

The deployed browser runtime remains **Core V32**. The active **V33 CPU bootstrap** ports upstream Xenia PowerPC/FPU/VMX translation and execution infrastructure to Emscripten/wasm32 while excluding the native x64 JIT and desktop graphics stack.

## Architecture rule

**Xenia owns Xbox 360 behavior. Render360 owns browser/iOS host behavior.**

```text
Xbox PPC / FPU / VMX128
  -> Xenia PPCFrontend / PPCTranslator / PPCScanner
  -> Xenia PPCHIRBuilder + ppc_emit_*
  -> Xenia HIR + portable compiler passes
  -> Render360 finalized-HIR correctness executor
  -> later Render360 WasmBackend
```

No fake framebuffer, fake boot success, fake guest FPS, fake shader translation, hardcoded PPC decoder output, or second JavaScript/PPC interpreter is accepted as Xbox output.

## Authoritative foundation gate — run 160

GitHub Actions **run 160** (`33148488674`) completed successfully at commit `25de4a6c415df817eeb6eb8534f5555573a34eb1`.

```text
V32 package/XEX core rebuild          PASS
PACKAGE_XEX_FOUNDATION                PASS
PPC_TRANSLATION_FOUNDATION            PASS
GUEST_CONTROL_FOUNDATION              PASS
SCALAR_PPC_CORRECTNESS_FOUNDATION     PASS
wasm32 compile matrix                 64 / 64 PASS
strict full-export link               LINKED
rooted probe exports                  25
real PPC/FPU/VMX correctness          19 / 19 PASS
stack-frame control closure gate      PASS
```

### STFS / Xbox package / XEX foundation — 100%

For the current browser-loader foundation scope, this gate is complete.

CI rebuilds `render360_xenia_core.wasm` directly from `render360_xenia_core_v32.cpp`, then verifies:

- LIVE / PIRS / CON package classification;
- Xenia-aligned STFS header and volume-descriptor contracts;
- native directory enumeration;
- STFS hash-chain traversal;
- root `default.xex` discovery;
- fragmented multi-block `default.xex` extraction;
- byte-for-byte reconstruction of the complete extracted executable;
- structural XEX inspection after reconstruction;
- entry point, image base, title ID and media ID extraction;
- range-driven I/O rather than loading a multi-GB package into WASM memory.

Measured runtime gate remains:

```text
core_version        32
mount_reads         5
extract_reads       3
default_xex_bytes   6144
default_xex_blocks  2
xex_entry           0x82001234
```

**100% here means the defined package/XEX foundation is complete and regression-gated.** It does not mean every retail package variant, XEX encryption/compression mode, title quirk or executable loader behavior is already compatible.

### Xenia PPC translation foundation — 100%

The portable translation foundation is complete for its defined scope.

`xenia_translation_foundation_check.py` locks:

- PPC frontend;
- PPC translator;
- PPC scanner;
- PPC context and opcode tables;
- all five current PPC emitter families: ALU, control, memory, FPU and Altivec/VMX;
- HIR opcodes, blocks, instructions, values and builder;
- compiler and compiler-pass framework;
- **every current upstream Xenia compiler-pass `.cc` implementation**;
- browser host translation units;
- strict undefined-symbol link behavior;
- representative real-PPC runtime categories.

Run 160 keeps the complete translation manifest green:

```text
upstream translation units manifested  36
browser translation units manifested    6
compiler passes manifested              14
end-to-end runtime categories           10
wasm32 compile matrix                   64 / 64 PASS
```

This marks **PPC translation foundation = 100%** without pretending every PowerPC instruction or retail title is executable.

### Scalar PPC correctness foundation — 100%

The defined non-FPU/non-VMX scalar correctness foundation is now complete and regression-gated.

It verifies real PPC bytes through Xenia translation and finalized-HIR execution for:

```text
integer arithmetic / bitwise                  ✓
integer signed/unsigned comparisons            ✓
conditional multi-block branches               ✓
CTR-controlled backward loops                  ✓
guest scalar load/store + Xbox endian          ✓
CR / LR / CTR architectural state              ✓
return boundaries                              ✓
```

This is a **foundation completion boundary**, not a claim that every obscure PPC opcode used by every game has already been compatibility-tested.

### Guest function / control foundation — 100%

Run 160 closes the function/control foundation with real direct, nested and runtime-indirect guest calls plus a stack-frame-shaped function flow.

Verified paths include:

```text
direct bl -> separately scanned callee -> blr            ✓
two-level nested guest calls                              ✓
CTR / bctrl runtime indirect guest call                   ✓
LR save/update/restore                                     ✓
stack pointer decrement/restore through r1                ✓
LR spill/reload through Xenia guest memory                ✓
caller resumes after callee                               ✓
```

The dedicated closure program performs:

```text
mflr  r5
addi  r1,r1,-32
stw   r5,16(r1)
bl    callee
addi  r3,r3,2
lwz   r5,16(r1)
addi  r1,r1,32
stw   r1,0(r8)
mtlr  r5
blr
callee: li r3,5
        blr
```

Run 160 measures:

```text
GUEST_CONTROL_FOUNDATION=PASS
SCALAR_PPC_CORRECTNESS_FOUNDATION=PASS
assembled_functions=2
result_r3=7
restored_sp=0x800001c0
```

The callee at `0x80000028` is independently discovered by Xenia `PPCScanner`, translated through Xenia and executed against the same live `PPCContext`. There is no second PPC decoder or hardcoded function result.

## Current execution milestone

The general runtime suite now contains **19 / 19** passing real PPC/FPU/VMX programs in addition to the dedicated stack-frame closure gate.

Verified execution includes:

```text
scalar integer / compare / branch / loop        ✓
guest scalar memory + endian                    ✓
CR / LR / CTR                                   ✓
direct calls                                    ✓
nested calls                                    ✓
CTR/bctrl indirect calls                        ✓
real stack-frame-shaped call/return             ✓
FLOAT64 FPR load/store                          ✓
FLOAT64 ADD / SUB / MUL                         ✓
VEC128 load/store + byte order                  ✓
VMX unsigned-byte VECTOR_ADD                    ✓
```

The FLOAT64 tests verify exact IEEE-754 guest-memory results, including `0x4008000000000000` for double `3.0`. The VMX test executes genuine `lvx -> vaddubm -> stvx` and verifies sixteen result bytes of `0x03`.

## Progress after run 160

These are scoped engineering estimates. A 100% bar means the named **foundation** has met its explicit regression gate, not that the full emulator or all retail compatibility is complete.

```text
STFS / Xbox package / XEX foundation
████████████████████  100%  ✓ FOUNDATION COMPLETE

Xenia PPC translation foundation
████████████████████  100%  ✓ FOUNDATION COMPLETE

Scalar PPC correctness foundation
████████████████████  100%  ✓ FOUNDATION COMPLETE

Guest function / control foundation
████████████████████  100%  ✓ FOUNDATION COMPLETE

FPU execution
█████████░░░░░░░░░░░   ~45%
✓ load/store / FPR state
✓ ADD / SUB / MUL
○ DIV
○ floating compare / conversion
○ FPSCR / rounding / exception details

VMX / VMX128 execution
███░░░░░░░░░░░░░░░░░   ~12–15%
✓ VEC128 load/store
✓ VEC128 byte order
✓ unsigned-byte add
○ halfword/word arithmetic
○ vector logic / compare / shift
○ VMX128-specific coverage

Hot WasmBackend
█░░░░░░░░░░░░░░░░░░░   ~3%

Full Xbox guest-memory system
██░░░░░░░░░░░░░░░░░░   ~10%

default.xex real entry execution
█░░░░░░░░░░░░░░░░░░░   ~5%

Kernel / xboxkrnl / XAM
░░░░░░░░░░░░░░░░░░░░   ~1–2%

Xenos guest GPU emulation
░░░░░░░░░░░░░░░░░░░░   ~1–2%

WebGPU Xenos backend
█░░░░░░░░░░░░░░░░░░░   ~2%

WebGL2 fallback
░░░░░░░░░░░░░░░░░░░░   ~1%

First genuine Xbox title boot
████░░░░░░░░░░░░░░░░   ~21–22%

Small XBLA / Braid-class playable
███░░░░░░░░░░░░░░░░░   ~15–16%

Portal-class playable browser target
██░░░░░░░░░░░░░░░░░░   ~8–9%

OVERALL RENDER360
█████░░░░░░░░░░░░░░░   ~23–25%
```

## Next implementation order

The four completed foundations should now stay closed unless their CI gates regress. Active implementation moves to the next unfinished layers:

1. **FPU execution** — add genuine PPC `fdiv`, typed FLOAT32/FLOAT64 HIR `DIV`, floating comparisons/conversions, then measured FPSCR/rounding behavior.
2. **VMX / VMX128 execution** — halfword/word arithmetic, vector AND/OR/XOR, comparisons and shifts, then measured Xbox-specific VMX128 operations.
3. **Render360 WasmBackend** — translate finalized Xenia HIR into generated WebAssembly functions instead of interpreting hot HIR.
4. Add translated block/function caching.
5. Add executable-page versioning and invalidation for generated/self-modifying guest code.
6. Replace the 64 KiB correctness window with sparse/page-backed Xbox virtual and physical memory, mappings, aliases and protection.
7. Map the already-captured complete `default.xex` sections at their Xbox addresses.
8. Establish initial CPU state and execute the **real XEX entry point**.
9. Bring up `KernelState`, xboxkrnl and XAM services demanded by actual title execution.
10. Build the shared Xenos browser GPU layer, then WebGPU/WGSL/EDRAM and WebGL2 fallback.
11. Add WebAudio and reach the first genuine guest-produced framebuffer.
12. Bring a small XBLA/Braid-class title through startup/menu/gameplay before Portal-class compatibility work.

The next high-value visible milestone remains **real `default.xex` entry-point execution**. The package, translation, scalar correctness and guest-control foundations are now closed; the biggest bridge to that milestone is **FPU/VMX coverage + hot execution + full guest memory**.

## Build / verification

```bash
bash ./build-core.sh
node ./test-package-xex-foundation.mjs
bash ./fetch-xenia.sh
python3 ./xenia_contract_check.py
python3 ./xenia_web_bootstrap_check.py
python3 ./xenia_translation_foundation_check.py
bash ./build-xenia-ppc-bootstrap.sh
bash ./link-xenia-ppc-bootstrap.sh
node ./test-xenia-ppc-translation-probe.mjs build/xenia-ppc-bootstrap/xenia_ppc_bootstrap.wasm
node ./test-guest-control-foundation.mjs build/xenia-ppc-bootstrap/xenia_ppc_bootstrap.wasm
```

Stable production remains Core V32. V33 CPU work remains isolated from the deployed runtime until real title bring-up is ready.

## License

Xenia-derived layout/algorithm work retains the Xenia BSD 3-Clause notice in `LICENSE_XENIA.txt`. No Xbox game files or copyrighted game assets are included.
