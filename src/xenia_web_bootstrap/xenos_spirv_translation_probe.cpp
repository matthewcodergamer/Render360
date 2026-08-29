#include <bit>
#include <cstdint>
#include <cstring>
#include <memory>
#include <vector>

#include "sparse_guest_memory.h"
#include "xenia/base/string_buffer.h"
#include "xenia/gpu/draw_util.h"
#include "xenia/gpu/shader.h"
#include "xenia/gpu/spirv_shader.h"
#include "xenia/gpu/spirv_shader_translator.h"
#include "xenia/gpu/xenos.h"

// The SPIR-V render-backend translator only needs Xenia's standard D3D10 MSAA
// sample-position tables from draw_util.cc. Pulling the complete desktop
// draw_util translation unit into the browser bootstrap would also drag in
// texture-cache / UI / trace dependencies that are unrelated to shader
// translation. Keep the exact upstream table values here as the browser link
// closure for the two extern symbols declared by draw_util.h.
namespace xe::gpu::draw_util {
const int8_t kD3D10StandardSamplePositions2x[2][2] = {{4, 4}, {-4, -4}};
const int8_t kD3D10StandardSamplePositions4x[4][2] = {
    {-2, -6}, {6, -2}, {-6, 2}, {2, 6}};
}  // namespace xe::gpu::draw_util

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
uint32_t r360_xenos_fetch_constant_word(uint32_t group, uint32_t word);
uint32_t r360_xenos_frontbuffer_ptr();
uint32_t r360_xenos_frontbuffer_width();
uint32_t r360_xenos_frontbuffer_height();
uint32_t r360_xenos_swaps();
}

#if defined(__wasm__)
#define R360_WASM_EXPORT(name) __attribute__((used, export_name(name)))
#else
#define R360_WASM_EXPORT(name)
#endif

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

constexpr uint32_t kFrontbufferSnapshotIdle = 0;
constexpr uint32_t kFrontbufferSnapshotReady = 1;
constexpr uint32_t kFrontbufferSnapshotNoSwap = 0xE3000001u;
constexpr uint32_t kFrontbufferSnapshotUnsupportedFormat = 0xE3000002u;
constexpr uint32_t kFrontbufferSnapshotInvalidFetch = 0xE3000003u;
constexpr uint32_t kFrontbufferSnapshotUnmapped = 0xE3000004u;
constexpr uint32_t kFrontbufferSnapshotDimensionMismatch = 0xE3000005u;
constexpr uint32_t kFrontbufferSnapshotUnsupportedLayout = 0xE3000006u;
constexpr uint32_t kFrontbufferSnapshotTooLarge = 0xE3000007u;
constexpr uint32_t kTextureFormat8888 = 6u;
constexpr uint32_t kTextureFormat2101010As16161616 = 54u;
constexpr uint32_t kMaxFrontbufferBytes = 16u * 1024u * 1024u;

uint32_t g_status = kStatusIdle;
uint32_t g_shader_type = 0;
uint32_t g_ucode_dwords = 0;
uint32_t g_translation_count = 0;
uint32_t g_error_count = 0;
std::vector<uint8_t> g_spirv;

uint32_t g_frontbuffer_snapshot_status = kFrontbufferSnapshotIdle;
uint32_t g_frontbuffer_snapshot_width = 0;
uint32_t g_frontbuffer_snapshot_height = 0;
uint32_t g_frontbuffer_snapshot_hash = 0;
uint32_t g_frontbuffer_snapshot_generation = 0;
uint32_t g_frontbuffer_snapshot_format = 0;
uint32_t g_frontbuffer_snapshot_tiled = 0;
uint32_t g_frontbuffer_snapshot_pitch = 0;
uint32_t g_frontbuffer_snapshot_source_address = 0;
uint32_t g_frontbuffer_snapshot_source_bytes = 0;
std::vector<uint8_t> g_frontbuffer_snapshot;

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

  // Browser/WebGPU translation profile. Xenia normally advertises the Vulkan
  // minimum 128 MiB storage-buffer range here, which makes it split the 512 MiB
  // Xbox shared-memory address space into four bindings and represent them as an
  // array of storage-buffer structs whose final member is a runtime array.
  // Vulkan permits that descriptor shape, but WGSL requires array element types
  // to be sized data types, so Naga correctly rejects it as InvalidArrayBaseType.
  // Advertising one logical 512 MiB range makes Xenia emit a single shared-memory
  // storage-buffer struct. This is a shader-layout decision only; Render360 still
  // pages sparse Xbox memory on the host and does not allocate 512 MiB of browser
  // linear memory merely to translate a shader.
  xe::gpu::SpirvShaderTranslator::Features features(false);
  features.max_storage_buffer_range = 512u * 1024u * 1024u;
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

