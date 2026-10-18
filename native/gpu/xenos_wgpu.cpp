// Native port of render360-webgpu-backend.mjs (XenosWebGpuBackend) onto
// wgpu-native. Method names follow the JavaScript; keep them in step.
//
// Differences from the browser, all because wgpu-native is not a browser:
//  * Xenia's SPIR-V goes to wgpu directly (no Naga-to-WGSL step), so bind
//    group layouts come from reflecting the SPIR-V (ReflectBindings) instead
//    of parsing WGSL text.
//  * Push constants ("immediates") are native, so Xenia's texture_load_* and
//    resolve shaders keep theirs instead of becoming a uniform buffer.
#include "xenos_wgpu.h"

#include <webgpu/webgpu.h>
#include <webgpu/wgpu.h>

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <cstdlib>
#include <map>
#include <string>
#include <unordered_map>
#include <vector>

#include "render360_core.h"

namespace r360gpu {
namespace {

constexpr uint32_t GPU_STREAM_UPLOAD = 1, GPU_STREAM_SHADER = 2, GPU_STREAM_PIPELINE = 3,
                   GPU_STREAM_RENDER_TARGETS = 4, GPU_STREAM_DRAW = 5, GPU_STREAM_SWAP = 6,
                   GPU_STREAM_LOAD_SHADER = 7, GPU_STREAM_TEXTURE = 8, GPU_STREAM_TEXTURE_LOAD = 9,
                   GPU_STREAM_EDRAM_DUMP = 10, GPU_STREAM_RESOLVE = 11, GPU_STREAM_CLEAR = 12;
constexpr uint32_t EDRAM_TILES = 2048, EDRAM_TILE_DWORDS = 80 * 16;
constexpr uint64_t SHARED_MEMORY_BYTES = 512ull * 1024 * 1024;  // Xenia SharedMemory::kBufferSize
constexpr uint64_t STAGING_BYTES = 16ull * 1024 * 1024;
constexpr uint32_t CONSTANT_WINDOW = 4096;
constexpr uint32_t DRAW_HEADER_WORDS = 26;

WGPUStringView S(const char* s) { return WGPUStringView{s, s ? std::strlen(s) : 0}; }
WGPUStringView S(const std::string& s) { return WGPUStringView{s.data(), s.size()}; }
float F(uint32_t w) { float f; std::memcpy(&f, &w, 4); return f; }
bool Is64bpp(uint32_t guest) { return guest == 5 || guest == 7 || guest == 15; }

// WebGpuTextureFormat (webgpu_textures.h).
WGPUTextureFormat TextureFormat(uint32_t i) {
  static const WGPUTextureFormat k[] = {
      WGPUTextureFormat_Undefined, WGPUTextureFormat_R8Unorm, WGPUTextureFormat_R8Snorm, WGPUTextureFormat_RG8Unorm,
      WGPUTextureFormat_RG8Snorm, WGPUTextureFormat_RGBA8Unorm, WGPUTextureFormat_RGBA8Snorm,
      WGPUTextureFormat_RGB10A2Unorm, WGPUTextureFormat_R16Float, WGPUTextureFormat_RG16Float,
      WGPUTextureFormat_RGBA16Float, WGPUTextureFormat_R32Float, WGPUTextureFormat_RG32Float,
      WGPUTextureFormat_RGBA32Float};
  return i < sizeof(k) / sizeof(k[0]) ? k[i] : WGPUTextureFormat_Undefined;
}
bool Unfilterable(WGPUTextureFormat f) {
  return f == WGPUTextureFormat_R32Float || f == WGPUTextureFormat_RG32Float || f == WGPUTextureFormat_RGBA32Float;
}

// xenos::ColorRenderTargetFormat -> host format (colorFormat in the JS).
WGPUTextureFormat ColorFormat(uint32_t guest) {
  switch (guest) {
    case 0: case 1: return WGPUTextureFormat_RGBA8Unorm;
    case 2: case 10: return WGPUTextureFormat_RGB10A2Unorm;
    case 3: case 12: case 5: case 7: return WGPUTextureFormat_RGBA16Float;
    case 4: case 6: return WGPUTextureFormat_RG16Float;
    case 14: return WGPUTextureFormat_R32Float;
    case 15: return WGPUTextureFormat_RG32Float;
    default: return WGPUTextureFormat_RGBA8Unorm;
  }
}
bool Blendable(WGPUTextureFormat f) { return f != WGPUTextureFormat_R32Float && f != WGPUTextureFormat_RG32Float; }

const WGPUCompareFunction COMPARE[] = {WGPUCompareFunction_Never, WGPUCompareFunction_Less, WGPUCompareFunction_Equal,
                                       WGPUCompareFunction_LessEqual, WGPUCompareFunction_Greater,
                                       WGPUCompareFunction_NotEqual, WGPUCompareFunction_GreaterEqual,
                                       WGPUCompareFunction_Always};
const WGPUStencilOperation STENCIL_OP[] = {
    WGPUStencilOperation_Keep, WGPUStencilOperation_Zero, WGPUStencilOperation_Replace,
    WGPUStencilOperation_IncrementClamp, WGPUStencilOperation_DecrementClamp, WGPUStencilOperation_Invert,
    WGPUStencilOperation_IncrementWrap, WGPUStencilOperation_DecrementWrap};

WGPUBlendFactor BlendFactor(uint32_t f, bool alpha) {
  switch (f) {
    case 0: return WGPUBlendFactor_Zero;
    case 1: return WGPUBlendFactor_One;
    case 4: return alpha ? WGPUBlendFactor_SrcAlpha : WGPUBlendFactor_Src;
    case 5: return alpha ? WGPUBlendFactor_OneMinusSrcAlpha : WGPUBlendFactor_OneMinusSrc;
    case 6: return WGPUBlendFactor_SrcAlpha;
    case 7: return WGPUBlendFactor_OneMinusSrcAlpha;
    case 8: return alpha ? WGPUBlendFactor_DstAlpha : WGPUBlendFactor_Dst;
    case 9: return alpha ? WGPUBlendFactor_OneMinusDstAlpha : WGPUBlendFactor_OneMinusDst;
    case 10: return WGPUBlendFactor_DstAlpha;
    case 11: return WGPUBlendFactor_OneMinusDstAlpha;
    case 12: case 14: return WGPUBlendFactor_Constant;
    case 13: case 15: return WGPUBlendFactor_OneMinusConstant;
    case 16: return WGPUBlendFactor_SrcAlphaSaturated;
    default: return WGPUBlendFactor_Zero;
  }
}
const WGPUBlendOperation BLEND_OP[] = {WGPUBlendOperation_Add, WGPUBlendOperation_Subtract, WGPUBlendOperation_Min,
                                       WGPUBlendOperation_Max, WGPUBlendOperation_ReverseSubtract};

// RB_BLENDCONTROL -> blend state; false: replace (blending off).
bool BlendState(uint32_t c, WGPUBlendState* out) {
  const uint32_t cs = c & 31, cop = (c >> 5) & 7, cd = (c >> 8) & 31, as = (c >> 16) & 31, aop = (c >> 21) & 7,
                 ad = (c >> 24) & 31;
  if (cs == 1 && cd == 0 && cop == 0 && as == 1 && ad == 0 && aop == 0) return false;
  auto component = [](uint32_t src, uint32_t op, uint32_t dst, bool alpha) {
    WGPUBlendComponent b{};
    b.operation = op < 5 ? BLEND_OP[op] : WGPUBlendOperation_Add;
    if (b.operation == WGPUBlendOperation_Min || b.operation == WGPUBlendOperation_Max) {
      b.srcFactor = b.dstFactor = WGPUBlendFactor_One;  // WebGPU min/max require one
    } else {
      b.srcFactor = BlendFactor(src, alpha);
      b.dstFactor = BlendFactor(dst, alpha);
    }
    return b;
  };
  out->color = component(cs, cop, cd, false);
  out->alpha = component(as, aop, ad, true);
  return true;
}

// --- SPIR-V reflection (what parseWgslBindings reads from Naga's WGSL) -------

struct Binding {
  uint32_t group = 0, binding = 0;
  enum Kind { kStorage, kUniform, kSampler, kTexture, kUnknown } kind = kUnknown;
  bool write = false, comparison = false;
  WGPUTextureViewDimension view = WGPUTextureViewDimension_2D;
  WGPUTextureSampleType sample = WGPUTextureSampleType_Float;
};

std::vector<Binding> ReflectBindings(const uint32_t* w, size_t n) {
  std::unordered_map<uint32_t, uint32_t> set, bind, var_type, var_class, ptr_pointee, load_of, si_sampler, si_image;
  std::unordered_map<uint32_t, bool> buffer_block;
  std::unordered_map<uint32_t, bool> nonwritable_var, nonwritable_struct, depth_image, sampler_type, dref_sampler,
      dref_image;
  struct Img { uint32_t sampled, dim, depth, arrayed; };
  std::unordered_map<uint32_t, Img> images;
  std::unordered_map<uint32_t, uint32_t> int_sign, array_elem;  // int type -> signedness; array -> element
  std::unordered_map<uint32_t, bool> float_type;
  std::vector<uint32_t> vars;
  for (size_t i = 5; i < n;) {
    const uint32_t count = w[i] >> 16, op = w[i] & 0xFFFF;
    if (!count || i + count > n) break;
    const uint32_t* a = w + i + 1;
    switch (op) {
      case 71:  // OpDecorate
        if (a[1] == 34) set[a[0]] = a[2];
        else if (a[1] == 33) bind[a[0]] = a[2];
        else if (a[1] == 24) nonwritable_var[a[0]] = true;
        else if (a[1] == 3) buffer_block[a[0]] = true;  // BufferBlock: storage buffer (SPIR-V 1.0 style)
        break;
      case 72:  // OpMemberDecorate NonWritable on a block member
        if (a[2] == 24) nonwritable_struct[a[0]] = true;
        break;
      case 21: int_sign[a[0]] = a[2]; break;          // OpTypeInt
      case 22: float_type[a[0]] = true; break;        // OpTypeFloat
      case 25: images[a[0]] = {a[1], a[2], a[3], a[4]}; break;  // OpTypeImage
      case 26: sampler_type[a[0]] = true; break;      // OpTypeSampler
      case 28: case 29: array_elem[a[0]] = a[1]; break;  // OpTypeArray / RuntimeArray
      case 32: ptr_pointee[a[0]] = a[2]; break;       // OpTypePointer
      case 59:                                        // OpVariable
        var_type[a[1]] = a[0];
        var_class[a[1]] = a[2];
        vars.push_back(a[1]);
        break;
      case 61: load_of[a[1]] = a[2]; break;           // OpLoad
      case 86: si_image[a[1]] = a[2]; si_sampler[a[1]] = a[3]; break;  // OpSampledImage
      case 89: case 90: case 91: case 92: case 97: {  // Dref sampling / gather
        const uint32_t sampled_image = a[2];
        if (si_sampler.count(sampled_image)) {
          dref_sampler[load_of[si_sampler[sampled_image]]] = true;
          dref_image[load_of[si_image[sampled_image]]] = true;
        }
        break;
      }
    }
    i += count;
  }
  std::vector<Binding> out;
  for (uint32_t v : vars) {
    if (!set.count(v) || !bind.count(v)) continue;
    Binding b;
    b.group = set[v];
    b.binding = bind[v];
    uint32_t t = ptr_pointee[var_type[v]];
    while (array_elem.count(t)) t = array_elem[t];
    const uint32_t cls = var_class[v];
    if (cls == 12 || (cls == 2 && buffer_block[t])) {
      b.kind = Binding::kStorage;
      b.write = !nonwritable_var[v] && !nonwritable_struct[t];
    } else if (cls == 2) {
      b.kind = Binding::kUniform;
    } else if (sampler_type.count(t)) {
      b.kind = Binding::kSampler;
      b.comparison = dref_sampler[v];
    } else if (images.count(t)) {
      const Img& img = images[t];
      b.kind = Binding::kTexture;
      switch (img.dim) {
        case 0: b.view = WGPUTextureViewDimension_1D; break;
        case 2: b.view = WGPUTextureViewDimension_3D; break;
        case 3: b.view = img.arrayed ? WGPUTextureViewDimension_CubeArray : WGPUTextureViewDimension_Cube; break;
        default: b.view = img.arrayed ? WGPUTextureViewDimension_2DArray : WGPUTextureViewDimension_2D; break;
      }
      if (img.depth == 1 || dref_image[v]) b.sample = WGPUTextureSampleType_Depth;
      else if (int_sign.count(img.sampled)) b.sample = int_sign[img.sampled] ? WGPUTextureSampleType_Sint : WGPUTextureSampleType_Uint;
      else b.sample = WGPUTextureSampleType_Float;
    }
    out.push_back(b);
  }
  return out;
}

// SPIR-V without NonReadable decorations (stripNonReadable).
std::vector<uint32_t> StripNonReadable(const uint32_t* w, size_t n) {
  std::vector<uint32_t> out(w, w + std::min<size_t>(n, 5));
  for (size_t i = 5; i < n;) {
    const uint32_t count = w[i] >> 16, op = w[i] & 0xFFFF;
    if (!count) break;
    const bool drop = (op == 71 && w[i + 2] == 25) || (op == 72 && w[i + 3] == 25);
    if (!drop) out.insert(out.end(), w + i, w + std::min(n, i + count));
    i += count;
  }
  return out;
}

// --- WGSL of the passes the JavaScript writes itself --------------------------

std::string ExpandShader(uint32_t mode) {
  const std::string head = "@group(0) @binding(0) var<storage, read_write> src: array<u32>;\n";
  const std::string index = "let i = id.x + id.y * 65535u * 64u; if (i >= arrayLength(&src)) { return; }";
  if (mode >= 5) {
    const std::string conv = mode == 5
        ? "vec2<f32>(f32(v & 0xFFFFu), f32(v >> 16u)) / 65535.0"
        : "max(vec2<f32>(f32((bitcast<i32>(v) << 16u) >> 16u), f32(bitcast<i32>(v) >> 16u)) / 32767.0, vec2<f32>(-1.0))";
    return head + "@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3<u32>) {\n  " + index +
           " let v = src[i]; src[i] = pack2x16float(" + conv + "); }";
  }
  const char* unpack[] = {
      "",
      "vec4<f32>(f32(t & 31u) / 31.0, f32((t >> 5u) & 63u) / 63.0, f32((t >> 11u) & 31u) / 31.0, 1.0)",
      "vec4<f32>(f32(t & 31u) / 31.0, f32((t >> 10u) & 63u) / 63.0, f32((t >> 5u) & 31u) / 31.0, 1.0)",
      "vec4<f32>(f32(t & 31u) / 31.0, f32((t >> 5u) & 31u) / 31.0, f32((t >> 10u) & 31u) / 31.0, f32(t >> 15u))",
      "vec4<f32>(f32(t & 15u), f32((t >> 4u) & 15u), f32((t >> 8u) & 15u), f32(t >> 12u)) / 15.0"};
  return head + "@group(0) @binding(1) var<storage, read_write> dst: array<u32>;\nfn texel(t: u32) -> u32 { return pack4x8unorm(" +
         unpack[mode] + "); }\n@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3<u32>) {\n  " +
         index + " let v = src[i]; dst[2u * i] = texel(v & 0xFFFFu); dst[2u * i + 1u] = texel(v >> 16u); }";
}

const char* CLEAR_SHADER = R"(@group(0) @binding(0) var<uniform> value: vec4<f32>;
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4<f32> {
  return vec4<f32>(f32(i == 1u) * 4.0 - 1.0, f32(i == 2u) * 4.0 - 1.0, 0.0, 1.0);
}
@fragment fn fs_color() -> @location(0) vec4<f32> { return value; }
@fragment fn fs_depth() -> @builtin(frag_depth) f32 { return value.x; })";

std::string EdramDumpShader(bool depth) {
  std::string s = R"(struct Dump {
  base_tiles: u32, pitch_tiles: u32, msaa: u32, format: u32,
  x0: u32, y0: u32, width: u32, height: u32, is_64bpp: u32, depth_float32: u32, pad0: u32, pad1: u32,
}
@group(0) @binding(0) var<storage, read_write> edram: array<u32>;
@group(0) @binding(1) var<uniform> dump: Dump;
)";
  s += depth ? "@group(0) @binding(2) var depth_texture: texture_depth_2d;\n@group(0) @binding(3) var stencil_texture: texture_2d<u32>;\n"
             : "@group(0) @binding(2) var color_texture: texture_2d<f32>;\n";
  s += R"(
