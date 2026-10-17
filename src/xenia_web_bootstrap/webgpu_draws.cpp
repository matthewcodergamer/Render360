// WebGPU backend draws: the per-draw part of Xenia's VulkanCommandProcessor
// (IssueDraw, UpdateSystemConstantValues, UpdateBindings) and
// VulkanPipelineCache (shader modifications, translation, pipeline state),
// recording into the command stream (webgpu_backend.h) instead of a Vulkan
// command buffer. Render targets follow Xenia's host render target path.
#include <algorithm>
#include <cstring>
#include <memory>
#include <unordered_map>
#include <vector>

#include "webgpu_backend.h"
#include "xenos_soft_draw.h"
#include "sparse_guest_memory.h"
#include "xenia/base/math.h"
#include "xenia/base/string_buffer.h"
#include "xenia/gpu/draw_util.h"
#include "xenia/gpu/register_file.h"
#include "xenia/gpu/registers.h"
#include "xenia/gpu/spirv_shader.h"
#include "xenia/gpu/spirv_shader_translator.h"
#include "xenia/gpu/xenos.h"

extern "C" uint32_t r360_kernel_gpu_address_to_virtual(uint32_t address);

namespace render360::xenia_web {
namespace {

using xe::gpu::RegisterFile;
using xe::gpu::Shader;
using xe::gpu::SpirvShader;
using xe::gpu::SpirvShaderTranslator;
namespace reg = xe::gpu::reg;
namespace xenos = xe::gpu::xenos;
namespace draw_util = xe::gpu::draw_util;
using namespace xe::gpu;  // XE_GPU_REG_* register indices

uint32_t g_mode = 0;  // 0 off, 1 record draws

// Why draws were not recorded (r360_gpu_draw_stat).
enum DrawSkip : uint32_t {
  kSkipNoVertexShader = 1,
  kSkipTranslation,
  kSkipPrimitive,
  kSkipIndices,
  kSkipVertexFetch,
  kSkipCount,
};
uint32_t g_draws = 0, g_skips[kSkipCount] = {}, g_last_skip = 0;
bool Skip(DrawSkip reason) {
  ++g_skips[reason];
  g_last_skip = reason;
  return false;
}

RegisterFile& Regs() {
  static RegisterFile registers;
  return registers;
}

SpirvShaderTranslator& Translator() {
  static SpirvShaderTranslator* translator = [] {
    SpirvShaderTranslator::Features features(false);
    // One logical 512 MiB shared memory binding (see
    // xenos_spirv_translation_probe.cpp: WGSL has no arrays of unsized
    // storage structs).
    features.max_storage_buffer_range = 512u * 1024u * 1024u;
    // WebGPU texture views do not swizzle: the shaders apply the swizzle
    // from the system constants, as Xenia does without
    // imageViewFormatSwizzle.
    features.image_view_format_swizzle = false;
    return new SpirvShaderTranslator(features, false, false, false);
  }();
  return *translator;
}

// Analyzed shaders by type and ucode (Xenia's shader storage).
SpirvShader* GetShader(xenos::ShaderType type, const uint32_t* words, uint32_t dwords,
                       uint32_t hash) {
  static std::unordered_map<uint64_t, std::unique_ptr<SpirvShader>> shaders;
  if (!words || !dwords) return nullptr;
  const uint64_t key = (uint64_t(hash) << 32) ^ (uint64_t(dwords) << 1) ^ uint64_t(type);
  auto it = shaders.find(key);
  if (it != shaders.end()) return it->second.get();
  auto shader = std::make_unique<SpirvShader>(type, key, words, dwords, std::endian::native);
  xe::StringBuffer disassembly;
  shader->AnalyzeUcode(disassembly);
  SpirvShader* result = shader.get();
  shaders.emplace(key, std::move(shader));
  return result;
}

// Port of VulkanPipelineCache::GetCurrentVertexShaderModification (host
// vertex shader type kVertex).
SpirvShaderTranslator::Modification VertexShaderModification(const Shader& shader,
                                                              uint32_t interpolator_mask) {
  const RegisterFile& regs = Regs();
  SpirvShaderTranslator::Modification modification(
      Translator().GetDefaultVertexShaderModification(
          shader.GetDynamicAddressableRegisterCount(regs.Get<reg::SQ_PROGRAM_CNTL>().vs_num_reg),
          Shader::HostVertexShaderType::kVertex));
  modification.vertex.interpolator_mask = interpolator_mask;
  modification.vertex.output_point_parameters =
      uint32_t((shader.writes_point_size_edge_flag_kill_vertex() & 0b001) &&
               regs.Get<reg::VGT_DRAW_INITIATOR>().prim_type == xenos::PrimitiveType::kPointList);
  return modification;
}

// Port of VulkanPipelineCache::GetCurrentPixelShaderModification (host
// render targets path).
SpirvShaderTranslator::Modification PixelShaderModification(const Shader& shader,
                                                             uint32_t interpolator_mask,
                                                             uint32_t param_gen_pos) {
  const RegisterFile& regs = Regs();
  SpirvShaderTranslator::Modification modification(
      Translator().GetDefaultPixelShaderModification(
          shader.GetDynamicAddressableRegisterCount(regs.Get<reg::SQ_PROGRAM_CNTL>().ps_num_reg)));
  modification.pixel.interpolator_mask = interpolator_mask;
  modification.pixel.interpolators_centroid =
      interpolator_mask &
      ~xenos::GetInterpolatorSamplingPattern(regs.Get<reg::RB_SURFACE_INFO>().msaa_samples,
                                            regs.Get<reg::SQ_CONTEXT_MISC>().sc_sample_cntl,
                                            regs.Get<reg::SQ_INTERPOLATOR_CNTL>().sampling_pattern);
  if (param_gen_pos < xenos::kMaxInterpolators) {
    modification.pixel.param_gen_enable = 1;
    modification.pixel.param_gen_interpolator = param_gen_pos;
    modification.pixel.param_gen_point =
        uint32_t(regs.Get<reg::VGT_DRAW_INITIATOR>().prim_type == xenos::PrimitiveType::kPointList);
  } else {
    modification.pixel.param_gen_enable = 0;
    modification.pixel.param_gen_interpolator = 0;
    modification.pixel.param_gen_point = 0;
  }
  using DepthStencilMode = SpirvShaderTranslator::Modification::DepthStencilMode;
  if (shader.implicit_early_z_write_allowed() &&
      (!shader.writes_color_target(0) ||
       !draw_util::DoesCoverageDependOnAlpha(regs.Get<reg::RB_COLORCONTROL>()))) {
    modification.pixel.depth_stencil_mode = DepthStencilMode::kEarlyHint;
  } else {
    modification.pixel.depth_stencil_mode = DepthStencilMode::kNoModifiers;
  }
  return modification;
}

// Stream ids of translations already sent (0: none yet).
std::unordered_map<const Shader::Translation*, uint32_t>& ShaderIds() {
  static std::unordered_map<const Shader::Translation*, uint32_t> ids;
  return ids;
}
uint32_t g_next_shader_id = 1;

// Translates (once) and returns the stream id, sending the shader the first
// time; 0 on failure.
uint32_t ShaderId(SpirvShader& shader, uint64_t modification) {
  Shader::Translation* translation = shader.GetOrCreateTranslation(modification);
  if (!translation) return 0;
  auto& ids = ShaderIds();
  if (auto it = ids.find(translation); it != ids.end()) return it->second;
  if (!translation->is_translated() && !Translator().TranslateAnalyzedShader(*translation)) {
    ids.emplace(translation, 0u);
    return 0;
  }
  const auto& binary = translation->translated_binary();
  if (!translation->is_valid() || binary.size() < 20 || (binary.size() & 3)) {
    ids.emplace(translation, 0u);
    return 0;
  }
  const auto& textures = shader.GetTextureBindingsAfterTranslation();
  const auto& samplers = shader.GetSamplerBindingsAfterTranslation();
  const uint32_t spirv_words = uint32_t(binary.size() / 4);
  const uint32_t id = g_next_shader_id++;
  uint32_t* w = GpuStream().Begin(kGpuStreamShader,
                                  5 + uint32_t(textures.size() + samplers.size()) + spirv_words);
  *w++ = id;
  *w++ = shader.type() == xenos::ShaderType::kVertex ? 0u : 1u;
  *w++ = uint32_t(textures.size());
  *w++ = uint32_t(samplers.size());
  *w++ = spirv_words;
  for (const auto& t : textures) {
    *w++ = t.fetch_constant | (uint32_t(t.dimension) << 5) | (uint32_t(t.is_signed) << 7);
  }
  for (const auto& s : samplers) {
    *w++ = s.fetch_constant | (uint32_t(s.mag_filter) << 5) | (uint32_t(s.min_filter) << 7) |
           (uint32_t(s.mip_filter) << 9) | (uint32_t(s.aniso_filter) << 11);
  }
  std::memcpy(w, binary.data(), binary.size());
  ids.emplace(translation, id);
  return id;
}

// Pipelines already sent, by description.
struct PipelineKeyHash {
  size_t operator()(const std::vector<uint32_t>& v) const {
    uint64_t h = 1469598103934665603ull;
    for (uint32_t x : v) h = (h ^ x) * 1099511628211ull;
    return size_t(h ^ (h >> 32));
  }
};
uint32_t PipelineId(const WebGpuPipelineDescription& description) {
  static std::unordered_map<std::vector<uint32_t>, uint32_t, PipelineKeyHash> pipelines;
  static uint32_t next_id = 1;
  constexpr uint32_t kWords = sizeof(description) / 4;
  std::vector<uint32_t> key(kWords);
  std::memcpy(key.data(), &description, sizeof(description));
  if (auto it = pipelines.find(key); it != pipelines.end()) return it->second;
  const uint32_t id = next_id++;
  uint32_t* w = GpuStream().Begin(kGpuStreamPipeline, 1 + kWords);
  w[0] = id;
  std::memcpy(w + 1, &description, sizeof(description));
  pipelines.emplace(std::move(key), id);
  return id;
}

// Guest indices converted to host little-endian indices of the host
// primitive type (Xenia's PrimitiveProcessor converts fans, quads and
// endianness in the same way when the host cannot use them directly).
struct Indices {
  uint32_t host_topology = 3;  // see WebGpuPipelineDescription::topology
  std::vector<uint32_t> values;  // empty: non-indexed with vertex_count
  uint32_t vertex_count = 0;
  bool use_32bit = false;
};

bool ReadGuestIndex(const XenosSoftDraw& draw, const reg::VGT_DRAW_INITIATOR& init, uint32_t i,
                    xenos::Endian endian, uint32_t* out) {
  if (i >= draw.index_size) return false;
  if (init.index_size == xenos::IndexFormat::kInt16) {
    // The GPU swaps whole 32-bit words, then takes the 16-bit half (as the
    // software renderer's ReadIndex does).
    const uint32_t address = draw.index_base + i * 2u;
    uint32_t word = 0;
    if (!ReadSparseGuestMemory(r360_kernel_gpu_address_to_virtual(address & ~3u), &word, 4)) return false;
    *out = (xenos::GpuSwap(word, endian) >> ((address & 2u) * 8u)) & 0xFFFFu;
    return true;
  }
  uint32_t v = 0;
  if (!ReadSparseGuestMemory(r360_kernel_gpu_address_to_virtual(draw.index_base + i * 4u), &v, 4)) return false;
  *out = xenos::GpuSwap(v, endian) & 0xFFFFFFu;
  return true;
}

bool BuildIndices(const XenosSoftDraw& draw, Indices& out) {
  const RegisterFile& regs = Regs();
  reg::VGT_DRAW_INITIATOR init;
  init.value = draw.draw_initiator;
  const uint32_t count = init.num_indices;
  const bool indexed = init.source_select == xenos::SourceSelect::kDMA;
  if (!indexed && init.source_select != xenos::SourceSelect::kAutoIndex) return false;
  const auto endian = xenos::Endian(regs[XE_GPU_REG_VGT_DMA_SIZE] >> 30);
  const uint32_t offset = regs[XE_GPU_REG_VGT_INDX_OFFSET];
  std::vector<uint32_t> guest;
  if (indexed) {
    guest.resize(count);
    for (uint32_t i = 0; i < count; ++i) {
      if (!ReadGuestIndex(draw, init, i, endian, &guest[i])) return false;
      guest[i] = (guest[i] + offset) & 0xFFFFFFu;
    }
  }
  auto index_at = [&](uint32_t i) { return indexed ? guest[i] : (i + offset) & 0xFFFFFFu; };
  auto& v = out.values;
  switch (init.prim_type) {
    case xenos::PrimitiveType::kPointList: out.host_topology = 0; break;
    case xenos::PrimitiveType::kLineList: out.host_topology = 1; break;
    case xenos::PrimitiveType::kLineStrip: out.host_topology = 2; break;
    case xenos::PrimitiveType::kTriangleList: out.host_topology = 3; break;
    case xenos::PrimitiveType::kTriangleStrip: out.host_topology = 4; break;
    case xenos::PrimitiveType::kTriangleFan:
      out.host_topology = 3;
      for (uint32_t i = 2; i < count; ++i) {
        v.push_back(index_at(0)); v.push_back(index_at(i - 1)); v.push_back(index_at(i));
      }
      break;
    case xenos::PrimitiveType::kQuadList:
      out.host_topology = 3;
      for (uint32_t i = 0; i + 3 < count; i += 4) {
        v.push_back(index_at(i)); v.push_back(index_at(i + 1)); v.push_back(index_at(i + 2));
        v.push_back(index_at(i)); v.push_back(index_at(i + 2)); v.push_back(index_at(i + 3));
      }
      break;
    case xenos::PrimitiveType::kLineLoop:
      out.host_topology = 2;
      for (uint32_t i = 0; i < count; ++i) v.push_back(index_at(i));
      if (count) v.push_back(index_at(0));
      break;
    default:
      return false;  // rectangle lists, polygons, patches: not yet
  }
  const bool converted = !v.empty() || init.prim_type == xenos::PrimitiveType::kTriangleFan ||
                         init.prim_type == xenos::PrimitiveType::kQuadList;
  if (!converted) {
    if (indexed || offset) {
      for (uint32_t i = 0; i < count; ++i) v.push_back(index_at(i));
    } else {
      out.vertex_count = count;
    }
  }
  for (uint32_t x : v) out.use_32bit |= x > 0xFFFFu;
  return true;
}

// Port of VulkanCommandProcessor::UpdateSystemConstantValues for the host
// render targets path (no fragment shader interlock, no resolution scale).
void FillSystemConstants(SpirvShaderTranslator::SystemConstants& c, bool primitive_polygonal,
                         const draw_util::ViewportInfo& viewport_info) {
  const RegisterFile& regs = Regs();
  std::memset(&c, 0, sizeof(c));
  auto pa_cl_vte_cntl = regs.Get<reg::PA_CL_VTE_CNTL>();
  auto rb_colorcontrol = regs.Get<reg::RB_COLORCONTROL>();
  auto rb_depth_info = regs.Get<reg::RB_DEPTH_INFO>();
  auto rb_surface_info = regs.Get<reg::RB_SURFACE_INFO>();
  uint32_t flags = 0;
  if (pa_cl_vte_cntl.vtx_xy_fmt) flags |= SpirvShaderTranslator::kSysFlag_XYDividedByW;
  if (pa_cl_vte_cntl.vtx_z_fmt) flags |= SpirvShaderTranslator::kSysFlag_ZDividedByW;
  if (pa_cl_vte_cntl.vtx_w0_fmt) flags |= SpirvShaderTranslator::kSysFlag_WNotReciprocal;
  if (primitive_polygonal) flags |= SpirvShaderTranslator::kSysFlag_PrimitivePolygonal;
  if (draw_util::IsPrimitiveLine(regs)) flags |= SpirvShaderTranslator::kSysFlag_PrimitiveLine;
  flags |= uint32_t(rb_surface_info.msaa_samples) << SpirvShaderTranslator::kSysFlag_MsaaSamples_Shift;
  if (rb_depth_info.depth_format == xenos::DepthRenderTargetFormat::kD24FS8) {
    flags |= SpirvShaderTranslator::kSysFlag_DepthFloat24;
  }
  const xenos::CompareFunction alpha_test_function =
      rb_colorcontrol.alpha_test_enable ? rb_colorcontrol.alpha_func : xenos::CompareFunction::kAlways;
  flags |= uint32_t(alpha_test_function) << SpirvShaderTranslator::kSysFlag_AlphaPassIfLess_Shift;
  for (uint32_t i = 0; i < xenos::kMaxColorRenderTargets; ++i) {
    auto color_info = regs.Get<reg::RB_COLOR_INFO>(reg::RB_COLOR_INFO::rt_register_indices[i]);
    if (color_info.color_format == xenos::ColorRenderTargetFormat::k_8_8_8_8_GAMMA) {
      flags |= SpirvShaderTranslator::kSysFlag_ConvertColor0ToGamma << i;
    }
    int32_t color_exp_bias = color_info.color_exp_bias;
    // Host k_16_16 / k_16_16_16_16 render targets are normalized to -1..1 in
    // 32-unit range (Xenia's non-truncated fixed-point RG(BA)16).
    if (color_info.color_format == xenos::ColorRenderTargetFormat::k_16_16 ||
        color_info.color_format == xenos::ColorRenderTargetFormat::k_16_16_16_16) {
      color_exp_bias -= 5;
    }
    uint32_t bits = uint32_t(0x3F800000 + (color_exp_bias << 23));
    std::memcpy(&c.color_exp_bias[i], &bits, 4);
  }
  c.flags = flags;
  c.vertex_index_endian = xenos::Endian::kNone;
  c.vertex_base_index = 0;  // applied while building the host indices
  for (uint32_t i = 0; i < 3; ++i) {
    c.ndc_scale[i] = viewport_info.ndc_scale[i];
    c.ndc_offset[i] = viewport_info.ndc_offset[i];
  }
  if (regs.Get<reg::VGT_DRAW_INITIATOR>().prim_type == xenos::PrimitiveType::kPointList) {
    auto minmax = regs.Get<reg::PA_SU_POINT_MINMAX>();
    auto size = regs.Get<reg::PA_SU_POINT_SIZE>();
    c.point_vertex_diameter_min = float(minmax.min_size) * (2.0f / 16.0f);
    c.point_vertex_diameter_max = float(minmax.max_size) * (2.0f / 16.0f);
    c.point_constant_diameter[0] = float(size.width) * (2.0f / 16.0f);
    c.point_constant_diameter[1] = float(size.height) * (2.0f / 16.0f);
    c.point_screen_diameter_to_ndc_radius[0] = 1.0f / std::max(viewport_info.xy_extent[0], 1u);
    c.point_screen_diameter_to_ndc_radius[1] = 1.0f / std::max(viewport_info.xy_extent[1], 1u);
  }
  // Texture signs and swizzles come from the texture cache (not yet: the
  // backend binds placeholder textures, sampled as unsigned RGBA).
  for (uint32_t i = 0; i < 16; ++i) c.texture_swizzles[i] = 0x688u | (0x688u << 12);  // RGBA
  c.alpha_test_reference = regs.Get<float>(XE_GPU_REG_RB_ALPHA_REF);
}

// Float constants used by the shader, packed in register order (Xenia's
// UpdateBindings tight packing).
void PackFloatConstants(const Shader& shader, bool pixel, std::vector<uint32_t>& out) {
  const RegisterFile& regs = Regs();
  const auto& map = shader.constant_register_map();
  const uint32_t base = XE_GPU_REG_SHADER_CONSTANT_000_X + (pixel ? 256u * 4u : 0u);
  for (uint32_t i = 0; i < 4; ++i) {
    uint64_t bits = map.float_bitmap[i];
    uint32_t index;
    while (xe::bit_scan_forward(bits, &index)) {
      bits &= ~(uint64_t(1) << index);
      const uint32_t reg_index = base + (((i << 6) + index) << 2);
      for (uint32_t c = 0; c < 4; ++c) out.push_back(regs[reg_index + c]);
    }
  }
  if (out.empty()) out.assign(4, 0u);
}

// The render targets the draw writes (host render targets path), as Xenia's
// RenderTargetCache::Update selects them.
WebGpuRenderTargetsKey RenderTargets(uint32_t normalized_color_mask, bool depth_enabled,
                                     uint32_t height) {
  const RegisterFile& regs = Regs();
  WebGpuRenderTargetsKey key{};
  auto surface = regs.Get<reg::RB_SURFACE_INFO>();
  key.surface_pitch = surface.surface_pitch;
  key.msaa_samples = uint32_t(surface.msaa_samples);
  key.height = height;
  for (uint32_t i = 0; i < 4; ++i) {
    auto info = regs.Get<reg::RB_COLOR_INFO>(reg::RB_COLOR_INFO::rt_register_indices[i]);
    const bool used = (normalized_color_mask >> (i * 4)) & 0xF;
    key.color_base[i] = used ? info.color_base : 0xFFFFFFFFu;
    key.color_format[i] = used ? uint32_t(info.color_format) : 0u;
  }
  auto depth = regs.Get<reg::RB_DEPTH_INFO>();
  key.depth_base = depth_enabled ? depth.depth_base : 0xFFFFFFFFu;
  key.depth_format = depth_enabled ? uint32_t(depth.depth_format) : 0u;
  return key;
}

WebGpuRenderTargetsKey g_bound_targets{};
bool g_targets_bound = false;

}  // namespace

bool WebGpuBackendEnabled() { return g_mode != 0; }

void WebGpuSwap(const uint32_t* fetch_constant) {
  if (!g_mode) return;
  uint32_t* w = GpuStream().Begin(kGpuStreamSwap, 6);
  std::memcpy(w, fetch_constant, 6 * sizeof(uint32_t));
}

bool WebGpuIssueDraw(const XenosSoftDraw& draw) {
  if (!g_mode) return false;
  RegisterFile& regs = Regs();
  const uint32_t count = std::min<uint32_t>(draw.register_count, RegisterFile::kRegisterCount);
  std::memcpy(regs.values, draw.registers, count * sizeof(uint32_t));
  const auto edram_mode = regs.Get<reg::RB_MODECONTROL>().edram_mode;
  if (edram_mode != xenos::EdramMode::kColorDepth && edram_mode != xenos::EdramMode::kDepthOnly) {
    return true;  // copies are resolves (not recorded here yet)
  }

  SpirvShader* vertex_shader =
      GetShader(xenos::ShaderType::kVertex, draw.vertex_shader, draw.vertex_shader_dwords,
                draw.vertex_shader_hash);
  if (!vertex_shader || !vertex_shader->is_ucode_analyzed()) return Skip(kSkipNoVertexShader);
  SpirvShader* pixel_shader = nullptr;
  if (edram_mode == xenos::EdramMode::kColorDepth && draw.pixel_shader) {
    pixel_shader = GetShader(xenos::ShaderType::kPixel, draw.pixel_shader, draw.pixel_shader_dwords,
                             draw.pixel_shader_hash);
    if (pixel_shader && !pixel_shader->is_ucode_analyzed()) return Skip(kSkipTranslation);
  }
  const bool primitive_polygonal = draw_util::IsPrimitivePolygonal(regs);
  if (!draw_util::IsRasterizationPotentiallyDone(regs, primitive_polygonal)) return true;

  uint32_t param_gen_pos = UINT32_MAX;
  const uint32_t interpolator_mask =
      pixel_shader ? vertex_shader->writes_interpolators() &
                         pixel_shader->GetInterpolatorInputMask(regs.Get<reg::SQ_PROGRAM_CNTL>(),
                                                                regs.Get<reg::SQ_CONTEXT_MISC>(),
                                                                param_gen_pos)
                   : 0u;
  const uint32_t vs_id =
      ShaderId(*vertex_shader, VertexShaderModification(*vertex_shader, interpolator_mask).value);
  if (!vs_id) return Skip(kSkipTranslation);
  uint32_t ps_id = 0;
  if (pixel_shader) {
    ps_id = ShaderId(*pixel_shader,
                     PixelShaderModification(*pixel_shader, interpolator_mask, param_gen_pos).value);
    if (!ps_id) return Skip(kSkipTranslation);
  }

  Indices indices;
  if (!BuildIndices(draw, indices)) return Skip(kSkipPrimitive);

  // Pipeline state (VulkanPipelineCache::GetCurrentStateDescription).
  const reg::RB_DEPTHCONTROL depth_control = draw_util::GetNormalizedDepthControl(regs);
  const uint32_t color_mask =
      pixel_shader ? draw_util::GetNormalizedColorMask(regs, pixel_shader->writes_color_targets()) : 0u;
  WebGpuPipelineDescription description{};
  description.vertex_shader = vs_id;
  description.pixel_shader = ps_id;
  description.topology = indices.host_topology;
  auto pa_su_sc_mode_cntl = regs.Get<reg::PA_SU_SC_MODE_CNTL>();
  if (primitive_polygonal) {
    description.cull_mode = pa_su_sc_mode_cntl.cull_front ? 1u : (pa_su_sc_mode_cntl.cull_back ? 2u : 0u);
    if (pa_su_sc_mode_cntl.cull_front && pa_su_sc_mode_cntl.cull_back) return true;  // nothing drawn
  }
  description.front_face_cw = pa_su_sc_mode_cntl.face ? 1u : 0u;
  const bool depth_used = depth_control.z_enable || depth_control.stencil_enable;
  description.depth_compare =
      depth_control.z_enable ? uint32_t(depth_control.zfunc) : uint32_t(xenos::CompareFunction::kAlways);
  description.depth_write = depth_control.z_enable && depth_control.z_write_enable;
  if (depth_control.stencil_enable) {
    description.stencil = depth_control.value & 0xFFFFFF81u;
    description.stencil_masks = regs[XE_GPU_REG_RB_STENCILREFMASK] & 0xFFFF00u;
  }
  for (uint32_t i = 0; i < 4; ++i) {
    const uint32_t mask = (color_mask >> (i * 4)) & 0xF;
    if (!mask) continue;
    auto info = regs.Get<reg::RB_COLOR_INFO>(reg::RB_COLOR_INFO::rt_register_indices[i]);
    description.color_formats[i] = uint32_t(info.color_format) + 1u;
    description.color_write_masks |= mask << (i * 4);
    description.blend_control[i] = regs[reg::RB_BLENDCONTROL::rt_register_indices[i]] & 0x1FFF1FFFu;
  }
  if (depth_used) {
    description.depth_format = uint32_t(regs.Get<reg::RB_DEPTH_INFO>().depth_format) + 1u;
  }
  description.msaa_samples = uint32_t(regs.Get<reg::RB_SURFACE_INFO>().msaa_samples);

  // Viewport and scissor in render target pixels (origin top-left, no
  // resolution scale). WebGPU clip space has Y up like Direct3D 12, so the
  // NDC transform is D3D12CommandProcessor's (origin_bottom_left).
  auto surface = regs.Get<reg::RB_SURFACE_INFO>();
  const uint32_t pitch = std::max<uint32_t>(surface.surface_pitch, 1u);
  constexpr uint32_t kMaxHeight = 2560;
  draw_util::ViewportInfo viewport_info;
  draw_util::GetHostViewportInfo(regs, 1, 1, true, pitch, kMaxHeight, false, depth_control,
                                 false, false, pixel_shader && pixel_shader->writes_depth(),
                                 viewport_info);
  draw_util::Scissor scissor;
  draw_util::GetScissor(regs, scissor);
  const uint32_t height = std::min<uint32_t>(
      kMaxHeight, std::max(scissor.offset[1] + scissor.extent[1],
                           viewport_info.xy_offset[1] + viewport_info.xy_extent[1]));

  // Render targets: a new set ends the current render pass.
  const WebGpuRenderTargetsKey targets = RenderTargets(color_mask, depth_used, height);
  if (!g_targets_bound || std::memcmp(&targets, &g_bound_targets, sizeof(targets)) != 0) {
    uint32_t* w = GpuStream().Begin(kGpuStreamRenderTargets, sizeof(targets) / 4);
    std::memcpy(w, &targets, sizeof(targets));
    g_bound_targets = targets;
    g_targets_bound = true;
  }

  // Vertex data the shader fetches from shared memory.
  for (const auto& binding : vertex_shader->vertex_bindings()) {
    const xenos::xe_gpu_vertex_fetch_t fetch = regs.GetVertexFetch(binding.fetch_constant);
    if (fetch.type != xenos::FetchConstantType::kVertex) return Skip(kSkipVertexFetch);
    if (!GpuSharedMemory().RequestRange(fetch.address << 2, fetch.size << 2)) {
      return Skip(kSkipVertexFetch);
    }
  }

  // Constants.
  SpirvShaderTranslator::SystemConstants system{};
  FillSystemConstants(system, primitive_polygonal, viewport_info);
  std::vector<uint32_t> float_vertex, float_pixel;
  PackFloatConstants(*vertex_shader, false, float_vertex);
  if (pixel_shader) PackFloatConstants(*pixel_shader, true, float_pixel);
  else float_pixel.assign(4, 0u);
  // Bool (8 dwords) and loop (32 dwords) constants, then the 32 texture /
  // vertex fetch constants (6 dwords each), as Xenia uploads them.
  constexpr uint32_t kBoolLoopWords = 8 + 32, kFetchWords = 32 * 6;

  const uint32_t index_words =
      indices.values.empty() ? 0u
                             : (indices.use_32bit ? uint32_t(indices.values.size())
                                                  : uint32_t((indices.values.size() + 1) / 2));
  const uint32_t system_words = sizeof(system) / 4;
  const uint32_t payload = sizeof(WebGpuDrawHeader) / 4 + system_words +
                           uint32_t(float_vertex.size() + float_pixel.size()) + kBoolLoopWords +
                           kFetchWords + index_words;
  const uint32_t pipeline_id = PipelineId(description);
  uint32_t* w = GpuStream().Begin(kGpuStreamDraw, payload);
  WebGpuDrawHeader header{};
  header.pipeline = pipeline_id;
  header.viewport[0] = viewport_info.xy_offset[0];
  header.viewport[1] = viewport_info.xy_offset[1];
  header.viewport[2] = viewport_info.xy_extent[0];
  header.viewport[3] = viewport_info.xy_extent[1];
  header.depth_range[0] = viewport_info.z_min;
  header.depth_range[1] = viewport_info.z_max;
  header.scissor[0] = scissor.offset[0];
  header.scissor[1] = scissor.offset[1];
  header.scissor[2] = scissor.extent[0];
  header.scissor[3] = scissor.extent[1];
  header.stencil_reference = regs.Get<reg::RB_STENCILREFMASK>().stencilref;
  header.blend_constant[0] = regs.Get<float>(XE_GPU_REG_RB_BLEND_RED);
  header.blend_constant[1] = regs.Get<float>(XE_GPU_REG_RB_BLEND_GREEN);
  header.blend_constant[2] = regs.Get<float>(XE_GPU_REG_RB_BLEND_BLUE);
  header.blend_constant[3] = regs.Get<float>(XE_GPU_REG_RB_BLEND_ALPHA);
  header.system_constant_words = system_words;
  header.float_vertex_words = uint32_t(float_vertex.size());
  header.float_pixel_words = uint32_t(float_pixel.size());
  header.bool_loop_words = kBoolLoopWords;
  header.fetch_words = kFetchWords;
  header.index_format = indices.values.empty() ? 0u : (indices.use_32bit ? 2u : 1u);
  header.vertex_count = indices.values.empty() ? indices.vertex_count : uint32_t(indices.values.size());
  header.vertex_texture_mask = vertex_shader->GetUsedTextureMaskAfterTranslation();
  header.pixel_texture_mask = pixel_shader ? pixel_shader->GetUsedTextureMaskAfterTranslation() : 0u;
  std::memcpy(w, &header, sizeof(header));
  w += sizeof(header) / 4;
  std::memcpy(w, &system, sizeof(system));
  w += system_words;
  std::memcpy(w, float_vertex.data(), float_vertex.size() * 4);
  w += float_vertex.size();
  std::memcpy(w, float_pixel.data(), float_pixel.size() * 4);
  w += float_pixel.size();
  std::memcpy(w, &regs[XE_GPU_REG_SHADER_CONSTANT_BOOL_000_031], kBoolLoopWords * 4);
  w += kBoolLoopWords;
  std::memcpy(w, &regs[XE_GPU_REG_SHADER_CONSTANT_FETCH_00_0], kFetchWords * 4);
  w += kFetchWords;
  if (index_words) {
    if (indices.use_32bit) {
      std::memcpy(w, indices.values.data(), indices.values.size() * 4);
    } else {
      auto* h = reinterpret_cast<uint16_t*>(w);
      for (size_t i = 0; i < indices.values.size(); ++i) h[i] = uint16_t(indices.values[i]);
      if (indices.values.size() & 1) h[indices.values.size()] = 0;
    }
  }
  ++g_draws;
  return true;
}

}  // namespace render360::xenia_web

namespace rx = render360::xenia_web;

extern "C" {
// 0 off, 1 record draws for the WebGPU backend.
__attribute__((used, export_name("r360_gpu_set_mode")))
uint32_t r360_gpu_set_mode(uint32_t mode) {
  rx::g_mode = mode;
  rx::g_targets_bound = false;
  return mode;
}
// 0 draws recorded, 1..5 skips by reason (see DrawSkip), 6 last skip reason.
__attribute__((used, export_name("r360_gpu_draw_stat")))
uint32_t r360_gpu_draw_stat(uint32_t index) {
  if (index == 0) return rx::g_draws;
  if (index < rx::kSkipCount) return rx::g_skips[index];
  return rx::g_last_skip;
}
}  // extern "C"
