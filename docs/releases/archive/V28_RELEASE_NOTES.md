# V28 release notes

V28 is the first Render360 build where XEX inspection is moved past four-byte magic detection into a strict native WebAssembly parser aligned with Xenia's XEX structures.

### Added
- ABI 3.0 / build 28.
- XEX header structural validation.
- Optional-header scan in C++/WASM.
- Entry point and image-base extraction.
- XEX execution-info title/media ID extraction.
- Compression/encryption metadata extraction.
- XEX2 security metadata extraction.
- Root-level GitHub Pages layout for `main` + `/(root)` deployment.
- Upstream-Xenia contract checker workflow.
- Expanded smoke tests using a synthetic structurally valid XEX2 header.

### Still intentionally unsupported
- XEX decryption/decompression.
- PE mapping and execution.
- STFS mounting.
- xboxkrnl/XAM runtime.
- PowerPC execution.
- Xenos rendering and shaders.

Unsupported work remains visible as a compatibility boundary rather than being returned as fake success.