uint32_t GpuSwap32(uint32_t value, uint32_t endian) {
  switch (endian & 3u) {
    case 0:
      return value;
    case 1:
      return ((value & 0x00FF00FFu) << 8u) |
             ((value & 0xFF00FF00u) >> 8u);
    case 2:
      return ((value & 0x000000FFu) << 24u) |
             ((value & 0x0000FF00u) << 8u) |
             ((value & 0x00FF0000u) >> 8u) |
             ((value & 0xFF000000u) >> 24u);
    case 3:
      return (value << 16u) | (value >> 16u);
  }
  return value;
}

uint32_t TiledOffset2D(uint32_t x, uint32_t y, uint32_t pitch,
                       uint32_t log2_bytes_per_block) {
  if (!pitch || pitch > 8192u || x >= pitch || log2_bytes_per_block > 4u) {
    return UINT32_MAX;
  }
  const uint32_t aligned_width = (pitch + 31u) & ~31u;
  const uint32_t macro =
      ((x >> 5u) + (y >> 5u) * (aligned_width >> 5u))
      << (log2_bytes_per_block + 7u);
  const uint32_t micro =
      ((x & 7u) + ((y & 0xEu) << 2u)) << log2_bytes_per_block;
  const uint32_t offset = macro + ((micro & ~0xFu) << 1u) +
                          (micro & 0xFu) + ((y & 1u) << 4u);
  return (((offset & ~0x1FFu) << 3u) + ((y & 16u) << 7u) +
          ((offset & 0x1C0u) << 2u) +
          (((((y & 8u) >> 2u) + (x >> 3u)) & 3u) << 6u) +
          (offset & 0x3Fu)) >>
         log2_bytes_per_block;
}

uint8_t Scale10To8(uint32_t value) {
  return static_cast<uint8_t>((value * 255u + 511u) / 1023u);
}

bool DecodeFrontbufferPixel(uint32_t packed, uint32_t format,
                            uint32_t swizzle, uint8_t* output) {
  if (!output) return false;
  uint8_t source[4] = {};
  if (format == kTextureFormat8888) {
    source[0] = static_cast<uint8_t>(packed);
    source[1] = static_cast<uint8_t>(packed >> 8u);
    source[2] = static_cast<uint8_t>(packed >> 16u);
    source[3] = static_cast<uint8_t>(packed >> 24u);
  } else if (format == kTextureFormat2101010As16161616) {
    source[0] = Scale10To8(packed & 0x3FFu);
    source[1] = Scale10To8((packed >> 10u) & 0x3FFu);
    source[2] = Scale10To8((packed >> 20u) & 0x3FFu);
    source[3] = static_cast<uint8_t>(((packed >> 30u) & 3u) * 85u);
  } else {
    return false;
  }
  for (uint32_t component = 0; component < 4u; ++component) {
    const uint32_t selector = (swizzle >> (component * 3u)) & 7u;
    if (selector <= 3u) {
      output[component] = source[selector];
    } else if (selector == 4u) {
      output[component] = 0u;
    } else if (selector == 5u) {
      output[component] = 255u;
    } else {
      return false;
    }
  }
  return true;
}

void ClearFrontbufferSnapshot(uint32_t status) {
  g_frontbuffer_snapshot_status = status;
  g_frontbuffer_snapshot_width = 0;
  g_frontbuffer_snapshot_height = 0;
  g_frontbuffer_snapshot_hash = 0;
  g_frontbuffer_snapshot_format = 0;
  g_frontbuffer_snapshot_tiled = 0;
  g_frontbuffer_snapshot_pitch = 0;
  g_frontbuffer_snapshot_source_address = 0;
  g_frontbuffer_snapshot_source_bytes = 0;
  g_frontbuffer_snapshot.clear();
}

uint32_t HashBytes(const std::vector<uint8_t>& bytes) {
  uint32_t hash = 2166136261u;
  for (uint8_t byte : bytes) {
    hash ^= byte;
    hash *= 16777619u;
  }
  return hash;
}