fn edram_offset_dwords(pixel: vec2<u32>, sample: u32) -> u32 {
  var s = pixel << vec2<u32>(select(0u, 1u, dump.msaa >= 2u), select(0u, 1u, dump.msaa >= 1u));
  s += (vec2<u32>(sample) >> vec2<u32>(1u, 0u)) & vec2<u32>(1u);
  let ints_log2 = dump.is_64bpp;
  let tile_size = vec2<u32>(80u >> ints_log2, 16u);
  let tile = s / tile_size;
  var base = dump.base_tiles + tile.y * dump.pitch_tiles + tile.x;
  s -= tile * tile_size;
)";
  if (depth) s += "  let half = tile_size.x >> 1u;\n  s.x = select(s.x + half, s.x - half, s.x >= half);\n";
  s += R"(  let address = base * 1280u + ((s.y * tile_size.x + s.x) << ints_log2);
  return address % (1280u * 2048u);
}
fn f32_to_7e3(f: f32) -> u32 {
  if (!(f > 0.0)) { return 0u; }
  var u = bitcast<u32>(f);
  if (u >= 0x41FF8000u) { return 0x3FFu; }
  if (u < 0x3E800000u) {
    let shift = min(125u - (u >> 23u), 24u);
    u = (0x800000u | (u & 0x7FFFFFu)) >> shift;
  } else {
    u += 0xC2000000u;
  }
  u += 0x7FFFu + ((u >> 16u) & 1u);
  return (u >> 16u) & 0x3FFu;
}
fn f32_to_20e4(f: f32) -> u32 {
  if (!(f > 0.0)) { return 0u; }
  var u = bitcast<u32>(f);
  if (u >= 0x3FFFFFF8u) { return 0xFFFFFFu; }
  if (u < 0x38800000u) {
    let shift = min(113u - (u >> 23u), 24u);
    u = (0x800000u | (u & 0x7FFFFFu)) >> shift;
  } else {
    u += 0xC8000000u;
  }
  u += 3u + ((u >> 3u) & 1u);
  return (u >> 3u) & 0xFFFFFFu;
}
fn s16(f: f32) -> u32 { return u32(i32(round(clamp(f, -1.0, 1.0) * 32767.0))) & 0xFFFFu; }
fn to_unorm(f: f32, bits: u32) -> u32 { let m = f32((1u << bits) - 1u); return u32(round(clamp(f, 0.0, 1.0) * m)); }

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= dump.width || id.y >= dump.height) { return; }
  let pixel = vec2<u32>(dump.x0 + id.x, dump.y0 + id.y);
  var lo = 0u;
  var hi = 0u;
)";
  if (depth) {
    s += R"(  let d = textureLoad(depth_texture, vec2<i32>(pixel), 0);
  let stencil = textureLoad(stencil_texture, vec2<i32>(pixel), 0).x & 0xFFu;
  let d24 = select(u32(round(clamp(d, 0.0, 1.0) * 16777215.0)), f32_to_20e4(d * 2.0), dump.format == 1u);
  lo = (d24 << 8u) | stencil;
)";
  } else {
    s += R"(  let c = textureLoad(color_texture, vec2<i32>(pixel), 0);
  switch dump.format {
    case 0u, 1u: { lo = pack4x8unorm(c); }
    case 2u, 10u: { lo = to_unorm(c.x, 10u) | (to_unorm(c.y, 10u) << 10u) | (to_unorm(c.z, 10u) << 20u) | (to_unorm(c.w, 2u) << 30u); }
    case 3u, 12u: { lo = f32_to_7e3(c.x) | (f32_to_7e3(c.y) << 10u) | (f32_to_7e3(c.z) << 20u) | (to_unorm(c.w, 2u) << 30u); }
    case 4u: { lo = s16(c.x) | (s16(c.y) << 16u); }
    case 5u: { lo = s16(c.x) | (s16(c.y) << 16u); hi = s16(c.z) | (s16(c.w) << 16u); }
    case 6u: { lo = pack2x16float(c.xy); }
    case 7u: { lo = pack2x16float(c.xy); hi = pack2x16float(c.zw); }
    case 14u: { lo = bitcast<u32>(c.x); }
    case 15u: { lo = bitcast<u32>(c.x); hi = bitcast<u32>(c.y); }
    default: { lo = pack4x8unorm(c); }
  }
)";
  }
  s += R"(  let samples = select(select(1u, 2u, dump.msaa == 1u), 4u, dump.msaa >= 2u);
  for (var s = 0u; s < samples; s++) {
    let o = edram_offset_dwords(pixel, s);
    edram[o] = lo;
    if (dump.is_64bpp != 0u) { edram[o + 1u] = hi; }
  }
})";
  return s;
}

// Present: front buffer with the swap fetch constant's swizzle, aspect fit
// via the viewport.
const char* PRESENT_SHADER = R"(struct Out { @builtin(position) position: vec4<f32>, @location(0) uv: vec2<f32> }
@vertex fn vs(@builtin(vertex_index) i: u32) -> Out {
  let p = vec2<f32>(f32(i == 1u) * 4.0 - 1.0, f32(i == 2u) * 4.0 - 1.0);
  return Out(vec4<f32>(p, 0.0, 1.0), vec2<f32>(p.x * 0.5 + 0.5, 0.5 - p.y * 0.5));
}
@group(0) @binding(0) var front: texture_2d_array<f32>;
@group(0) @binding(1) var front_sampler: sampler;
@group(0) @binding(2) var<uniform> swizzle: vec4<u32>;
fn component(t: vec4<f32>, s: u32) -> f32 {
  if (s >= 5u) { return 1.0; }
  if (s == 4u) { return 0.0; }
  return t[s];
}
@fragment fn fs(i: Out) -> @location(0) vec4<f32> {
  let t = textureSample(front, front_sampler, i.uv, 0);
  let s = swizzle.x;
  return vec4<f32>(component(t, s & 7u), component(t, (s >> 3u) & 7u), component(t, (s >> 6u) & 7u), 1.0);
})";

// --- helpers ------------------------------------------------------------------

float Float7e3To32(uint32_t f10) {
  f10 &= 0x3FF;
  if (!f10) return 0;
  int mantissa = f10 & 0x7F, exponent = f10 >> 7;
  if (!exponent) {
    const int lz = 7 - (31 - __builtin_clz(uint32_t(mantissa)));
    exponent = 1 - lz;
    mantissa = (mantissa << lz) & 0x7F;
  }
  return F(uint32_t(((exponent + 124) << 23) | (mantissa << 16)));
}
float Float20e4To32(uint32_t f24) {
  f24 &= 0xFFFFFF;
  if (!f24) return 0;
  int mantissa = f24 & 0xFFFFF, exponent = f24 >> 20;
  if (!exponent) {
    const int lz = 20 - (31 - __builtin_clz(uint32_t(mantissa)));
    exponent = 1 - lz;
    mantissa = (mantissa << lz) & 0xFFFFF;
  }
  return F(uint32_t(((exponent + 112) << 23) | (mantissa << 3)));
}
float HalfToFloat(uint32_t h) {
  const float s = (h & 0x8000) ? -1.f : 1.f;
  const int e = (h >> 10) & 31, m = h & 1023;
  if (!e) return s * m * std::ldexp(1.f, -24);
  if (e == 31) return m ? NAN : s * INFINITY;
  return s * (1 + m / 1024.f) * std::ldexp(1.f, e - 15);
}
WGPUColor ColorClearValue(uint32_t format, uint32_t lo, uint32_t hi) {
  const uint64_t v = uint64_t(lo) | (uint64_t(hi) << 32);
  auto bits = [&](int shift, int n) { return uint32_t((v >> shift) & ((1ull << n) - 1)); };
  auto s16 = [](uint32_t x) { return std::max(double(int16_t(x)) / 32767.0, -1.0); };
  switch (format) {
    case 0: case 1: return {bits(0, 8) / 255.0, bits(8, 8) / 255.0, bits(16, 8) / 255.0, bits(24, 8) / 255.0};
    case 2: case 10: return {bits(0, 10) / 1023.0, bits(10, 10) / 1023.0, bits(20, 10) / 1023.0, bits(30, 2) / 3.0};
    case 3: case 12: return {Float7e3To32(bits(0, 10)), Float7e3To32(bits(10, 10)), Float7e3To32(bits(20, 10)), bits(30, 2) / 3.0};
    case 4: return {s16(bits(0, 16)), s16(bits(16, 16)), 0, 0};
    case 5: return {s16(bits(0, 16)), s16(bits(16, 16)), s16(bits(32, 16)), s16(bits(48, 16))};
    case 6: return {HalfToFloat(bits(0, 16)), HalfToFloat(bits(16, 16)), 0, 0};
    case 7: return {HalfToFloat(bits(0, 16)), HalfToFloat(bits(16, 16)), HalfToFloat(bits(32, 16)), HalfToFloat(bits(48, 16))};
    case 14: return {F(lo), 0, 0, 0};
    case 15: return {F(lo), F(hi), 0, 0};
    default: return {0, 0, 0, 0};
  }
}

// A CPU ring written to a GPU buffer in one writeBuffer on flush (XenosRing).
struct Ring {
  WGPUBuffer buffer = nullptr;
  std::vector<uint8_t> cpu;
  uint64_t offset = 0, size = 0, limit = 0;
  uint32_t align = 4;
  bool Fits(uint64_t bytes) const { return offset + ((bytes + align - 1) & ~uint64_t(align - 1)) <= limit; }
  uint32_t Push(const void* data, uint64_t bytes) {
    const uint64_t at = offset;
    std::memcpy(cpu.data() + at, data, bytes);
    offset = at + ((bytes + align - 1) & ~uint64_t(align - 1));
    return uint32_t(at);
  }
  void Flush(WGPUQueue queue) {
    if (offset) wgpuQueueWriteBuffer(queue, buffer, 0, cpu.data(), offset);
    offset = 0;
  }
};

struct Shader {
  uint32_t id = 0, stage = 0;
  std::vector<uint32_t> textures, samplers;
  std::vector<Binding> bindings;
  WGPUShaderModule module = nullptr;
  std::string error;
};

struct GroupLayout {
  std::string key;
  WGPUBindGroupLayout layout = nullptr;
  std::vector<WGPUBindGroupLayoutEntry> entries;
  WGPUBindGroup group = nullptr;  // placeholder / constant group
};

struct PipelineDescription {
  uint32_t vertex_shader, pixel_shader, topology, cull_mode, front_face_cw, depth_compare, depth_write, stencil,
      stencil_masks, color_formats[4], color_write_masks, blend_control[4], depth_format, msaa_samples;
};

struct Pipeline {
  PipelineDescription d{};
  WGPURenderPipeline pipeline = nullptr;
  GroupLayout* layouts[4] = {};
  std::string error;
};

struct RenderTargetsKey {
  uint32_t surface_pitch = 0, msaa = 0, height = 0, color_base[4]{}, color_format[4]{}, depth_base = 0,
           depth_format = 0;
};

struct Target {
  std::string key;
  uint32_t base = 0, guest_format = 0, msaa = 0, width = 0, height = 0;
  bool depth = false, initialized = false, is64bpp = false;
  uint32_t tile_width = 0, tile_height = 0, pitch_tiles = 0;
  WGPUTexture texture = nullptr;
  WGPUTextureView view = nullptr;
  WGPUTextureFormat format = WGPUTextureFormat_Undefined;
};

struct Texture {
  uint32_t id = 0, dimension = 0, width = 0, height = 0;
  WGPUTexture texture = nullptr;
  WGPUTextureFormat format = WGPUTextureFormat_Undefined;
  std::map<WGPUTextureViewDimension, WGPUTextureView> views;
};

