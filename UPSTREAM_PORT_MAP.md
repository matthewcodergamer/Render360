# V30 upstream Xenia port map

Render360 currently keeps a small freestanding wasm32 compatibility subset instead of vendoring the full Xenia tree. `scripts/fetch-xenia.sh` brings current upstream into `upstream/xenia/`, and `scripts/xenia_contract_check.py` detects drift in the pieces V30 mirrors.

| Render360 V30 area | Xenia source of truth | V30 status |
|---|---|---|
| XEX header / optional-header keys | `src/xenia/kernel/util/xex2_info.h` | portability subset in `src/xenia_port/xex2_layout.h` |
| XEX module boundary | `src/xenia/cpu/xex_module.h/.cc` | structure inspection only; full module/image load future |
| XContent package / STFS structs | `src/xenia/vfs/devices/stfs_xbox.h` | on-disk constants in `src/xenia_port/stfs_layout.h` |
| STFS device mount | `src/xenia/vfs/devices/stfs_container_device.cc` | native pull-driven mount state machine |
| STFS block mapping | `BlockToOffsetSTFS` | ported for wasm32 |
| STFS hash-table selection | `BlockToHashBlockNumberSTFS`, `GetBlockHash` | L0/L1/L2 active-index logic ported |
| STFS directory enumeration | `ReadSTFS` | native 0x40 entry parser + flat parent indices |
| Browser file I/O | host-specific Render360 adapter | `File.slice()` fulfills native range requests |
| Xenia VFS `Device` / `Entry` objects | `src/xenia/vfs/` | V31 target |
| PowerPC | `src/xenia/cpu/` | not yet ported |
| Kernel/XAM | `src/xenia/kernel/` | not yet ported |
| Xenos command processing | `src/xenia/gpu/command_processor.cc` | future shared subsystem |
| Web host GPU | Render360-specific | direct WebGPU diagnostic today; emulator backend future |

The goal is to progressively reduce the compatibility subset as more actual upstream Xenia source can compile for the web target.
