# Render360 Xenia-Web V30

Render360 is an experimental browser port architecture for Xenia. V30 keeps the live C++/WebAssembly worker from V29 and moves the first real Xbox package-mount milestone into native WASM: a pull-driven STFS reader for LIVE/PIRS/CON containers.

## Project rule

**Xenia owns Xbox 360 behavior. Render360 owns browser/iOS host behavior.**

The browser should not grow another JavaScript Xbox emulator. V30's JavaScript only supplies browser capabilities such as `File.slice()`, UI, input and the host graphics surface. STFS layout, block mapping, hash-chain selection and directory parsing live in C++/WASM and are kept aligned with Xenia's `stfs_xbox.h` / `stfs_container_device.cc` behavior.

## V30 architecture

```text
GitHub Pages
   |
   +-- UI thread
   |    +-- File API byte-range adapter
   |    +-- touch/controller UI
   |    +-- direct WebGPU host
   |    +-- Three.js diagnostic (idle only)
   |
   +-- render360_xenia_core.wasm
   |    +-- strict XEX inspector
   |    +-- native STFS mount state machine
   |    |    +-- XContent / volume descriptor
   |    |    +-- block + hash address mapping
   |    |    +-- L0/L1/L2 active-index traversal
   |    |    +-- 0x40-byte directory parser
   |    |    +-- root default.xex lookup
   |    |    `-- first default.xex data-block probe
   |    `-- versioned ABI
   |
   `-- Web Worker
        `-- continuous native runtime/input/session telemetry
```

## What V30 genuinely does

- recognizes XEX1, XEX2, LIVE, PIRS, CON and PowerPC ELF
- begins a native STFS mount by giving WASM only the package size
- lets the C++ state machine request exact file ranges by 64-bit offset + size
- validates XContent/STFS header and volume descriptor fields
- maps STFS data blocks with Xenia's block-to-offset algorithm
- resolves read-only and resilient STFS hash backing-table selection through L0/L1/L2 active-index metadata
- follows the file-table block chain
- parses native 0x40-byte `StfsDirectoryEntry` records
- preserves Xenia's flat directory-parent index model
- locates root `default.xex` when present
- requests the first data block of that real embedded entry and proves XEX1/XEX2 magic
- keeps the V29 native worker/runtime/input bridge alive
- keeps direct WebGPU + WebGL2 fallback and a diagnostic Three.js layer that turns off while content is loaded

## Strict boundary

V30 **does not boot a retail game**. Finding `default.xex` is not execution. V30 does not yet:

- extract the complete `default.xex` STFS block chain
- expose mounted files through a full Xenia VFS object
- decrypt/decompress the XEX image
- validate/map its PE image and imports
- execute PowerPC code
- run kernel/XAM
- execute Xenos command streams or shaders
- render an Xbox game frame

Those are later milestones. The immediate V31 target is **full `default.xex` extraction through the mounted STFS/VFS path**.

## Xenia source workflow

The ZIP intentionally does not vendor the entire Xenia repository. Fetch the current upstream source when developing or in Actions:

```bash
bash ./scripts/fetch-xenia.sh
python3 ./scripts/xenia_contract_check.py
```

This creates `upstream/xenia/` locally and verifies that the XEX/STFS portability contracts Render360 currently uses still match upstream Xenia.

## Build and test

```bash
bash ./scripts/build-core.sh
node ./scripts/smoke_test_node.js
```

The smoke test constructs a two-directory-block synthetic LIVE/STFS package and drives the same native pull-I/O state machine used by the browser. It asserts that the hash chain is followed, two entries are enumerated, root `default.xex` is found, and its first data block is classified as XEX2.

The browser bridge test can also be run while serving the project on port 8765:

```bash
python3 -m http.server 8765
node ./scripts/test_mount_node.mjs
```

## GitHub Pages

The ZIP is root-ready for the existing configuration:

**Settings → Pages → Deploy from a branch → `main` → `/(root)`**

After uploading, a cache-busting test URL is:

`https://matthewcodergamer.github.io/Render360/?v=30`

## Performance direction

Do not use the diagnostic Three.js scene as the Xbox renderer. The intended game path remains:

```text
Xenia/Xenos command processor -> Render360 WebGPU backend -> WebGPU canvas
```

The portable C++ core is being kept separate so a future iOS target can reuse Xbox logic while replacing WASM/WebGPU with native ARM64/Metal where appropriate.

## Licensing

Xenia-derived layout/algorithm work preserves Xenia's BSD 3-Clause notice. See `LICENSE_XENIA.txt`. Future imported third-party components must preserve their own licenses as well.