struct LoadShader {
  WGPUComputePipeline pipeline = nullptr;
  WGPUBindGroupLayout layouts[2] = {};
  uint32_t immediate_size = 0;
  std::string error;
};

class BackendImpl final : public Backend {
 public:
  WGPUInstance instance_ = nullptr;
  WGPUAdapter adapter_ = nullptr;
  WGPUDevice device_ = nullptr;
  WGPUQueue queue_ = nullptr;
  WGPUSurface surface_ = nullptr;
  WGPUTextureFormat surface_format_ = WGPUTextureFormat_BGRA8Unorm;
  uint32_t surface_w_ = 0, surface_h_ = 0;
  std::string adapter_name_, last_error_;
  Stats stats_;
  bool float32_filterable_ = false, depth32_stencil8_ = false;
  uint64_t shared_memory_bytes_ = SHARED_MEMORY_BYTES;
  uint32_t uniform_align_ = 256;

  WGPUBuffer shared_memory_ = nullptr, staging_ = nullptr, edram_ = nullptr;
  uint64_t staging_offset_ = 0;
  WGPUCommandEncoder encoder_ = nullptr;
  WGPURenderPassEncoder pass_ = nullptr;
  struct { WGPURenderPipeline pipeline = nullptr; WGPUBindGroup groups[4] = {}; } pass_state_;
  uint32_t pass_w_ = 0, pass_h_ = 0;
  Ring uniforms_, indices_;
  std::unordered_map<uint32_t, Shader> shaders_;
  std::unordered_map<uint32_t, Pipeline> pipelines_;
  std::map<std::string, std::unique_ptr<GroupLayout>> layouts_;
  std::map<std::string, void*> placeholders_;  // key -> WGPUSampler / WGPUTextureView
  std::map<std::string, std::unique_ptr<Target>> targets_;
  RenderTargetsKey bound_{};
  bool have_bound_ = false;
  std::unordered_map<uint32_t, LoadShader> load_shaders_;
  std::unordered_map<uint32_t, Texture> textures_;
  std::unordered_map<uint32_t, WGPUSampler> samplers_;
  std::unordered_map<std::string, WGPUBindGroup> texture_groups_;
  WGPUBuffer scratch_ = nullptr;
  uint64_t scratch_size_ = 0;
  std::vector<WGPUBuffer> scratch_retired_;
  std::vector<Target*> tile_owner_ = std::vector<Target*>(EDRAM_TILES, nullptr);
  Texture* front_ = nullptr;
  uint32_t front_swizzle_ = 0x688;
  std::map<uint32_t, WGPUComputePipeline> expand_pipelines_;
  WGPUComputePipeline dump_pipelines_[2] = {};
  std::map<std::pair<WGPUTextureFormat, bool>, WGPURenderPipeline> clear_pipelines_;
  WGPUBindGroupLayout clear_layout_ = nullptr;
  WGPUBindGroup clear_group_ = nullptr;
  WGPURenderPipeline present_pipeline_ = nullptr;
  WGPUBuffer present_swizzle_ = nullptr;
  WGPUSampler present_sampler_ = nullptr;

  ~BackendImpl() override {
    if (device_) wgpuDeviceRelease(device_);
    if (instance_) wgpuInstanceRelease(instance_);
  }

  uint32_t swaps() const override { return uint32_t(stats_.swaps); }
  const Stats& stats() const override { return stats_; }
  std::string last_error() const override { return last_error_; }
  std::string adapter_name() const override { return adapter_name_; }

  void NoteError(const std::string& e) {
    ++stats_.errors;
    if (stats_.errors <= 20) std::fprintf(stderr, "R360_WGPU error: %s\n", e.c_str());
    last_error_ = e;
  }

  WGPUBuffer MakeBuffer(const char* label, uint64_t size, WGPUBufferUsage usage) {
    WGPUBufferDescriptor d = WGPU_BUFFER_DESCRIPTOR_INIT;
    d.label = S(label);
    d.size = size;
    d.usage = usage;
    return wgpuDeviceCreateBuffer(device_, &d);
  }

  WGPUShaderModule WgslModule(const std::string& code, const char* label) {
    WGPUShaderSourceWGSL src = WGPU_SHADER_SOURCE_WGSL_INIT;
    src.code = S(code);
    WGPUShaderModuleDescriptor d = WGPU_SHADER_MODULE_DESCRIPTOR_INIT;
    d.nextInChain = &src.chain;
    d.label = S(label);
    return wgpuDeviceCreateShaderModule(device_, &d);
  }
  WGPUShaderModule SpirvModule(const uint32_t* words, size_t count, const char* label) {
    WGPUShaderSourceSPIRV src = WGPU_SHADER_SOURCE_SPIRV_INIT;
    src.codeSize = uint32_t(count);
    src.code = words;
    WGPUShaderModuleDescriptor d = WGPU_SHADER_MODULE_DESCRIPTOR_INIT;
    d.nextInChain = &src.chain;
    d.label = S(label);
    return wgpuDeviceCreateShaderModule(device_, &d);
  }

  // Errors raised inside a scope are returned instead of reaching the
  // uncaptured-error handler (createRenderPipeline's throw in the JS).
  void PushScope() { wgpuDevicePushErrorScope(device_, WGPUErrorFilter_Validation); }
  std::string PopScope() {
    struct R { std::string message; bool done = false; } r;
    WGPUPopErrorScopeCallbackInfo info = WGPU_POP_ERROR_SCOPE_CALLBACK_INFO_INIT;
    info.mode = WGPUCallbackMode_AllowProcessEvents;
    info.callback = [](WGPUPopErrorScopeStatus, WGPUErrorType type, WGPUStringView message, void* u, void*) {
      auto* r = static_cast<R*>(u);
      if (type != WGPUErrorType_NoError) r->message.assign(message.data ? message.data : "", message.data ? message.length : 0);
      r->done = true;
    };
    info.userdata1 = &r;
    wgpuDevicePopErrorScope(device_, info);
    while (!r.done) wgpuInstanceProcessEvents(instance_);
    return r.message;
  }

  bool Init(void* metal_layer, std::string* error) {
    WGPUInstanceDescriptor id = WGPU_INSTANCE_DESCRIPTOR_INIT;
    instance_ = wgpuCreateInstance(&id);
    if (!instance_) { *error = "wgpuCreateInstance failed"; return false; }
    if (metal_layer) {
      WGPUSurfaceSourceMetalLayer src = WGPU_SURFACE_SOURCE_METAL_LAYER_INIT;
      src.layer = metal_layer;
      WGPUSurfaceDescriptor sd = WGPU_SURFACE_DESCRIPTOR_INIT;
      sd.nextInChain = &src.chain;
      surface_ = wgpuInstanceCreateSurface(instance_, &sd);
    }
    WGPURequestAdapterOptions ao = WGPU_REQUEST_ADAPTER_OPTIONS_INIT;
    ao.powerPreference = WGPUPowerPreference_HighPerformance;
    ao.compatibleSurface = surface_;
    struct A { WGPUAdapter adapter = nullptr; std::string message; bool done = false; } a;
    WGPURequestAdapterCallbackInfo ai = WGPU_REQUEST_ADAPTER_CALLBACK_INFO_INIT;
    ai.mode = WGPUCallbackMode_AllowProcessEvents;
    ai.callback = [](WGPURequestAdapterStatus, WGPUAdapter adapter, WGPUStringView m, void* u, void*) {
      auto* a = static_cast<A*>(u);
      a->adapter = adapter;
      if (m.data) a->message.assign(m.data, m.length);
      a->done = true;
    };
    ai.userdata1 = &a;
    wgpuInstanceRequestAdapter(instance_, &ao, ai);
    while (!a.done) wgpuInstanceProcessEvents(instance_);
    if (!a.adapter) { *error = "no GPU adapter: " + a.message; return false; }
    adapter_ = a.adapter;
    WGPUAdapterInfo info = WGPU_ADAPTER_INFO_INIT;
    wgpuAdapterGetInfo(adapter_, &info);
    if (info.device.data) adapter_name_.assign(info.device.data, info.device.length);
    wgpuAdapterInfoFreeMembers(info);

    WGPULimits limits = WGPU_LIMITS_INIT;
    wgpuAdapterGetLimits(adapter_, &limits);
    float32_filterable_ = wgpuAdapterHasFeature(adapter_, WGPUFeatureName_Float32Filterable);
    depth32_stencil8_ = wgpuAdapterHasFeature(adapter_, WGPUFeatureName_Depth32FloatStencil8);
    std::vector<WGPUFeatureName> features;
    if (float32_filterable_) features.push_back(WGPUFeatureName_Float32Filterable);
    if (depth32_stencil8_) features.push_back(WGPUFeatureName_Depth32FloatStencil8);
    features.push_back(WGPUFeatureName(WGPUNativeFeature_Immediates));
    if (wgpuAdapterHasFeature(adapter_, WGPUFeatureName(WGPUNativeFeature_TextureFormat16bitNorm)))
      features.push_back(WGPUFeatureName(WGPUNativeFeature_TextureFormat16bitNorm));
    // Shared memory: Xenia's 512 MiB or the largest power of two allowed
    // (sharedMemoryBytesForLimits).
    const uint64_t max_buffer = std::min<uint64_t>(limits.maxBufferSize, limits.maxStorageBufferBindingSize);
    while (shared_memory_bytes_ > max_buffer) shared_memory_bytes_ /= 2;
    WGPULimits required = limits;  // everything the adapter offers
    required.maxImmediateSize = std::max<uint32_t>(limits.maxImmediateSize, 128);
    uniform_align_ = limits.minUniformBufferOffsetAlignment ? limits.minUniformBufferOffsetAlignment : 256;

    WGPUDeviceDescriptor dd = WGPU_DEVICE_DESCRIPTOR_INIT;
    dd.label = S("Render360 Xenos");
    dd.requiredFeatureCount = features.size();
    dd.requiredFeatures = features.data();
    dd.requiredLimits = &required;
    dd.uncapturedErrorCallbackInfo.callback = [](WGPUDevice const*, WGPUErrorType, WGPUStringView m, void* u, void*) {
      static_cast<BackendImpl*>(u)->NoteError(std::string(m.data ? m.data : "", m.data ? m.length : 0));
    };
    dd.uncapturedErrorCallbackInfo.userdata1 = this;
    struct D { WGPUDevice device = nullptr; std::string message; bool done = false; } d;
    WGPURequestDeviceCallbackInfo di = WGPU_REQUEST_DEVICE_CALLBACK_INFO_INIT;
    di.mode = WGPUCallbackMode_AllowProcessEvents;
    di.callback = [](WGPURequestDeviceStatus, WGPUDevice device, WGPUStringView m, void* u, void*) {
      auto* d = static_cast<D*>(u);
      d->device = device;
      if (m.data) d->message.assign(m.data, m.length);
      d->done = true;
    };
    di.userdata1 = &d;
    wgpuAdapterRequestDevice(adapter_, &dd, di);
    while (!d.done) wgpuInstanceProcessEvents(instance_);
    if (!d.device) { *error = "no GPU device: " + d.message; return false; }
    device_ = d.device;
    queue_ = wgpuDeviceGetQueue(device_);

    shared_memory_ = MakeBuffer("Render360 shared memory", shared_memory_bytes_,
                                WGPUBufferUsage_Storage | WGPUBufferUsage_CopyDst | WGPUBufferUsage_CopySrc);
    staging_ = MakeBuffer("Render360 upload staging", STAGING_BYTES, WGPUBufferUsage_CopySrc | WGPUBufferUsage_CopyDst);
    edram_ = MakeBuffer("Render360 EDRAM", uint64_t(EDRAM_TILES) * EDRAM_TILE_DWORDS * 4,
                        WGPUBufferUsage_Storage | WGPUBufferUsage_CopySrc | WGPUBufferUsage_CopyDst);
    uniforms_.size = 8ull * 1024 * 1024 + CONSTANT_WINDOW;
    uniforms_.limit = 8ull * 1024 * 1024;
    uniforms_.align = uniform_align_;
    uniforms_.cpu.resize(uniforms_.size);
    uniforms_.buffer = MakeBuffer("Render360 constants", uniforms_.size, WGPUBufferUsage_Uniform | WGPUBufferUsage_CopyDst);
    indices_.size = indices_.limit = 8ull * 1024 * 1024;
    indices_.cpu.resize(indices_.size);
    indices_.buffer = MakeBuffer("Render360 indices", indices_.size, WGPUBufferUsage_Index | WGPUBufferUsage_CopyDst);
    return true;
  }

  WGPUCommandEncoder Encoder() {
    if (!encoder_) {
      WGPUCommandEncoderDescriptor d = WGPU_COMMAND_ENCODER_DESCRIPTOR_INIT;
      encoder_ = wgpuDeviceCreateCommandEncoder(device_, &d);
    }
    return encoder_;
  }

  void Submit() {
    EndPass();
    uniforms_.Flush(queue_);
    indices_.Flush(queue_);
    if (encoder_) {
      WGPUCommandBufferDescriptor d = WGPU_COMMAND_BUFFER_DESCRIPTOR_INIT;
      WGPUCommandBuffer cmd = wgpuCommandEncoderFinish(encoder_, &d);
      wgpuQueueSubmit(queue_, 1, &cmd);
      wgpuCommandBufferRelease(cmd);
      wgpuCommandEncoderRelease(encoder_);
      encoder_ = nullptr;
      ++stats_.submits;
    }
    for (WGPUBuffer b : scratch_retired_) { wgpuBufferDestroy(b); wgpuBufferRelease(b); }
    scratch_retired_.clear();
    staging_offset_ = 0;
  }

  void EndPass() {
    if (pass_) {
      wgpuRenderPassEncoderEnd(pass_);
      wgpuRenderPassEncoderRelease(pass_);
      pass_ = nullptr;
    }
  }

  void ReplayCore() override {
    const uint32_t count = r360_gpu_stream_words();
    if (!count) return;
    ReplayWords(reinterpret_cast<const uint32_t*>(r360_gpu_stream_data()), count);
    r360_gpu_stream_reset();
  }

