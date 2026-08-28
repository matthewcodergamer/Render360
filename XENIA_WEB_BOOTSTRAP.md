# Xenia Web Bootstrap — V33 CPU breakthrough

## Goal

Bring the real upstream Xenia PowerPC/FPU/VMX frontend, instruction semantics, HIR/compiler pipeline, Processor runtime and minimum browser-safe host support into wasm32 without importing Xenia's native x64 JIT or desktop graphics backends.

Milestone language remains strict:

- **PPC TRANSLATION FOUNDATION COMPLETE**: the defined portable Xenia translation graph, current compiler-pass set, scanner/emitter surface and strict wasm32 link are regression-gated.
- **SCALAR PPC CORRECTNESS FOUNDATION COMPLETE**: the defined non-FPU/non-VMX scalar arithmetic/control/memory correctness surface is regression-gated through finalized Xenia HIR.
- **GUEST CONTROL FOUNDATION COMPLETE**: direct, nested, CTR-indirect and stack-frame-shaped guest calls/returns are regression-gated through Xenia scanner/frontend with shared PPCContext.
- **PPC EXECUTING**: finalized Xenia HIR executes and produces verified PowerPC architectural-state or guest-memory changes.
- **PLAYABLE**: genuine title execution, kernel, graphics, input and audio work sufficiently for gameplay.

## Current authoritative green result — run 160

GitHub Actions run **160** (`33148488674`) completed successfully at commit `25de4a6c415df817eeb6eb8534f5555573a34eb1`.

```text
V32 package/XEX rebuild              PASS
PACKAGE_XEX_FOUNDATION               PASS
PPC_TRANSLATION_FOUNDATION           PASS
GUEST_CONTROL_FOUNDATION             PASS
SCALAR_PPC_CORRECTNESS_FOUNDATION    PASS
wasm32 compile matrix                64 passed / 0 blocked
strict full-export link              LINKED
rooted exports                       25
real PPC correctness suite           19 / 19 PASS
stack-frame closure gate             PASS
```

The live CPU path remains:

```text
real big-endian Xbox PPC/FPU/VMX bytes
  -> Xenia Memory
  -> Xenia Processor / PPCFrontend / PPCTranslator / PPCScanner
  -> Xenia PPCHIRBuilder + ppc_emit_*
  -> Xenia HIR
  -> complete current portable compiler-pass set
  -> finalized Xenia HIR
  -> Render360 HIRCorrectnessExecutor
  -> real Xenia PPCContext + Processor-owned Xenia Memory
  -> asserted architectural and guest-memory state
```

## Translation foundation — COMPLETE / 100%

`xenia_translation_foundation_check.py` is the completion gate for this layer. It locks the current source manifest and fails if upstream drift introduces an untracked compiler pass or removes a required translation component.

Run 160 keeps this manifest green:

```text
upstream translation units       36
browser translation units         6
current compiler passes          14
runtime category markers         10
full wasm32 build graph          64 / 64 PASS
```

The locked scope includes PPCFrontend, PPCTranslator, PPCScanner, PPC context/opcode support, all five PPC emitter families, HIR, the compiler framework, every current upstream compiler-pass implementation, browser host seams, the probe/correctness backend and strict undefined-symbol linking.

This is **translation foundation = 100%**, not arbitrary retail PPC compatibility = 100%.

## Package/XEX foundation — COMPLETE / 100%

The workflow rebuilds Core V32 from source and runs `test-package-xex-foundation.mjs` before the CPU bootstrap.

The package gate verifies:

```text
LIVE / PIRS / CON classification
STFS header + descriptor parsing
native directory traversal
hash-chain traversal
root default.xex discovery
fragmented multi-block complete extraction
byte-for-byte executable reconstruction
XEX structural metadata inspection
```

Measured gate retained in run 160:

```text
core_version        32
mount_reads         5
extract_reads       3
default_xex_bytes   6144
default_xex_blocks  2
xex_entry           0x82001234
```

Retail encryption/compression compatibility and executable mapping remain later compatibility/runtime layers rather than unfinished package-foundation work.

## Scalar PPC correctness foundation — COMPLETE / 100%

The defined scalar correctness scope is now locked through genuine PPC bytes and finalized Xenia HIR for:

```text
integer arithmetic / bitwise
signed and unsigned comparisons
conditional multi-block branches
CTR-controlled backward loops
guest scalar load/store
Xbox endian conversion
CR / LR / CTR state
return boundaries
```

Unsupported HIR still fails closed. This does not claim every PowerPC opcode has been compatibility-tested; FPU and VMX are deliberately tracked as separate execution layers.

## Guest function/control foundation — COMPLETE / 100%

The general runtime suite now proves:

```text
direct bl / callee / blr                     PASS
two-level nested bl chain                     PASS
CTR / bctrl runtime-indirect call             PASS
LR save/update/restore                        PASS
caller resume after callee                    PASS
```

The new dedicated closure gate additionally executes a stack-frame-shaped guest flow:

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

Run 160 measured:

```text
GUEST_CONTROL_FOUNDATION=PASS
SCALAR_PPC_CORRECTNESS_FOUNDATION=PASS
assembled_functions=2
result_r3=7
restored_sp=0x800001c0
top-level finalized HIR executed=39
nested callee finalized HIR executed=6
```

