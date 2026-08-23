# Xenia upstream port map — V29

## Source-of-truth files

- `src/xenia/kernel/util/xex2_info.h`
  - XEX structures, optional-header keys, compression/encryption enums.
  - V29's native inspector is intentionally kept structurally aligned to this file.
- `src/xenia/cpu/xex_module.cc` / `.h`
  - XEX1/XEX2 load flow, security info, image preparation, optional-header handling, PE validation, imports.
- `src/xenia/cpu/lzx.*`
  - Normal-compression path used by XEX loading.
- `src/xenia/cpu/ppc/`
  - Xenon PowerPC frontend/HIR path.
- `src/xenia/cpu/backend/`
  - Host execution backend interface; x64 backend is not browser-usable directly.
- `src/xenia/gpu/command_processor.cc`
  - Shared Xenos command/ring processing.
- `src/xenia/gpu/shader*`
  - Xenos shader representation/translation.
- `src/xenia/gpu/xenos.h` and register/texture utilities
  - Guest GPU semantics.

## Browser-owned code

Keep this small:
- UI and file picker
- WebAssembly loader/ABI bridge
- WebGPU device and presentation backend
- gamepad/touch mapping
- browser audio
- IndexedDB/OPFS persistence

## V29 boundary

V29 has not copied `XexModule::Load` and does not claim XEX execution. It ports only the stable XEX layout knowledge necessary to validate/inspect headers in the native core. The GitHub `Xenia upstream contract check` workflow detects obvious drift in the tracked keys/structures before later native port work builds on them.
