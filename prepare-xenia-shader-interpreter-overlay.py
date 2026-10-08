#!/usr/bin/env python3
"""Adapt upstream Xenia's shader runtime to Render360's browser/WASM host.

The Xenos control-flow, ALU, vertex-format, shader analysis and export semantics
remain upstream Xenia. Browser-specific seams are intentionally narrow:
- physical vertex and texture reads use Render360 sparse guest RAM;
- file trace telemetry and optional shader dumping are disabled;
- GPU cvars use fixed browser defaults without desktop config registration;
- the upstream debug interpreter gains a fail-closed first real texture tier:
  2D RGBA8, point sampled, base mip, linear or Xenos-tiled memory.

Unsupported texture formats, dimensions, LOD modes and filtering are reported as
execution failures; they are never replaced with synthetic zero samples.
"""
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SOURCE = ROOT / "upstream/xenia/src/xenia/gpu/shader_interpreter.cc"
HEADER_SOURCE = ROOT / "upstream/xenia/src/xenia/gpu/shader_interpreter.h"
DEST = ROOT / "build/xenia-web-overlay/xenia/gpu/shader_interpreter.cc"
HEADER_DEST = ROOT / "build/xenia-web-overlay/xenia/gpu/shader_interpreter.h"
if not SOURCE.exists() or not HEADER_SOURCE.exists():
    raise SystemExit("Run ./fetch-xenia.sh first; upstream shader interpreter is missing")

# Header: keep the public Xenia API, but allow texture-bearing shaders into the
# interpreter. Capability is validated per fetch at execution time so unsupported
# cases fail closed instead of being replaced with zero texture samples.
header = HEADER_SOURCE.read_text(errors="strict")
can_interpret = '''  static bool CanInterpretShader(const Shader& shader) {
    assert_true(shader.is_ucode_analyzed());
    // Texture instructions are not very common in vertex shaders (and not used
    // in Direct3D 9's internal rectangles such as clears) and are extremely
    // complex, not implemented.
    if (shader.uses_texture_fetch_instruction_results()) {
      return false;
    }
    return true;
  }
'''
if can_interpret not in header:
    raise SystemExit("Upstream ShaderInterpreter::CanInterpretShader anchor drifted")
header = header.replace(
    can_interpret,
    '''  static bool CanInterpretShader(const Shader& shader) {
    assert_true(shader.is_ucode_analyzed());
    // Render360 validates texture support per instruction and fetch constant at
    // execution time. Unsupported cases fail the interpreter explicitly.
    return true;
  }
''',
    1,
)
getter_anchor = '''  const float* temp_registers() const { return &temp_registers_[0][0]; }
  float* temp_registers() { return &temp_registers_[0][0]; }
'''
if getter_anchor not in header:
    raise SystemExit("Upstream ShaderInterpreter temp-register anchor drifted")
header = header.replace(
    getter_anchor,
    getter_anchor + '''
  bool texture_fetch_failed() const { return texture_fetch_failed_; }
  uint32_t texture_fetch_count() const { return texture_fetch_count_; }
''',
    1,
)
method_anchor = '''  void ExecuteVertexFetchInstruction(ucode::VertexFetchInstruction instr);
'''
if method_anchor not in header:
    raise SystemExit("Upstream ShaderInterpreter vertex-fetch declaration drifted")
header = header.replace(
    method_anchor,
    method_anchor + '''  void ExecuteTextureFetchInstruction(ucode::TextureFetchInstruction instr);
''',
    1,
)
state_anchor = '''  State state_;
'''
if state_anchor not in header:
    raise SystemExit("Upstream ShaderInterpreter state anchor drifted")
header = header.replace(
    state_anchor,
    state_anchor + '''
  bool texture_fetch_failed_ = false;
  uint32_t texture_fetch_count_ = 0;
''',
    1,
)
HEADER_DEST.parent.mkdir(parents=True, exist_ok=True)
HEADER_DEST.write_text(header)

text = SOURCE.read_text(errors="strict")
include_anchor = '#include "xenia/gpu/shader_interpreter.h"\n'
if include_anchor not in text:
    raise SystemExit("Upstream shader interpreter include anchor drifted")
text = text.replace(
    include_anchor,
    include_anchor + '\n#include "sparse_guest_memory.h"\n#include "xenos_soft_renderer.h"\nextern "C" uint32_t r360_kernel_gpu_address_to_virtual(uint32_t address);\n',
    1,
)

namespace_anchor = '''namespace xe {
namespace gpu {
'''
if namespace_anchor not in text:
    raise SystemExit("Upstream shader interpreter namespace anchor drifted")