  void ReplayWords(const uint32_t* words, size_t count) override {
    for (size_t i = 0; i < count;) {
      const uint32_t op = words[i] & 0xFF, n = words[i] >> 8;
      if (i + 1 + n > count) break;
      const uint32_t* p = words + i + 1;
      switch (op) {
        case GPU_STREAM_UPLOAD: Upload(p[0], p[1], reinterpret_cast<const uint8_t*>(p + 2)); break;
        case GPU_STREAM_SHADER: DefineShader(p, n); break;
        case GPU_STREAM_PIPELINE: DefinePipeline(p, n); break;
        case GPU_STREAM_RENDER_TARGETS: EndPass(); ParseRenderTargets(p); break;
        case GPU_STREAM_DRAW: Draw(p, n); break;
        case GPU_STREAM_SWAP: {
          ++stats_.swaps;
          auto it = n > 6 ? textures_.find(p[6]) : textures_.end();
          front_ = it == textures_.end() ? nullptr : &it->second;
          front_swizzle_ = n > 7 ? p[7] : 0x688;
          Submit();
          break;
        }
        case GPU_STREAM_EDRAM_DUMP: DumpEdram(p); break;
        case GPU_STREAM_RESOLVE: Resolve(p); break;
        case GPU_STREAM_CLEAR: Clear(p); break;
        case GPU_STREAM_LOAD_SHADER: DefineLoadShader(p, n); break;
        case GPU_STREAM_TEXTURE: DefineTexture(p); break;
        case GPU_STREAM_TEXTURE_LOAD: LoadTexture(p, n); break;
        default:
          NoteError("unknown GPU stream op " + std::to_string(op));
          return;
      }
      i += 1 + n;
    }
  }

  void DefineShader(const uint32_t* p, uint32_t n) {
    Shader s;
    s.id = p[0];
    s.stage = p[1];
    const uint32_t tc = p[2], sc = p[3], words = p[4];
    s.textures.assign(p + 5, p + 5 + tc);
    s.samplers.assign(p + 5 + tc, p + 5 + tc + sc);
    const uint32_t* spirv = p + 5 + tc + sc;
    if (5 + tc + sc + words > n) { s.error = "truncated"; shaders_[s.id] = s; return; }
    s.bindings = ReflectBindings(spirv, words);
    // Xenia sets OpExecutionMode EarlyFragmentTests on pixel shaders without
    // depth writes or kills; wgpu rejects the capability. It is only a hint:
    // Metal tests depth early by itself for such shaders.
    std::vector<uint32_t> code;
    code.reserve(words);
    code.insert(code.end(), spirv, spirv + std::min<uint32_t>(words, 5));
    for (uint32_t i = 5; i < words;) {
      const uint32_t count = spirv[i] >> 16, op = spirv[i] & 0xFFFF;
      if (!count || i + count > words) break;
      if (!(op == 16 && count >= 3 && spirv[i + 2] == 9)) code.insert(code.end(), spirv + i, spirv + i + count);
      i += count;
    }
    PushScope();
    char label[64];
    std::snprintf(label, sizeof(label), "Xenos %s shader %u", s.stage ? "pixel" : "vertex", s.id);
    s.module = SpirvModule(code.data(), code.size(), label);
    s.error = PopScope();
    if (!s.error.empty()) {
      ++stats_.shader_failures;
      if (stats_.shader_failures <= 5) std::fprintf(stderr, "R360_WGPU shader %u: %s\n", s.id, s.error.c_str());
      s.module = nullptr;
    }
    shaders_[s.id] = std::move(s);
    ++stats_.shaders;
  }

  WGPUTextureFormat DepthFormat(uint32_t guest) const {
    return guest == 1 && depth32_stencil8_ ? WGPUTextureFormat_Depth32FloatStencil8 : WGPUTextureFormat_Depth24PlusStencil8;
  }

  // groupLayout: bind group layout (and placeholder / constant group).
  GroupLayout* Layout(uint32_t group, const std::vector<const Shader*>& shaders, std::string* error) {
    std::map<uint32_t, WGPUBindGroupLayoutEntry> entries;
    if (group == 1) {
      for (uint32_t b = 0; b < 5; ++b) {
        WGPUBindGroupLayoutEntry e = WGPU_BIND_GROUP_LAYOUT_ENTRY_INIT;
        e.binding = b;
        e.visibility = WGPUShaderStage_Vertex | WGPUShaderStage_Fragment;
        e.buffer.type = WGPUBufferBindingType_Uniform;
        e.buffer.hasDynamicOffset = true;
        entries[b] = e;
      }
    } else {
      for (const Shader* s : shaders) {
        for (const Binding& d : s->bindings) {
          if (d.group != group) continue;
          const WGPUShaderStage vis = s->stage ? WGPUShaderStage_Fragment : WGPUShaderStage_Vertex;
          auto it = entries.find(d.binding);
          if (it != entries.end()) { it->second.visibility |= vis; continue; }
          WGPUBindGroupLayoutEntry e = WGPU_BIND_GROUP_LAYOUT_ENTRY_INIT;
          e.binding = d.binding;
          e.visibility = vis;
          switch (d.kind) {
            case Binding::kStorage:
              if (d.write && !s->stage) { *error = "vertex shader memory export is not supported yet"; return nullptr; }
              e.buffer.type = d.write ? WGPUBufferBindingType_Storage : WGPUBufferBindingType_ReadOnlyStorage;
              break;
            case Binding::kUniform: e.buffer.type = WGPUBufferBindingType_Uniform; break;
            case Binding::kSampler:
              e.sampler.type = d.comparison ? WGPUSamplerBindingType_Comparison : WGPUSamplerBindingType_Filtering;
              break;
            case Binding::kTexture:
              e.texture.sampleType = d.sample;
              e.texture.viewDimension = d.view;
              e.texture.multisampled = false;
              break;
            default: *error = "unsupported SPIR-V binding"; return nullptr;
          }
          entries[d.binding] = e;
        }
      }
    }
    std::string key = std::to_string(group) + ":";
    std::vector<WGPUBindGroupLayoutEntry> list;
    for (auto& [b, e] : entries) {
      list.push_back(e);
      char k[96];
      std::snprintf(k, sizeof(k), "%u/%u/%d%d/%d/%d%d%d|", e.binding, unsigned(e.visibility), int(e.buffer.type),
                    int(e.buffer.hasDynamicOffset), int(e.sampler.type), int(e.texture.sampleType),
                    int(e.texture.viewDimension), 0);
      key += k;
    }
    auto found = layouts_.find(key);
    if (found != layouts_.end()) return found->second.get();
    auto gl = std::make_unique<GroupLayout>();
    gl->key = key;
    gl->entries = list;
    WGPUBindGroupLayoutDescriptor ld = WGPU_BIND_GROUP_LAYOUT_DESCRIPTOR_INIT;
    ld.entryCount = list.size();
    ld.entries = list.data();
    gl->layout = wgpuDeviceCreateBindGroupLayout(device_, &ld);
    std::vector<WGPUBindGroupEntry> ge;
    for (const auto& e : list) {
      WGPUBindGroupEntry g = WGPU_BIND_GROUP_ENTRY_INIT;
      g.binding = e.binding;
      if (group == 1) {
        g.buffer = uniforms_.buffer;
        g.size = CONSTANT_WINDOW;
      } else {
        Placeholder(e, &g);
      }
      ge.push_back(g);
    }
    WGPUBindGroupDescriptor gd = WGPU_BIND_GROUP_DESCRIPTOR_INIT;
    gd.layout = gl->layout;
    gd.entryCount = ge.size();
    gd.entries = ge.data();
    gl->group = wgpuDeviceCreateBindGroup(device_, &gd);
    GroupLayout* raw = gl.get();
    layouts_[key] = std::move(gl);
    return raw;
  }

  // placeholderResource: shared memory, a 1x1 texture or a sampler.
  void Placeholder(const WGPUBindGroupLayoutEntry& e, WGPUBindGroupEntry* g) {
    if (e.buffer.type != WGPUBufferBindingType_BindingNotUsed && e.buffer.type != WGPUBufferBindingType_Undefined) {
      g->buffer = shared_memory_;
      g->size = shared_memory_bytes_;
      return;
    }
    if (e.sampler.type != WGPUSamplerBindingType_BindingNotUsed && e.sampler.type != WGPUSamplerBindingType_Undefined) {
      const bool cmp = e.sampler.type == WGPUSamplerBindingType_Comparison;
      const std::string key = cmp ? "sampler:cmp" : "sampler:filter";
      if (!placeholders_.count(key)) {
        WGPUSamplerDescriptor sd = WGPU_SAMPLER_DESCRIPTOR_INIT;
        if (cmp) sd.compare = WGPUCompareFunction_Less;
        else sd.magFilter = sd.minFilter = WGPUFilterMode_Linear;
        placeholders_[key] = wgpuDeviceCreateSampler(device_, &sd);
      }
      g->sampler = static_cast<WGPUSampler>(placeholders_[key]);
      return;
    }
    const auto st = e.texture.sampleType;
    const auto vd = e.texture.viewDimension;
    const std::string key = "texture:" + std::to_string(int(st)) + ":" + std::to_string(int(vd));
    if (!placeholders_.count(key)) {
      const WGPUTextureFormat format = st == WGPUTextureSampleType_Sint ? WGPUTextureFormat_RGBA8Sint
                                       : st == WGPUTextureSampleType_Uint ? WGPUTextureFormat_RGBA8Uint
                                       : st == WGPUTextureSampleType_Depth ? WGPUTextureFormat_Depth32Float
                                                                           : WGPUTextureFormat_RGBA8Unorm;
      const uint32_t layers = (vd == WGPUTextureViewDimension_Cube || vd == WGPUTextureViewDimension_CubeArray) ? 6 : 1;
      WGPUTextureDescriptor td = WGPU_TEXTURE_DESCRIPTOR_INIT;
      td.format = format;
      td.dimension = vd == WGPUTextureViewDimension_3D ? WGPUTextureDimension_3D : WGPUTextureDimension_2D;
      td.size = {1, 1, layers};
      td.usage = WGPUTextureUsage_TextureBinding | WGPUTextureUsage_CopyDst;
      WGPUTexture tex = wgpuDeviceCreateTexture(device_, &td);
      if (format != WGPUTextureFormat_Depth32Float) {
        std::vector<uint8_t> texel(4 * layers, 255);
        WGPUTexelCopyTextureInfo dst = WGPU_TEXEL_COPY_TEXTURE_INFO_INIT;
        dst.texture = tex;
        WGPUTexelCopyBufferLayout layout = WGPU_TEXEL_COPY_BUFFER_LAYOUT_INIT;
        layout.bytesPerRow = 4;
        layout.rowsPerImage = 1;
        WGPUExtent3D size{1, 1, layers};
        wgpuQueueWriteTexture(queue_, &dst, texel.data(), texel.size(), &layout, &size);
      }
      WGPUTextureViewDescriptor vdsc = WGPU_TEXTURE_VIEW_DESCRIPTOR_INIT;
      vdsc.dimension = vd;
      placeholders_[key] = wgpuTextureCreateView(tex, &vdsc);
    }
    g->textureView = static_cast<WGPUTextureView>(placeholders_[key]);
  }

