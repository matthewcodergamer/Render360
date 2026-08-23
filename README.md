# Render360 Xenia-Web V29

Render360 is an experimental browser port architecture for Xenia. V29 focuses on making the browser runtime genuinely live while keeping unsupported Xbox 360 functionality explicit.

## V29 runtime architecture

```text
GitHub Pages (serves files)
        |
        +--> UI thread
        |      +--> WebGPU animated shader pipeline
        |      +--> Three.js / WebGL diagnostic renderer
        |      +--> touch/controller UI
        |
        +--> Web Worker
               +--> C++ wasm32 core
               +--> continuous r360_runtime_tick
               +--> native input state
               +--> runtime counters/telemetry
```

The worker continues while the page is active. iOS/Safari may reduce or suspend JavaScript/worker activity when the tab is backgrounded or the device is locked; GitHub Pages does not provide a permanently running server process.

## Current native features

- XEX1 / XEX2 / STFS LIVE / PIRS / CON / PowerPC ELF recognition
- Xenia-aligned XEX base/optional/security metadata inspection
- versioned C++/WASM ABI
- continuous native worker runtime heartbeat
- native controller input bitmask
- strict scalar XAM bridge for verified transitional values
- animated WebGPU graphics pipeline, WebGL2 fallback, and Three.js/WebGL diagnostic layer

## Not yet implemented

- STFS VFS mount/default.xex extraction in the native core
- Xenia XEX decryption/decompression and PE image mapping
- full kernel/XAM implementation
- PowerPC/Xenia HIR browser execution backend
- Xenos command processor to WebGPU
- Xenos shader translation to WGSL
- textures, EDRAM, resolves, audio and real commercial-game execution

## Build the WASM core

```bash
bash ./scripts/build-core.sh
node ./scripts/smoke_test_node.js
```

## Run locally

```bash
python3 -m http.server 8000
```

Then open `http://localhost:8000/`.

## GitHub Pages

This repository is root-ready for **Settings -> Pages -> Deploy from a branch -> main -> /(root)**.

The browser downloads the static files from GitHub Pages, then the Web Worker, WASM and graphics loops run on the user's device.

## Licensing

Xenia-derived work must preserve Xenia's BSD 3-Clause license and any applicable third-party licenses. Three.js is loaded as a diagnostic dependency from its public CDN distribution and is licensed under MIT.