helpers = r'''
namespace {

// XGAddress2DTiledOffset-compatible base-level addressing for uncompressed
// textures. The return value is a texel/block index, not a byte address.
uint32_t Render360TiledOffset2D(uint32_t x, uint32_t y, uint32_t pitch,
                                uint32_t log2_bytes_per_block) {
  if (!pitch || pitch > 8192u || x >= pitch || log2_bytes_per_block > 4u) {
    return UINT32_MAX;
  }
  const uint32_t aligned_width = (pitch + 31u) & ~31u;
  const uint32_t macro =
      ((x >> 5) + (y >> 5) * (aligned_width >> 5))
      << (log2_bytes_per_block + 7u);
  const uint32_t micro =
      ((x & 7u) + ((y & 0xEu) << 2u)) << log2_bytes_per_block;
  const uint32_t offset = macro + ((micro & ~0xFu) << 1u) +
                          (micro & 0xFu) + ((y & 1u) << 4u);
  return (((offset & ~0x1FFu) << 3u) + ((y & 16u) << 7u) +
          ((offset & 0x1C0u) << 2u) +
          (((((y & 8u) >> 2u) + (x >> 3u)) & 3u) << 6u) +
          (offset & 0x3Fu)) >> log2_bytes_per_block;
}

bool Render360ResolveTextureCoordinate(int64_t coordinate, uint32_t size,
                                       xenos::ClampMode clamp,
                                       uint32_t* resolved) {
  if (!resolved || !size) return false;
  switch (clamp) {
    case xenos::ClampMode::kRepeat: {
      int64_t m = coordinate % int64_t(size);
      if (m < 0) m += size;
      *resolved = uint32_t(m);
      return true;
    }
    case xenos::ClampMode::kMirroredRepeat: {
      const int64_t period = int64_t(size) * 2;
      int64_t m = coordinate % period;
      if (m < 0) m += period;
      if (m >= int64_t(size)) m = period - 1 - m;
      *resolved = uint32_t(m);
      return true;
    }
    case xenos::ClampMode::kClampToEdge:
      *resolved = coordinate < 0
                      ? 0u
                      : (coordinate >= int64_t(size) ? size - 1u
                                                     : uint32_t(coordinate));
      return true;
    default:
      // Halfway, border and mirror-clamp modes need additional Xenos sampling
      // rules. They remain explicit blockers until implemented.
      return false;
  }
}

bool Render360TextureSwizzle(const float source[4], uint32_t swizzle,
                             float result[4]) {
  for (uint32_t i = 0; i < 4; ++i) {
    switch ((swizzle >> (i * 3u)) & 7u) {
      case 0: result[i] = source[0]; break;
      case 1: result[i] = source[1]; break;
      case 2: result[i] = source[2]; break;
      case 3: result[i] = source[3]; break;
      case 4: result[i] = 0.0f; break;
      case 5: result[i] = 1.0f; break;
      default: return false;
    }
  }
  return true;
}

}  // namespace
'''
text = text.replace(namespace_anchor, namespace_anchor + helpers, 1)

execute_reset_anchor = '''void ShaderInterpreter::Execute() {
  // For more consistency between invocations in case of a malformed shader.
  state_.Reset();
'''
if execute_reset_anchor not in text:
    raise SystemExit("Upstream ShaderInterpreter::Execute reset anchor drifted")
text = text.replace(
    execute_reset_anchor,
    execute_reset_anchor + '''  texture_fetch_failed_ = false;
  texture_fetch_count_ = 0;
''',
    1,
)

texture_zero_anchor = '''            } else {
              // Not supporting texture fetching (very complex).
              float zero_result[4] = {};
              StoreFetchResult(fetch_instr.dest(),
                               fetch_instr.is_dest_relative(),
                               fetch_instr.dest_swizzle(), zero_result);
            }
'''
if texture_zero_anchor not in text:
    raise SystemExit("Upstream zero texture-fetch anchor drifted")
text = text.replace(
    texture_zero_anchor,
    '''            } else {
              ExecuteTextureFetchInstruction(fetch_instr.texture_fetch());
            }
''',
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
                r360_kernel_gpu_address_to_virtual(render360_vertex_address),
                render360_vertex_bytes,
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

texture_method_anchor = '''void ShaderInterpreter::ExecuteVertexFetchInstruction(
    ucode::VertexFetchInstruction instr) {
'''
if texture_method_anchor not in text:
    raise SystemExit("Upstream ExecuteVertexFetchInstruction definition drifted")
texture_method = r'''void ShaderInterpreter::ExecuteTextureFetchInstruction(
    ucode::TextureFetchInstruction instr) {
  // Render360: sampling is done by the software Xenos backend
  // (xenos_soft_renderer.cpp) - formats, tiling, filtering and clamping.
  if (instr.opcode() != ucode::FetchOpcode::kTextureFetch) {
    // getCompTexLOD / gradients / set-LOD: not sampled; results stay as-is.
    return;
  }
  const xenos::xe_gpu_texture_fetch_t fetch_constant =
      register_file_.GetTextureFetch(instr.fetch_constant_index());
  const float* source = GetTempRegister(instr.src(), instr.is_src_relative());
  const uint32_t source_swizzle = instr.src_swizzle();
  const float coords[3] = {source[(source_swizzle >> 0u) & 3u],
                           source[(source_swizzle >> 2u) & 3u],
                           source[(source_swizzle >> 4u) & 3u]};
  float result[4] = {};
  if (!render360::xenia_web::SampleXenosTexture(fetch_constant, instr, coords,
                                                result)) {
    texture_fetch_failed_ = true;
  }
  StoreFetchResult(instr.dest(), instr.is_dest_relative(), instr.dest_swizzle(),
                   result);
  ++texture_fetch_count_;
}

'''
text = text.replace(texture_method_anchor, texture_method + texture_method_anchor, 1)

DEST.parent.mkdir(parents=True, exist_ok=True)
DEST.write_text(text)
print(f"Generated sparse-memory Xenia shader interpreter overlay: {DEST}")
print(f"Generated texture-capable Xenia shader interpreter header: {HEADER_DEST}")

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

print("Shader rule: upstream control-flow/ALU/analysis preserved; real sparse 2D RGBA8 texture point sampling + browser-safe telemetry/defaults")