  void DefinePipeline(const uint32_t* p, uint32_t n) {
    const uint32_t id = p[0];
    Pipeline entry;
    if (n < 21) { pipelines_[id] = entry; return; }
    const uint32_t* w = p + 1;
    PipelineDescription& d = entry.d;
    d = {w[0], w[1], w[2], w[3], w[4], w[5], w[6], w[7], w[8], {w[9], w[10], w[11], w[12]}, w[13],
         {w[14], w[15], w[16], w[17]}, w[18], w[19]};
    auto fail = [&](const std::string& e) {
      entry.error = e;
      ++stats_.pipeline_failures;
      if (stats_.pipeline_failures <= 5) std::fprintf(stderr, "R360_WGPU pipeline %u: %s\n", id, e.c_str());
      pipelines_[id] = entry;
    };
    auto vs_it = shaders_.find(d.vertex_shader);
    const Shader* vs = vs_it == shaders_.end() ? nullptr : &vs_it->second;
    const Shader* ps = nullptr;
    if (d.pixel_shader) {
      auto it = shaders_.find(d.pixel_shader);
      ps = it == shaders_.end() ? nullptr : &it->second;
    }
    if (!vs || !vs->module) return fail("vertex shader " + std::to_string(d.vertex_shader) + ": " + (vs ? vs->error : "missing"));
    if (d.pixel_shader && (!ps || !ps->module)) return fail("pixel shader " + std::to_string(d.pixel_shader) + ": " + (ps ? ps->error : "missing"));
    std::vector<const Shader*> both{vs};
    if (ps) both.push_back(ps);
    std::string err;
    WGPUBindGroupLayout bgl[4];
    for (uint32_t g = 0; g < 4; ++g) {
      entry.layouts[g] = Layout(g, both, &err);
      if (!entry.layouts[g]) return fail(err);
      bgl[g] = entry.layouts[g]->layout;
    }
    WGPUPipelineLayoutDescriptor pld = WGPU_PIPELINE_LAYOUT_DESCRIPTOR_INIT;
    pld.bindGroupLayoutCount = 4;
    pld.bindGroupLayouts = bgl;
    WGPUPipelineLayout layout = wgpuDeviceCreatePipelineLayout(device_, &pld);

    WGPUColorTargetState targets[4];
    WGPUBlendState blends[4];
    size_t target_count = 0;
    for (uint32_t i = 0; i < 4; ++i) {
      if (!d.color_formats[i]) continue;
      while (target_count < i) {
        targets[target_count] = WGPU_COLOR_TARGET_STATE_INIT;
        targets[target_count].format = WGPUTextureFormat_Undefined;
        ++target_count;
      }
      WGPUColorTargetState t = WGPU_COLOR_TARGET_STATE_INIT;
      t.format = ColorFormat(d.color_formats[i] - 1);
      t.writeMask = (d.color_write_masks >> (i * 4)) & 0xF;
      if (BlendState(d.blend_control[i], &blends[i]) && Blendable(t.format)) t.blend = &blends[i];
      targets[target_count++] = t;
    }
    static const WGPUPrimitiveTopology kTopology[] = {WGPUPrimitiveTopology_PointList, WGPUPrimitiveTopology_LineList,
                                                      WGPUPrimitiveTopology_LineStrip, WGPUPrimitiveTopology_TriangleList,
                                                      WGPUPrimitiveTopology_TriangleStrip};
    static const WGPUCullMode kCull[] = {WGPUCullMode_None, WGPUCullMode_Front, WGPUCullMode_Back};
    WGPURenderPipelineDescriptor rd = WGPU_RENDER_PIPELINE_DESCRIPTOR_INIT;
    rd.layout = layout;
    rd.vertex.module = vs->module;
    rd.vertex.entryPoint = S("main");
    rd.primitive.topology = kTopology[std::min<uint32_t>(d.topology, 4)];
    rd.primitive.cullMode = kCull[std::min<uint32_t>(d.cull_mode, 2)];
    rd.primitive.frontFace = d.front_face_cw ? WGPUFrontFace_CW : WGPUFrontFace_CCW;
    rd.multisample.count = 1;
    WGPUFragmentState fs = WGPU_FRAGMENT_STATE_INIT;
    if (ps) {
      fs.module = ps->module;
      fs.entryPoint = S("main");
      fs.targetCount = target_count;
      fs.targets = targets;
      rd.fragment = &fs;
    }
    WGPUDepthStencilState ds = WGPU_DEPTH_STENCIL_STATE_INIT;
    if (d.depth_format) {
      const uint32_t st = d.stencil;
      const bool on = (st & 1) != 0;
      auto face = [](uint32_t func, uint32_t fail, uint32_t zpass, uint32_t zfail) {
        WGPUStencilFaceState f = WGPU_STENCIL_FACE_STATE_INIT;
        f.compare = COMPARE[func & 7];
        f.failOp = STENCIL_OP[fail & 7];
        f.depthFailOp = STENCIL_OP[zfail & 7];
        f.passOp = STENCIL_OP[zpass & 7];
        return f;
      };
      WGPUStencilFaceState front = WGPU_STENCIL_FACE_STATE_INIT;
      front.compare = WGPUCompareFunction_Always;
      WGPUStencilFaceState back = front;
      if (on) {
        front = face((st >> 8) & 7, (st >> 11) & 7, (st >> 14) & 7, (st >> 17) & 7);
        back = ((st >> 7) & 1) ? face((st >> 20) & 7, (st >> 23) & 7, (st >> 26) & 7, (st >> 29) & 7) : front;
      }
      ds.format = DepthFormat(d.depth_format - 1);
      ds.depthWriteEnabled = d.depth_write ? WGPUOptionalBool_True : WGPUOptionalBool_False;
      ds.depthCompare = COMPARE[d.depth_compare & 7];
      ds.stencilFront = front;
      ds.stencilBack = back;
      ds.stencilReadMask = on ? (d.stencil_masks >> 8) & 0xFF : 0xFF;
      ds.stencilWriteMask = on ? (d.stencil_masks >> 16) & 0xFF : 0;
      rd.depthStencil = &ds;
    }
    PushScope();
    entry.pipeline = wgpuDeviceCreateRenderPipeline(device_, &rd);
    const std::string e = PopScope();
    wgpuPipelineLayoutRelease(layout);
    if (!e.empty()) {
      entry.pipeline = nullptr;
      return fail(e);
    }
    ++stats_.pipelines;
    pipelines_[id] = entry;
  }

  void ParseRenderTargets(const uint32_t* w) {
    bound_.surface_pitch = w[0];
    bound_.msaa = w[1];
    bound_.height = w[2];
    for (int i = 0; i < 4; ++i) { bound_.color_base[i] = w[3 + i]; bound_.color_format[i] = w[7 + i]; }
    bound_.depth_base = w[11];
    bound_.depth_format = w[12];
    have_bound_ = true;
  }

  // target(): host render target for an EDRAM base / format / pitch.
  Target* GetTarget(uint32_t base, uint32_t guest_format, bool depth, uint32_t pitch, uint32_t height, uint32_t msaa) {
    char kbuf[96];
    std::snprintf(kbuf, sizeof(kbuf), "%c:%u:%u:%u:%u", depth ? 'd' : 'c', base, guest_format, pitch, msaa);
    const std::string key = kbuf;
    auto it = targets_.find(key);
    Target* old = it == targets_.end() ? nullptr : it->second.get();
    if (old && old->height >= height) return old;
    auto t = std::make_unique<Target>();
    t->key = key;
    t->base = base;
    t->guest_format = guest_format;
    t->depth = depth;
    t->msaa = msaa;
    t->format = depth ? DepthFormat(guest_format) : ColorFormat(guest_format);
    t->width = pitch;
    t->height = std::max({height, old ? old->height : 0u, 720u});
    WGPUTextureDescriptor td = WGPU_TEXTURE_DESCRIPTOR_INIT;
    td.format = t->format;
    td.size = {t->width, t->height, 1};
    td.usage = WGPUTextureUsage_RenderAttachment | WGPUTextureUsage_TextureBinding | WGPUTextureUsage_CopySrc |
               WGPUTextureUsage_CopyDst;
    t->texture = wgpuDeviceCreateTexture(device_, &td);
    t->view = wgpuTextureCreateView(t->texture, nullptr);
    // tileGeometry
    const uint32_t sx = msaa >= 2 ? 2 : 1, sy = msaa >= 1 ? 2 : 1;
    t->is64bpp = !depth && Is64bpp(guest_format);
    t->tile_width = (t->is64bpp ? 40 : 80) / sx;
    t->tile_height = 16 / sy;
    t->pitch_tiles = (pitch + t->tile_width - 1) / t->tile_width;
    if (old) {
      EndPass();
      WGPUTexelCopyTextureInfo src = WGPU_TEXEL_COPY_TEXTURE_INFO_INIT, dst = WGPU_TEXEL_COPY_TEXTURE_INFO_INIT;
      src.texture = old->texture;
      dst.texture = t->texture;
      WGPUExtent3D size{old->width, old->height, 1};
      wgpuCommandEncoderCopyTextureToTexture(Encoder(), &src, &dst, &size);
      t->initialized = old->initialized;
      for (auto& owner : tile_owner_) if (owner == old) owner = t.get();
      if (front_ == nullptr) {}
      // The old texture is referenced by the recorded copy; release after submit.
      wgpuTextureRelease(old->texture);
    }
    Target* raw = t.get();
    targets_[key] = std::move(t);
    ++stats_.targets_created;
    return raw;
  }

  void Own(Target* t, uint32_t height) {
    const uint32_t rows = (std::min(height, t->height) + t->tile_height - 1) / t->tile_height;
    for (uint32_t r = 0; r < rows; ++r)
      for (uint32_t c = 0; c < t->pitch_tiles; ++c) tile_owner_[(t->base + r * t->pitch_tiles + c) % EDRAM_TILES] = t;
  }

  WGPURenderPassEncoder BeginPass() {
    if (pass_) return pass_;
    if (!have_bound_ || !bound_.surface_pitch) return nullptr;
    const RenderTargetsKey& k = bound_;
    WGPURenderPassColorAttachment colors[4];
    size_t color_count = 0;
    std::vector<Target*> used;
    for (int i = 0; i < 4; ++i) {
      if (k.color_base[i] == 0xFFFFFFFFu) continue;
      Target* t = GetTarget(k.color_base[i], k.color_format[i], false, k.surface_pitch, k.height, k.msaa);
      while (color_count < size_t(i)) {
        colors[color_count] = WGPU_RENDER_PASS_COLOR_ATTACHMENT_INIT;
        ++color_count;
      }
      WGPURenderPassColorAttachment a = WGPU_RENDER_PASS_COLOR_ATTACHMENT_INIT;
      a.view = t->view;
      a.loadOp = t->initialized ? WGPULoadOp_Load : WGPULoadOp_Clear;
      a.clearValue = {0, 0, 0, 0};
      a.storeOp = WGPUStoreOp_Store;
      colors[color_count++] = a;
      used.push_back(t);
    }
    WGPURenderPassDescriptor pd = WGPU_RENDER_PASS_DESCRIPTOR_INIT;
    pd.colorAttachmentCount = color_count;
    pd.colorAttachments = colors;
    WGPURenderPassDepthStencilAttachment ds = WGPU_RENDER_PASS_DEPTH_STENCIL_ATTACHMENT_INIT;
    if (k.depth_base != 0xFFFFFFFFu) {
      Target* d = GetTarget(k.depth_base, k.depth_format, true, k.surface_pitch, k.height, k.msaa);
      ds.view = d->view;
      ds.depthLoadOp = d->initialized ? WGPULoadOp_Load : WGPULoadOp_Clear;
      ds.depthClearValue = 1;
      ds.depthStoreOp = WGPUStoreOp_Store;
      ds.stencilLoadOp = d->initialized ? WGPULoadOp_Load : WGPULoadOp_Clear;
      ds.stencilClearValue = 0;
      ds.stencilStoreOp = WGPUStoreOp_Store;
      pd.depthStencilAttachment = &ds;
      used.push_back(d);
    }
    if (used.empty()) return nullptr;
    pass_w_ = used[0]->width;
    pass_h_ = UINT32_MAX;
    for (Target* t : used) {
      t->initialized = true;
      Own(t, k.height);
      pass_h_ = std::min(pass_h_, t->height);
    }
    pass_ = wgpuCommandEncoderBeginRenderPass(Encoder(), &pd);
    pass_state_ = {};
    ++stats_.render_passes;
    return pass_;
  }

  void Draw(const uint32_t* p, uint32_t n) {
    if (n < DRAW_HEADER_WORDS) { ++stats_.skipped_draws; return; }
    auto it = pipelines_.find(p[0]);
    if (it == pipelines_.end() || !it->second.pipeline) { ++stats_.skipped_draws; return; }
    Pipeline& entry = it->second;
    const uint32_t counts[5] = {p[16], p[17], p[18], p[19], p[20]};
    const uint32_t index_format = p[21], vertex_count = p[22], binding_words = p[25];
    uint32_t o = DRAW_HEADER_WORDS;
    const uint32_t* constants[5];
    uint64_t total = 0;
    for (int i = 0; i < 5; ++i) {
      constants[i] = p + o;
      o += counts[i];
      total += ((counts[i] * 4ull) + uniforms_.align - 1) & ~uint64_t(uniforms_.align - 1);
    }
    const uint32_t* binding = p + o;
    o += binding_words;
    const uint32_t index_words = index_format == 2 ? vertex_count : index_format == 1 ? (vertex_count + 1) / 2 : 0;
    const uint32_t* index_data = p + o;
    const uint64_t index_bytes = index_format == 2 ? vertex_count * 4ull : vertex_count * 2ull;
    if (o + index_words > n) { ++stats_.skipped_draws; return; }
    if (uniforms_.offset + total > uniforms_.limit || !indices_.Fits(index_bytes)) Submit();
    WGPURenderPassEncoder pass = BeginPass();
    if (!pass) { ++stats_.skipped_draws; return; }
    uint32_t offsets[5];
    for (int i = 0; i < 5; ++i) offsets[i] = uniforms_.Push(constants[i], counts[i] * 4ull);
    const int64_t W = pass_w_, H = pass_h_;
    const int64_t vx = std::clamp<int64_t>(p[1], 0, W), vy = std::clamp<int64_t>(p[2], 0, H);
    const int64_t vw = std::min<int64_t>(p[3], W - vx), vh = std::min<int64_t>(p[4], H - vy);
    const int64_t sx = std::min<int64_t>(p[7], W), sy = std::min<int64_t>(p[8], H);
    const int64_t sw = std::min<int64_t>(p[9], W - sx), sh = std::min<int64_t>(p[10], H - sy);
    if (vw <= 0 || vh <= 0 || sw <= 0 || sh <= 0) { ++stats_.skipped_draws; return; }
    if (pass_state_.pipeline != entry.pipeline) {
      wgpuRenderPassEncoderSetPipeline(pass, entry.pipeline);
      pass_state_.pipeline = entry.pipeline;
    }
    WGPUBindGroup tg[2];
    TextureBindGroups(entry, binding, binding_words, tg);
    for (uint32_t g = 0; g < 4; ++g) {
      WGPUBindGroup group = g >= 2 ? tg[g - 2] : entry.layouts[g]->group;
      if (g == 1) {
        wgpuRenderPassEncoderSetBindGroup(pass, 1, group, 5, offsets);
      } else if (pass_state_.groups[g] != group) {
        wgpuRenderPassEncoderSetBindGroup(pass, g, group, 0, nullptr);
        pass_state_.groups[g] = group;
      }
    }
    float z0 = std::clamp(F(p[5]), 0.f, 1.f), z1 = std::clamp(F(p[6]), 0.f, 1.f);
    if (z0 > z1) std::swap(z0, z1);
    wgpuRenderPassEncoderSetViewport(pass, float(vx), float(vy), float(vw), float(vh), z0, z1);
    wgpuRenderPassEncoderSetScissorRect(pass, uint32_t(sx), uint32_t(sy), uint32_t(sw), uint32_t(sh));
    wgpuRenderPassEncoderSetStencilReference(pass, p[11]);
    WGPUColor blend{F(p[12]), F(p[13]), F(p[14]), F(p[15])};
    wgpuRenderPassEncoderSetBlendConstant(pass, &blend);
    if (index_format) {
      const uint32_t offset = indices_.Push(index_data, index_bytes);
      wgpuRenderPassEncoderSetIndexBuffer(pass, indices_.buffer,
                                          index_format == 2 ? WGPUIndexFormat_Uint32 : WGPUIndexFormat_Uint16, offset,
                                          index_bytes);
      wgpuRenderPassEncoderDrawIndexed(pass, vertex_count, 1, 0, 0, 0);
    } else {
      wgpuRenderPassEncoderDraw(pass, vertex_count, 1, 0, 0);
    }
    ++stats_.draws;
  }

