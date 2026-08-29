#include <array>
#include <bit>
#include <cstdint>
#include <memory>

#include "ppc_translation_probe_runtime.h"
#include "xenia/base/string_buffer.h"
#include "xenia/gpu/register_file.h"
#include "xenia/gpu/shader.h"
#include "xenia/gpu/shader_interpreter.h"
#include "xenia/gpu/ucode.h"
#include "xenia/gpu/xenos.h"
#include "xenia/memory.h"

extern "C" {
uint32_t r360_xenos_register(uint32_t index);
uint32_t r360_xenos_shader_buffer(uint32_t shader_type);
uint32_t r360_xenos_shader_dwords(uint32_t shader_type);
uint32_t r360_xenos_shader_hash(uint32_t shader_type);
}

namespace render360::xenia_web {
namespace {

constexpr uint32_t kStatusIdle = 0;
constexpr uint32_t kStatusAnalyzed = 1;
constexpr uint32_t kStatusInterpretable = 2;
constexpr uint32_t kStatusExecuted = 3;
constexpr uint32_t kStatusNoShader = 0xE1000001u;
constexpr uint32_t kStatusNoMemory = 0xE1000002u;
constexpr uint32_t kStatusTextureFetchUnsupported = 0xE1000003u;
constexpr uint32_t kStatusInvalidType = 0xE1000004u;

uint32_t g_status = kStatusIdle;
uint32_t g_shader_type = 0;
uint32_t g_ucode_dwords = 0;
uint32_t g_cf_pair_bound = 0;
uint32_t g_register_bound = 0;
uint32_t g_vertex_bindings = 0;
uint32_t g_texture_bindings = 0;
uint32_t g_writes_interpolators = 0;
uint32_t g_writes_color_targets = 0;
uint32_t g_uses_texture_fetch_results = 0;
uint32_t g_texture_fetches = 0;
uint32_t g_execution_count = 0;
uint32_t g_alloc_exports = 0;
uint32_t g_value_exports = 0;
uint32_t g_last_export_register = 0;
uint32_t g_last_export_mask = 0;
std::array<uint32_t, 4> g_last_export_bits{};
std::array<uint32_t, xe::gpu::xenos::kMaxShaderTempRegisters * 4u>
    g_last_temp_bits{};

class CaptureExportSink final : public xe::gpu::ShaderInterpreter::ExportSink {
 public:
  void AllocExport(xe::gpu::ucode::AllocType, uint32_t) override {
    ++g_alloc_exports;
  }

  void Export(xe::gpu::ucode::ExportRegister export_register,
              const float* value, uint32_t value_mask) override {
    ++g_value_exports;
    g_last_export_register = static_cast<uint32_t>(export_register);
    g_last_export_mask = value_mask;
    for (uint32_t i = 0; i < 4; ++i) {
      g_last_export_bits[i] = std::bit_cast<uint32_t>(value[i]);
    }
  }
};

void ResetTelemetry() {
  g_status = kStatusIdle;
  g_shader_type = 0;
  g_ucode_dwords = 0;
  g_cf_pair_bound = 0;
  g_register_bound = 0;
  g_vertex_bindings = 0;
  g_texture_bindings = 0;
  g_writes_interpolators = 0;
  g_writes_color_targets = 0;
  g_uses_texture_fetch_results = 0;
  g_texture_fetches = 0;
  g_alloc_exports = 0;
  g_value_exports = 0;
  g_last_export_register = 0;
  g_last_export_mask = 0;
  g_last_export_bits.fill(0);
  g_last_temp_bits.fill(0);
}

bool ValidShaderType(uint32_t type) { return type <= 1u; }

std::unique_ptr<xe::gpu::Shader> AnalyzeCurrentShader(uint32_t type) {
  ResetTelemetry();
  g_shader_type = type;
  if (!ValidShaderType(type)) {
    g_status = kStatusInvalidType;
    return nullptr;
  }
  const uint32_t count = r360_xenos_shader_dwords(type);
  const uint32_t ptr = r360_xenos_shader_buffer(type);
  if (!count || !ptr) {
    g_status = kStatusNoShader;
    return nullptr;
  }
  const auto* words = reinterpret_cast<const uint32_t*>(
      static_cast<uintptr_t>(ptr));
  auto shader = std::make_unique<xe::gpu::Shader>(
      type == 0 ? xe::gpu::xenos::ShaderType::kVertex
                : xe::gpu::xenos::ShaderType::kPixel,
      uint64_t(r360_xenos_shader_hash(type)), words, count,
      std::endian::native);
  xe::StringBuffer disassembly_buffer;
  shader->AnalyzeUcode(disassembly_buffer);
  g_ucode_dwords = count;
  g_cf_pair_bound = shader->cf_pair_index_bound();
  g_register_bound = shader->register_static_address_bound();
  g_vertex_bindings = static_cast<uint32_t>(shader->vertex_bindings().size());
  g_texture_bindings = static_cast<uint32_t>(shader->texture_bindings().size());
  g_writes_interpolators = shader->writes_interpolators();
  g_writes_color_targets = shader->writes_color_targets();
  g_uses_texture_fetch_results =
      shader->uses_texture_fetch_instruction_results() ? 1u : 0u;
  g_status = kStatusAnalyzed;
  return shader;
}

uint32_t Analyze(uint32_t type) {
  auto shader = AnalyzeCurrentShader(type);
  if (!shader) return 0;
  if (!xe::gpu::ShaderInterpreter::CanInterpretShader(*shader)) {
    g_status = kStatusTextureFetchUnsupported;
    return 0;
  }
  g_status = kStatusInterpretable;
  return 1;
}

uint32_t Execute(uint32_t type) {
  auto shader = AnalyzeCurrentShader(type);
  if (!shader) return 0;
  if (!xe::gpu::ShaderInterpreter::CanInterpretShader(*shader)) {
    g_status = kStatusTextureFetchUnsupported;
    return 0;
  }

  xe::Memory* memory = ActiveProbeMemory();
  if (!memory) {
    g_status = kStatusNoMemory;
    return 0;
  }

  xe::gpu::RegisterFile registers;
  for (uint32_t i = 0; i < xe::gpu::RegisterFile::kRegisterCount; ++i) {
    registers.values[i] = r360_xenos_register(i);
  }

  xe::gpu::ShaderInterpreter interpreter(registers, *memory);
  std::fill(interpreter.temp_registers(),
            interpreter.temp_registers() +
                xe::gpu::xenos::kMaxShaderTempRegisters * 4u,
            0.0f);
  CaptureExportSink sink;
  interpreter.SetExportSink(&sink);
  interpreter.SetShader(*shader);
  interpreter.Execute();
  g_texture_fetches = interpreter.texture_fetch_count();
  const float* temps = interpreter.temp_registers();
  for (uint32_t i = 0; i < g_last_temp_bits.size(); ++i) {
    g_last_temp_bits[i] = std::bit_cast<uint32_t>(temps[i]);
  }
  if (interpreter.texture_fetch_failed()) {
    g_status = kStatusTextureFetchUnsupported;
    return 0;
  }
  ++g_execution_count;
  g_status = kStatusExecuted;
  return 1;
}

}  // namespace
}  // namespace render360::xenia_web

