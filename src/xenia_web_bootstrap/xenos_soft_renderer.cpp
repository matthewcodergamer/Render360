// Software Xenos backend. Plays the role of one of Xenia's GPU backends (its
// render target cache, primitive processor, rasterizer state and resolve
// paths), executing on the CPU: the browser has no Xenia host GPU backend.
// Register semantics, shader execution, resolve geometry and texture tiling
// are Xenia's (registers.h, ShaderInterpreter, draw_util::GetResolveInfo,
// texture_address::Tiled2D); this file supplies EDRAM storage, primitive
// assembly, triangle rasterization, the output merger and resolve copies.

#include "xenos_soft_renderer.h"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <memory>
#include <unordered_map>
#include <vector>

#include "ppc_translation_probe_runtime.h"
#include "sparse_guest_memory.h"
#include "xenia/base/string_buffer.h"
#include "xenia/gpu/draw_util.h"
#include "xenia/gpu/register_file.h"
#include "xenia/gpu/registers.h"
#include "xenia/gpu/shader.h"
#include "xenia/gpu/shader_interpreter.h"
#include "xenia/gpu/texture_address.h"
#include "xenia/gpu/trace_writer.h"

extern "C" uint32_t r360_kernel_gpu_address_to_virtual(uint32_t address);

namespace render360::xenia_web {
namespace {

namespace xenos = xe::gpu::xenos;
using namespace xe::gpu;  // XE_GPU_REG_* register indices
namespace reg = xe::gpu::reg;
using xe::gpu::RegisterFile;

// --- EDRAM -------------------------------------------------------------------
// 2048 tiles of 80x16 32-bit samples (5120 bytes), as Xenia's EDRAM model.
// 64bpp render targets use 40x16 samples per tile; depth tiles have their
// 40-sample column halves swapped (Xenia render_target_cache).
constexpr uint32_t kEdramTiles = 2048;
constexpr uint32_t kTileWidth = 80;
constexpr uint32_t kTileHeight = 16;
constexpr uint32_t kTileWords = kTileWidth * kTileHeight;
std::vector<uint32_t>& Edram() {
  static std::vector<uint32_t> edram(size_t(kEdramTiles) * kTileWords, 0);
  return edram;
}

struct Surface {
  uint32_t base_tiles = 0;
  uint32_t pitch_tiles = 0;
  uint32_t samples_x = 1, samples_y = 1;
  bool is_64bpp = false;
  bool is_depth = false;
};

// Word index of sample (sx, sy) (sample coordinates) of a surface.
uint32_t EdramWord(const Surface& s, uint32_t sx, uint32_t sy) {
  const uint32_t tile_w = s.is_64bpp ? kTileWidth / 2 : kTileWidth;
  const uint32_t tile = (s.base_tiles + (sy / kTileHeight) * s.pitch_tiles + sx / tile_w) % kEdramTiles;
  uint32_t x_in_tile = sx % tile_w;
  if (s.is_depth) x_in_tile = (x_in_tile + kTileWidth / 2) % kTileWidth;
  const uint32_t y_in_tile = sy % kTileHeight;
  return tile * kTileWords + (y_in_tile * tile_w + x_in_tile) * (s.is_64bpp ? 2u : 1u);
}

Surface MakeSurface(uint32_t base_tiles, uint32_t surface_pitch, xenos::MsaaSamples msaa,
                    bool is_64bpp, bool is_depth) {
  Surface s;
  s.base_tiles = base_tiles;
  s.samples_x = msaa >= xenos::MsaaSamples::k4X ? 2 : 1;
  s.samples_y = msaa >= xenos::MsaaSamples::k2X ? 2 : 1;
  s.is_64bpp = is_64bpp;
  s.is_depth = is_depth;
  const uint32_t tile_w = is_64bpp ? kTileWidth / 2 : kTileWidth;
  s.pitch_tiles = (surface_pitch * s.samples_x + tile_w - 1) / tile_w;
  return s;
}

bool IsColorFormat64bpp(xenos::ColorRenderTargetFormat f) {
  return f == xenos::ColorRenderTargetFormat::k_16_16_16_16 ||
         f == xenos::ColorRenderTargetFormat::k_16_16_16_16_FLOAT ||
         f == xenos::ColorRenderTargetFormat::k_32_32_FLOAT;
}

float Saturate(float v) { return v != v ? 0.0f : std::min(1.0f, std::max(0.0f, v)); }
uint32_t Unorm(float v, uint32_t bits) {
  const float max = float((1u << bits) - 1u);
  return uint32_t(std::lround(Saturate(v) * max));
}

// Half float conversions (Xenos 16-bit float render targets).
uint16_t FloatToHalf(float f) {
  uint32_t x;
  std::memcpy(&x, &f, 4);
  const uint32_t sign = (x >> 16) & 0x8000u;
  int32_t exp = int32_t((x >> 23) & 0xFF) - 127 + 15;
  uint32_t mant = x & 0x7FFFFFu;
  if (exp <= 0) return uint16_t(sign);
  if (exp >= 31) return uint16_t(sign | 0x7BFFu);
  return uint16_t(sign | (uint32_t(exp) << 10) | (mant >> 13));
}
float HalfToFloat(uint16_t h) {
  const uint32_t sign = uint32_t(h & 0x8000u) << 16;
  const uint32_t exp = (h >> 10) & 0x1Fu, mant = h & 0x3FFu;
  uint32_t x;
  if (!exp) x = sign;  // denormals flushed
  else x = sign | ((exp - 15 + 127) << 23) | (mant << 13);
  float f;
  std::memcpy(&f, &x, 4);
  return f;
}

// Render target color storage <-> RGBA float.
void EncodeColor(xenos::ColorRenderTargetFormat format, const float c[4], uint32_t out[2]) {
  out[1] = 0;
  switch (format) {
    case xenos::ColorRenderTargetFormat::k_2_10_10_10:
    case xenos::ColorRenderTargetFormat::k_2_10_10_10_AS_10_10_10_10:
      out[0] = Unorm(c[0], 10) | (Unorm(c[1], 10) << 10) | (Unorm(c[2], 10) << 20) | (Unorm(c[3], 2) << 30);
      return;
    case xenos::ColorRenderTargetFormat::k_16_16_FLOAT:
      out[0] = FloatToHalf(c[0]) | (uint32_t(FloatToHalf(c[1])) << 16);
      return;
    case xenos::ColorRenderTargetFormat::k_16_16_16_16_FLOAT:
      out[0] = FloatToHalf(c[0]) | (uint32_t(FloatToHalf(c[1])) << 16);
      out[1] = FloatToHalf(c[2]) | (uint32_t(FloatToHalf(c[3])) << 16);
      return;
    case xenos::ColorRenderTargetFormat::k_32_FLOAT:
      std::memcpy(&out[0], &c[0], 4);
      return;
    case xenos::ColorRenderTargetFormat::k_32_32_FLOAT:
      std::memcpy(&out[0], &c[0], 4);
      std::memcpy(&out[1], &c[1], 4);
      return;
    default:  // k_8_8_8_8, k_8_8_8_8_GAMMA and the rest as 8888
      out[0] = Unorm(c[0], 8) | (Unorm(c[1], 8) << 8) | (Unorm(c[2], 8) << 16) | (Unorm(c[3], 8) << 24);
      return;
  }
}
void DecodeColor(xenos::ColorRenderTargetFormat format, const uint32_t in[2], float c[4]) {
  switch (format) {
    case xenos::ColorRenderTargetFormat::k_2_10_10_10:
    case xenos::ColorRenderTargetFormat::k_2_10_10_10_AS_10_10_10_10:
      c[0] = float(in[0] & 0x3FF) / 1023.0f;
      c[1] = float((in[0] >> 10) & 0x3FF) / 1023.0f;
      c[2] = float((in[0] >> 20) & 0x3FF) / 1023.0f;
      c[3] = float(in[0] >> 30) / 3.0f;
      return;
    case xenos::ColorRenderTargetFormat::k_16_16_FLOAT:
      c[0] = HalfToFloat(uint16_t(in[0])); c[1] = HalfToFloat(uint16_t(in[0] >> 16));
      c[2] = 0.0f; c[3] = 1.0f;
      return;
    case xenos::ColorRenderTargetFormat::k_16_16_16_16_FLOAT:
      c[0] = HalfToFloat(uint16_t(in[0])); c[1] = HalfToFloat(uint16_t(in[0] >> 16));
      c[2] = HalfToFloat(uint16_t(in[1])); c[3] = HalfToFloat(uint16_t(in[1] >> 16));
      return;
    case xenos::ColorRenderTargetFormat::k_32_FLOAT:
      std::memcpy(&c[0], &in[0], 4); c[1] = c[2] = 0.0f; c[3] = 1.0f;
      return;
    case xenos::ColorRenderTargetFormat::k_32_32_FLOAT:
      std::memcpy(&c[0], &in[0], 4); std::memcpy(&c[1], &in[1], 4); c[2] = 0.0f; c[3] = 1.0f;
      return;
    default:
      for (uint32_t i = 0; i < 4; ++i) c[i] = float((in[0] >> (i * 8)) & 0xFF) / 255.0f;
      return;
  }
}

// --- Guest memory ---------------------------------------------------------------
bool ReadGpu32(uint32_t gpu_address, uint32_t* out) {
  uint8_t b[4];
  if (!ReadSparseGuestMemory(r360_kernel_gpu_address_to_virtual(gpu_address), b, 4)) return false;
  std::memcpy(out, b, 4);  // host little-endian load of the raw bytes
  return true;
}
bool WriteGpu32(uint32_t gpu_address, uint32_t value) {
  uint8_t b[4];
  std::memcpy(b, &value, 4);
  return WriteSparseGuestMemory(r360_kernel_gpu_address_to_virtual(gpu_address), b, 4);
}

// --- Telemetry ------------------------------------------------------------------
uint32_t g_draws_rendered = 0;
// 1 = rasterize draws (default); 0 = fast-forward: color/depth draws are not
// rasterized, while resolves and clears still run so GPU/CPU synchronization
// (fences, write-backs, interrupts) is unchanged.
uint32_t g_rasterize = 1;
uint32_t g_draws_skipped = 0;
uint32_t g_resolves = 0;
uint32_t g_pixels_shaded = 0;
uint32_t g_last_skip_reason = 0;
uint32_t g_texture_fetch_failures = 0;
uint32_t g_last_texture_format = 0;
enum SkipReason : uint32_t {
  kSkipNone = 0,
  kSkipNoShader = 1,
  kSkipShaderNotInterpretable = 2,
  kSkipPrimitive = 3,
  kSkipIndexBuffer = 4,
  kSkipResolveInfo = 5,
  kSkipEdramMode = 6,
  kSkipVertexShader = 7,
  kSkipPixelShader = 8,
};
bool Skip(uint32_t reason) {
  g_last_skip_reason = reason;
  ++g_draws_skipped;
  return false;
}

RegisterFile& Registers() {
  static RegisterFile registers;
  return registers;
}

// Analyzed shaders by type and hash (Xenia Shader::AnalyzeUcode).
xe::gpu::Shader* GetShader(xenos::ShaderType type, const uint32_t* words,
                           uint32_t dwords, uint32_t hash) {
  static std::unordered_map<uint64_t, std::unique_ptr<xe::gpu::Shader>> cache;
  if (!words || !dwords) return nullptr;
  const uint64_t key = (uint64_t(hash) << 32) ^ (uint64_t(dwords) << 1) ^ uint64_t(type);
  auto it = cache.find(key);
  if (it != cache.end()) return it->second.get();
  auto shader = std::make_unique<xe::gpu::Shader>(type, key, words, dwords, std::endian::native);
  xe::StringBuffer disassembly;
  shader->AnalyzeUcode(disassembly);
  auto* result = shader.get();
  if (cache.size() > 4096) cache.clear();
  cache.emplace(key, std::move(shader));
  return result;
}

// --- Shader execution -----------------------------------------------------------
struct VertexOut {
  float position[4] = {0, 0, 0, 1};
  float interpolators[16][4] = {};
};

class VertexExportSink final : public xe::gpu::ShaderInterpreter::ExportSink {
 public:
  VertexOut* out = nullptr;
  void Export(xe::gpu::ucode::ExportRegister export_register, const float* value,
              uint32_t value_mask) override {
    float* target = nullptr;
    const uint32_t index = uint32_t(export_register);
    if (export_register == xe::gpu::ucode::ExportRegister::kVSPosition) {
      target = out->position;
    } else if (index < 16) {
      target = out->interpolators[index];
    }
    if (!target) return;
    for (uint32_t i = 0; i < 4; ++i) {
      if (value_mask & (1u << i)) target[i] = value[i];
    }
  }
};

class PixelExportSink final : public xe::gpu::ShaderInterpreter::ExportSink {
 public:
  float color[4][4] = {};
  uint32_t written = 0;
  bool depth_written = false;
  float depth = 0.0f;
  void Export(xe::gpu::ucode::ExportRegister export_register, const float* value,
              uint32_t value_mask) override {
    const uint32_t index = uint32_t(export_register);
    if (index < 4) {
      for (uint32_t i = 0; i < 4; ++i) {
        if (value_mask & (1u << i)) color[index][i] = value[i];
      }
      written |= 1u << index;
    } else if (export_register == xe::gpu::ucode::ExportRegister::kPSDepth) {
      depth_written = true;
      depth = value[0];
    }
  }
};

// --- Output merger ---------------------------------------------------------------
float BlendFactorValue(xenos::BlendFactor f, const float src[4], const float dst[4],
                       const float constant[4], uint32_t c) {
  switch (f) {
    case xenos::BlendFactor::kZero: return 0.0f;
    case xenos::BlendFactor::kOne: return 1.0f;
    case xenos::BlendFactor::kSrcColor: return src[c];
    case xenos::BlendFactor::kOneMinusSrcColor: return 1.0f - src[c];
    case xenos::BlendFactor::kSrcAlpha: return src[3];
    case xenos::BlendFactor::kOneMinusSrcAlpha: return 1.0f - src[3];
    case xenos::BlendFactor::kDstColor: return dst[c];
    case xenos::BlendFactor::kOneMinusDstColor: return 1.0f - dst[c];
    case xenos::BlendFactor::kDstAlpha: return dst[3];
    case xenos::BlendFactor::kOneMinusDstAlpha: return 1.0f - dst[3];
    case xenos::BlendFactor::kConstantColor: return constant[c];
    case xenos::BlendFactor::kOneMinusConstantColor: return 1.0f - constant[c];
    case xenos::BlendFactor::kConstantAlpha: return constant[3];
    case xenos::BlendFactor::kOneMinusConstantAlpha: return 1.0f - constant[3];
    case xenos::BlendFactor::kSrcAlphaSaturate:
      return c == 3 ? 1.0f : std::min(src[3], 1.0f - dst[3]);
    default: return 1.0f;
  }
}
float BlendOpValue(xenos::BlendOp op, float s, float d) {
  switch (op) {
    case xenos::BlendOp::kAdd: return s + d;
    case xenos::BlendOp::kSubtract: return s - d;
    case xenos::BlendOp::kMin: return std::min(s, d);
    case xenos::BlendOp::kMax: return std::max(s, d);
    case xenos::BlendOp::kRevSubtract: return d - s;
    default: return s + d;
  }
}
bool Compare(xenos::CompareFunction f, float a, float b) {
  switch (f) {
    case xenos::CompareFunction::kNever: return false;
    case xenos::CompareFunction::kLess: return a < b;
    case xenos::CompareFunction::kEqual: return a == b;
    case xenos::CompareFunction::kLessEqual: return a <= b;
    case xenos::CompareFunction::kGreater: return a > b;
    case xenos::CompareFunction::kNotEqual: return a != b;
    case xenos::CompareFunction::kGreaterEqual: return a >= b;
    default: return true;
  }
}

struct RenderTarget {
  bool enabled = false;
  Surface surface;
  xenos::ColorRenderTargetFormat format = xenos::ColorRenderTargetFormat::k_8_8_8_8;
  uint32_t write_mask = 0;
  reg::RB_BLENDCONTROL blend;
  float exp_bias_scale = 1.0f;
};

struct DrawState {
  RenderTarget rt[4];
  Surface depth_surface;
  bool depth_enabled = false;
  bool depth_write = false;
  xenos::CompareFunction depth_func = xenos::CompareFunction::kAlways;
  bool depth_float24 = false;
  bool alpha_test = false;
  xenos::CompareFunction alpha_func = xenos::CompareFunction::kAlways;
  float alpha_ref = 0.0f;
  float blend_constant[4] = {};
  int32_t scissor_x0 = 0, scissor_y0 = 0, scissor_x1 = 0, scissor_y1 = 0;
  uint32_t interpolator_count = 0;
  bool param_gen = false;
  uint32_t param_gen_register = 0;
  bool cull_front = false, cull_back = false, front_cw = false;
  xenos::ShaderType ps_type = xenos::ShaderType::kPixel;
};

void WritePixel(const DrawState& st, uint32_t px, uint32_t py, float z,
                const PixelExportSink& ps) {
  // Depth test (24-bit unorm depth in the high bits, stencil in the low 8).
  if (st.depth_enabled) {
    const Surface& ds = st.depth_surface;
    uint32_t& word = Edram()[EdramWord(ds, px * ds.samples_x, py * ds.samples_y)];
    const float stored = float(word >> 8) / 16777215.0f;
    const float zc = Saturate(ps.depth_written ? ps.depth : z);
    if (!Compare(st.depth_func, zc, stored)) return;
    if (st.depth_write) {
      const uint32_t value = (Unorm(zc, 24) << 8) | (word & 0xFFu);
      for (uint32_t sy = 0; sy < ds.samples_y; ++sy)
        for (uint32_t sx = 0; sx < ds.samples_x; ++sx)
          Edram()[EdramWord(ds, px * ds.samples_x + sx, py * ds.samples_y + sy)] = value;
    }
  }
  if (st.alpha_test && !Compare(st.alpha_func, ps.color[0][3], st.alpha_ref)) return;
  for (uint32_t i = 0; i < 4; ++i) {
    const RenderTarget& rt = st.rt[i];
    if (!rt.enabled || !rt.write_mask || !(ps.written & (1u << i))) continue;
    float src[4];
    for (uint32_t c = 0; c < 4; ++c) src[c] = ps.color[i][c] * rt.exp_bias_scale;
    uint32_t stored[2];
    const uint32_t w0 = EdramWord(rt.surface, px * rt.surface.samples_x, py * rt.surface.samples_y);
    stored[0] = Edram()[w0];
    stored[1] = rt.surface.is_64bpp ? Edram()[w0 + 1] : 0u;
    float dst[4];
    DecodeColor(rt.format, stored, dst);
    float out[4];
    const auto& b = rt.blend;
    const bool blending =
        !(b.color_srcblend == xenos::BlendFactor::kOne && b.color_destblend == xenos::BlendFactor::kZero &&
          b.color_comb_fcn == xenos::BlendOp::kAdd && b.alpha_srcblend == xenos::BlendFactor::kOne &&
          b.alpha_destblend == xenos::BlendFactor::kZero && b.alpha_comb_fcn == xenos::BlendOp::kAdd);
    for (uint32_t c = 0; c < 4; ++c) {
      if (!blending) { out[c] = src[c]; continue; }
      const bool alpha = c == 3;
      const auto sf = alpha ? b.alpha_srcblend : b.color_srcblend;
      const auto df = alpha ? b.alpha_destblend : b.color_destblend;
      const auto op = alpha ? b.alpha_comb_fcn : b.color_comb_fcn;
      float s = src[c], d = dst[c];
      if (op != xenos::BlendOp::kMin && op != xenos::BlendOp::kMax) {
        s *= BlendFactorValue(sf, src, dst, st.blend_constant, c);
        d *= BlendFactorValue(df, src, dst, st.blend_constant, c);
      }
      out[c] = BlendOpValue(op, s, d);
    }
    for (uint32_t c = 0; c < 4; ++c) {
      if (!(rt.write_mask & (1u << c))) out[c] = dst[c];
    }
    uint32_t encoded[2];
    EncodeColor(rt.format, out, encoded);
    for (uint32_t sy = 0; sy < rt.surface.samples_y; ++sy) {
      for (uint32_t sx = 0; sx < rt.surface.samples_x; ++sx) {
        const uint32_t w = EdramWord(rt.surface, px * rt.surface.samples_x + sx, py * rt.surface.samples_y + sy);
        Edram()[w] = encoded[0];
        if (rt.surface.is_64bpp) Edram()[w + 1] = encoded[1];
      }
    }
  }
}

struct ScreenVertex {
  float x, y, z, w;  // w = 1/clip w for perspective-correct interpolation
  const VertexOut* out;
};

// Converts a vertex shader position to screen space as Xenia's host viewport
// (draw_util::GetHostViewportInfo) and shader translators do with
// PA_CL_VTE_CNTL, the guest viewport, the window offset and pixel center.
ScreenVertex ToScreen(const RegisterFile& regs, const VertexOut& v) {
  const auto vte = regs.Get<reg::PA_CL_VTE_CNTL>();
  float x = v.position[0], y = v.position[1], z = v.position[2], w = v.position[3];
  // vtx_w0_fmt = 0: the exported W is 1/W.
  float clip_w = vte.vtx_w0_fmt ? w : (w != 0.0f ? 1.0f / w : 1.0f);
  if (!(clip_w > 0.0f) || !std::isfinite(clip_w)) clip_w = 1e-6f;
  const float rw = 1.0f / clip_w;
  if (!vte.vtx_xy_fmt) { x *= rw; y *= rw; }
  if (!vte.vtx_z_fmt) z *= rw;
  const auto f = [&](uint32_t index) { return regs.Get<float>(index); };
  if (vte.vport_x_scale_ena) x *= f(XE_GPU_REG_PA_CL_VPORT_XSCALE);
  if (vte.vport_x_offset_ena) x += f(XE_GPU_REG_PA_CL_VPORT_XOFFSET);
  if (vte.vport_y_scale_ena) y *= f(XE_GPU_REG_PA_CL_VPORT_YSCALE);
  if (vte.vport_y_offset_ena) y += f(XE_GPU_REG_PA_CL_VPORT_YOFFSET);
  if (vte.vport_z_scale_ena) z *= f(XE_GPU_REG_PA_CL_VPORT_ZSCALE);
  if (vte.vport_z_offset_ena) z += f(XE_GPU_REG_PA_CL_VPORT_ZOFFSET);
  if (regs.Get<reg::PA_SU_SC_MODE_CNTL>().vtx_window_offset_enable) {
    const auto offset = regs.Get<reg::PA_SC_WINDOW_OFFSET>();
    x += float(offset.window_x_offset);
    y += float(offset.window_y_offset);
  }
  // Direct3D 9 pixel centers are at integer coordinates.
  if (regs.Get<reg::PA_SU_VTX_CNTL>().pix_center == xenos::PixelCenter::kD3DZero) {
    x += 0.5f;
    y += 0.5f;
  }
  return {x, y, z, rw, &v};
}

class Rasterizer {
 public:
  Rasterizer(const RegisterFile& regs, const DrawState& st, xe::gpu::ShaderInterpreter& ps,
             const xe::gpu::Shader* pixel_shader)
      : regs_(regs), st_(st), ps_(ps), pixel_shader_(pixel_shader) {}