  // textureBindGroups: groups 2 (vertex) and 3 (pixel) of a draw.
  void TextureBindGroups(Pipeline& entry, const uint32_t* words, uint32_t word_count, WGPUBindGroup out[2]) {
    uint32_t o = 0;
    for (uint32_t g = 2; g < 4; ++g) {
      const uint32_t sid = g == 2 ? entry.d.vertex_shader : entry.d.pixel_shader;
      auto sit = shaders_.find(sid);
      const Shader* shader = (sid || g == 2) && sit != shaders_.end() ? &sit->second : nullptr;
      GroupLayout* layout = entry.layouts[g];
      if (!shader || layout->entries.empty()) {
        out[g - 2] = layout->group;
        if (shader) o += uint32_t(shader->textures.size() + shader->samplers.size());
        continue;
      }
      const uint32_t nt = uint32_t(shader->textures.size()), ns = uint32_t(shader->samplers.size());
      if (o + nt + ns > word_count) { out[g - 2] = layout->group; continue; }
      const uint32_t* ids = words + o;
      o += nt + ns;
      std::string key = layout->key + "|";
      for (uint32_t i = 0; i < nt + ns; ++i) key += std::to_string(ids[i]) + ",";
      auto found = texture_groups_.find(key);
      if (found != texture_groups_.end()) { out[g - 2] = found->second; continue; }
      if (texture_groups_.size() > 4096) {
        for (auto& [k, bg] : texture_groups_) wgpuBindGroupRelease(bg);
        texture_groups_.clear();
      }
      std::vector<WGPUBindGroupEntry> ge;
      for (const auto& e : layout->entries) {
        WGPUBindGroupEntry b = WGPU_BIND_GROUP_ENTRY_INIT;
        b.binding = e.binding;
        const bool is_texture = e.texture.sampleType != WGPUTextureSampleType_BindingNotUsed &&
                                e.texture.sampleType != WGPUTextureSampleType_Undefined;
        const bool is_sampler = e.sampler.type != WGPUSamplerBindingType_BindingNotUsed &&
                                e.sampler.type != WGPUSamplerBindingType_Undefined;
        if (is_texture) {
          WGPUTextureView view = nullptr;
          if (e.binding < nt) {
            auto t = textures_.find(ids[e.binding]);
            if (t != textures_.end() && !(Unfilterable(t->second.format) && !float32_filterable_)) {
              auto v = t->second.views.find(e.texture.viewDimension);
              if (v != t->second.views.end()) view = v->second;
            }
            if (!view && ids[e.binding]) {
              ++stats_.unbindable_textures;
              if (stats_.unbindable_textures <= 5) {
                auto tt = textures_.find(ids[e.binding]);
                std::fprintf(stderr, "R360_WGPU unbindable texture id=%u found=%d format=%d want_view=%d views=%zu\n",
                             ids[e.binding], tt != textures_.end(), tt != textures_.end() ? int(tt->second.format) : -1,
                             int(e.texture.viewDimension), tt != textures_.end() ? tt->second.views.size() : 0);
              }
            }
          }
          if (view) b.textureView = view; else Placeholder(e, &b);
        } else if (is_sampler && e.binding >= nt && e.binding < nt + ns && e.sampler.type == WGPUSamplerBindingType_Filtering) {
          b.sampler = Sampler(ids[e.binding]);
        } else {
          Placeholder(e, &b);
        }
        ge.push_back(b);
      }
      WGPUBindGroupDescriptor gd = WGPU_BIND_GROUP_DESCRIPTOR_INIT;
      gd.layout = layout->layout;
      gd.entryCount = ge.size();
      gd.entries = ge.data();
      WGPUBindGroup group = wgpuDeviceCreateBindGroup(device_, &gd);
      texture_groups_[key] = group;
      out[g - 2] = group;
    }
  }

  WGPUSampler Sampler(uint32_t parameters) {
    auto it = samplers_.find(parameters);
    if (it != samplers_.end()) return it->second;
    auto address = [](uint32_t m) {
      return m == 0 ? WGPUAddressMode_Repeat : m == 1 ? WGPUAddressMode_MirrorRepeat : WGPUAddressMode_ClampToEdge;
    };
    const uint32_t mag = (parameters >> 11) & 1, min = (parameters >> 12) & 1, mip = (parameters >> 13) & 1;
    const uint32_t aniso = (parameters >> 14) & 7, base_map = (parameters >> 17) & 1, min_level = (parameters >> 18) & 15;
    WGPUSamplerDescriptor d = WGPU_SAMPLER_DESCRIPTOR_INIT;
    d.addressModeU = address(parameters & 7);
    d.addressModeV = address((parameters >> 3) & 7);
    d.addressModeW = address((parameters >> 6) & 7);
    d.magFilter = mag ? WGPUFilterMode_Linear : WGPUFilterMode_Nearest;
    d.minFilter = min ? WGPUFilterMode_Linear : WGPUFilterMode_Nearest;
    d.mipmapFilter = mip ? WGPUMipmapFilterMode_Linear : WGPUMipmapFilterMode_Nearest;
    d.lodMinClamp = float(min_level);
    d.lodMaxClamp = base_map ? min_level + 0.25f : 32.f;
    // Anisotropy needs every filter linear. The owner's iPhone setting (GTA
    // port): 16x anisotropic where the guest asks for it.
    if (aniso >= 2 && mag && min && mip) d.maxAnisotropy = uint16_t(std::min(16u, 1u << (aniso - 1)));
    WGPUSampler s = wgpuDeviceCreateSampler(device_, &d);
    samplers_[parameters] = s;
    return s;
  }

  // defineLoadShader: one of Xenia's texture_load_* / resolve compute
  // shaders, with its push constants kept (wgpu immediates).
  void DefineLoadShader(const uint32_t* p, uint32_t n) {
    const uint32_t index = p[0], words = p[1];
    LoadShader entry;
    if (2 + words > n) { load_shaders_[index] = entry; return; }
    std::vector<uint32_t> spirv = StripNonReadable(p + 2, words);
    const bool resolve = index >= 64;
    PushScope();
    WGPUShaderModule module = SpirvModule(spirv.data(), spirv.size(), "Xenia texture load");
    WGPUBindGroupLayout layouts[2];
    for (int i = 0; i < 2; ++i) {
      WGPUBindGroupLayoutEntry e = WGPU_BIND_GROUP_LAYOUT_ENTRY_INIT;
      e.binding = 0;
      e.visibility = WGPUShaderStage_Compute;
      // Texture loads: group 0 destination, 1 source. Resolves: 0 EDRAM, 1 shared memory.
      const bool writes = resolve ? i == 1 : i == 0;
      e.buffer.type = writes ? WGPUBufferBindingType_Storage : WGPUBufferBindingType_ReadOnlyStorage;
      WGPUBindGroupLayoutDescriptor ld = WGPU_BIND_GROUP_LAYOUT_DESCRIPTOR_INIT;
      ld.entryCount = 1;
      ld.entries = &e;
      layouts[i] = wgpuDeviceCreateBindGroupLayout(device_, &ld);
      entry.layouts[i] = layouts[i];
    }
    entry.immediate_size = resolve ? 20 : 40;
    WGPUPipelineLayoutDescriptor pld = WGPU_PIPELINE_LAYOUT_DESCRIPTOR_INIT;
    pld.bindGroupLayoutCount = 2;
    pld.bindGroupLayouts = layouts;
    pld.immediateSize = 128;
    WGPUComputePipelineDescriptor cd = WGPU_COMPUTE_PIPELINE_DESCRIPTOR_INIT;
    cd.layout = wgpuDeviceCreatePipelineLayout(device_, &pld);
    cd.compute.module = module;
    cd.compute.entryPoint = S("main");
    entry.pipeline = wgpuDeviceCreateComputePipeline(device_, &cd);
    entry.error = PopScope();
    if (!entry.error.empty()) {
      ++stats_.load_shader_failures;
      if (stats_.load_shader_failures <= 5) std::fprintf(stderr, "R360_WGPU load shader %u: %s\n", index, entry.error.c_str());
      entry.pipeline = nullptr;
    }
    load_shaders_[index] = entry;
  }

  void DefineTexture(const uint32_t* p) {
    const uint32_t id = p[0], format_index = p[1], dimension = p[2], width = p[3], height = p[4], depth = p[5],
                   mips = p[6];
    auto old = textures_.find(id);
    if (old != textures_.end()) {
      if (front_ == &old->second) front_ = nullptr;
      wgpuTextureDestroy(old->second.texture);
      textures_.erase(old);
    }
    const WGPUTextureFormat format = TextureFormat(format_index);
    if (getenv("R360_WGPU_LOG")) std::fprintf(stderr, "R360_WGPU texture id=%u format_index=%u dim=%u %ux%ux%u mips=%u\n", id, format_index, dimension, width, height, depth, mips);
    if (format == WGPUTextureFormat_Undefined || !width || !height) { ++stats_.texture_failures; return; }
    Texture t;
    t.id = id;
    t.format = format;
    t.dimension = dimension;
    t.width = width;
    t.height = height;
    const bool is3d = dimension == 1;
    WGPUTextureDescriptor td = WGPU_TEXTURE_DESCRIPTOR_INIT;
    td.format = format;
    td.dimension = is3d ? WGPUTextureDimension_3D : WGPUTextureDimension_2D;
    td.size = {width, height, std::max(depth, 1u)};
    td.mipLevelCount = std::max(mips, 1u);
    td.usage = WGPUTextureUsage_TextureBinding | WGPUTextureUsage_CopyDst | WGPUTextureUsage_CopySrc;
    t.texture = wgpuDeviceCreateTexture(device_, &td);
    auto view = [&](WGPUTextureViewDimension d) {
      WGPUTextureViewDescriptor vd = WGPU_TEXTURE_VIEW_DESCRIPTOR_INIT;
      vd.dimension = d;
      t.views[d] = wgpuTextureCreateView(t.texture, &vd);
    };
    if (is3d) view(WGPUTextureViewDimension_3D);
    else if (dimension == 2) view(WGPUTextureViewDimension_Cube);
    else view(WGPUTextureViewDimension_2DArray);
    textures_[id] = std::move(t);
    for (auto& [k, bg] : texture_groups_) wgpuBindGroupRelease(bg);
    texture_groups_.clear();
    ++stats_.textures;
  }

  WGPUBindGroup BufferGroup(WGPUBindGroupLayout layout, WGPUBuffer buffer, uint64_t offset, uint64_t size) {
    WGPUBindGroupEntry e = WGPU_BIND_GROUP_ENTRY_INIT;
    e.binding = 0;
    e.buffer = buffer;
    e.offset = offset;
    e.size = size;
    WGPUBindGroupDescriptor d = WGPU_BIND_GROUP_DESCRIPTOR_INIT;
    d.layout = layout;
    d.entryCount = 1;
    d.entries = &e;
    return wgpuDeviceCreateBindGroup(device_, &d);
  }

  void LoadTexture(const uint32_t* p, uint32_t n) {
    const uint32_t id = p[0], shader_index = p[1], expand = p[2], buffer_size = p[3], base_offset = p[4],
                   base_size = p[5], mips_offset = p[6], mips_size = p[7], dispatch_count = p[8], copy_count = p[9];
    auto t = textures_.find(id);
    auto sh = load_shaders_.find(shader_index);
    if (t == textures_.end() || sh == load_shaders_.end() || !sh->second.pipeline ||
        10 + dispatch_count * 14 + copy_count * 8 > n) {
      ++stats_.texture_load_failures;
      return;
    }
    EndPass();
    const bool expanded = expand >= 1 && expand <= 4;
    const uint64_t scratch_bytes = uint64_t(buffer_size) * (expanded ? 3 : 1) + 256;
    if (!scratch_ || scratch_size_ < scratch_bytes) {
      if (scratch_) scratch_retired_.push_back(scratch_);
      uint64_t size = 1 << 20;
      while (size < scratch_bytes) size *= 2;
      scratch_ = MakeBuffer("Render360 texture load scratch", size, WGPUBufferUsage_Storage | WGPUBufferUsage_CopySrc);
      scratch_size_ = size;
    }
    WGPUBindGroup dest = BufferGroup(sh->second.layouts[0], scratch_, 0, buffer_size);
    WGPUBindGroup sources[2] = {
        base_size ? BufferGroup(sh->second.layouts[1], shared_memory_, base_offset, base_size) : nullptr,
        mips_size ? BufferGroup(sh->second.layouts[1], shared_memory_, mips_offset, mips_size) : nullptr};
    WGPUComputePassDescriptor cpd = WGPU_COMPUTE_PASS_DESCRIPTOR_INIT;
    WGPUComputePassEncoder pass = wgpuCommandEncoderBeginComputePass(Encoder(), &cpd);
    wgpuComputePassEncoderSetPipeline(pass, sh->second.pipeline);
    wgpuComputePassEncoderSetBindGroup(pass, 0, dest, 0, nullptr);
    uint32_t o = 10;
    for (uint32_t d = 0; d < dispatch_count; ++d, o += 14) {
      WGPUBindGroup src = p[o] < 2 ? sources[p[o]] : nullptr;
      if (!src) continue;
      wgpuComputePassEncoderSetBindGroup(pass, 1, src, 0, nullptr);
      wgpuComputePassEncoderSetImmediates(pass, 0, p + o + 1, 40);
      wgpuComputePassEncoderDispatchWorkgroups(pass, p[o + 11], p[o + 12], p[o + 13]);
    }
    wgpuComputePassEncoderEnd(pass);
    wgpuComputePassEncoderRelease(pass);
    WGPUBuffer copy_source = scratch_;
    uint64_t scale = 1, copy_base = 0;
    if (expand) ExpandTexels(expand, buffer_size, &copy_source, &scale, &copy_base);
    for (uint32_t c = 0; c < copy_count; ++c, o += 8) {
      const uint32_t offset = p[o], bytes_per_row = p[o + 1], rows_per_image = p[o + 2], mip = p[o + 3],
                     layers = p[o + 4], width = p[o + 5], height = p[o + 6], depth = p[o + 7];
      WGPUTexelCopyBufferInfo src = WGPU_TEXEL_COPY_BUFFER_INFO_INIT;
      src.buffer = copy_source;
      src.layout.offset = copy_base + offset * scale;
      src.layout.bytesPerRow = uint32_t(bytes_per_row * scale);
      src.layout.rowsPerImage = rows_per_image;
      WGPUTexelCopyTextureInfo dst = WGPU_TEXEL_COPY_TEXTURE_INFO_INIT;
      dst.texture = t->second.texture;
      dst.mipLevel = mip;
      WGPUExtent3D size{width, height, t->second.dimension == 1 ? depth : layers};
      wgpuCommandEncoderCopyBufferToTexture(Encoder(), &src, &dst, &size);
    }
    wgpuBindGroupRelease(dest);
    for (WGPUBindGroup s : sources) if (s) wgpuBindGroupRelease(s);
    ++stats_.texture_loads;
  }

