#!/usr/bin/env python3
"""Adapt upstream Xenia's shader runtime to Render360's browser/WASM host.

The Xenos control-flow, ALU, vertex-format, shader analysis and export semantics
remain upstream Xenia. Only desktop-only integration seams are changed:
- physical vertex reads use Render360 sparse guest RAM;
- file trace telemetry is disabled;
- optional shader dumping to the host filesystem is disabled;
- GPU cvars use fixed browser defaults without desktop config registration.
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

# Shader::AnalyzeUcode's optional desktop dump is debugging-only. The analysis
# itself (control flow, bindings, constants, disassembly and hashes) remains
# upstream and is used by the Render360 interpreter probe.
translator = ROOT / "upstream/xenia/src/xenia/gpu/shader_translator.cc"
translator_text = translator.read_text(errors="strict")
dump_block = '''  // An empty shader can be created internally by shader translators as a dummy,
  // don't dump it.
  if (!cvars::dump_shaders.empty() && !ucode_data().empty()) {
    DumpUcode(cvars::dump_shaders);
  }
'''
if dump_block not in translator_text:
    raise SystemExit("Upstream Shader::AnalyzeUcode dump block drifted")
translator_text = translator_text.replace(
    dump_block,
    '''  // Render360 browser/WASM: preserve AnalyzeUcode semantics but skip the
  // optional desktop shader-file dump. Captured shader telemetry remains in
  // memory and is surfaced through the browser runtime.
''',
    1,
)
translator.write_text(translator_text)

# DEFINE_path / DEFINE_* registers desktop config objects during static
# initialization. The shader-only standalone runtime needs the values, not the
# desktop configuration/filesystem machinery. Keep upstream defaults as plain
# variables so linked shader code sees identical values without getcwd/config
# filesystem syscalls on Safari.
gpu_flags = ROOT / "upstream/xenia/src/xenia/gpu/gpu_flags.cc"
gpu_flags.write_text('''#include "xenia/gpu/gpu_flags.h"\n\nnamespace cvars {\nstd::filesystem::path trace_gpu_prefix = std::filesystem::path("scratch/gpu/");\nbool trace_gpu_stream = false;\nstd::filesystem::path dump_shaders = std::filesystem::path();\nbool vsync = true;\nbool gpu_allow_invalid_fetch_constants = false;\nbool non_seamless_cube_map = true;\nbool half_pixel_offset = true;\nint32_t query_occlusion_fake_sample_count = 1000;\n}  // namespace cvars\n''')

print("Shader rule: upstream control-flow/ALU/analysis preserved; sparse guest reads + browser-safe telemetry/defaults only")