  void Triangle(const ScreenVertex& a, const ScreenVertex& b, const ScreenVertex& c) {
    const float area = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
    if (area == 0.0f || !std::isfinite(area)) return;
    // Face culling: area > 0 is clockwise in y-down screen space.
    const bool clockwise = area > 0.0f;
    const bool front = st_.front_cw ? clockwise : !clockwise;
    if ((front && st_.cull_front) || (!front && st_.cull_back)) return;
    int32_t x0 = int32_t(std::floor(std::min({a.x, b.x, c.x})));
    int32_t y0 = int32_t(std::floor(std::min({a.y, b.y, c.y})));
    int32_t x1 = int32_t(std::ceil(std::max({a.x, b.x, c.x})));
    int32_t y1 = int32_t(std::ceil(std::max({a.y, b.y, c.y})));
    x0 = std::max(x0, st_.scissor_x0);
    y0 = std::max(y0, st_.scissor_y0);
    x1 = std::min(x1, st_.scissor_x1);
    y1 = std::min(y1, st_.scissor_y1);
    if (x0 >= x1 || y0 >= y1) return;
    const float inv_area = 1.0f / area;
    for (int32_t py = y0; py < y1; ++py) {
      const float sy = float(py) + 0.5f;
      for (int32_t px = x0; px < x1; ++px) {
        const float sx = float(px) + 0.5f;
        float w0 = Edge(b, c, sx, sy), w1 = Edge(c, a, sx, sy), w2 = Edge(a, b, sx, sy);
        if (area < 0.0f) { w0 = -w0; w1 = -w1; w2 = -w2; }
        // Top-left fill rule approximated by an inclusive/exclusive split.
        if (w0 < 0.0f || w1 < 0.0f || w2 < 0.0f) continue;
        if ((w0 == 0.0f && !TopLeft(b, c, area)) || (w1 == 0.0f && !TopLeft(c, a, area)) ||
            (w2 == 0.0f && !TopLeft(a, b, area))) {
          continue;
        }
        float l0 = w0 * std::fabs(inv_area), l1 = w1 * std::fabs(inv_area), l2 = w2 * std::fabs(inv_area);
        Shade(px, py, sx, sy, a, b, c, l0, l1, l2, front);
      }
    }
  }