uint32_t CaptureFrontbufferSnapshot() {
  ClearFrontbufferSnapshot(kFrontbufferSnapshotIdle);
  if (!r360_xenos_swaps()) {
    g_frontbuffer_snapshot_status = kFrontbufferSnapshotNoSwap;
    return 0u;
  }

  const uint32_t frontbuffer_address = r360_xenos_frontbuffer_ptr();
  const uint32_t swap_width = r360_xenos_frontbuffer_width();
  const uint32_t swap_height = r360_xenos_frontbuffer_height();
  if (!swap_width || !swap_height || swap_width > 8192u || swap_height > 8192u) {
    g_frontbuffer_snapshot_status = kFrontbufferSnapshotDimensionMismatch;
    return 0u;
  }

  uint32_t words[6] = {};
  for (uint32_t i = 0; i < 6u; ++i) {
    words[i] = r360_xenos_fetch_constant_word(0u, i);
  }
  const uint32_t type = words[0] & 3u;
  const uint32_t pitch = ((words[0] >> 22u) & 0x1FFu) << 5u;
  const uint32_t tiled = words[0] >> 31u;
  const uint32_t format = words[1] & 0x3Fu;
  const uint32_t endian = (words[1] >> 6u) & 3u;
  const uint32_t stacked = (words[1] >> 10u) & 1u;
  const uint32_t base_address = (words[1] >> 12u) << 12u;
  const uint32_t width = (words[2] & 0x1FFFu) + 1u;
  const uint32_t height = ((words[2] >> 13u) & 0x1FFFu) + 1u;
  const uint32_t swizzle = (words[3] >> 1u) & 0xFFFu;
  const uint32_t dimension = (words[5] >> 9u) & 3u;

  if (type != 2u || !pitch || pitch < width || pitch > 8192u ||
      base_address != frontbuffer_address) {
    g_frontbuffer_snapshot_status = kFrontbufferSnapshotInvalidFetch;
    return 0u;
  }
  if (dimension != 1u || stacked) {
    g_frontbuffer_snapshot_status = kFrontbufferSnapshotUnsupportedLayout;
    return 0u;
  }
  if (format != kTextureFormat8888 &&
      format != kTextureFormat2101010As16161616) {
    g_frontbuffer_snapshot_status = kFrontbufferSnapshotUnsupportedFormat;
    return 0u;
  }
  if (width != swap_width || height != swap_height) {
    g_frontbuffer_snapshot_status = kFrontbufferSnapshotDimensionMismatch;
    return 0u;
  }

  const uint64_t output_bytes = uint64_t(width) * height * 4u;
  const uint32_t source_height = tiled ? ((height + 31u) & ~31u) : height;
  const uint64_t source_bytes = uint64_t(pitch) * source_height * 4u;
  if (!output_bytes || output_bytes > kMaxFrontbufferBytes || !source_bytes ||
      source_bytes > kMaxFrontbufferBytes ||
      uint64_t(base_address) + source_bytes > (uint64_t(1) << 32u)) {
    g_frontbuffer_snapshot_status = kFrontbufferSnapshotTooLarge;
    return 0u;
  }

  std::vector<uint8_t> source(static_cast<size_t>(source_bytes));
  if (!ReadSparseGuestMemory(base_address, source.data(),
                             static_cast<uint32_t>(source_bytes))) {
    g_frontbuffer_snapshot_status = kFrontbufferSnapshotUnmapped;
    return 0u;
  }
  g_frontbuffer_snapshot.resize(static_cast<size_t>(output_bytes));

  for (uint32_t y = 0; y < height; ++y) {
    for (uint32_t x = 0; x < width; ++x) {
      const uint32_t texel_index =
          tiled ? TiledOffset2D(x, y, pitch, 2u) : y * pitch + x;
      if (texel_index == UINT32_MAX ||
          uint64_t(texel_index) * 4u + 4u > source_bytes) {
        ClearFrontbufferSnapshot(kFrontbufferSnapshotInvalidFetch);
        return 0u;
      }
      const size_t source_offset = size_t(texel_index) * 4u;
      uint32_t packed = uint32_t(source[source_offset]) |
                        (uint32_t(source[source_offset + 1u]) << 8u) |
                        (uint32_t(source[source_offset + 2u]) << 16u) |
                        (uint32_t(source[source_offset + 3u]) << 24u);
      packed = GpuSwap32(packed, endian);
      uint8_t* destination =
          g_frontbuffer_snapshot.data() + (size_t(y) * width + x) * 4u;
      if (!DecodeFrontbufferPixel(packed, format, swizzle, destination)) {
        ClearFrontbufferSnapshot(kFrontbufferSnapshotInvalidFetch);
        return 0u;
      }
    }
  }

  g_frontbuffer_snapshot_status = kFrontbufferSnapshotReady;
  g_frontbuffer_snapshot_width = width;
  g_frontbuffer_snapshot_height = height;
  g_frontbuffer_snapshot_hash = HashBytes(g_frontbuffer_snapshot);
  ++g_frontbuffer_snapshot_generation;
  g_frontbuffer_snapshot_format = format;
  g_frontbuffer_snapshot_tiled = tiled;
  g_frontbuffer_snapshot_pitch = pitch;
  g_frontbuffer_snapshot_source_address = base_address;
  g_frontbuffer_snapshot_source_bytes = static_cast<uint32_t>(source_bytes);
  return 1u;
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

R360_WASM_EXPORT("r360_xenos_frontbuffer_snapshot_capture")
uint32_t r360_xenos_frontbuffer_snapshot_capture() {
  return render360::xenia_web::CaptureFrontbufferSnapshot();
}
R360_WASM_EXPORT("r360_xenos_frontbuffer_snapshot_status")
uint32_t r360_xenos_frontbuffer_snapshot_status() {
  return render360::xenia_web::g_frontbuffer_snapshot_status;
}
R360_WASM_EXPORT("r360_xenos_frontbuffer_snapshot_buffer")
uint32_t r360_xenos_frontbuffer_snapshot_buffer() {
  return render360::xenia_web::g_frontbuffer_snapshot.empty()
             ? 0u
             : static_cast<uint32_t>(reinterpret_cast<uintptr_t>(
                   render360::xenia_web::g_frontbuffer_snapshot.data()));
}
R360_WASM_EXPORT("r360_xenos_frontbuffer_snapshot_size")
uint32_t r360_xenos_frontbuffer_snapshot_size() {
  return static_cast<uint32_t>(
      render360::xenia_web::g_frontbuffer_snapshot.size());
}
R360_WASM_EXPORT("r360_xenos_frontbuffer_snapshot_width")
uint32_t r360_xenos_frontbuffer_snapshot_width() {
  return render360::xenia_web::g_frontbuffer_snapshot_width;
}
R360_WASM_EXPORT("r360_xenos_frontbuffer_snapshot_height")
uint32_t r360_xenos_frontbuffer_snapshot_height() {
  return render360::xenia_web::g_frontbuffer_snapshot_height;
}
R360_WASM_EXPORT("r360_xenos_frontbuffer_snapshot_hash")
uint32_t r360_xenos_frontbuffer_snapshot_hash() {
  return render360::xenia_web::g_frontbuffer_snapshot_hash;
}
R360_WASM_EXPORT("r360_xenos_frontbuffer_snapshot_generation")
uint32_t r360_xenos_frontbuffer_snapshot_generation() {
  return render360::xenia_web::g_frontbuffer_snapshot_generation;
}
R360_WASM_EXPORT("r360_xenos_frontbuffer_snapshot_format")
uint32_t r360_xenos_frontbuffer_snapshot_format() {
  return render360::xenia_web::g_frontbuffer_snapshot_format;
}
R360_WASM_EXPORT("r360_xenos_frontbuffer_snapshot_tiled")
uint32_t r360_xenos_frontbuffer_snapshot_tiled() {
  return render360::xenia_web::g_frontbuffer_snapshot_tiled;
}
R360_WASM_EXPORT("r360_xenos_frontbuffer_snapshot_pitch")
uint32_t r360_xenos_frontbuffer_snapshot_pitch() {
  return render360::xenia_web::g_frontbuffer_snapshot_pitch;
}
R360_WASM_EXPORT("r360_xenos_frontbuffer_snapshot_source_address")
uint32_t r360_xenos_frontbuffer_snapshot_source_address() {
  return render360::xenia_web::g_frontbuffer_snapshot_source_address;
}
R360_WASM_EXPORT("r360_xenos_frontbuffer_snapshot_source_bytes")
uint32_t r360_xenos_frontbuffer_snapshot_source_bytes() {
  return render360::xenia_web::g_frontbuffer_snapshot_source_bytes;
}
}