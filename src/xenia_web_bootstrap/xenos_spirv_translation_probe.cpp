#include <bit>
#include <cstdint>
#include <cstring>
#include <memory>
#include <vector>

#include "xenia/base/string_buffer.h"
#include "xenia/gpu/shader.h"
#include "xenia/gpu/spirv_shader.h"
#include "xenia/gpu/spirv_shader_translator.h"
#include "xenia/gpu/xenos.h"

// Xenia's SPIR-V translator is intentionally split across implementation units
// for ALU, fetch, memory-export and render-backend/EDRAM lowering. The desktop
// build system compiles them as sibling objects. Render360's standalone WASM
// bootstrap keeps the accelerator behind one explicit bridge object, so include
// those pinned upstream implementation units here rather than duplicating or
// stubbing any shader semantics. None of these .cc units are compiled elsewhere
// in the current Render360 WASM source matrix.
#include "xenia/gpu/spirv_shader_translator_alu.cc"
#include "xenia/gpu/spirv_shader_translator_fetch.cc"
#include "xenia/gpu/spirv_shader_translator_memexport.cc"
#include "xenia/gpu/spirv_shader_translator_rb.cc"
// glslang's SpvBuilder.cpp delegates CFG traversal to this sibling source.
#include "third_party/glslang/SPIRV/InReadableOrder.cpp"

extern "C" {
uint32_t r360_xenos_shader_buffer(uint32_t shader_type);
uint32_t r360_xenos_shader_dwords(uint32_t shader_type);
uint32_t r360_xenos_shader_hash(uint32_t shader_type);
}

namespace render360::xenia_web {
namespace {

constexpr uint32_t kStatusIdle = 0;
constexpr uint32_t kStatusTranslated = 1;
constexpr uint32_t kStatusNoShader = 0xE2000001u;
constexpr uint32_t kStatusInvalidType = 0xE2000002u;
constexpr uint32_t kStatusAnalyzeFailed = 0xE2000003u;
constexpr uint32_t kStatusTranslateFailed = 0xE2000004u;
constexpr uint32_t kStatusInvalidSpirv = 0xE2000005u;
constexpr uint32_t kSpirvMagic = 0x07230203u;

uint32_t g_status = kStatusIdle;
uint32_t g_shader_type = 0;
uint32_t g_ucode_dwords = 0;
uint32_t g_translation_count = 0;
uint32_t g_error_count = 0;
std::vector<uint8_t> g_spirv;

void Reset() {
  g_status = kStatusIdle;
  g_shader_type = 0;
  g_ucode_dwords = 0;
  g_error_count = 0;
  g_spirv.clear();
}

uint32_t Translate(uint32_t type) {
  Reset();
  g_shader_type = type;
  if (type > 1u) {
    g_status = kStatusInvalidType;
    return 0;
  }

  const uint32_t count = r360_xenos_shader_dwords(type);
  const uint32_t ptr = r360_xenos_shader_buffer(type);
  if (!count || !ptr) {
    g_status = kStatusNoShader;
    return 0;
  }
  g_ucode_dwords = count;
  const auto* words = reinterpret_cast<const uint32_t*>(
      static_cast<uintptr_t>(ptr));

  xe::gpu::SpirvShader shader(
      type == 0 ? xe::gpu::xenos::ShaderType::kVertex
                : xe::gpu::xenos::ShaderType::kPixel,
      uint64_t(r360_xenos_shader_hash(type)), words, count,
      std::endian::native);
  xe::StringBuffer disassembly;
  shader.AnalyzeUcode(disassembly);
  if (!shader.is_ucode_analyzed()) {
    g_status = kStatusAnalyzeFailed;
    return 0;
  }

  // Conservative translation-only feature set: SPIR-V 1.0, 128 MiB storage
  // buffer slices, no Vulkan-only optional capabilities. This is intentionally
  // chosen as the portable input tier for the subsequent Naga SPIR-V -> WGSL
  // bridge used by browser WebGPU implementations such as Safari.
  xe::gpu::SpirvShaderTranslator::Features features(false);
  xe::gpu::SpirvShaderTranslator translator(features, false, false, false);
  const uint32_t dynamic_registers = xe::gpu::xenos::kMaxShaderTempRegisters;
  const uint64_t modification =
      type == 0
          ? translator.GetDefaultVertexShaderModification(dynamic_registers)
          : translator.GetDefaultPixelShaderModification(dynamic_registers);
  xe::gpu::Shader::Translation* translation =
      shader.GetOrCreateTranslation(modification);
  if (!translation || !translator.TranslateAnalyzedShader(*translation)) {
    if (translation) {
      g_error_count = static_cast<uint32_t>(translation->errors().size());
    }
    g_status = kStatusTranslateFailed;
    return 0;
  }
  g_error_count = static_cast<uint32_t>(translation->errors().size());
  if (!translation->is_valid() || !translation->is_translated()) {
    g_status = kStatusTranslateFailed;
    return 0;
  }

  g_spirv = translation->translated_binary();
  if (g_spirv.size() < 5u * sizeof(uint32_t) ||
      (g_spirv.size() & 3u) != 0u) {
    g_spirv.clear();
    g_status = kStatusInvalidSpirv;
    return 0;
  }
  uint32_t magic = 0;
  std::memcpy(&magic, g_spirv.data(), sizeof(magic));
  if (magic != kSpirvMagic) {
    g_spirv.clear();
    g_status = kStatusInvalidSpirv;
    return 0;
  }

  ++g_translation_count;
  g_status = kStatusTranslated;
  return 1;
}

}  // namespace
}  // namespace render360::xenia_web

extern "C" {
void r360_xenos_spirv_reset() { render360::xenia_web::Reset(); }
uint32_t r360_xenos_spirv_translate(uint32_t shader_type) {
  return render360::xenia_web::Translate(shader_type);
}
uint32_t r360_xenos_spirv_status() {
  return render360::xenia_web::g_status;
}
uint32_t r360_xenos_spirv_shader_type() {
  return render360::xenia_web::g_shader_type;
}
uint32_t r360_xenos_spirv_ucode_dwords() {
  return render360::xenia_web::g_ucode_dwords;
}
uint32_t r360_xenos_spirv_translation_count() {
  return render360::xenia_web::g_translation_count;
}
uint32_t r360_xenos_spirv_error_count() {
  return render360::xenia_web::g_error_count;
}
uint32_t r360_xenos_spirv_buffer() {
  return render360::xenia_web::g_spirv.empty()
             ? 0u
             : static_cast<uint32_t>(reinterpret_cast<uintptr_t>(
                   render360::xenia_web::g_spirv.data()));
}
uint32_t r360_xenos_spirv_size() {
  return static_cast<uint32_t>(render360::xenia_web::g_spirv.size());
}
uint32_t r360_xenos_spirv_word(uint32_t index) {
  const size_t offset = size_t(index) * sizeof(uint32_t);
  if (offset + sizeof(uint32_t) > render360::xenia_web::g_spirv.size()) {
    return 0u;
  }
  uint32_t value = 0;
  std::memcpy(&value, render360::xenia_web::g_spirv.data() + offset,
              sizeof(value));
  return value;
}
}