 private:
  static float Edge(const ScreenVertex& p, const ScreenVertex& q, float x, float y) {
    return (q.x - p.x) * (y - p.y) - (q.y - p.y) * (x - p.x);
  }
  static bool TopLeft(const ScreenVertex& p, const ScreenVertex& q, float area) {
    float dx = q.x - p.x, dy = q.y - p.y;
    if (area < 0.0f) { dx = -dx; dy = -dy; }
    return (dy == 0.0f && dx < 0.0f) || dy > 0.0f;
  }

  void Shade(int32_t px, int32_t py, float sx, float sy, const ScreenVertex& a,
             const ScreenVertex& b, const ScreenVertex& c, float l0, float l1, float l2,
             bool front) {
    // Perspective-correct barycentrics.
    const float pw0 = l0 * a.w, pw1 = l1 * b.w, pw2 = l2 * c.w;
    const float sum = pw0 + pw1 + pw2;
    const float p0 = sum != 0.0f ? pw0 / sum : l0, p1 = sum != 0.0f ? pw1 / sum : l1,
                p2 = sum != 0.0f ? pw2 / sum : l2;
    const float z = l0 * a.z + l1 * b.z + l2 * c.z;
    PixelExportSink sink;
    if (pixel_shader_) {
      float* temps = ps_.temp_registers();
      for (uint32_t i = 0; i < st_.interpolator_count; ++i) {
        for (uint32_t k = 0; k < 4; ++k) {
          temps[i * 4 + k] = p0 * a.out->interpolators[i][k] +
                             p1 * b.out->interpolators[i][k] +
                             p2 * c.out->interpolators[i][k];
        }
      }
      if (st_.param_gen && st_.param_gen_register < 16) {
        // Xenia: XY screen position, Z front-facing sign, W point coordinate.
        float* p = temps + st_.param_gen_register * 4;
        p[0] = sx; p[1] = sy; p[2] = front ? 0.0f : -0.0f; p[3] = 0.0f;
      }
      ps_.SetExportSink(&sink);
      ps_.Execute();
      if (ps_.texture_fetch_failed()) ++g_texture_fetch_failures;
    } else {
      sink.written = 0;
    }
    ++g_pixels_shaded;
    WritePixel(st_, uint32_t(px), uint32_t(py), z, sink);
  }

