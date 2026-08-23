# Render360 Xenia-Web V28

Render360 is being rebuilt as a **browser port project around Xenia's architecture**, not as another giant JavaScript Xbox 360 emulator.

V28 is designed for the GitHub Pages configuration already used by the project:

- **Source:** Deploy from a branch
- **Branch:** `main`
- **Folder:** `/(root)`

The website files are therefore at the repository root. Upload the extracted contents of this ZIP to the root of the Render360 repository and GitHub Pages can serve them directly.

## What V28 genuinely adds

- Real freestanding **C++ → wasm32** native core.
- ABI 3.0 and build version 28.
- 8 MB native file-staging window.
- Strict recognition of XEX1, XEX2, LIVE, PIRS, CON and PowerPC ELF.
- **Xenia-aligned XEX header inspection in WASM**, not JavaScript:
  - module flags
  - XEX header size
  - security-info offset
  - optional-header count
  - entry point
  - image base
  - system flags
  - execution info / title ID / media ID when present
  - file-format encryption/compression metadata when present
  - selected XEX2 security metadata (image size, load address, region, media flags, page count)
- WebGPU canvas initialization with WebGL2 diagnostic fallback.
- Strict unsupported boundaries; it does not claim that parsed XEX metadata means the title booted.
- A weekly/manual GitHub workflow that fetches current Xenia and checks that V28's XEX constants/layout contract has not drifted from upstream.
- Build/smoke-test GitHub workflow for the wasm core.

## What is NOT finished

V28 is **not yet a playable Xbox 360 emulator**. The next native milestones are still substantial:

1. Xenia XEX decryption/decompression and PE image mapping.
2. Xenia import/library setup and VFS/STFS mounting.
3. xboxkrnl/XAM kernel behavior.
4. Browser-compatible PowerPC execution backend.
5. Shared Xenos command processing.
6. WebGPU command/texture/EDRAM/resolve backend.
7. Xenos shader translation for WebGPU.
8. Audio, gamepad/touch and persistent storage.

## GitHub upload

Extract the ZIP and upload **the contents**, not the ZIP as one file. The root should contain:

```text
index.html
app.css
app.js
wasm-core.js
gpu-web.js
render360_xenia_core.wasm
manifest.webmanifest
.nojekyll
src/
scripts/
docs/
.github/
README.md
LICENSE_XENIA.txt
VERSION
```

With GitHub Pages already set to `main` + `/(root)`, the project URL is:

```text
https://matthewcodergamer.github.io/Render360/
```

## Build the core

```bash
bash ./scripts/build-core.sh
node ./scripts/smoke_test_node.js
```

The committed `render360_xenia_core.wasm` is prebuilt so branch-based GitHub Pages can run without compiling in the browser.

## Check against current Xenia

```bash
bash ./scripts/fetch-xenia.sh
python3 ./scripts/xenia_contract_check.py
```

`src/xenia_port/xex2_layout.h` contains only the small XEX layout subset needed for the V28 native inspection milestone and preserves Xenia BSD attribution. Full emulator behavior should continue to come from upstream Xenia as subsystems are ported.

## License

Xenia is BSD 3-Clause licensed. Keep `LICENSE_XENIA.txt`. Xenia third-party dependencies retain their own licenses and must be audited before vendoring or redistribution.