Xenia `PPCScanner` independently discovers the callee at guest `0x80000028`, Xenia translates it separately, and the nested finalized HIR executes against the same live `PPCContext`. No second PPC decoder or hardcoded callee behavior is introduced.

## Current FPU execution tier

The current FPU tier verifies exact guest-memory results for:

```text
1.0 + 2.0 = 3.0
5.0 - 2.0 = 3.0
1.5 * 2.0 = 3.0
```

Each uses genuine `lfd -> arithmetic -> stfd` PPC and verifies `0x4008000000000000` for IEEE-754 double 3.0.

ADD, SUB and MUL are verified. DIV, compare/conversion and deeper FPSCR/rounding behavior remain open.

## Current VMX execution tier

The first vector path remains green:

```text
lvx      v1,0,r4
lvx      v2,0,r5
vaddubm  v3,v1,v2
stvx     v3,0,r7
lwz      r3,0(r7)
blr
```

Xenia emits 29 finalized HIR instructions. The correctness executor currently implements the measured Xenia VEC128 byte-swap convention and unsigned INT8 `VECTOR_ADD`; sixteen `0x01` bytes plus sixteen `0x02` bytes produce sixteen `0x03` bytes.

## Phase ladder after run 160

```text
Phase 1   upstream source / contract audit                    COMPLETE
Phase 2   PPC/HIR/frontend wasm32 compile                     COMPLETE
Phase 2A  PPCContext wasm32 ABI                               COMPLETE
Phase 2B  translation ProbeBackend                            COMPLETE
Phase 2C  Xenia Memory / Processor probe closure              COMPLETE FOR PROBE
Phase 2D  complete current compiler-pass source manifest      COMPLETE
Phase 3   strict full-export link                             COMPLETE
Phase 3A  real PPC -> finalized Xenia HIR                     COMPLETE
Phase 3B  PPC TRANSLATION FOUNDATION                         COMPLETE / 100%
Phase 3C  STFS / package / XEX loader foundation              COMPLETE / 100%
Phase 4A  scalar PPC correctness foundation                   COMPLETE / 100%
Phase 4B  guest call/control foundation                       COMPLETE / 100%
Phase 4C  FLOAT64 load/store + ADD/SUB/MUL                    COMPLETE FIRST SUBSET
Phase 4D  FP DIV + compare/convert/FPSCR                      ACTIVE NEXT
Phase 4E  VMX VEC128 load/byte-add/store                      COMPLETE FIRST SUBSET
Phase 4F  broader VMX / VMX128 correctness                    NEXT
Phase 5   hot-block WasmBackend + function cache              FUTURE
Phase 5A  executable-page versioning/invalidation             FUTURE
Phase 6   sparse/page-backed Xbox guest memory                FUTURE
Phase 7   map/enter captured default.xex                      FUTURE
Phase 8   KernelState / xboxkrnl / XAM                        FUTURE
Phase 9   shared Xenos browser GPU layer                      FUTURE
Phase 10  WebAudio + first genuine guest framebuffer          FUTURE
```

## Next implementation boundary

Do not reopen the four completed foundations unless their regression gates fail. The next implementation sequence is:

1. genuine PPC `fdiv` plus typed FLOAT32/FLOAT64 HIR `DIV` execution;
2. floating compare/conversion and measured CR/FPSCR/rounding effects;
3. VMX halfword/word add/sub, vector logic, shifts and comparisons;
4. measured VMX128-specific cases representative of Xbox 360 code;
5. start `WasmBackend`: finalized Xenia HIR -> generated WebAssembly;
6. add function/block caching and executable-page versioning/invalidation;
7. replace the bounded correctness window with sparse/page-backed Xbox virtual/physical memory;
8. map complete captured `default.xex` sections at guest addresses;
9. establish initial CPU state and enter the real XEX entry point;
10. bring up KernelState/xboxkrnl/XAM from services real execution requests;
11. move into shared Xenos browser semantics, WebGPU/WGSL/EDRAM, WebGL2 fallback and WebAudio.

The transition is now:

```text
100% package/XEX foundation
        +
100% PPC translation foundation
        +
100% scalar PPC correctness foundation
        +
100% guest control foundation
        ↓
finish FPU + broaden VMX
        ↓
hot WasmBackend + full guest memory
        ↓
map actual default.xex
        ↓
execute actual title entry point
```

## Hot execution tier after correctness

```text
Xenia finalized HIR
  -> Render360 WasmBackend
  -> generated WebAssembly functions/modules
  -> cache by guest block + code version
```

Writes to executable guest pages must invalidate affected translated blocks.

## Browser graphics architecture

```text
Xenia Xenos command/register/resource/shader/EDRAM semantics
  -> shared Render360 browser GPU layer
       -> WebGPU PRIMARY backend / WGSL
       -> WebGL2 FALLBACK backend / GLSL ES
```

Both backends consume the same guest Xenos semantics. WebGL2 is a compatibility backend, not a fake alternate renderer.

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

## Do not port into the browser CPU bootstrap

- x64 emitter/native executable-code cache;
- D3D12 or Vulkan;
- desktop windowing/HID/audio output;
- desktop fixed-address 4.5 GiB mapping as though wasm32 supported it.

Those are host implementations, not Xbox semantics.
