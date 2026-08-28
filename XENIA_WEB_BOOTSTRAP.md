# Xenia Web Bootstrap — V33 CPU breakthrough

## Goal

Bring the real upstream Xenia PowerPC/FPU/VMX frontend, instruction semantics, HIR/compiler pipeline, Processor runtime and minimum browser-safe host support into wasm32 without importing Xenia's native x64 JIT or desktop graphics backends.

Milestone language remains strict:

- **PPC TRANSLATION FOUNDATION COMPLETE**: the defined portable Xenia translation graph, current compiler-pass set, scanner/emitter surface and strict wasm32 link are regression-gated.
- **PPC EXECUTING**: finalized Xenia HIR executes and produces verified PowerPC architectural-state or guest-memory changes.
- **PLAYABLE**: genuine title execution, kernel, graphics, input and audio work sufficiently for gameplay.

## Current authoritative green result — run 153

GitHub Actions run **153** (`33145524618`) completed successfully at commit `1d59e3618f4cf624a97c2d1b8fb84c01ccd44ad1`.

```text
V32 package/XEX rebuild       PASS
PACKAGE_XEX_FOUNDATION        PASS
PPC_TRANSLATION_FOUNDATION    PASS
wasm32 compile matrix         64 passed / 0 blocked
strict full-export link       LINKED
rooted exports                25
real PPC correctness cases    18 / 18 PASS
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

## Translation foundation — COMPLETE

`xenia_translation_foundation_check.py` is now the explicit completion gate for this layer. It locks the current source manifest and fails if upstream drift introduces an untracked compiler pass or removes a required translation component.

Measured run-153 manifest:

```text
upstream translation units       36
browser translation units         6
current compiler passes          14
runtime category markers         10
full wasm32 build graph          64 / 64 PASS
```

The locked translation scope includes:

- `PPCFrontend`;
- `PPCTranslator`;
- `PPCScanner`;
- PPC context and opcode table/lookup/disassembly support;
- `ppc_emit_alu.cc`;
- `ppc_emit_control.cc`;
- `ppc_emit_memory.cc`;
- `ppc_emit_fpu.cc`;
- `ppc_emit_altivec.cc`;
- HIR opcodes, blocks, instructions, values and builder;
- compiler/compiler-pass framework;
- all current upstream compiler-pass `.cc` implementations, including data-flow analysis and value reduction;
- browser logging/thread-host seams;
- correctness backend, probe backend and translation driver;
- strict `ERROR_ON_UNDEFINED_SYMBOLS=1` link behavior;
- representative real PPC/FPU/VMX end-to-end runtime categories.

This is why the **Xenia PPC translation foundation is now 100% complete for its defined portable browser scope**. This does not mean arbitrary PPC execution compatibility is complete; that is Phase 4 and remains active.

## Package/XEX foundation — COMPLETE

The same workflow now rebuilds Core V32 from source and runs `test-package-xex-foundation.mjs` before the CPU bootstrap.

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

Measured run 153:

```text
core_version        32
mount_reads         5
extract_reads       3
default_xex_bytes   6144
default_xex_blocks  2
xex_entry           0x82001234
```

The synthetic `default.xex` deliberately spans two fragmented blocks, forcing the native extraction state machine to follow the STFS hash chain rather than passing only a first-block probe. The reconstructed executable is compared byte-for-byte and then fed into the XEX inspector.

This closes the **current STFS/Xbox-package/XEX loader foundation**. Retail-specific encryption/compression compatibility and actual executable mapping are later layers, not unfinished foundation work.

## What is now verified in execution

### Integer / control / memory

```text
li r3,1 ; blr                                      -> r3 = 1
seed r4=7; addi r3,r4,5 ; blr                     -> r3 = 12
seed r4=0x0F00; ori r3,r4,0xF0 ; blr              -> r3 = 0x0FF0
cmpwi/beq, r4=0                                   -> taken, r3 = 2
cmpwi/beq, r4=5                                   -> fallthrough, r3 = 1
lwz r3,0(r4), guest=0x89ABCDEF                   -> r3 = 0x89ABCDEF
stw r5,0(r4); lwz r3,0(r4)                        -> r3/guest = 0x12345678
mtlr r4; mflr r3                                  -> r3 = 0x80000040
mtctr r4; mfctr r3                                -> r3 = 9
cmpwi r4,0; mfcr r3                               -> r3 = 0x20000000
mtctr r4; addi loop; bdnz loop, r4=3              -> r3 = 3
direct bl/callee/blr                              -> r3 = 7
two-level nested bl                               -> r3 = 7
```

Direct and nested calls are not hardcoded. Xenia emits call/LR behavior, the real Xenia scanner discovers callee extents, and each callee is independently translated through Xenia before finalized HIR executes against the shared active `PPCContext`.

### FLOAT64 arithmetic

The current FPU tier verifies:

```text
1.0 + 2.0 = 3.0
5.0 - 2.0 = 3.0
1.5 * 2.0 = 3.0
```

Each uses genuine `lfd -> arithmetic -> stfd` PPC and verifies the exact result bits:

```text
0x4008000000000000 = IEEE-754 double 3.0
```

ADD, SUB and MUL are verified. DIV, compare/conversion and deeper FPSCR behavior remain open.

### First VMX VEC128 execution tier

Run 153 keeps the first VMX execution gate green:

```text
lvx      v1,0,r4
lvx      v2,0,r5
vaddubm  v3,v1,v2
stvx     v3,0,r7
lwz      r3,0(r7)
blr
```

Xenia emits 29 finalized HIR instructions. The executor supports exactly the measured VEC128 byte-swap and unsigned INT8 `VECTOR_ADD` form. Sixteen `0x01` bytes plus sixteen `0x02` bytes produce sixteen `0x03` bytes in guest memory.

Unsupported HIR remains fail-closed.

## Phase ladder after foundation completion

```text
Phase 1   upstream source / contract audit                    COMPLETE
Phase 2   PPC/HIR/frontend wasm32 compile                     COMPLETE
Phase 2A  PPCContext wasm32 ABI                               COMPLETE
Phase 2B  translation ProbeBackend                            COMPLETE
Phase 2C  Xenia Memory / Processor probe closure              COMPLETE FOR PROBE
Phase 2D  complete current compiler-pass source manifest      COMPLETE (run 153)
Phase 3   strict full-export link                             COMPLETE
Phase 3A  real PPC -> finalized Xenia HIR                     COMPLETE
Phase 3B  PPC TRANSLATION FOUNDATION                         COMPLETE / 100%
Phase 3C  STFS / package / XEX loader foundation              COMPLETE / 100%
Phase 4   finalized-HIR correctness execution                 ACTIVE / VERIFIED
Phase 4A  integer arithmetic / compare / branch               COMPLETE FIRST SUBSET
Phase 4B  guest load/store + endian semantics                 COMPLETE FIRST SUBSET
Phase 4C  CR/LR/CTR + backward loops                          COMPLETE FIRST SUBSET
Phase 4D  direct + nested guest calls                         COMPLETE FIRST SUBSET
Phase 4E  FLOAT64 load/store + ADD/SUB/MUL                    COMPLETE FIRST SUBSET
Phase 4F  VMX VEC128 load/byte-add/store                      COMPLETE FIRST SUBSET
Phase 4G  FP DIV + compare/convert/FPSCR                      ACTIVE NEXT
Phase 4H  broader VMX / VMX128 correctness                    NEXT
Phase 5   hot-block WasmBackend + function cache              FUTURE
Phase 5A  executable-page versioning/invalidation             FUTURE
Phase 6   sparse/page-backed Xbox guest memory                FUTURE
Phase 7   map/enter captured default.xex                      FUTURE
Phase 8   KernelState / xboxkrnl / XAM                        FUTURE
Phase 9   shared Xenos browser GPU layer                      FUTURE
Phase 10  WebAudio + first genuine guest framebuffer          FUTURE
```

## Next implementation boundary

Do not keep reopening the two complete foundations unless their regression gates fail. The next implementation sequence is:

1. add genuine PPC `fdiv` and typed FLOAT32/FLOAT64 HIR `DIV` execution;
2. add floating compare/conversion cases and verify CR/FPSCR effects;
3. broaden VMX to halfword/word add/sub, vector logic, shifts and comparisons;
4. add measured VMX128-specific cases representative of Xbox 360 code;
5. start `WasmBackend`: finalized Xenia HIR -> generated WebAssembly;
6. add function/block caching and executable-page invalidation;
7. replace the bounded correctness window with sparse/page-backed Xbox virtual/physical memory;
8. map complete captured `default.xex` sections at guest addresses;
9. establish initial CPU state and enter the real XEX entry point;
10. bring up KernelState/xboxkrnl/XAM from the services real execution requests;
11. then move into the shared Xenos browser GPU layer, WebGPU/WGSL/EDRAM, WebGL2 fallback and WebAudio.

The major transition is now straightforward to describe:

```text
complete STFS/XEX package source
        +
complete PPC translation foundation
        +
expanding correctness execution
        ↓
full guest memory
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
```

## Do not port into the browser CPU bootstrap

- x64 emitter/native executable-code cache;
- D3D12 or Vulkan;
- desktop windowing/HID/audio output;
- desktop fixed-address 4.5 GiB mapping as though wasm32 supported it.

Those are host implementations, not Xbox semantics.