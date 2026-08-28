# Render360 Xenia-Web roadmap

## Project rule
**Port Xenia; do not imitate Xenia.**

Xenia remains the source of truth for Xbox 360 behavior. Render360 owns the browser host: WebAssembly build/runtime integration, browser file access, workers, WebGPU, WebAudio, touch/gamepad input, persistent browser storage, PWA behavior and diagnostics.

Keep as much Xbox-specific implementation as practical in C/C++ compiled to WebAssembly. JavaScript/TypeScript should be the browser platform layer, not a second emulator core.

## Current verified boundary — Core V32

### Working now
- Real freestanding C++ → wasm32 core and versioned ABI.
- Continuous Web Worker runtime with browser/native input bridge.
- Strict XEX1 / XEX2 / LIVE / PIRS / CON recognition.
- Native pull-driven STFS mount: WASM requests byte ranges and browser `File.slice()` services them.
- Xenia-aligned STFS header, volume descriptor, block mapping and hash-chain traversal.
- Native STFS directory parsing and root `default.xex` discovery.
- Complete `default.xex` streaming/capture without loading the entire package into WASM memory.
- XEX structural/header inspection and first-frame gate diagnostics.
- Direct WebGPU host initialization and dynamic-resolution infrastructure.
- Three.js test arena only for input/host diagnostics; it is explicitly not the Xbox renderer.
- Mobile touch controls, gamepad polling, worker telemetry and diagnostic UI.

### Not working yet
- No retail Xbox 360 PPC instruction execution.
- No Xenia PPC frontend/HIR compiled into the browser build yet.
- No mapped/decompressed/decrypted retail XEX image execution path yet.
- No Xenia KernelState/xboxkrnl/XAM startup yet.
- No guest thread scheduler running retail code yet.
- No Xenos ringbuffer command processor connected to a WebGPU backend yet.
- No Xenos shader → WGSL translator yet.
- No EDRAM/render-target/resolve implementation yet.
- No real guest framebuffer/present yet.

Therefore `PLAYABLE` must not be reported for retail titles yet.

## UI V33 — responsive shell
- Preserve the existing liquid-glass visual design.
- Shared safe-area layout contract for topbar, host controls, arena HUD, content and bottom controller zones.
- No independent absolute-position collisions between arena HUD/top controls/game chip.
- Scrollable central cards inside the safe playable viewport.
- Two-column phone status grid instead of six vertically stacked cards.
- Dynamic viewport (`dvh`) handling for iOS browser chrome.
- Collision-safe scaling of left/right/look controls on narrow portrait screens.
- Sheets constrained to safe viewport height.

UI versioning is intentionally separate from emulator-core versioning.

## Next core milestone — Xenia portable bootstrap

Before implementing another game-specific workaround, prove that selected upstream Xenia portable/common layers build under Emscripten/wasm32.

Initial compile target:

```text
Xenia base/common pieces
XEX structures/parser
memory structures
PPC frontend
HIR
portable compiler passes
VFS structures
kernel structures needed for module loading
Xenos definitions / generic decoding structures
```

Disable/replace for the web target:

```text
x64 backend/emitter/code cache
Win32/Linux/macOS windowing
D3D12 backend
Vulkan backend
native HID backends
native audio output
host-specific filesystem APIs
native executable-memory assumptions
host exception machinery that cannot map to the browser
```

Success condition: a browser-built `xenia_core.wasm` initializes the selected portable subsystems and reports their real status without booting a game.

## CPU path — reuse Xenia PPC frontend + HIR

Preferred architecture:

```text
Xbox 360 PPC/VMX128
        ↓
Xenia PPC frontend / translator
        ↓
Xenia HIR
        ↓
portable optimization/compiler passes
        ↓
Browser execution backend
```

Do **not** rebuild `PPCDecoder.js`, `PPCInterpreter.js`, a separate JS IR, or duplicate Xbox instruction semantics unless a specific upstream component proves impossible to port.

### Phase CPU-A — correctness backend
Provide a wasm32-safe correctness path first. This may be an interpreter/emulated-opcode backend driven from Xenia HIR.

Run Xenia PPC tests and synthetic guest blocks before retail games.

Track:
- guest PC
- guest instructions executed
- exceptions
- HIR blocks emitted
- interpreted/emulated operations
- unsupported opcodes

### Phase CPU-B — hot-code WebAssembly backend
After correctness, add a `WasmBackend` or equivalent hot-block path.

Conceptual split:

```text
Xenia HIR
   ↓
WasmBackend
   ↓
WebAssembly module/function generation
   ↓
Safari/JavaScriptCore WASM engine
   ↓
ARM64 iPhone CPU
```

Cache by guest address + code hash/mode and invalidate when guest code pages are modified.

The current Xenia x64 backend must not be treated as browser-portable code.

## XEX image preparation
Implement the executable path before claiming guest execution:

1. full XEX optional-header/security parsing
2. unencrypted/uncompressed image path first
3. PE image validation
4. guest section mapping and permissions
5. TLS/import/export metadata
6. supported compression paths
7. supported encryption/session-key paths where legally and technically appropriate
8. strict stop on unsupported required paths