  void ExpandTexels(uint32_t mode, uint32_t buffer_size, WGPUBuffer* buffer, uint64_t* scale, uint64_t* base) {
    WGPUComputePipeline& pipeline = expand_pipelines_[mode];
    if (!pipeline) {
      WGPUShaderModule module = WgslModule(ExpandShader(mode), "Render360 texel expand");
      WGPUComputePipelineDescriptor cd = WGPU_COMPUTE_PIPELINE_DESCRIPTOR_INIT;
      cd.compute.module = module;
      cd.compute.entryPoint = S("main");
      pipeline = wgpuDeviceCreateComputePipeline(device_, &cd);
    }
    const bool in_place = mode >= 5;
    const uint64_t out = in_place ? 0 : ((buffer_size + 255ull) / 256) * 256;
    WGPUBindGroupEntry e[2] = {WGPU_BIND_GROUP_ENTRY_INIT, WGPU_BIND_GROUP_ENTRY_INIT};
    e[0].binding = 0; e[0].buffer = scratch_; e[0].offset = 0; e[0].size = buffer_size;
    e[1].binding = 1; e[1].buffer = scratch_; e[1].offset = out; e[1].size = buffer_size * 2ull;
    WGPUBindGroupDescriptor gd = WGPU_BIND_GROUP_DESCRIPTOR_INIT;
    gd.layout = wgpuComputePipelineGetBindGroupLayout(pipeline, 0);
    gd.entryCount = in_place ? 1 : 2;
    gd.entries = e;
    WGPUBindGroup group = wgpuDeviceCreateBindGroup(device_, &gd);
    WGPUComputePassDescriptor cpd = WGPU_COMPUTE_PASS_DESCRIPTOR_INIT;
    WGPUComputePassEncoder pass = wgpuCommandEncoderBeginComputePass(Encoder(), &cpd);
    wgpuComputePassEncoderSetPipeline(pass, pipeline);
    wgpuComputePassEncoderSetBindGroup(pass, 0, group, 0, nullptr);
    const uint32_t groups = (buffer_size / 4 + 63) / 64;
    wgpuComputePassEncoderDispatchWorkgroups(pass, std::min(groups, 65535u), (groups + 65534) / 65535, 1);
    wgpuComputePassEncoderEnd(pass);
    wgpuComputePassEncoderRelease(pass);
    wgpuBindGroupRelease(group);
    *buffer = scratch_;
    *scale = in_place ? 1 : 2;
    *base = out;
  }

  WGPUComputePipeline DumpPipeline(bool depth) {
    WGPUComputePipeline& p = dump_pipelines_[depth ? 1 : 0];
    if (!p) {
      WGPUShaderModule module = WgslModule(EdramDumpShader(depth), "Render360 EDRAM dump");
      WGPUComputePipelineDescriptor cd = WGPU_COMPUTE_PIPELINE_DESCRIPTOR_INIT;
      cd.compute.module = module;
      cd.compute.entryPoint = S("main");
      p = wgpuDeviceCreateComputePipeline(device_, &cd);
    }
    return p;
  }

  void DumpEdram(const uint32_t* p) {
    const uint32_t base = p[0], row_length = p[1], rows = p[2], pitch = p[3];
    std::vector<Target*> owners;
    for (uint32_t r = 0; r < rows; ++r)
      for (uint32_t c = 0; c < row_length; ++c) {
        Target* o = tile_owner_[(base + r * pitch + c) % EDRAM_TILES];
        if (o && std::find(owners.begin(), owners.end(), o) == owners.end()) owners.push_back(o);
      }
    if (owners.empty()) return;
    EndPass();
    for (Target* t : owners) {
      const uint32_t delta = (base - t->base + EDRAM_TILES) % EDRAM_TILES;
      const uint32_t row0 = delta / t->pitch_tiles, col0 = delta % t->pitch_tiles;
      const uint32_t x0 = col0 * t->tile_width, y0 = row0 * t->tile_height;
      const int64_t width = std::min<int64_t>(int64_t(t->width) - x0, int64_t(std::max(row_length, 1u)) * t->tile_width);
      const int64_t height = std::min<int64_t>(int64_t(t->height) - y0, int64_t(rows) * t->tile_height);
      if (width <= 0 || height <= 0) continue;
      WGPUComputePipeline pipeline = DumpPipeline(t->depth);
      const uint32_t constants[12] = {t->base, t->pitch_tiles, t->msaa, t->guest_format, x0, y0, uint32_t(width),
                                      uint32_t(height), t->is64bpp ? 1u : 0u,
                                      DepthFormat(t->guest_format) == WGPUTextureFormat_Depth32FloatStencil8 ? 1u : 0u,
                                      0, 0};
      if (!uniforms_.Fits(sizeof(constants))) Submit();
      const uint32_t offset = uniforms_.Push(constants, sizeof(constants));
      std::vector<WGPUBindGroupEntry> e(2, WGPU_BIND_GROUP_ENTRY_INIT);
      e[0].binding = 0; e[0].buffer = edram_; e[0].size = WGPU_WHOLE_SIZE;
      e[1].binding = 1; e[1].buffer = uniforms_.buffer; e[1].offset = offset; e[1].size = 48;
      std::vector<WGPUTextureView> views;
      if (t->depth) {
        WGPUTextureViewDescriptor vd = WGPU_TEXTURE_VIEW_DESCRIPTOR_INIT;
        vd.aspect = WGPUTextureAspect_DepthOnly;
        views.push_back(wgpuTextureCreateView(t->texture, &vd));
        vd.aspect = WGPUTextureAspect_StencilOnly;
        views.push_back(wgpuTextureCreateView(t->texture, &vd));
        WGPUBindGroupEntry d2 = WGPU_BIND_GROUP_ENTRY_INIT, d3 = WGPU_BIND_GROUP_ENTRY_INIT;
        d2.binding = 2; d2.textureView = views[0];
        d3.binding = 3; d3.textureView = views[1];
        e.push_back(d2);
        e.push_back(d3);
      } else {
        WGPUBindGroupEntry d2 = WGPU_BIND_GROUP_ENTRY_INIT;
        d2.binding = 2; d2.textureView = t->view;
        e.push_back(d2);
      }
      WGPUBindGroupDescriptor gd = WGPU_BIND_GROUP_DESCRIPTOR_INIT;
      gd.layout = wgpuComputePipelineGetBindGroupLayout(pipeline, 0);
      gd.entryCount = e.size();
      gd.entries = e.data();
      WGPUBindGroup group = wgpuDeviceCreateBindGroup(device_, &gd);
      WGPUComputePassDescriptor cpd = WGPU_COMPUTE_PASS_DESCRIPTOR_INIT;
      WGPUComputePassEncoder pass = wgpuCommandEncoderBeginComputePass(Encoder(), &cpd);
      wgpuComputePassEncoderSetPipeline(pass, pipeline);
      wgpuComputePassEncoderSetBindGroup(pass, 0, group, 0, nullptr);
      wgpuComputePassEncoderDispatchWorkgroups(pass, uint32_t((width + 7) / 8), uint32_t((height + 7) / 8), 1);
      wgpuComputePassEncoderEnd(pass);
      wgpuComputePassEncoderRelease(pass);
      wgpuBindGroupRelease(group);
      for (auto v : views) wgpuTextureViewRelease(v);
      ++stats_.dumps;
    }
  }

  void Resolve(const uint32_t* p) {
    auto sh = load_shaders_.find(64 + p[0]);
    if (sh == load_shaders_.end() || !sh->second.pipeline) { ++stats_.resolve_failures; return; }
    const uint32_t groups_x = p[6], groups_y = p[7], offset = p[8], size = p[9];
    if (uint64_t(offset) + size > shared_memory_bytes_ || !size) { ++stats_.resolve_failures; return; }
    EndPass();
    WGPUBindGroup src = BufferGroup(sh->second.layouts[0], edram_, 0, uint64_t(EDRAM_TILES) * EDRAM_TILE_DWORDS * 4);
    WGPUBindGroup dst = BufferGroup(sh->second.layouts[1], shared_memory_, offset, size);
    WGPUComputePassDescriptor cpd = WGPU_COMPUTE_PASS_DESCRIPTOR_INIT;
    WGPUComputePassEncoder pass = wgpuCommandEncoderBeginComputePass(Encoder(), &cpd);
    wgpuComputePassEncoderSetPipeline(pass, sh->second.pipeline);
    wgpuComputePassEncoderSetBindGroup(pass, 0, src, 0, nullptr);
    wgpuComputePassEncoderSetBindGroup(pass, 1, dst, 0, nullptr);
    wgpuComputePassEncoderSetImmediates(pass, 0, p + 1, 20);
    wgpuComputePassEncoderDispatchWorkgroups(pass, groups_x, groups_y, 1);
    wgpuComputePassEncoderEnd(pass);
    wgpuComputePassEncoderRelease(pass);
    wgpuBindGroupRelease(src);
    wgpuBindGroupRelease(dst);
    ++stats_.resolves;
  }

  WGPUBindGroupLayout ClearLayout() {
    if (!clear_layout_) {
      WGPUBindGroupLayoutEntry e = WGPU_BIND_GROUP_LAYOUT_ENTRY_INIT;
      e.binding = 0;
      e.visibility = WGPUShaderStage_Fragment;
      e.buffer.type = WGPUBufferBindingType_Uniform;
      e.buffer.hasDynamicOffset = true;
      WGPUBindGroupLayoutDescriptor ld = WGPU_BIND_GROUP_LAYOUT_DESCRIPTOR_INIT;
      ld.entryCount = 1;
      ld.entries = &e;
      clear_layout_ = wgpuDeviceCreateBindGroupLayout(device_, &ld);
      WGPUBindGroupEntry g = WGPU_BIND_GROUP_ENTRY_INIT;
      g.binding = 0; g.buffer = uniforms_.buffer; g.size = 16;
      WGPUBindGroupDescriptor gd = WGPU_BIND_GROUP_DESCRIPTOR_INIT;
      gd.layout = clear_layout_;
      gd.entryCount = 1;
      gd.entries = &g;
      clear_group_ = wgpuDeviceCreateBindGroup(device_, &gd);
    }
    return clear_layout_;
  }

  WGPURenderPipeline ClearPipeline(const Target* t) {
    auto& p = clear_pipelines_[{t->format, t->depth}];
    if (p) return p;
    WGPUShaderModule module = WgslModule(CLEAR_SHADER, "Render360 clear");
    WGPUBindGroupLayout bgl = ClearLayout();
    WGPUPipelineLayoutDescriptor pld = WGPU_PIPELINE_LAYOUT_DESCRIPTOR_INIT;
    pld.bindGroupLayoutCount = 1;
    pld.bindGroupLayouts = &bgl;
    WGPURenderPipelineDescriptor rd = WGPU_RENDER_PIPELINE_DESCRIPTOR_INIT;
    rd.layout = wgpuDeviceCreatePipelineLayout(device_, &pld);
    rd.vertex.module = module;
    rd.vertex.entryPoint = S("vs");
    rd.primitive.topology = WGPUPrimitiveTopology_TriangleList;
    rd.multisample.count = 1;
    WGPUFragmentState fs = WGPU_FRAGMENT_STATE_INIT;
    fs.module = module;
    WGPUColorTargetState ct = WGPU_COLOR_TARGET_STATE_INIT;
    WGPUDepthStencilState ds = WGPU_DEPTH_STENCIL_STATE_INIT;
    if (t->depth) {
      fs.entryPoint = S("fs_depth");
      WGPUStencilFaceState face = WGPU_STENCIL_FACE_STATE_INIT;
      face.compare = WGPUCompareFunction_Always;
      face.passOp = face.failOp = face.depthFailOp = WGPUStencilOperation_Replace;
      ds.format = t->format;
      ds.depthWriteEnabled = WGPUOptionalBool_True;
      ds.depthCompare = WGPUCompareFunction_Always;
      ds.stencilFront = ds.stencilBack = face;
      ds.stencilWriteMask = 0xFF;
      rd.depthStencil = &ds;
    } else {
      fs.entryPoint = S("fs_color");
      ct.format = t->format;
      fs.targetCount = 1;
      fs.targets = &ct;
    }
    rd.fragment = &fs;
    p = wgpuDeviceCreateRenderPipeline(device_, &rd);
    return p;
  }