extern "C" {
void r360_xenos_shader_interpreter_reset() {
  render360::xenia_web::ResetTelemetry();
}
uint32_t r360_xenos_shader_interpreter_analyze(uint32_t shader_type) {
  return render360::xenia_web::Analyze(shader_type);
}
uint32_t r360_xenos_shader_interpreter_execute(uint32_t shader_type) {
  return render360::xenia_web::Execute(shader_type);
}
uint32_t r360_xenos_shader_interpreter_status() {
  return render360::xenia_web::g_status;
}
uint32_t r360_xenos_shader_interpreter_shader_type() {
  return render360::xenia_web::g_shader_type;
}
uint32_t r360_xenos_shader_interpreter_ucode_dwords() {
  return render360::xenia_web::g_ucode_dwords;
}
uint32_t r360_xenos_shader_interpreter_cf_pair_bound() {
  return render360::xenia_web::g_cf_pair_bound;
}
uint32_t r360_xenos_shader_interpreter_register_bound() {
  return render360::xenia_web::g_register_bound;
}
uint32_t r360_xenos_shader_interpreter_vertex_bindings() {
  return render360::xenia_web::g_vertex_bindings;
}
uint32_t r360_xenos_shader_interpreter_texture_bindings() {
  return render360::xenia_web::g_texture_bindings;
}
uint32_t r360_xenos_shader_interpreter_uses_texture_fetch() {
  return render360::xenia_web::g_uses_texture_fetch_results;
}
uint32_t r360_xenos_shader_interpreter_texture_fetches() {
  return render360::xenia_web::g_texture_fetches;
}
uint32_t r360_xenos_shader_interpreter_writes_interpolators() {
  return render360::xenia_web::g_writes_interpolators;
}
uint32_t r360_xenos_shader_interpreter_writes_color_targets() {
  return render360::xenia_web::g_writes_color_targets;
}
uint32_t r360_xenos_shader_interpreter_execution_count() {
  return render360::xenia_web::g_execution_count;
}
uint32_t r360_xenos_shader_interpreter_alloc_exports() {
  return render360::xenia_web::g_alloc_exports;
}
uint32_t r360_xenos_shader_interpreter_value_exports() {
  return render360::xenia_web::g_value_exports;
}
uint32_t r360_xenos_shader_interpreter_last_export_register() {
  return render360::xenia_web::g_last_export_register;
}
uint32_t r360_xenos_shader_interpreter_last_export_mask() {
  return render360::xenia_web::g_last_export_mask;
}
uint32_t r360_xenos_shader_interpreter_last_export_component_bits(
    uint32_t component) {
  return component < 4 ? render360::xenia_web::g_last_export_bits[component]
                       : 0u;
}
uint32_t r360_xenos_shader_interpreter_temp_component_bits(uint32_t reg,
                                                           uint32_t component) {
  if (reg >= xe::gpu::xenos::kMaxShaderTempRegisters || component >= 4u) {
    return 0u;
  }
  return render360::xenia_web::g_last_temp_bits[reg * 4u + component];
}
}