  const RegisterFile& regs_;
  const DrawState& st_;
  xe::gpu::ShaderInterpreter& ps_;
  const xe::gpu::Shader* pixel_shader_;
};

// --- Draw state ----------------------------------------------------------------
void BuildDrawState(const RegisterFile& regs, DrawState& st, bool depth_only) {
  const auto surface_info = regs.Get<reg::RB_SURFACE_INFO>();
  const uint32_t mask = regs[XE_GPU_REG_RB_COLOR_MASK];
  static const uint32_t kColorInfo[4] = {XE_GPU_REG_RB_COLOR_INFO, XE_GPU_REG_RB_COLOR1_INFO,
                                         XE_GPU_REG_RB_COLOR2_INFO, XE_GPU_REG_RB_COLOR3_INFO};
  static const uint32_t kBlend[4] = {XE_GPU_REG_RB_BLENDCONTROL0, XE_GPU_REG_RB_BLENDCONTROL1,
                                     XE_GPU_REG_RB_BLENDCONTROL2, XE_GPU_REG_RB_BLENDCONTROL3};
  for (uint32_t i = 0; i < 4; ++i) {
    RenderTarget& rt = st.rt[i];
    rt.write_mask = depth_only ? 0u : (mask >> (i * 4)) & 0xFu;
    rt.enabled = rt.write_mask != 0;
    reg::RB_COLOR_INFO info;
    info.value = regs[kColorInfo[i]];
    rt.format = info.color_format;
    rt.surface = MakeSurface(info.color_base | (info.color_base_bit_11 << 11),
                             surface_info.surface_pitch, surface_info.msaa_samples,
                             IsColorFormat64bpp(info.color_format), false);
    rt.blend.value = regs[kBlend[i]];
    rt.exp_bias_scale = std::ldexp(1.0f, info.color_exp_bias);
  }
  const auto depthcontrol = xe::gpu::draw_util::GetNormalizedDepthControl(regs);
  const auto depth_info = regs.Get<reg::RB_DEPTH_INFO>();
  st.depth_enabled = depthcontrol.z_enable != 0;
  st.depth_write = depthcontrol.z_write_enable != 0;
  st.depth_func = depthcontrol.zfunc;
  st.depth_float24 = depth_info.depth_format == xenos::DepthRenderTargetFormat::kD24FS8;
  st.depth_surface = MakeSurface(depth_info.depth_base | (depth_info.depth_base_bit_11 << 11),
                                 surface_info.surface_pitch, surface_info.msaa_samples, false, true);
  const auto colorcontrol = regs.Get<reg::RB_COLORCONTROL>();
  st.alpha_test = colorcontrol.alpha_test_enable != 0;
  st.alpha_func = colorcontrol.alpha_func;
  st.alpha_ref = regs.Get<float>(XE_GPU_REG_RB_ALPHA_REF);
  st.blend_constant[0] = regs.Get<float>(XE_GPU_REG_RB_BLEND_RED);
  st.blend_constant[1] = regs.Get<float>(XE_GPU_REG_RB_BLEND_GREEN);
  st.blend_constant[2] = regs.Get<float>(XE_GPU_REG_RB_BLEND_BLUE);
  st.blend_constant[3] = regs.Get<float>(XE_GPU_REG_RB_BLEND_ALPHA);
  xe::gpu::draw_util::Scissor scissor;
  xe::gpu::draw_util::GetScissor(regs, scissor, true);
  st.scissor_x0 = int32_t(scissor.offset[0]);
  st.scissor_y0 = int32_t(scissor.offset[1]);
  st.scissor_x1 = int32_t(scissor.offset[0] + scissor.extent[0]);
  st.scissor_y1 = int32_t(scissor.offset[1] + scissor.extent[1]);
  const auto program = regs.Get<reg::SQ_PROGRAM_CNTL>();
  st.interpolator_count = std::min(16u, uint32_t(program.vs_export_count) + 1u);
  st.param_gen = program.param_gen != 0;
  st.param_gen_register = regs.Get<reg::SQ_CONTEXT_MISC>().param_gen_pos;
  const auto mode = regs.Get<reg::PA_SU_SC_MODE_CNTL>();
  st.cull_front = mode.cull_front != 0;
  st.cull_back = mode.cull_back != 0;
  st.front_cw = mode.face != 0;
}

bool ReadIndex(const XenosSoftDraw& draw, const reg::VGT_DRAW_INITIATOR& init,
               uint32_t i, uint32_t* index) {
  if (init.source_select == xenos::SourceSelect::kAutoIndex) {
    *index = i;
    return true;
  }
  if (init.source_select != xenos::SourceSelect::kDMA || i >= draw.index_size) return false;
  const RegisterFile& regs = Registers();
  const auto endian = xenos::Endian(regs[XE_GPU_REG_VGT_DMA_SIZE] >> 30);
  if (init.index_size == xenos::IndexFormat::kInt16) {
    const uint32_t address = draw.index_base + i * 2u;
    uint32_t word = 0;
    if (!ReadGpu32(address & ~3u, &word)) return false;
    word = xenos::GpuSwap(word, endian);
    *index = (word >> ((address & 2u) * 8u)) & 0xFFFFu;
  } else {
    uint32_t word = 0;
    if (!ReadGpu32(draw.index_base + i * 4u, &word)) return false;
    *index = xenos::GpuSwap(word, endian) & 0xFFFFFFu;
  }
  *index = (*index + regs[XE_GPU_REG_VGT_INDX_OFFSET]) & 0xFFFFFFu;
  return true;
}

bool RenderPrimitives(const XenosSoftDraw& draw, bool depth_only) {
  RegisterFile& regs = Registers();
  reg::VGT_DRAW_INITIATOR init;
  init.value = draw.draw_initiator;
  const uint32_t count = init.num_indices;
  const auto prim = init.prim_type;
  if (prim == xenos::PrimitiveType::kPointList || prim == xenos::PrimitiveType::kLineList ||
      prim == xenos::PrimitiveType::kLineStrip || prim == xenos::PrimitiveType::kLineLoop) {
    return Skip(kSkipPrimitive);  // points/lines are not rasterized yet
  }
  if (!count) return true;
  auto* vs = GetShader(xenos::ShaderType::kVertex, draw.vertex_shader,
                       draw.vertex_shader_dwords, draw.vertex_shader_hash);
  if (!vs) return Skip(kSkipNoShader);
  auto* ps = depth_only ? nullptr
                        : GetShader(xenos::ShaderType::kPixel, draw.pixel_shader,
                                    draw.pixel_shader_dwords, draw.pixel_shader_hash);
  if (!xe::gpu::ShaderInterpreter::CanInterpretShader(*vs) ||
      (ps && !xe::gpu::ShaderInterpreter::CanInterpretShader(*ps))) {
    return Skip(kSkipShaderNotInterpretable);
  }
  xe::Memory* memory = ActiveProbeMemory();
  if (!memory) return Skip(kSkipVertexShader);

  // Vertex shading.
  std::vector<VertexOut> vertices(count);
  {
    xe::gpu::ShaderInterpreter interpreter(regs, *memory);
    VertexExportSink sink;
    interpreter.SetExportSink(&sink);
    interpreter.SetShader(*vs);
    for (uint32_t i = 0; i < count; ++i) {
      uint32_t index = 0;
      if (!ReadIndex(draw, init, i, &index)) return Skip(kSkipIndexBuffer);
      std::fill(interpreter.temp_registers(),
                interpreter.temp_registers() + xenos::kMaxShaderTempRegisters * 4, 0.0f);
      interpreter.temp_registers()[0] = float(index);
      sink.out = &vertices[i];
      interpreter.Execute();
    }
  }

  DrawState st;
  BuildDrawState(regs, st, depth_only);
  xe::gpu::ShaderInterpreter pixel_interpreter(regs, *memory);
  if (ps) pixel_interpreter.SetShader(*ps);
  Rasterizer raster(regs, st, pixel_interpreter, ps);
  std::vector<ScreenVertex> screen(count);
  for (uint32_t i = 0; i < count; ++i) screen[i] = ToScreen(regs, vertices[i]);

  switch (prim) {
    case xenos::PrimitiveType::kTriangleList:
      for (uint32_t i = 0; i + 2 < count; i += 3) raster.Triangle(screen[i], screen[i + 1], screen[i + 2]);
      break;
    case xenos::PrimitiveType::kTriangleStrip:
      for (uint32_t i = 0; i + 2 < count; ++i) {
        if (i & 1) raster.Triangle(screen[i + 1], screen[i], screen[i + 2]);
        else raster.Triangle(screen[i], screen[i + 1], screen[i + 2]);
      }
      break;
    case xenos::PrimitiveType::kTriangleFan:
    case xenos::PrimitiveType::kPolygon:
      for (uint32_t i = 1; i + 1 < count; ++i) raster.Triangle(screen[0], screen[i], screen[i + 1]);
      break;
    case xenos::PrimitiveType::kQuadList:
      for (uint32_t i = 0; i + 3 < count; i += 4) {
        raster.Triangle(screen[i], screen[i + 1], screen[i + 2]);
        raster.Triangle(screen[i], screen[i + 2], screen[i + 3]);
      }
      break;
    case xenos::PrimitiveType::kQuadStrip:
      for (uint32_t i = 0; i + 3 < count; i += 2) {
        raster.Triangle(screen[i], screen[i + 1], screen[i + 3]);
        raster.Triangle(screen[i], screen[i + 3], screen[i + 2]);
      }
      break;
    case xenos::PrimitiveType::kRectangleList: {
      // Xenia primitive processor: the fourth corner is v1 + v2 - v0 (for every
      // attribute) of the rectangle described by the first three vertices.
      for (uint32_t i = 0; i + 2 < count; i += 3) {
        VertexOut fourth;
        const VertexOut& a = vertices[i];
        const VertexOut& b = vertices[i + 1];
        const VertexOut& c = vertices[i + 2];
        // The corner opposite to v0 is v1 + v2 - v0 when v0 is the right angle;
        // Xenia picks the vertex shared by the two shortest edges.
        const ScreenVertex& sa = screen[i];
        const ScreenVertex& sb = screen[i + 1];
        const ScreenVertex& sc = screen[i + 2];
        auto len2 = [](const ScreenVertex& p, const ScreenVertex& q) {
          return (p.x - q.x) * (p.x - q.x) + (p.y - q.y) * (p.y - q.y);
        };
        const float ab = len2(sa, sb), bc = len2(sb, sc), ca = len2(sc, sa);
        const VertexOut *p0 = &a, *p1 = &b, *p2 = &c;  // p0 = right-angle corner
        if (bc >= ab && bc >= ca) { p0 = &a; p1 = &b; p2 = &c; }
        else if (ca >= ab && ca >= bc) { p0 = &b; p1 = &c; p2 = &a; }
        else { p0 = &c; p1 = &a; p2 = &b; }
        for (uint32_t k = 0; k < 4; ++k) fourth.position[k] = p1->position[k] + p2->position[k] - p0->position[k];
        for (uint32_t n = 0; n < 16; ++n)
          for (uint32_t k = 0; k < 4; ++k)
            fourth.interpolators[n][k] = p1->interpolators[n][k] + p2->interpolators[n][k] - p0->interpolators[n][k];
        const ScreenVertex s0 = ToScreen(regs, *p0), s1 = ToScreen(regs, *p1), s2 = ToScreen(regs, *p2);
        const ScreenVertex s3 = ToScreen(regs, fourth);
        raster.Triangle(s0, s1, s2);
        raster.Triangle(s1, s3, s2);
      }
      break;
    }
    default:
      return Skip(kSkipPrimitive);
  }
  ++g_draws_rendered;
  return true;
}

// --- Resolve --------------------------------------------------------------------
// Encodes RGBA into a resolve destination color format (Xenos ColorFormat ==
// TextureFormat numbering), returning bits and bytes per pixel.
uint32_t EncodeDest(xenos::ColorFormat format, const float c[4], uint32_t* bytes) {
  switch (uint32_t(format)) {
    case uint32_t(xenos::TextureFormat::k_8):
      *bytes = 1;
      return Unorm(c[0], 8);
    case uint32_t(xenos::TextureFormat::k_5_6_5):
      *bytes = 2;
      return Unorm(c[2], 5) | (Unorm(c[1], 6) << 5) | (Unorm(c[0], 5) << 11);
    case uint32_t(xenos::TextureFormat::k_1_5_5_5):
      *bytes = 2;
      return Unorm(c[0], 5) | (Unorm(c[1], 5) << 5) | (Unorm(c[2], 5) << 10) | (Unorm(c[3], 1) << 15);
    case uint32_t(xenos::TextureFormat::k_4_4_4_4):
      *bytes = 2;
      return Unorm(c[0], 4) | (Unorm(c[1], 4) << 4) | (Unorm(c[2], 4) << 8) | (Unorm(c[3], 4) << 12);
    case uint32_t(xenos::TextureFormat::k_8_8):
      *bytes = 2;
      return Unorm(c[0], 8) | (Unorm(c[1], 8) << 8);
    case uint32_t(xenos::TextureFormat::k_2_10_10_10):
      *bytes = 4;
      return Unorm(c[0], 10) | (Unorm(c[1], 10) << 10) | (Unorm(c[2], 10) << 20) | (Unorm(c[3], 2) << 30);
    case uint32_t(xenos::TextureFormat::k_16_16_FLOAT):
      *bytes = 4;
      return FloatToHalf(c[0]) | (uint32_t(FloatToHalf(c[1])) << 16);
    case uint32_t(xenos::TextureFormat::k_32_FLOAT): {
      *bytes = 4;
      uint32_t v;
      std::memcpy(&v, &c[0], 4);
      return v;
    }
    default:  // k_8_8_8_8 and unhandled formats
      *bytes = 4;
      return Unorm(c[0], 8) | (Unorm(c[1], 8) << 8) | (Unorm(c[2], 8) << 16) | (Unorm(c[3], 8) << 24);
  }
}

bool Resolve() {
  RegisterFile& regs = Registers();
  xe::Memory* memory = ActiveProbeMemory();
  if (!memory) return Skip(kSkipResolveInfo);
  // GetResolveInfo only reads guest memory through the Render360 overlay
  // (sparse memory); the trace writer is never used by it.
  alignas(xe::gpu::TraceWriter) static uint8_t trace_storage[sizeof(xe::gpu::TraceWriter)] = {};
  auto& trace_writer = *reinterpret_cast<xe::gpu::TraceWriter*>(trace_storage);
  xe::gpu::draw_util::ResolveInfo info;
  if (!xe::gpu::draw_util::GetResolveInfo(regs, *memory, trace_writer, 1, 1, false, false, info)) {
    return Skip(kSkipResolveInfo);
  }
  const bool copying_depth = info.IsCopyingDepth();
  const auto& edram_info = copying_depth ? info.depth_edram_info : info.color_edram_info;
  const uint32_t width = info.coordinate_info.width_div_8 * 8u;
  const uint32_t height = info.height_div_8 * 8u;
  const uint32_t origin_x = info.coordinate_info.edram_offset_x_div_8 * 8u;
  const uint32_t origin_y = info.coordinate_info.edram_offset_y_div_8 * 8u;
  Surface source;
  source.base_tiles = edram_info.base_tiles;
  source.pitch_tiles = edram_info.pitch_tiles;
  source.samples_x = edram_info.msaa_samples >= xenos::MsaaSamples::k4X ? 2 : 1;
  source.samples_y = edram_info.msaa_samples >= xenos::MsaaSamples::k2X ? 2 : 1;
  source.is_64bpp = edram_info.format_is_64bpp;
  source.is_depth = edram_info.is_depth;
  const auto color_format = xenos::ColorRenderTargetFormat(edram_info.format);

  const auto copy_command = info.rb_copy_control.copy_command;
  if (copy_command != xenos::CopyCommand::kNull && width && height) {
    const auto dest_info = info.copy_dest_info;
    const uint32_t dest_pitch = info.copy_dest_coordinate_info.pitch_aligned_div_32 * 32u;
    const uint32_t dest_x0 = info.copy_dest_coordinate_info.offset_x_div_8 * 8u;
    const uint32_t dest_y0 = info.copy_dest_coordinate_info.offset_y_div_8 * 8u;
    const float exp_scale = std::ldexp(1.0f, dest_info.copy_dest_exp_bias);
    for (uint32_t y = 0; y < height; ++y) {
      for (uint32_t x = 0; x < width; ++x) {
        const uint32_t sx = (origin_x + x) * source.samples_x;
        const uint32_t sy = (origin_y + y) * source.samples_y;
        const uint32_t w = EdramWord(source, sx, sy);
        float c[4];
        if (copying_depth) {
          const uint32_t d = Edram()[w];
          c[0] = float(d >> 8) / 16777215.0f;
          c[1] = c[2] = 0.0f;
          c[3] = 1.0f;
        } else {
          const uint32_t stored[2] = {Edram()[w], source.is_64bpp ? Edram()[w + 1] : 0u};
          DecodeColor(color_format, stored, c);
        }
        for (uint32_t k = 0; k < 4; ++k) c[k] *= exp_scale;
        if (dest_info.copy_dest_swap) std::swap(c[0], c[2]);
        uint32_t bytes = 4;
        uint32_t value = EncodeDest(dest_info.copy_dest_format, c, &bytes);
        const uint32_t bpp_log2 = bytes == 1 ? 0u : bytes == 2 ? 1u : 2u;
        const int32_t offset = xe::gpu::texture_address::Tiled2D(
            int32_t(dest_x0 + x), int32_t(dest_y0 + y), dest_pitch, bpp_log2);
        const uint32_t address = info.copy_dest_base + uint32_t(offset);
        // Byte-insert into the containing word, then apply the Endian128 swap
        // (for 32bpp and smaller only 8in16/8in32/16in32 matter).
        uint32_t word = 0;
        ReadGpu32(address & ~3u, &word);
        const auto endian = xenos::Endian(uint32_t(dest_info.copy_dest_endian) & 3u);
        uint32_t host = xenos::GpuSwap(word, endian);
        const uint32_t shift = (address & 3u) * 8u;
        const uint32_t mask = bytes == 4 ? 0xFFFFFFFFu : (((1u << (bytes * 8u)) - 1u) << shift);
        host = (host & ~mask) | ((value << shift) & mask);
        WriteGpu32(address & ~3u, xenos::GpuSwap(host, endian));
      }
    }
  }

  // Clears (Xenia: color and/or depth for the resolve rectangle).
  if (width && height) {
    if (info.IsClearingColor()) {
      Surface rt = source;
      rt.base_tiles = info.color_edram_info.base_tiles;
      rt.pitch_tiles = info.color_edram_info.pitch_tiles;
      rt.is_64bpp = info.color_edram_info.format_is_64bpp;
      rt.is_depth = false;
      for (uint32_t y = 0; y < height * rt.samples_y; ++y)
        for (uint32_t x = 0; x < width * rt.samples_x; ++x) {
          const uint32_t w = EdramWord(rt, origin_x * rt.samples_x + x, origin_y * rt.samples_y + y);
          if (rt.is_64bpp) { Edram()[w] = info.rb_color_clear_lo; Edram()[w + 1] = info.rb_color_clear; }
          else Edram()[w] = info.rb_color_clear;
        }
    }
    if (info.IsClearingDepth()) {
      Surface ds = source;
      ds.base_tiles = info.depth_edram_info.base_tiles;
      ds.pitch_tiles = info.depth_edram_info.pitch_tiles;
      ds.is_64bpp = false;
      ds.is_depth = true;
      for (uint32_t y = 0; y < height * ds.samples_y; ++y)
        for (uint32_t x = 0; x < width * ds.samples_x; ++x)
          Edram()[EdramWord(ds, origin_x * ds.samples_x + x, origin_y * ds.samples_y + y)] = info.rb_depth_clear;
    }
  }
  ++g_resolves;
  return true;
}

// --- Textures -------------------------------------------------------------------
struct TexelLayout {
  uint32_t block_w = 1, block_h = 1, bytes = 4;
};
bool TextureLayout(xenos::TextureFormat f, TexelLayout* l) {
  switch (f) {
    case xenos::TextureFormat::k_8: case xenos::TextureFormat::k_8_A: case xenos::TextureFormat::k_8_B:
      *l = {1, 1, 1}; return true;
    case xenos::TextureFormat::k_1_5_5_5: case xenos::TextureFormat::k_5_6_5: case xenos::TextureFormat::k_6_5_5:
    case xenos::TextureFormat::k_8_8: case xenos::TextureFormat::k_4_4_4_4: case xenos::TextureFormat::k_16:
    case xenos::TextureFormat::k_16_FLOAT:
      *l = {1, 1, 2}; return true;
    case xenos::TextureFormat::k_8_8_8_8: case xenos::TextureFormat::k_8_8_8_8_A: case xenos::TextureFormat::k_2_10_10_10:
    case xenos::TextureFormat::k_16_16: case xenos::TextureFormat::k_16_16_FLOAT: case xenos::TextureFormat::k_32_FLOAT:
    case xenos::TextureFormat::k_10_11_11: case xenos::TextureFormat::k_11_11_10:
      *l = {1, 1, 4}; return true;
    case xenos::TextureFormat::k_DXT1:
      *l = {4, 4, 8}; return true;
    case xenos::TextureFormat::k_DXT2_3: case xenos::TextureFormat::k_DXT4_5:
      *l = {4, 4, 16}; return true;
    default:
      return false;
  }
}

void Rgb565(uint32_t v, float c[3]) {
  c[0] = float((v >> 11) & 31) / 31.0f;
  c[1] = float((v >> 5) & 63) / 63.0f;
  c[2] = float(v & 31) / 31.0f;
}

// Decodes texel (x, y) of a block-compressed or plain format from the
// host-order (endian-swapped) block bytes.
void DecodeTexel(xenos::TextureFormat f, const uint8_t* block, uint32_t bx, uint32_t by, float c[4]) {
  auto u16 = [&](uint32_t o) { return uint32_t(block[o]) | (uint32_t(block[o + 1]) << 8); };
  auto u32 = [&](uint32_t o) { return u16(o) | (u16(o + 2) << 16); };
  c[0] = c[1] = c[2] = 0.0f; c[3] = 1.0f;
  switch (f) {
    case xenos::TextureFormat::k_8: case xenos::TextureFormat::k_8_A: case xenos::TextureFormat::k_8_B:
      c[0] = c[1] = c[2] = c[3] = float(block[0]) / 255.0f; return;
    case xenos::TextureFormat::k_8_8:
      c[0] = float(block[0]) / 255.0f; c[1] = float(block[1]) / 255.0f; c[2] = 0.0f; c[3] = 1.0f; return;
    case xenos::TextureFormat::k_5_6_5: {
      const uint32_t v = u16(0);
      c[0] = float(v & 31) / 31.0f; c[1] = float((v >> 5) & 63) / 63.0f; c[2] = float(v >> 11) / 31.0f; return;
    }
    case xenos::TextureFormat::k_6_5_5: {
      const uint32_t v = u16(0);
      c[0] = float(v & 31) / 31.0f; c[1] = float((v >> 5) & 31) / 31.0f; c[2] = float(v >> 10) / 63.0f; return;
    }
    case xenos::TextureFormat::k_1_5_5_5: {
      const uint32_t v = u16(0);
      c[0] = float(v & 31) / 31.0f; c[1] = float((v >> 5) & 31) / 31.0f; c[2] = float((v >> 10) & 31) / 31.0f;
      c[3] = float(v >> 15); return;
    }
    case xenos::TextureFormat::k_4_4_4_4: {
      const uint32_t v = u16(0);
      for (uint32_t i = 0; i < 4; ++i) c[i] = float((v >> (i * 4)) & 15) / 15.0f;
      return;
    }
    case xenos::TextureFormat::k_16:
      c[0] = float(u16(0)) / 65535.0f; return;
    case xenos::TextureFormat::k_16_FLOAT:
      c[0] = HalfToFloat(uint16_t(u16(0))); return;
    case xenos::TextureFormat::k_8_8_8_8: case xenos::TextureFormat::k_8_8_8_8_A:
      for (uint32_t i = 0; i < 4; ++i) c[i] = float(block[i]) / 255.0f;
      return;
    case xenos::TextureFormat::k_2_10_10_10: {
      const uint32_t v = u32(0);
      c[0] = float(v & 0x3FF) / 1023.0f; c[1] = float((v >> 10) & 0x3FF) / 1023.0f;
      c[2] = float((v >> 20) & 0x3FF) / 1023.0f; c[3] = float(v >> 30) / 3.0f; return;
    }
    case xenos::TextureFormat::k_16_16:
      c[0] = float(u16(0)) / 65535.0f; c[1] = float(u16(2)) / 65535.0f; return;
    case xenos::TextureFormat::k_16_16_FLOAT:
      c[0] = HalfToFloat(uint16_t(u16(0))); c[1] = HalfToFloat(uint16_t(u16(2))); return;
    case xenos::TextureFormat::k_32_FLOAT: {
      const uint32_t v = u32(0);
      std::memcpy(&c[0], &v, 4); return;
    }
    case xenos::TextureFormat::k_DXT1:
    case xenos::TextureFormat::k_DXT2_3:
    case xenos::TextureFormat::k_DXT4_5: {
      const uint32_t color_offset = f == xenos::TextureFormat::k_DXT1 ? 0u : 8u;
      const uint32_t c0 = u16(color_offset), c1 = u16(color_offset + 2);
      const uint32_t bits = u32(color_offset + 4);
      float p0[3], p1[3];
      Rgb565(c0, p0);
      Rgb565(c1, p1);
      const uint32_t sel = (bits >> ((by * 4 + bx) * 2)) & 3u;
      float rgb[3];
      float alpha = 1.0f;
      for (uint32_t i = 0; i < 3; ++i) {
        if (sel == 0) rgb[i] = p0[i];
        else if (sel == 1) rgb[i] = p1[i];
        else if (c0 > c1 || f != xenos::TextureFormat::k_DXT1)
          rgb[i] = sel == 2 ? (2 * p0[i] + p1[i]) / 3.0f : (p0[i] + 2 * p1[i]) / 3.0f;
        else
          rgb[i] = sel == 2 ? (p0[i] + p1[i]) * 0.5f : 0.0f;
      }
      if (f == xenos::TextureFormat::k_DXT1 && c0 <= c1 && sel == 3) alpha = 0.0f;
      if (f == xenos::TextureFormat::k_DXT2_3) {
        const uint32_t texel = by * 4 + bx;
        alpha = float((block[texel / 2] >> ((texel & 1) * 4)) & 15) / 15.0f;
      } else if (f == xenos::TextureFormat::k_DXT4_5) {
        const float a0 = float(block[0]) / 255.0f, a1 = float(block[1]) / 255.0f;
        uint64_t abits = 0;
        for (uint32_t i = 0; i < 6; ++i) abits |= uint64_t(block[2 + i]) << (8 * i);
        const uint32_t s = uint32_t(abits >> (3 * (by * 4 + bx))) & 7u;
        if (s == 0) alpha = a0;
        else if (s == 1) alpha = a1;
        else if (block[0] > block[1]) alpha = ((8 - s) * a0 + (s - 1) * a1) / 7.0f;
        else if (s == 6) alpha = 0.0f;
        else if (s == 7) alpha = 1.0f;
        else alpha = ((6 - s) * a0 + (s - 1) * a1) / 5.0f;
      }
      c[0] = rgb[0]; c[1] = rgb[1]; c[2] = rgb[2]; c[3] = alpha;
      return;
    }
    default:
      return;
  }
}

bool FetchTexel(const xenos::xe_gpu_texture_fetch_t& fetch, const TexelLayout& layout,
                uint32_t pitch_blocks, int32_t x, int32_t y, float c[4]) {
  const uint32_t bx = uint32_t(x) / layout.block_w, by = uint32_t(y) / layout.block_h;
  const uint32_t bpp_log2 = layout.bytes == 1 ? 0 : layout.bytes == 2 ? 1 : layout.bytes == 4 ? 2 : layout.bytes == 8 ? 3 : 4;
  uint32_t offset;
  if (fetch.tiled) {
    offset = uint32_t(xe::gpu::texture_address::Tiled2D(int32_t(bx), int32_t(by), pitch_blocks, bpp_log2));
  } else {
    offset = (by * pitch_blocks + bx) * layout.bytes;
  }
  const uint32_t base = fetch.base_address << 12;
  const uint32_t address = base + offset;
  uint8_t block[16] = {};
  const uint32_t read_bytes = std::max(4u, layout.bytes);
  for (uint32_t i = 0; i < read_bytes; i += 4) {
    uint32_t word = 0;
    if (!ReadGpu32((address & ~3u) + i, &word)) return false;
    word = xenos::GpuSwap(word, fetch.endianness);
    std::memcpy(block + i, &word, 4);
  }
  DecodeTexel(fetch.format, layout.bytes < 4 ? block + (address & 3u) : block,
              uint32_t(x) % layout.block_w, uint32_t(y) % layout.block_h, c);
  return true;
}

int32_t Wrap(int32_t v, int32_t size, xenos::ClampMode mode) {
  switch (mode) {
    case xenos::ClampMode::kRepeat: {
      int32_t m = v % size;
      return m < 0 ? m + size : m;
    }
    case xenos::ClampMode::kMirroredRepeat: {
      const int32_t period = size * 2;
      int32_t m = v % period;
      if (m < 0) m += period;
      return m >= size ? period - 1 - m : m;
    }
    default:
      return std::min(std::max(v, 0), size - 1);
  }
}

}  // namespace

bool SampleXenosTexture(const xenos::xe_gpu_texture_fetch_t& fetch,
                        const xe::gpu::ucode::TextureFetchInstruction& instr,
                        const float coords[3], float result[4]) {
  TexelLayout layout;
  g_last_texture_format = uint32_t(fetch.format);
  if (fetch.type != xenos::FetchConstantType::kTexture ||
      (fetch.dimension != xenos::DataDimension::k2DOrStacked &&
       fetch.dimension != xenos::DataDimension::k1D) ||
      !TextureLayout(fetch.format, &layout)) {
    return false;
  }
  const bool is_1d = fetch.dimension == xenos::DataDimension::k1D;
  const int32_t width = int32_t(is_1d ? fetch.size_1d.width + 1 : fetch.size_2d.width + 1);
  const int32_t height = is_1d ? 1 : int32_t(fetch.size_2d.height + 1);
  uint32_t pitch_texels = fetch.pitch << 5;
  if (!pitch_texels) pitch_texels = uint32_t(width);
  uint32_t pitch_blocks = (pitch_texels + layout.block_w - 1) / layout.block_w;
  if (fetch.tiled) pitch_blocks = (pitch_blocks + 31u) & ~31u;
  float u = coords[0], v = coords[1];
  if (!instr.unnormalized_coordinates()) {
    u *= float(width);
    v *= float(height);
  }
  u += instr.offset_x();
  v += instr.offset_y();
  const auto mag = instr.has_mag_filter() ? instr.mag_filter() : fetch.mag_filter;
  const bool linear = mag == xenos::TextureFilter::kLinear;
  float c[4] = {};
  if (!linear) {
    const int32_t x = Wrap(int32_t(std::floor(u)), width, fetch.clamp_x);
    const int32_t y = Wrap(int32_t(std::floor(v)), height, fetch.clamp_y);
    if (!FetchTexel(fetch, layout, pitch_blocks, x, y, c)) return false;
  } else {
    const float fu = u - 0.5f, fv = v - 0.5f;
    const int32_t x0 = int32_t(std::floor(fu)), y0 = int32_t(std::floor(fv));
    const float ax = fu - float(x0), ay = fv - float(y0);
    float t[4][4];
    for (int32_t j = 0; j < 4; ++j) {
      const int32_t x = Wrap(x0 + (j & 1), width, fetch.clamp_x);
      const int32_t y = Wrap(y0 + (j >> 1), height, fetch.clamp_y);
      if (!FetchTexel(fetch, layout, pitch_blocks, x, y, t[j])) return false;
    }
    for (uint32_t k = 0; k < 4; ++k) {
      const float top = t[0][k] * (1 - ax) + t[1][k] * ax;
      const float bottom = t[2][k] * (1 - ax) + t[3][k] * ax;
      c[k] = top * (1 - ay) + bottom * ay;
    }
  }
  if (fetch.exp_adjust) {
    for (uint32_t k = 0; k < 4; ++k) c[k] = std::ldexp(c[k], fetch.exp_adjust);
  }
  // Fetch constant swizzle: 0-3 component, 4 = 0, 5 = 1.
  for (uint32_t i = 0; i < 4; ++i) {
    const uint32_t s = (fetch.swizzle >> (i * 3)) & 7u;
    result[i] = s < 4 ? c[s] : s == 4 ? 0.0f : 1.0f;
  }
  return true;
}

bool RenderXenosDraw(const XenosSoftDraw& draw) {
  RegisterFile& regs = Registers();
  const uint32_t count = std::min<uint32_t>(draw.register_count, RegisterFile::kRegisterCount);
  std::memcpy(regs.values, draw.registers, count * sizeof(uint32_t));
  const auto mode = regs.Get<reg::RB_MODECONTROL>().edram_mode;
  switch (mode) {
    case xenos::EdramMode::kColorDepth:
      return g_rasterize ? RenderPrimitives(draw, false) : true;
    case xenos::EdramMode::kDepthOnly:
      return g_rasterize ? RenderPrimitives(draw, true) : true;
    case xenos::EdramMode::kCopy:
      return Resolve();
    case xenos::EdramMode::kNoOperation:
      return true;
    default:
      return Skip(kSkipEdramMode);
  }
}

void ResetXenosSoftRenderer() {
  std::fill(Edram().begin(), Edram().end(), 0u);
  g_draws_rendered = g_draws_skipped = g_resolves = g_pixels_shaded = 0;
  g_last_skip_reason = g_texture_fetch_failures = g_last_texture_format = 0;
}

}  // namespace render360::xenia_web

namespace rx = render360::xenia_web;
extern "C" {
uint32_t r360_xenos_soft_draws() { return rx::g_draws_rendered; }
uint32_t r360_xenos_soft_set_rasterize(uint32_t on) { rx::g_rasterize = on ? 1u : 0u; return rx::g_rasterize; }
uint32_t r360_xenos_soft_skipped() { return rx::g_draws_skipped; }
uint32_t r360_xenos_soft_resolves() { return rx::g_resolves; }
uint32_t r360_xenos_soft_pixels() { return rx::g_pixels_shaded; }
uint32_t r360_xenos_soft_last_skip() { return rx::g_last_skip_reason; }
uint32_t r360_xenos_soft_texture_failures() { return rx::g_texture_fetch_failures; }
uint32_t r360_xenos_soft_last_texture_format() { return rx::g_last_texture_format; }
}
