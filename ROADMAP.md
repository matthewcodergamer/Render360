# Render360 Xenia-Web Roadmap — V36

## Project rule

**Port Xenia; do not imitate Xenia.** Xenia remains the semantic source of truth for Xbox 360 CPU, kernel and GPU behavior. Render360 owns browser-native integration: WebAssembly, sparse memory, browser storage/I/O, workers, WebGPU, WebGL2 fallback, WebAudio, input and diagnostics.

The root `README.md` is the authoritative public status board.

## Promotion rule

Development order is implementation first, critic last:

1. define a bounded subsystem contract;
2. finish the implementation;
3. pass its implementation tests;
4. let a separate adversarial critic attack it;
5. replay previously locked foundations where the aggregate stack is touched;
6. only then promote the bounded contract to 100%.

## Verified closure ladder

```text
Run 254  eight CPU/browser foundations
Run 261  strict XEX guest mapper
Run 265  full default.xex STFS extraction
Run 276  XEX2 metadata + decoded mapper integration
Run 282  NONE/NONE preparation
Run 288  BASIC preparation
Run 294  NORMAL framing/deblocking
Run 299  upstream Xenia LZX in wasm32
Run 303  XEX session-key / AES-CBC foundation
Run 315  prepared NORMAL image → relocated guest entry → Xenia PPC/HIR
Run 321  strict Xbox PE image decoder
Run 328  prepared PE image → SparseGuestMemory → decoder-derived entry
Run 335  prepared PE entry → mapped guest bytes → Xenia PPC/HIR
Run 338  encrypted retail NONE/BASIC/NORMAL → exact prepared image
Run 348  entry execution + first runtime-boundary telemetry
Run 369  XEX imports → real PE RVA mapping → kernel HLE execution bridge
Run 373  independent harsh critic → PPC/kernel ABI + guest state + continuation
Run 379  starter xboxkrnl/XAM services + guest threads/TLS/runtime
GPU Run 3  bounded Xenos + EDRAM + guest-memory bridge + WebGPU/WGSL
Run 389  translated guest PPC → PM4 → Xenos → EDRAM frame + provenance critic
WebGL2 Run 1  Xenos framebuffer → WebGL2 presentation + harsh critic
Run 395  title-handoff startup-state support + full locked regression replay
XEX GPU Traffic Run 10  encrypted XEX → relocated PPC PM4 → Xenos + harsh critic
XDVDFS Title Input Run 6  virtual XISO/XGD mount → real default.xex + browser runtime
Publish Browser Bootstrap Run 1  verified full bootstrap artifact → Pages/main
Deployed Browser Bootstrap Critic Run 1  deployed-WASM hash/provenance/export closure
```

Latest browser-title gates: XDVDFS Run 6 is Actions ID `33242096411`; Publish Browser Bootstrap Run 1 is `33242129180`; Deployed Browser Bootstrap Critic Run 1 is `33242318128`. The deployed bootstrap originates from full Xenia/WASM Run `33240071351`, source commit `1296c26eaabf85f0dd034321743c813626cc3a43`, and is provenance-checked before browser promotion.

## Closed V36 contracts

```text
CPU / WASM / MEMORY FOUNDATIONS                  100% ✓
PACKAGE / STFS / XEX FOUNDATION                  100% ✓
XEX2 METADATA + GUEST MAPPER                     100% ✓
NONE / BASIC / NORMAL PREPARATION                100% ✓
UPSTREAM XENIA LZX WASM                          100% ✓
XEX SESSION-KEY / AES-CBC                        100% ✓
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
REAL xboxkrnl / XAM STARTER SERVICES             100% ✓
GUEST THREADS / TLS / RUNTIME FOUNDATION         100% ✓
XENOS FIRST-FRAME SEMANTIC FOUNDATION            100% ✓
INDEPENDENT XENOS HARSH CRITIC                   100% ✓
WEBGPU / WGSL / EDRAM PRESENTATION FOUNDATION    100% ✓
GUEST MEMORY → XENOS → EDRAM FRAME BRIDGE       100% ✓
FIRST GENUINE GUEST FRAME                        100% ✓
INDEPENDENT FIRST-FRAME PROVENANCE CRITIC        100% ✓
WEBGL2 XENOS FRAMEBUFFER FALLBACK                100% ✓
INDEPENDENT WEBGL2 FALLBACK HARSH CRITIC         100% ✓
ENCRYPTED XEX PIPELINE → XENOS TRAFFIC BRIDGE    100% ✓
INDEPENDENT XEX→GPU TRAFFIC HARSH CRITIC         100% ✓
XDVDFS VIRTUAL ISO INPUT                         100% ✓
INDEPENDENT XDVDFS HARSH CRITIC                  100% ✓
BROWSER TITLE RUNTIME / XEX SECURITY HANDOFF     100% ✓
VERIFIED MODERN BOOTSTRAP DEPLOYMENT             100% ✓
DEPLOYED BOOTSTRAP PROVENANCE/EXPORT CRITIC      100% ✓
```

These are bounded contracts, not universal Xbox 360 compatibility claims.

## Gate D4A0 — encrypted XEX title pipeline to Xenos traffic — CLOSED

A structurally valid encrypted retail-style XEX2 fixture reaches AES/session-key preparation, strict PE decode, relocated guest mapping, translated Xenia PPC/HIR, PPC-produced PM4 words, exact guest-memory provenance and the closed Xenos/EDRAM frame path. The fixture is **not a commercial game**.