Unknown or unsupported requirements must remain visible in diagnostics.

## Kernel/XAM — reuse heavily
Port Xenia kernel HLE rather than recreating Xbox APIs in JavaScript.

Target:
- `KernelState`
- export resolver
- xboxkrnl
- XAM
- kernel objects
- memory APIs
- files
- threads/events/semaphores/timers
- input-facing exports

Browser-specific work belongs underneath the Xbox-facing APIs.

Example:

```text
Guest NtOpenFile
   ↓
Xenia xboxkrnl HLE
   ↓
Xenia VFS
   ↓
Render360 browser random-access source
   ↓
Blob / OPFS / retained file source
```

No broad unknown-export `return success` stubs.

## Browser VFS / large-game I/O
Never load a multi-gigabyte disc image with `File.arrayBuffer()`.

Provide a random-access abstraction:

```text
size()
read(offset, length)
close()
```

Backends:
- Blob/File `slice()`
- OPFS
- IndexedDB chunk/cache layer where useful
- HTTP Range only for explicitly remote/user-authorized sources

Feed this beneath Xenia VFS/disc/STFS machinery.

Track bytes read, cache hits, read latency and outstanding I/O.

## Host threading
Guest Xbox threads and browser workers are different concepts.

Guest scheduler models Xbox thread state and synchronization.
Host workers are execution resources for CPU/GPU/I/O/audio work.

Where cross-origin isolation is available, use SharedArrayBuffer/WebAssembly shared memory. Keep a single-thread diagnostic path.

## GPU — add WebGPU as a Xenia backend
Do not rewrite Xenos in JavaScript and do not route the emulator through Three.js.

Preferred architecture:

```text
Xenos ringbuffer
   ↓
Xenia generic command processing / register state
   ↓
Xenia shader + texture interpretation
   ↓
WebGPU backend
```

Target components:
- WebGPUGraphicsSystem
- WebGPUCommandProcessor/backend integration
- WebGPUSharedMemory
- WebGPUTextureCache
- WebGPUPipelineCache
- WebGPURenderTargetCache
- WGSL shader translator

## Shader path
Reuse Xenia's Xenos decoding/analysis and implement the final browser emission stage:

```text
Xenos microcode
   ↓
Xenia shader analysis / IR
   ↓
WGSL emission
   ↓
WebGPU shader module
```

Do not rediscover what Xenos instructions mean if upstream already encodes that knowledge.

Cache by guest microcode hash and retain translation diagnostics.

## EDRAM / render targets
Reuse Xenia's semantics and algorithms, replace host API details.

Two browser paths may be needed:
- FAST: normal WebGPU render attachments when behavior maps safely.
- ACCURATE: storage-buffer/storage-texture + compute/fragment emulation for Xenos behavior WebGPU cannot directly express.

A real first frame requires guest render-target/resolve behavior, not a host-side substitute.

## Audio
Port Xbox-facing audio behavior in native/WASM code where practical and use AudioWorklet/WebAudio only as the host sink.

Maintain a ring buffer and expose underrun/buffer-depth telemetry.

## Storage
Separate user game data from generated emulator data.

User game data:
- selected XEX/STFS/disc
- retained file handle/source where browser capabilities allow

Generated data:
- shader translation cache
- pipeline metadata
- texture-transcode cache
- title settings
- compatibility data
- Xbox save data

Use OPFS/IndexedDB as appropriate.

## First real-frame ladder

```text
STFS/disc mounted
→ default.xex available
→ XEX image mapped
→ first PPC instruction
→ sustained PPC execution
→ KernelState/xboxkrnl/XAM startup
→ guest threads running
→ first Xenos packet
→ first guest shader decoded
→ first WGSL shader compiles
→ first guest draw submitted
→ EDRAM/resolve succeeds
→ guest framebuffer presented
```

The UI should show this exact chain and never advance a gate based on timers or host-side test graphics.

## Validation order
1. Xenia portable wasm32 bootstrap.
2. Xenia PPC/unit tests through the browser-safe CPU backend.
3. Synthetic PPC executable/homebrew.
4. Simple XEX/kernel startup.
5. Null GPU backend logging real ringbuffer packets.
6. Offline one-shader Xenos → WGSL test.
7. One guest triangle/draw.
8. First genuine guest framebuffer.
9. Small/simple XBLA title.
10. Braid-class title.
11. Portal / Orange Box-class title.
12. GTA IV.
13. GTA V only after the emulator foundations are proven.

## Definition of the first major emulator milestone
The milestone is complete only when user-provided Xbox 360 content causes all of the following:

1. real XEX found and parsed
2. image mapped into guest memory
3. imports bound to real HLE implementations
4. PPC guest instructions execute
5. guest threads run
6. guest-generated Xenos packets are processed
7. a real guest shader is translated to WGSL
8. a real guest draw reaches WebGPU
9. a guest-generated framebuffer is presented

Priority remains:

**correctness → observability → compatibility → performance → visual polish**
