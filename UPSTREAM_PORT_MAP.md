# Render360 upstream Xenia port map — V33

Render360 uses Xenia as the source of truth for Xbox 360 behavior. The browser project should progressively consume Xenia's portable/common implementation while keeping browser host services separate.

`fetch-xenia.sh` pulls current upstream into `upstream/xenia/`. `xenia_contract_check.py` protects the existing XEX/STFS compatibility subset, and `xenia_web_bootstrap_check.py` now audits the PPC frontend/HIR/compiler surface required for the V33 CPU bootstrap.

| Render360 area | Xenia source of truth | Current status / next boundary |
|---|---|---|
| XEX header / optional-header keys | `src/xenia/kernel/util/xex2_info.h` | wasm32 compatibility subset active |
| XEX module boundary | `src/xenia/cpu/xex_module.h/.cc` | structural inspection active; image preparation/mapping next |
| XContent / STFS structs | `src/xenia/vfs/devices/stfs_xbox.h` | on-disk constants mirrored |
| STFS device behavior | `src/xenia/vfs/devices/stfs_container_device.cc` | native pull-driven browser mount active |
| STFS block/hash mapping | `BlockToOffsetSTFS`, `BlockToHashBlockNumberSTFS`, `GetBlockHash` | active |
| STFS directory + default.xex | `ReadSTFS()` and Xenia STFS structures | complete executable streaming/capture active |
| Browser random access | Render360 host adapter | `File.slice()` range reads active; OPFS/retained handles future |
| Xenia VFS objects | `src/xenia/vfs/` | integrate after executable-image boundary |
| PPC architectural state | `src/xenia/cpu/ppc/ppc_context.*` | V33 bootstrap target |
| PPC frontend | `src/xenia/cpu/ppc/ppc_frontend.*` | V33 bootstrap target |
| PPC translator | `src/xenia/cpu/ppc/ppc_translator.*` | V33 bootstrap target |
| PPC -> HIR semantics | `src/xenia/cpu/ppc/ppc_hir_builder.*`, `ppc_emit_*.cc` | V33 bootstrap target |
| HIR | `src/xenia/cpu/hir/` | V33 reusable portable boundary |
| compiler / passes | `src/xenia/cpu/compiler/` | V33 reusable portable boundary |
| x64 backend | `src/xenia/cpu/backend/x64/` | **do not port to browser** |
| browser correctness backend | Render360 | build after real Xenia HIR compiles |
| WasmBackend | Render360 | hot-block backend after correctness tests |
| Kernel/XAM | `src/xenia/kernel/` | reuse heavily after PPC execution |
| Xenos command processing | `src/xenia/gpu/command_processor.cc` + common GPU code | reuse after kernel startup |
| Xenos shader knowledge | Xenia shader translator/common GPU code | reuse analysis; add WGSL emission |
| D3D12/Vulkan | Xenia host GPU backends | reference behavior only; **do not port APIs** |
| WebGPU | Render360 host backend | diagnostic host active; real Xenos backend future |
| EDRAM / render targets | Xenia common semantics + backend behavior | add WebGPU implementation |
| Browser audio | Xenia Xbox/APU behavior + Render360 WebAudio host | future |
| Browser HID | Xenia Xbox input semantics + Render360 Gamepad/touch host | host input bridge already active |

## CPU seam we are preserving

```text
Xbox PPC / VMX128
        -> Xenia PPCFrontend
        -> Xenia PPCTranslator
        -> Xenia PPCHIRBuilder / emit semantics
        -> Xenia HIR
        -> portable compiler passes
        -> [browser correctness backend]
        -> [Render360 WasmBackend]
```

Upstream `PPCFrontend::DefineFunction` already allocates a `PPCTranslator` and invokes `Translate`, so Render360 should preserve that real path rather than creating a parallel JavaScript PPC decoder.

## Rule

If a subsystem describes **Xbox behavior**, prefer upstream Xenia implementation or semantics. If it describes **host OS / host CPU / host graphics API behavior**, replace it with a browser adapter.

See `XENIA_WEB_BOOTSTRAP.md` for the V33 CPU milestone and its no-fake-success criteria.