## Gate D4A1 — browser ISO / real title input — CLOSED

```text
user-selected .iso File/Blob
        ↓
XISO/XGD1/XGD2/XGD3 XDVDFS detection
        ↓
bounded directory reads
        ↓
real /default.xex discovery
        ↓
XEX2 encrypted image key from security-info + 0x150
        ↓
existing retail XEX / PE / PPC / kernel handoff
```

The ISO remains virtual; the browser does not copy a multi-gigabyte disc into Wasm. The harsh critic checks bounded reads, pointer/range corruption, exact `default.xex` provenance and no whole-image copy.

The modern `xenia_ppc_bootstrap.wasm` is now automatically published from a successful full Xenia/WASM artifact. A separate deployed-binary critic verifies SHA-256/size provenance and the required PPC/kernel/Xenos exports before this browser runtime contract is considered closed.

## Gate D4B — genuine extracted title to real GPU traffic — ACTIVE

This is now the primary milestone:

```text
real user-supplied ISO / STFS title
        ↓
virtual filesystem → genuine default.xex
        ↓
retail XEX preparation + PE mapping
        ↓
Xenia PPC/HIR execution
        ↓
real title kernel/runtime progress
        ↓
CAPTURE ACTUAL GPU MMIO / RINGBUFFER ADDRESS + WORDS
        ↓
closed Xenos PM4 / EDRAM path
        ↓
FIRST EXTRACTED-TITLE FRAME
```

The implementation must capture the GPU command address/range created by genuine title execution. It must not substitute a test PM4 stream. The first exact unsupported kernel call, MMIO register, PM4 command, shader instruction, texture/resource descriptor or EDRAM format becomes the next implementation target.

## Immediate implementation order

```text
1. Exercise the deployed browser path with a lawful user-supplied Xbox 360 ISO/XEX.
2. Extend translated title execution so GPU MMIO/ringbuffer setup writes are captured automatically.
3. Follow the genuine command processor ringbuffer address/range from title state.
4. Feed only those title-produced PM4 words into the existing Xenos provenance bridge.
5. Record the first exact unsupported PM4 packet/register or shader/resource operation.
6. Port the corresponding upstream Xenia semantic behavior.
7. Capture real vertex/pixel shader microcode and translate the reached subset to WGSL.
8. Add vertex/index fetch, textures/resources and EDRAM/resolve formats as the real trace demands.
9. Present the first extracted-title frame via WebGPU and verify the same Xenos frame via WebGL2 where supported.
10. Run a separate extracted-title frame provenance critic before promotion.
```

Additional xboxkrnl/XAM, synchronization, filesystem, audio or input behavior is implemented only when genuine title execution asks for it.

## ISO / GOD input track

Render360 does not require ISO2GOD.

```text
.iso → random-access XDVDFS File/Blob mount → default.xex + game files  ✓ CLOSED
genuine STFS package → STFS mount → default.xex                        ✓ CLOSED
both → existing Render360 XEX / PE / PPC pipeline                       ✓ CLOSED INPUT HANDOFF
```

The GOD-specific filesystem/container variants can be expanded when a real input requires behavior beyond the already-closed STFS path.

## Performance track

Performance work should be driven by real traces: keep hot execution in Wasm, minimize JS↔Wasm crossings, retain compiled PPC Wasm caching, use Wasm SIMD for VMX, batch Xenos command handling, cache translated shaders/resources, reduce EDRAM copies, use low internal resolution for mobile, and move shared queues/workers behind cross-origin-isolation capability checks.

## Compatibility ladder

```text
CPU/browser foundations                           ✓ LOCKED
STFS + XEX metadata                               ✓ LOCKED
retail XEX preparation                            ✓ LOCKED
strict PE decode + guest mapping                  ✓ LOCKED
prepared entry → Xenia PPC/HIR                    ✓ LOCKED
kernel ABI + starter services                     ✓ LOCKED
threads/TLS/runtime                               ✓ LOCKED
Xenos first-frame semantic foundation             ✓ LOCKED
WebGPU/WGSL/EDRAM presentation foundation         ✓ LOCKED
first translated-guest-PPC frame                  ✓ LOCKED BY PROVENANCE CRITIC
WebGL2 Xenos framebuffer fallback                 ✓ LOCKED BY HARSH CRITIC
encrypted XEX pipeline → relocated Xenos traffic  ✓ LOCKED BY HARSH CRITIC
ISO/XDVDFS virtual mount + browser title handoff   ✓ LOCKED BY HARSH CRITIC
verified modern bootstrap deployed to Pages       ✓ LOCKED BY DEPLOYMENT CRITIC
genuine extracted title → actual GPU traffic       ← ACTIVE
real shader / texture / resource translation
first extracted-title frame
performance / latency optimization
small homebrew / XBLA-class bring-up
Braid-class playable target
Portal-class bring-up
Portal 2-class bring-up
```

## Status rule

Never report `REAL TITLE ENTRY`, `FIRST TITLE DRAW`, `FIRST TITLE PRESENT`, `FIRST EXTRACTED-TITLE FRAME`, `PLAYABLE`, title FPS, shader translation or title boot unless that event came from genuine extracted-title execution through the corresponding emulator subsystem.