  void Clear(const uint32_t* p) {
    const uint32_t is_depth = p[0], base = p[1], pitch_tiles = p[2], msaa = p[3], format = p[4], x = p[5], y = p[6],
                   width = p[7], height = p[8], lo = p[9], hi = p[10];
    EndPass();
    for (auto& [key, tp] : targets_) {
      Target* t = tp.get();
      if (t->depth != !!is_depth || t->pitch_tiles != pitch_tiles || t->msaa != msaa || t->guest_format != format) continue;
      const uint32_t delta = (base - t->base + EDRAM_TILES) % EDRAM_TILES;
      const uint32_t x0 = (delta % pitch_tiles) * t->tile_width + x, y0 = (delta / pitch_tiles) * t->tile_height + y;
      if (x0 >= t->width || y0 >= t->height) continue;
      const uint32_t w = std::min(width, t->width - x0), h = std::min(height, t->height - y0);
      const bool whole = x0 == 0 && y0 == 0 && w >= t->width && h >= t->height;
      float depth_value = 0;
      uint32_t stencil_value = 0;
      WGPUColor color{0, 0, 0, 0};
      if (is_depth) {
        const uint32_t d24 = (lo >> 8) & 0xFFFFFF;
        depth_value = std::clamp(format == 1 ? Float20e4To32(d24) * 0.5f : d24 / float(0xFFFFFF), 0.f, 1.f);
        stencil_value = lo & 0xFF;
      } else {
        color = ColorClearValue(format, lo, hi);
      }
      WGPURenderPassDescriptor pd = WGPU_RENDER_PASS_DESCRIPTOR_INIT;
      WGPURenderPassColorAttachment ca = WGPU_RENDER_PASS_COLOR_ATTACHMENT_INIT;
      WGPURenderPassDepthStencilAttachment da = WGPU_RENDER_PASS_DEPTH_STENCIL_ATTACHMENT_INIT;
      if (is_depth) {
        da.view = t->view;
        da.depthLoadOp = whole ? WGPULoadOp_Clear : WGPULoadOp_Load;
        da.depthClearValue = depth_value;
        da.depthStoreOp = WGPUStoreOp_Store;
        da.stencilLoadOp = whole ? WGPULoadOp_Clear : WGPULoadOp_Load;
        da.stencilClearValue = stencil_value;
        da.stencilStoreOp = WGPUStoreOp_Store;
        pd.depthStencilAttachment = &da;
      } else {
        ca.view = t->view;
        ca.loadOp = whole ? WGPULoadOp_Clear : WGPULoadOp_Load;
        ca.clearValue = color;
        ca.storeOp = WGPUStoreOp_Store;
        pd.colorAttachmentCount = 1;
        pd.colorAttachments = &ca;
      }
      if (!whole) {
        const float words[4] = {is_depth ? depth_value : float(color.r), is_depth ? 0 : float(color.g),
                                is_depth ? 0 : float(color.b), is_depth ? 0 : float(color.a)};
        if (!uniforms_.Fits(sizeof(words))) Submit();
        const uint32_t at = uniforms_.Push(words, sizeof(words));
        WGPURenderPipeline pipeline = ClearPipeline(t);
        WGPURenderPassEncoder pass = wgpuCommandEncoderBeginRenderPass(Encoder(), &pd);
        wgpuRenderPassEncoderSetPipeline(pass, pipeline);
        wgpuRenderPassEncoderSetBindGroup(pass, 0, clear_group_, 1, &at);
        wgpuRenderPassEncoderSetScissorRect(pass, x0, y0, w, h);
        if (is_depth) wgpuRenderPassEncoderSetStencilReference(pass, stencil_value);
        wgpuRenderPassEncoderDraw(pass, 3, 1, 0, 0);
        wgpuRenderPassEncoderEnd(pass);
        wgpuRenderPassEncoderRelease(pass);
      } else {
        WGPURenderPassEncoder pass = wgpuCommandEncoderBeginRenderPass(Encoder(), &pd);
        wgpuRenderPassEncoderEnd(pass);
        wgpuRenderPassEncoderRelease(pass);
      }
      t->initialized = true;
      ++stats_.clears;
    }
  }

  void Upload(uint32_t dest, uint32_t length, const uint8_t* bytes) {
    if (uint64_t(dest) + length > shared_memory_bytes_) { ++stats_.dropped_uploads; return; }
    if (staging_offset_ + length > STAGING_BYTES) Submit();
    const uint32_t padded = (length + 3) & ~3u;
    EndPass();
    if (padded > STAGING_BYTES) {
      wgpuQueueWriteBuffer(queue_, shared_memory_, dest, bytes, padded);
    } else {
      wgpuQueueWriteBuffer(queue_, staging_, staging_offset_, bytes, padded);
      wgpuCommandEncoderCopyBufferToBuffer(Encoder(), staging_, staging_offset_, shared_memory_, dest, padded);
      staging_offset_ += padded;
    }
    ++stats_.uploads;
    stats_.uploaded_bytes += padded;
  }

  bool Present(uint32_t dw, uint32_t dh) override {
    if (!front_ || !surface_ || !dw || !dh) return false;
    if (dw != surface_w_ || dh != surface_h_) {
      WGPUSurfaceCapabilities caps = WGPU_SURFACE_CAPABILITIES_INIT;
      wgpuSurfaceGetCapabilities(surface_, adapter_, &caps);
      surface_format_ = caps.formatCount ? caps.formats[0] : WGPUTextureFormat_BGRA8Unorm;
      wgpuSurfaceCapabilitiesFreeMembers(caps);
      WGPUSurfaceConfiguration c = WGPU_SURFACE_CONFIGURATION_INIT;
      c.device = device_;
      c.format = surface_format_;
      c.usage = WGPUTextureUsage_RenderAttachment;
      c.width = dw;
      c.height = dh;
      c.presentMode = WGPUPresentMode_Fifo;
      c.alphaMode = WGPUCompositeAlphaMode_Opaque;
      wgpuSurfaceConfigure(surface_, &c);
      surface_w_ = dw;
      surface_h_ = dh;
      if (present_pipeline_) { wgpuRenderPipelineRelease(present_pipeline_); present_pipeline_ = nullptr; }
    }
    if (!present_pipeline_) {
      WGPUShaderModule module = WgslModule(PRESENT_SHADER, "Render360 present");
      WGPURenderPipelineDescriptor rd = WGPU_RENDER_PIPELINE_DESCRIPTOR_INIT;
      rd.vertex.module = module;
      rd.vertex.entryPoint = S("vs");
      rd.primitive.topology = WGPUPrimitiveTopology_TriangleList;
      rd.multisample.count = 1;
      WGPUColorTargetState ct = WGPU_COLOR_TARGET_STATE_INIT;
      ct.format = surface_format_;
      WGPUFragmentState fs = WGPU_FRAGMENT_STATE_INIT;
      fs.module = module;
      fs.entryPoint = S("fs");
      fs.targetCount = 1;
      fs.targets = &ct;
      rd.fragment = &fs;
      present_pipeline_ = wgpuDeviceCreateRenderPipeline(device_, &rd);
      WGPUSamplerDescriptor sd = WGPU_SAMPLER_DESCRIPTOR_INIT;
      sd.magFilter = sd.minFilter = WGPUFilterMode_Linear;
      if (!present_sampler_) present_sampler_ = wgpuDeviceCreateSampler(device_, &sd);
      if (!present_swizzle_) present_swizzle_ = MakeBuffer("present swizzle", 16, WGPUBufferUsage_Uniform | WGPUBufferUsage_CopyDst);
    }
    const uint32_t swz[4] = {front_swizzle_, 0, 0, 0};
    wgpuQueueWriteBuffer(queue_, present_swizzle_, 0, swz, sizeof(swz));
    auto view_it = front_->views.find(WGPUTextureViewDimension_2DArray);
    if (view_it == front_->views.end()) return false;
    WGPUBindGroupEntry e[3] = {WGPU_BIND_GROUP_ENTRY_INIT, WGPU_BIND_GROUP_ENTRY_INIT, WGPU_BIND_GROUP_ENTRY_INIT};
    e[0].binding = 0; e[0].textureView = view_it->second;
    e[1].binding = 1; e[1].sampler = present_sampler_;
    e[2].binding = 2; e[2].buffer = present_swizzle_; e[2].size = 16;
    WGPUBindGroupDescriptor gd = WGPU_BIND_GROUP_DESCRIPTOR_INIT;
    gd.layout = wgpuRenderPipelineGetBindGroupLayout(present_pipeline_, 0);
    gd.entryCount = 3;
    gd.entries = e;
    WGPUBindGroup group = wgpuDeviceCreateBindGroup(device_, &gd);
    WGPUSurfaceTexture st = WGPU_SURFACE_TEXTURE_INIT;
    wgpuSurfaceGetCurrentTexture(surface_, &st);
    if (!st.texture) { wgpuBindGroupRelease(group); return false; }
    WGPUTextureView target = wgpuTextureCreateView(st.texture, nullptr);
    WGPURenderPassColorAttachment ca = WGPU_RENDER_PASS_COLOR_ATTACHMENT_INIT;
    ca.view = target;
    ca.loadOp = WGPULoadOp_Clear;
    ca.clearValue = {0, 0, 0, 1};
    ca.storeOp = WGPUStoreOp_Store;
    WGPURenderPassDescriptor pd = WGPU_RENDER_PASS_DESCRIPTOR_INIT;
    pd.colorAttachmentCount = 1;
    pd.colorAttachments = &ca;
    EndPass();
    WGPURenderPassEncoder pass = wgpuCommandEncoderBeginRenderPass(Encoder(), &pd);
    // Aspect fit.
    const float fa = float(front_->width) / float(front_->height), va = float(dw) / float(dh);
    float w = float(dw), h = float(dh);
    if (fa > va) h = w / fa; else w = h * fa;
    wgpuRenderPassEncoderSetViewport(pass, (dw - w) / 2, (dh - h) / 2, w, h, 0, 1);
    wgpuRenderPassEncoderSetPipeline(pass, present_pipeline_);
    wgpuRenderPassEncoderSetBindGroup(pass, 0, group, 0, nullptr);
    wgpuRenderPassEncoderDraw(pass, 3, 1, 0, 0);
    wgpuRenderPassEncoderEnd(pass);
    wgpuRenderPassEncoderRelease(pass);
    Submit();
    wgpuSurfacePresent(surface_);
    wgpuTextureViewRelease(target);
    wgpuTextureRelease(st.texture);
    wgpuBindGroupRelease(group);
    ++stats_.presents;
    return true;
  }

  bool ReadShared(uint32_t offset, uint32_t length, std::vector<uint8_t>* out) override {
    length = (length + 3) & ~3u;
    if (uint64_t(offset) + length > shared_memory_bytes_ || !length) return false;
    Submit();
    WGPUBuffer read = MakeBuffer("readback", length, WGPUBufferUsage_MapRead | WGPUBufferUsage_CopyDst);
    wgpuCommandEncoderCopyBufferToBuffer(Encoder(), shared_memory_, offset, read, 0, length);
    Submit();
    bool done = false, ok = false;
    WGPUBufferMapCallbackInfo mi = WGPU_BUFFER_MAP_CALLBACK_INFO_INIT;
    mi.mode = WGPUCallbackMode_AllowProcessEvents;
    mi.callback = [](WGPUMapAsyncStatus status, WGPUStringView, void* d, void* o) {
      *static_cast<bool*>(o) = status == WGPUMapAsyncStatus_Success;
      *static_cast<bool*>(d) = true;
    };
    mi.userdata1 = &done;
    mi.userdata2 = &ok;
    wgpuBufferMapAsync(read, WGPUMapMode_Read, 0, length, mi);
    while (!done) { wgpuDevicePoll(device_, true, nullptr); wgpuInstanceProcessEvents(instance_); }
    if (ok) {
      const auto* m = static_cast<const uint8_t*>(wgpuBufferGetConstMappedRange(read, 0, length));
      out->assign(m, m + length);
      wgpuBufferUnmap(read);
    }
    wgpuBufferDestroy(read);
    wgpuBufferRelease(read);
    return ok;
  }

  bool ReadFront(std::vector<uint8_t>* rgba, uint32_t* width, uint32_t* height) override {
    if (!front_ || front_->format != WGPUTextureFormat_RGBA8Unorm) return false;
    Submit();
    const uint32_t w = front_->width, h = front_->height, bpr = (w * 4 + 255) / 256 * 256;
    WGPUBuffer read = MakeBuffer("readback", uint64_t(bpr) * h, WGPUBufferUsage_MapRead | WGPUBufferUsage_CopyDst);
    WGPUTexelCopyTextureInfo src = WGPU_TEXEL_COPY_TEXTURE_INFO_INIT;
    src.texture = front_->texture;
    WGPUTexelCopyBufferInfo dst = WGPU_TEXEL_COPY_BUFFER_INFO_INIT;
    dst.buffer = read;
    dst.layout.bytesPerRow = bpr;
    dst.layout.rowsPerImage = h;
    WGPUExtent3D size{w, h, 1};
    wgpuCommandEncoderCopyTextureToBuffer(Encoder(), &src, &dst, &size);
    Submit();
    bool done = false, ok = false;
    WGPUBufferMapCallbackInfo mi = WGPU_BUFFER_MAP_CALLBACK_INFO_INIT;
    mi.mode = WGPUCallbackMode_AllowProcessEvents;
    mi.callback = [](WGPUMapAsyncStatus status, WGPUStringView, void* d, void* o) {
      *static_cast<bool*>(o) = status == WGPUMapAsyncStatus_Success;
      *static_cast<bool*>(d) = true;
    };
    mi.userdata1 = &done;
    mi.userdata2 = &ok;
    wgpuBufferMapAsync(read, WGPUMapMode_Read, 0, uint64_t(bpr) * h, mi);
    while (!done) { wgpuDevicePoll(device_, true, nullptr); wgpuInstanceProcessEvents(instance_); }
    if (ok) {
      const auto* m = static_cast<const uint8_t*>(wgpuBufferGetConstMappedRange(read, 0, uint64_t(bpr) * h));
      rgba->resize(size_t(w) * h * 4);
      for (uint32_t y = 0; y < h; ++y) std::memcpy(rgba->data() + size_t(y) * w * 4, m + size_t(y) * bpr, w * 4);
      wgpuBufferUnmap(read);
      *width = w;
      *height = h;
    }
    wgpuBufferDestroy(read);
    wgpuBufferRelease(read);
    return ok;
  }
};

}  // namespace

std::unique_ptr<Backend> Backend::Create(void* metal_layer, std::string* error) {
  auto b = std::make_unique<BackendImpl>();
  std::string e;
  if (!b->Init(metal_layer, &e)) {
    if (error) *error = e;
    return nullptr;
  }
  return b;
}

void EnableCoreRecording(bool on) {
  r360_gpu_set_mode(on ? 1 : 0);
  r360_xenos_soft_set_rasterize(on ? 0 : 1);
}

}  // namespace r360gpu
