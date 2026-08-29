#!/usr/bin/env python3
"""Adapt upstream Xenia's shader interpreter to Render360 sparse guest RAM.

The Xenos control-flow, ALU, vertex-format and export semantics remain upstream
Xenia. Only the desktop physical-memory pointer used by vertex fetches is
redirected to Render360's authoritative sparse guest-memory model. Trace-writer
file telemetry is disabled in this standalone browser runtime.
"""
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SOURCE = ROOT / "upstream/xenia/src/xenia/gpu/shader_interpreter.cc"
DEST = ROOT / "build/xenia-web-overlay/xenia/gpu/shader_interpreter.cc"
if not SOURCE.exists():
    raise SystemExit("Run ./fetch-xenia.sh first; upstream shader_interpreter.cc is missing")

text = SOURCE.read_text(errors="strict")
include_anchor = '#include "xenia/gpu/shader_interpreter.h"\n'
if include_anchor not in text:
    raise SystemExit("Upstream shader interpreter include anchor drifted")
text = text.replace(
    include_anchor,
    include_anchor + '\n#include "sparse_guest_memory.h"\n',
    1,
)

memory_anchor = '''    const uint32_t* memory_dwords =
        reinterpret_cast<const uint32_t*>(memory_.physical_membase());
'''
if memory_anchor not in text:
    raise SystemExit("Upstream shader interpreter physical membase anchor drifted")
text = text.replace(
    memory_anchor,
    '''    // Render360 wasm32: the title's physical/graphics allocations are kept in
    // SparseGuestMemory rather than a desktop 512 MiB physical host view.
''',
    1,
)

trace_anchor = '''        if (trace_writer_) {
          trace_writer_->WriteMemoryRead(
              sizeof(uint32_t) * dword_address_dwords, sizeof(uint32_t));
        }
'''
if trace_anchor not in text:
    raise SystemExit("Upstream shader interpreter trace-read anchor drifted")
text = text.replace(
    trace_anchor,
    '''        // Browser bootstrap has no file trace writer. Read provenance is
        // enforced by SparseGuestMemory permissions instead.
''',
    1,
)

read_anchor = '''        dword_value = xenos::GpuSwap(memory_dwords[dword_address_dwords],
                                     fetch_constant.endian);
'''
if read_anchor not in text:
    raise SystemExit("Upstream shader interpreter vertex-read anchor drifted")
text = text.replace(
    read_anchor,
    '''        uint8_t render360_vertex_bytes[4] = {};
        const uint32_t render360_vertex_address =
            dword_address_dwords * uint32_t(sizeof(uint32_t));
        if (render360::xenia_web::ReadSparseGuestMemory(
                render360_vertex_address, render360_vertex_bytes,
                sizeof(render360_vertex_bytes))) {
          uint32_t render360_vertex_raw = 0;
          std::memcpy(&render360_vertex_raw, render360_vertex_bytes,
                      sizeof(render360_vertex_raw));
          dword_value =
              xenos::GpuSwap(render360_vertex_raw, fetch_constant.endian);
        }
''',
    1,
)

DEST.parent.mkdir(parents=True, exist_ok=True)
DEST.write_text(text)
print(f"Generated sparse-memory Xenia shader interpreter overlay: {DEST}")
print("Shader rule: upstream control-flow/ALU/vertex unpacking unchanged; only physical vertex reads use SparseGuestMemory")
