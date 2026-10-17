// WebGPU texture cache (see webgpu_textures.h): Xenia's TextureCache binding
// and texture key logic (src/xenia/gpu/texture_cache.cc) and
// VulkanTextureCache's host formats and LoadTextureDataFromResidentMemoryImpl
// (src/xenia/gpu/vulkan/vulkan_texture_cache.cc), recording WebGPU stream
// ops instead of Vulkan commands.
#include "webgpu_textures.h"

#include <algorithm>
#include <cstring>
#include <memory>
#include <unordered_map>
#include <vector>

#include "sparse_guest_memory.h"
#include "webgpu_backend.h"
#include "xenia/base/math.h"
#include "xenia/gpu/texture_cache.h"
#include "xenia/gpu/texture_info.h"
#include "xenia/gpu/texture_util.h"

extern "C" uint32_t r360_kernel_gpu_address_to_virtual(uint32_t address);

namespace xe::gpu::shaders {
#include "xenia/gpu/shaders/bytecode/vulkan_spirv/texture_load_128bpb_cs.h"
#include "xenia/gpu/shaders/bytecode/vulkan_spirv/texture_load_16bpb_cs.h"
#include "xenia/gpu/shaders/bytecode/vulkan_spirv/texture_load_32bpb_cs.h"
#include "xenia/gpu/shaders/bytecode/vulkan_spirv/texture_load_64bpb_cs.h"
#include "xenia/gpu/shaders/bytecode/vulkan_spirv/texture_load_8bpb_cs.h"
#include "xenia/gpu/shaders/bytecode/vulkan_spirv/texture_load_bgrg8_rgb8_cs.h"
#include "xenia/gpu/shaders/bytecode/vulkan_spirv/texture_load_bgrg8_rgbg8_cs.h"
#include "xenia/gpu/shaders/bytecode/vulkan_spirv/texture_load_ctx1_cs.h"
#include "xenia/gpu/shaders/bytecode/vulkan_spirv/texture_load_depth_float_cs.h"
#include "xenia/gpu/shaders/bytecode/vulkan_spirv/texture_load_depth_unorm_cs.h"
#include "xenia/gpu/shaders/bytecode/vulkan_spirv/texture_load_dxn_rg8_cs.h"
#include "xenia/gpu/shaders/bytecode/vulkan_spirv/texture_load_dxt1_rgba8_cs.h"
#include "xenia/gpu/shaders/bytecode/vulkan_spirv/texture_load_dxt3_rgba8_cs.h"
#include "xenia/gpu/shaders/bytecode/vulkan_spirv/texture_load_dxt3a_cs.h"
#include "xenia/gpu/shaders/bytecode/vulkan_spirv/texture_load_dxt3aas1111_argb4_cs.h"
#include "xenia/gpu/shaders/bytecode/vulkan_spirv/texture_load_dxt3aas1111_bgra4_cs.h"
#include "xenia/gpu/shaders/bytecode/vulkan_spirv/texture_load_dxt5_rgba8_cs.h"
#include "xenia/gpu/shaders/bytecode/vulkan_spirv/texture_load_dxt5a_r8_cs.h"
#include "xenia/gpu/shaders/bytecode/vulkan_spirv/texture_load_gbgr8_grgb8_cs.h"
#include "xenia/gpu/shaders/bytecode/vulkan_spirv/texture_load_gbgr8_rgb8_cs.h"
#include "xenia/gpu/shaders/bytecode/vulkan_spirv/texture_load_r10g11b11_rgba16_cs.h"
#include "xenia/gpu/shaders/bytecode/vulkan_spirv/texture_load_r10g11b11_rgba16_snorm_cs.h"
#include "xenia/gpu/shaders/bytecode/vulkan_spirv/texture_load_r11g11b10_rgba16_cs.h"
#include "xenia/gpu/shaders/bytecode/vulkan_spirv/texture_load_r11g11b10_rgba16_snorm_cs.h"
#include "xenia/gpu/shaders/bytecode/vulkan_spirv/texture_load_r16_snorm_float_cs.h"
#include "xenia/gpu/shaders/bytecode/vulkan_spirv/texture_load_r16_unorm_float_cs.h"
#include "xenia/gpu/shaders/bytecode/vulkan_spirv/texture_load_r4g4b4a4_a4r4g4b4_cs.h"
#include "xenia/gpu/shaders/bytecode/vulkan_spirv/texture_load_r4g4b4a4_b4g4r4a4_cs.h"
#include "xenia/gpu/shaders/bytecode/vulkan_spirv/texture_load_r5g5b5a1_b5g5r5a1_cs.h"
#include "xenia/gpu/shaders/bytecode/vulkan_spirv/texture_load_r5g5b6_b5g6r5_swizzle_rbga_cs.h"
#include "xenia/gpu/shaders/bytecode/vulkan_spirv/texture_load_r5g6b5_b5g6r5_cs.h"
#include "xenia/gpu/shaders/bytecode/vulkan_spirv/texture_load_rg16_snorm_float_cs.h"
#include "xenia/gpu/shaders/bytecode/vulkan_spirv/texture_load_rg16_unorm_float_cs.h"
#include "xenia/gpu/shaders/bytecode/vulkan_spirv/texture_load_rgba16_snorm_float_cs.h"
#include "xenia/gpu/shaders/bytecode/vulkan_spirv/texture_load_rgba16_unorm_float_cs.h"
}  // namespace xe::gpu::shaders

namespace render360::xenia_web {

using namespace xe::gpu;

namespace {

// Xenia's TextureCache types (protected there; this class is never
// instantiated).
class Types : public TextureCache {
 public:
  using TextureCache::kLoadGuestXThreadsPerGroupLog2;
  using TextureCache::kLoadGuestYBlocksPerGroupLog2;
  using TextureCache::LoadConstants;
  using TextureCache::LoadShaderIndex;
  using TextureCache::LoadShaderInfo;
  using TextureCache::TextureKey;
  using TextureCache::kLoadShaderCount;
  using TextureCache::kLoadShaderIndex128bpb;
  using TextureCache::kLoadShaderIndex16bpb;
  using TextureCache::kLoadShaderIndex32bpb;
  using TextureCache::kLoadShaderIndex64bpb;
  using TextureCache::kLoadShaderIndex8bpb;
  using TextureCache::kLoadShaderIndexBGRG8ToRGB8;
  using TextureCache::kLoadShaderIndexCTX1;
  using TextureCache::kLoadShaderIndexDXNToRG8;
  using TextureCache::kLoadShaderIndexDXT1ToRGBA8;
  using TextureCache::kLoadShaderIndexDXT3A;
  using TextureCache::kLoadShaderIndexDXT3ToRGBA8;
  using TextureCache::kLoadShaderIndexDXT5AToR8;
  using TextureCache::kLoadShaderIndexDXT5ToRGBA8;
  using TextureCache::kLoadShaderIndexDepthFloat;
  using TextureCache::kLoadShaderIndexDepthUnorm;
  using TextureCache::kLoadShaderIndexGBGR8ToRGB8;
  using TextureCache::kLoadShaderIndexR10G11B11ToRGBA16;
  using TextureCache::kLoadShaderIndexR10G11B11ToRGBA16SNorm;
  using TextureCache::kLoadShaderIndexR11G11B10ToRGBA16;
  using TextureCache::kLoadShaderIndexR11G11B10ToRGBA16SNorm;
  using TextureCache::kLoadShaderIndexR16SNormToFloat;
  using TextureCache::kLoadShaderIndexR16UNormToFloat;
  using TextureCache::kLoadShaderIndexRG16SNormToFloat;
  using TextureCache::kLoadShaderIndexRG16UNormToFloat;
  using TextureCache::kLoadShaderIndexRGBA16SNormToFloat;
  using TextureCache::kLoadShaderIndexRGBA16UNormToFloat;
  using TextureCache::kLoadShaderIndexUnknown;

  // TextureCache::GuestToHostSwizzle (texture_cache.cc is not linked).
  static uint32_t GuestToHostSwizzle(uint32_t guest_swizzle, uint32_t host_format_swizzle) {
    uint32_t host_swizzle = 0;
    for (uint32_t i = 0; i < 4; ++i) {
      const uint32_t guest_component = (guest_swizzle >> (3 * i)) & 0b111;
      const uint32_t host_component = guest_component >= xenos::XE_GPU_TEXTURE_SWIZZLE_0
                                          ? guest_component & 0b101
                                          : (host_format_swizzle >> (3 * guest_component)) & 0b111;
      host_swizzle |= host_component << (3 * i);
    }
    return host_swizzle;
  }
  // VulkanTextureCache::AreDimensionsCompatible.
  static constexpr bool AreDimensionsCompatible(xenos::FetchOpDimension binding_dimension,
                                                xenos::DataDimension resource_dimension) {
    switch (binding_dimension) {
      case xenos::FetchOpDimension::k1D:
      case xenos::FetchOpDimension::k2D:
        return resource_dimension == xenos::DataDimension::k1D ||
               resource_dimension == xenos::DataDimension::k2DOrStacked;
      case xenos::FetchOpDimension::k3DOrStacked:
        return resource_dimension == xenos::DataDimension::k3D;
      case xenos::FetchOpDimension::kCube:
        return resource_dimension == xenos::DataDimension::kCube;
      default:
        return false;
    }
  }
};
using TextureKey = Types::TextureKey;
using LoadShaderIndex = Types::LoadShaderIndex;
constexpr LoadShaderIndex kUnknown = Types::kLoadShaderIndexUnknown;

// TextureCache::load_shader_info_ and the Vulkan SPIR-V of each load shader.
struct LoadShader {
  Types::LoadShaderInfo info;
  const uint32_t* spirv;
  uint32_t spirv_bytes;
};
#define R360_LOAD_SHADER(bytes, log2, name) \
  {{bytes, log2}, shaders::name, uint32_t(sizeof(shaders::name))}
const LoadShader kLoadShaders[Types::kLoadShaderCount] = {
    R360_LOAD_SHADER(1, 4, texture_load_8bpb_cs),
    R360_LOAD_SHADER(2, 4, texture_load_16bpb_cs),
    R360_LOAD_SHADER(4, 3, texture_load_32bpb_cs),
    R360_LOAD_SHADER(8, 2, texture_load_64bpb_cs),
    R360_LOAD_SHADER(16, 1, texture_load_128bpb_cs),
    R360_LOAD_SHADER(2, 4, texture_load_r5g5b5a1_b5g5r5a1_cs),
    R360_LOAD_SHADER(2, 4, texture_load_r5g6b5_b5g6r5_cs),
    R360_LOAD_SHADER(2, 4, texture_load_r5g5b6_b5g6r5_swizzle_rbga_cs),
    R360_LOAD_SHADER(2, 4, texture_load_r4g4b4a4_b4g4r4a4_cs),
    R360_LOAD_SHADER(2, 4, texture_load_r4g4b4a4_a4r4g4b4_cs),
    R360_LOAD_SHADER(4, 3, texture_load_gbgr8_grgb8_cs),
    R360_LOAD_SHADER(8, 3, texture_load_gbgr8_rgb8_cs),
    R360_LOAD_SHADER(4, 3, texture_load_bgrg8_rgbg8_cs),
    R360_LOAD_SHADER(8, 3, texture_load_bgrg8_rgb8_cs),
    R360_LOAD_SHADER(8, 3, texture_load_r10g11b11_rgba16_cs),
    R360_LOAD_SHADER(8, 3, texture_load_r10g11b11_rgba16_snorm_cs),
    R360_LOAD_SHADER(8, 3, texture_load_r11g11b10_rgba16_cs),
    R360_LOAD_SHADER(8, 3, texture_load_r11g11b10_rgba16_snorm_cs),
    R360_LOAD_SHADER(2, 4, texture_load_r16_unorm_float_cs),
    R360_LOAD_SHADER(2, 4, texture_load_r16_snorm_float_cs),
    R360_LOAD_SHADER(4, 3, texture_load_rg16_unorm_float_cs),
    R360_LOAD_SHADER(4, 3, texture_load_rg16_snorm_float_cs),
    R360_LOAD_SHADER(8, 2, texture_load_rgba16_unorm_float_cs),
    R360_LOAD_SHADER(8, 2, texture_load_rgba16_snorm_float_cs),
    R360_LOAD_SHADER(4, 2, texture_load_dxt1_rgba8_cs),
    R360_LOAD_SHADER(4, 1, texture_load_dxt3_rgba8_cs),
    R360_LOAD_SHADER(4, 1, texture_load_dxt5_rgba8_cs),
    R360_LOAD_SHADER(2, 1, texture_load_dxn_rg8_cs),
    R360_LOAD_SHADER(1, 2, texture_load_dxt3a_cs),
    R360_LOAD_SHADER(2, 2, texture_load_dxt3aas1111_bgra4_cs),
    R360_LOAD_SHADER(2, 2, texture_load_dxt3aas1111_argb4_cs),
    R360_LOAD_SHADER(1, 2, texture_load_dxt5a_r8_cs),
    R360_LOAD_SHADER(2, 2, texture_load_ctx1_cs),
    R360_LOAD_SHADER(4, 3, texture_load_depth_unorm_cs),
    R360_LOAD_SHADER(4, 3, texture_load_depth_float_cs),
};
#undef R360_LOAD_SHADER

// VulkanTextureCache::HostFormat for WebGPU.
struct HostFormat {
  LoadShaderIndex load_shader = kUnknown;
  WebGpuTextureFormat format = kWebGpuFormatNone;
  WebGpuTextureExpand expand = kWebGpuExpandNone;
  bool linear_filterable = true;
};
struct HostFormatPair {
  HostFormat format_unsigned;
  HostFormat format_signed;
  uint32_t swizzle = xenos::XE_GPU_TEXTURE_SWIZZLE_RGBA;
};

// VulkanTextureCache::kBestHostFormats with its fallbacks for formats
// WebGPU lacks: S3TC, DXN and DXT5A decompressed (BC is optional in
// WebGPU and absent on iOS), 4:2:2 to RGBA8, 16-bit normalized through the
// *ToFloat load shaders, and 16-bit packed formats expanded to RGBA8.
const HostFormatPair* HostFormats() {
  static HostFormatPair formats[64];
  static bool initialized = false;
  if (initialized) return formats;
  initialized = true;
  using F = xenos::TextureFormat;
  auto set = [](F f, HostFormat u, HostFormat s, uint32_t swizzle) {
    formats[uint32_t(f)] = {u, s, swizzle};
  };
  constexpr uint32_t RRRR = xenos::XE_GPU_TEXTURE_SWIZZLE_RRRR;
  constexpr uint32_t RGGG = xenos::XE_GPU_TEXTURE_SWIZZLE_RGGG;
  constexpr uint32_t RGBA = xenos::XE_GPU_TEXTURE_SWIZZLE_RGBA;
  constexpr uint32_t RGBB = xenos::XE_GPU_TEXTURE_SWIZZLE_RGBB;
  const HostFormat none;
  auto h = [](LoadShaderIndex shader, WebGpuTextureFormat format,
              WebGpuTextureExpand expand = kWebGpuExpandNone, bool filterable = true) {
    return HostFormat{shader, format, expand, filterable};
  };
  set(F::k_1_REVERSE, none, none, RRRR);
  set(F::k_1, none, none, RRRR);
  set(F::k_8, h(Types::kLoadShaderIndex8bpb, kWebGpuFormatR8Unorm),
      h(Types::kLoadShaderIndex8bpb, kWebGpuFormatR8Snorm), RRRR);
  set(F::k_1_5_5_5, h(Types::kLoadShaderIndex16bpb, kWebGpuFormatRGBA8Unorm, kWebGpuExpand1555),
      none, RGBA);
  set(F::k_5_6_5, h(Types::kLoadShaderIndex16bpb, kWebGpuFormatRGBA8Unorm, kWebGpuExpand565),
      none, RGBB);
  // On the host, green bits in blue, blue bits in green (as Xenia's
  // R5G5B6ToB5G6R5WithRBGASwizzle).
  set(F::k_6_5_5, h(Types::kLoadShaderIndex16bpb, kWebGpuFormatRGBA8Unorm, kWebGpuExpand655),
      none, XE_GPU_MAKE_TEXTURE_SWIZZLE(R, B, G, G));
  set(F::k_8_8_8_8, h(Types::kLoadShaderIndex32bpb, kWebGpuFormatRGBA8Unorm),
      h(Types::kLoadShaderIndex32bpb, kWebGpuFormatRGBA8Snorm), RGBA);
  // No snorm 10:10:10:2 in WebGPU.
  set(F::k_2_10_10_10, h(Types::kLoadShaderIndex32bpb, kWebGpuFormatRGB10A2Unorm), none, RGBA);
  set(F::k_8_A, h(Types::kLoadShaderIndex8bpb, kWebGpuFormatR8Unorm),
      h(Types::kLoadShaderIndex8bpb, kWebGpuFormatR8Snorm), RRRR);
  set(F::k_8_B, none, none, RRRR);
  set(F::k_8_8, h(Types::kLoadShaderIndex16bpb, kWebGpuFormatRG8Unorm),
      h(Types::kLoadShaderIndex16bpb, kWebGpuFormatRG8Snorm), RGGG);
  set(F::k_Cr_Y1_Cb_Y0_REP, h(Types::kLoadShaderIndexGBGR8ToRGB8, kWebGpuFormatRGBA8Unorm),
      h(Types::kLoadShaderIndexGBGR8ToRGB8, kWebGpuFormatRGBA8Snorm), RGBB);
  set(F::k_Y1_Cr_Y0_Cb_REP, h(Types::kLoadShaderIndexBGRG8ToRGB8, kWebGpuFormatRGBA8Unorm),
      h(Types::kLoadShaderIndexBGRG8ToRGB8, kWebGpuFormatRGBA8Snorm), RGBB);
  set(F::k_16_16_EDRAM, none, none, RGGG);
  set(F::k_8_8_8_8_A, none, none, RGBA);
  set(F::k_4_4_4_4, h(Types::kLoadShaderIndex16bpb, kWebGpuFormatRGBA8Unorm, kWebGpuExpand4444),
      none, RGBA);
  set(F::k_10_11_11,
      h(Types::kLoadShaderIndexR11G11B10ToRGBA16, kWebGpuFormatRGBA16Float, kWebGpuExpandUnorm16ToFloat),
      h(Types::kLoadShaderIndexR11G11B10ToRGBA16SNorm, kWebGpuFormatRGBA16Float,
        kWebGpuExpandSnorm16ToFloat),
      RGBB);
  set(F::k_11_11_10,
      h(Types::kLoadShaderIndexR10G11B11ToRGBA16, kWebGpuFormatRGBA16Float, kWebGpuExpandUnorm16ToFloat),
      h(Types::kLoadShaderIndexR10G11B11ToRGBA16SNorm, kWebGpuFormatRGBA16Float,
        kWebGpuExpandSnorm16ToFloat),
      RGBB);
  set(F::k_DXT1, h(Types::kLoadShaderIndexDXT1ToRGBA8, kWebGpuFormatRGBA8Unorm), none, RGBA);
  set(F::k_DXT2_3, h(Types::kLoadShaderIndexDXT3ToRGBA8, kWebGpuFormatRGBA8Unorm), none, RGBA);
  set(F::k_DXT4_5, h(Types::kLoadShaderIndexDXT5ToRGBA8, kWebGpuFormatRGBA8Unorm), none, RGBA);
  set(F::k_16_16_16_16_EDRAM, none, none, RGBA);
  // Depth as R32_SFLOAT; filterable only with float32-filterable, which is
  // optional (sampled with point filtering, as Xenia does for formats
  // without linear filtering).
  set(F::k_24_8, h(Types::kLoadShaderIndexDepthUnorm, kWebGpuFormatR32Float, kWebGpuExpandNone, false),
      none, RRRR);
  set(F::k_24_8_FLOAT,
      h(Types::kLoadShaderIndexDepthFloat, kWebGpuFormatR32Float, kWebGpuExpandNone, false), none,
      RRRR);
  set(F::k_16, h(Types::kLoadShaderIndexR16UNormToFloat, kWebGpuFormatR16Float),
      h(Types::kLoadShaderIndexR16SNormToFloat, kWebGpuFormatR16Float), RRRR);
  set(F::k_16_16, h(Types::kLoadShaderIndexRG16UNormToFloat, kWebGpuFormatRG16Float),
      h(Types::kLoadShaderIndexRG16SNormToFloat, kWebGpuFormatRG16Float), RGGG);
  set(F::k_16_16_16_16, h(Types::kLoadShaderIndexRGBA16UNormToFloat, kWebGpuFormatRGBA16Float),
      h(Types::kLoadShaderIndexRGBA16SNormToFloat, kWebGpuFormatRGBA16Float), RGBA);
  set(F::k_16_EXPAND, h(Types::kLoadShaderIndex16bpb, kWebGpuFormatR16Float),
      h(Types::kLoadShaderIndex16bpb, kWebGpuFormatR16Float), RRRR);
  set(F::k_16_16_EXPAND, h(Types::kLoadShaderIndex32bpb, kWebGpuFormatRG16Float),
      h(Types::kLoadShaderIndex32bpb, kWebGpuFormatRG16Float), RGGG);
  set(F::k_16_16_16_16_EXPAND, h(Types::kLoadShaderIndex64bpb, kWebGpuFormatRGBA16Float),
      h(Types::kLoadShaderIndex64bpb, kWebGpuFormatRGBA16Float), RGBA);
  set(F::k_16_FLOAT, h(Types::kLoadShaderIndex16bpb, kWebGpuFormatR16Float),
      h(Types::kLoadShaderIndex16bpb, kWebGpuFormatR16Float), RRRR);
  set(F::k_16_16_FLOAT, h(Types::kLoadShaderIndex32bpb, kWebGpuFormatRG16Float),
      h(Types::kLoadShaderIndex32bpb, kWebGpuFormatRG16Float), RGGG);
  set(F::k_16_16_16_16_FLOAT, h(Types::kLoadShaderIndex64bpb, kWebGpuFormatRGBA16Float),
      h(Types::kLoadShaderIndex64bpb, kWebGpuFormatRGBA16Float), RGBA);
  set(F::k_32, none, none, RRRR);
  set(F::k_32_32, none, none, RGGG);
  set(F::k_32_32_32_32, none, none, RGBA);
  const HostFormat r32f = h(Types::kLoadShaderIndex32bpb, kWebGpuFormatR32Float, kWebGpuExpandNone, false);
  set(F::k_32_FLOAT, r32f, r32f, RRRR);
  const HostFormat rg32f = h(Types::kLoadShaderIndex64bpb, kWebGpuFormatRG32Float, kWebGpuExpandNone, false);
  set(F::k_32_32_FLOAT, rg32f, rg32f, RGGG);
  const HostFormat rgba32f =
      h(Types::kLoadShaderIndex128bpb, kWebGpuFormatRGBA32Float, kWebGpuExpandNone, false);
  set(F::k_32_32_32_32_FLOAT, rgba32f, rgba32f, RGBA);
  set(F::k_32_AS_8, none, none, RRRR);
  set(F::k_32_AS_8_8, none, none, RGGG);
  set(F::k_16_MPEG, none, none, RRRR);
  set(F::k_16_16_MPEG, none, none, RGGG);
  set(F::k_8_INTERLACED, none, none, RRRR);
  set(F::k_32_AS_8_INTERLACED, none, none, RRRR);
  set(F::k_32_AS_8_8_INTERLACED, none, none, RGGG);
  set(F::k_16_INTERLACED, none, none, RRRR);
  set(F::k_16_MPEG_INTERLACED, none, none, RRRR);
  set(F::k_16_16_MPEG_INTERLACED, none, none, RGGG);
  set(F::k_DXN, h(Types::kLoadShaderIndexDXNToRG8, kWebGpuFormatRG8Unorm), none, RGGG);
  set(F::k_8_8_8_8_AS_16_16_16_16, h(Types::kLoadShaderIndex32bpb, kWebGpuFormatRGBA8Unorm),
      h(Types::kLoadShaderIndex32bpb, kWebGpuFormatRGBA8Snorm), RGBA);
  formats[uint32_t(F::k_DXT1_AS_16_16_16_16)] = formats[uint32_t(F::k_DXT1)];
  formats[uint32_t(F::k_DXT2_3_AS_16_16_16_16)] = formats[uint32_t(F::k_DXT2_3)];
  formats[uint32_t(F::k_DXT4_5_AS_16_16_16_16)] = formats[uint32_t(F::k_DXT4_5)];
  formats[uint32_t(F::k_2_10_10_10_AS_16_16_16_16)] = formats[uint32_t(F::k_2_10_10_10)];
  formats[uint32_t(F::k_10_11_11_AS_16_16_16_16)] = formats[uint32_t(F::k_10_11_11)];
  formats[uint32_t(F::k_11_11_10_AS_16_16_16_16)] = formats[uint32_t(F::k_11_11_10)];
  set(F::k_32_32_32_FLOAT, none, none, RGBB);
  set(F::k_DXT3A, h(Types::kLoadShaderIndexDXT3A, kWebGpuFormatR8Unorm), none, RRRR);
  set(F::k_DXT5A, h(Types::kLoadShaderIndexDXT5AToR8, kWebGpuFormatR8Unorm), none, RRRR);
  set(F::k_CTX1, h(Types::kLoadShaderIndexCTX1, kWebGpuFormatRG8Unorm), none, RGGG);
  // Xenia loads DXT3A_AS_1_1_1_1 into 4:4:4:4, which WebGPU lacks (not yet).
  set(F::k_DXT3A_AS_1_1_1_1, none, none, RGBA);
  set(F::k_8_8_8_8_GAMMA_EDRAM, none, none, RGBA);
  set(F::k_2_10_10_10_FLOAT_EDRAM, none, none, RGBA);
  return formats;
}

const HostFormatPair& GetHostFormatPair(const TextureKey& key) {
  return HostFormats()[uint32_t(key.format)];
}

// Unsigned and signed versions are separate textures whenever both exist
// with different formats: WebGPU views cannot reinterpret unorm as snorm
// (Vulkan's mutable-format images can, for Xenia's
// unsigned_signed_compatible formats).
bool IsSignedVersionSeparateForFormat(const TextureKey& key) {
  const HostFormatPair& pair = GetHostFormatPair(key);
  return pair.format_unsigned.format && pair.format_signed.format &&
         pair.format_unsigned.format != pair.format_signed.format;
}

const HostFormat& GetHostFormat(const TextureKey& key) {
  const HostFormatPair& pair = GetHostFormatPair(key);
  bool is_signed = IsSignedVersionSeparateForFormat(key)
                       ? bool(key.signed_separate)
                       : pair.format_unsigned.load_shader == kUnknown;
  return is_signed ? pair.format_signed : pair.format_unsigned;
}

// Guest physical pages backing a texture, with the GPU write-watch
// generation each had when loaded (Xenia watches them with memory access
// watches; here the sparse guest memory GPU watch).
struct PageRange {
  std::vector<uint32_t> generations;
  uint32_t first_page = 0;
  void Watch(uint32_t start, uint32_t length) {
    generations.clear();
    if (!length) return;
    first_page = start >> 12;
    const uint32_t last_page = (start + length - 1) >> 12;
    for (uint32_t page = first_page; page <= last_page; ++page) {
      generations.push_back(SparseGuestGpuWatch(r360_kernel_gpu_address_to_virtual(page << 12)));
    }
  }
  bool Outdated() const {
    for (size_t i = 0; i < generations.size(); ++i) {
      const uint32_t page = first_page + uint32_t(i);
      if (generations[i] != SparseGuestGpuGeneration(r360_kernel_gpu_address_to_virtual(page << 12))) {
        return true;
      }
    }
    return false;
  }
};

struct Texture {
  TextureKey key;
  uint32_t id = 0;
  texture_util::TextureGuestLayout guest_layout;
  bool loaded_base = false, loaded_mips = false;
  PageRange base_pages, mip_pages;
  uint32_t GetGuestBaseSize() const { return guest_layout.base.level_data_extent_bytes; }
  uint32_t GetGuestMipsSize() const { return guest_layout.mips_total_extent_bytes; }
};

struct TextureKeyHasher {
  size_t operator()(const TextureKey& key) const {
    uint64_t words[2] = {};
    std::memcpy(words, &key, std::min(sizeof(key), sizeof(words)));
    uint64_t h = words[0] * 0x9E3779B97F4A7C15ull ^ words[1];
    return size_t(h ^ (h >> 29));
  }
};

// TextureCache::TextureBinding.
struct TextureBinding {
  TextureKey key;
  uint32_t host_swizzle = 0;
  uint8_t swizzled_signs = 0;
  Texture* texture = nullptr;
  Texture* texture_signed = nullptr;
  void Reset() {
    key.MakeInvalid();
    host_swizzle = xenos::XE_GPU_TEXTURE_SWIZZLE_0000;
    swizzled_signs = uint8_t(xenos::TextureSign::kUnsigned) * uint8_t(0b01010101);
    texture = nullptr;
    texture_signed = nullptr;
  }
};

struct Cache {
  std::unordered_map<TextureKey, std::unique_ptr<Texture>, TextureKeyHasher> textures;
  TextureBinding bindings[32];
  uint32_t next_id = 1;
  bool load_shader_sent[Types::kLoadShaderCount] = {};
  uint32_t loads = 0, load_failures = 0, created = 0;
};
Cache& cache() {
  static Cache c;
  return c;
}

// TextureCache::BindingInfoFromFetchConstant.
void BindingInfoFromFetchConstant(const xenos::xe_gpu_texture_fetch_t& fetch, TextureKey& key_out,
                                  uint8_t* swizzled_signs_out) {
  key_out.MakeInvalid();
  if (swizzled_signs_out) {
    *swizzled_signs_out = uint8_t(xenos::TextureSign::kUnsigned) * uint8_t(0b01010101);
  }
  // gpu_allow_invalid_fetch_constants is off by default in Xenia.
  if (fetch.type != xenos::FetchConstantType::kTexture) return;
  uint32_t width_minus_1, height_minus_1, depth_or_array_size_minus_1;
  uint32_t base_page, mip_page, mip_max_level;
  texture_util::GetSubresourcesFromFetchConstant(fetch, &width_minus_1, &height_minus_1,
                                                 &depth_or_array_size_minus_1, &base_page,
                                                 &mip_page, nullptr, &mip_max_level);
  if (base_page == 0 && mip_page == 0) return;
  if (fetch.dimension == xenos::DataDimension::k1D) {
    if (width_minus_1 >= xenos::kTexture2DCubeMaxWidthHeight || fetch.tiled || fetch.packed_mips) {
      return;
    }
  }
  key_out.base_page = base_page;
  key_out.mip_page = mip_page;
  key_out.dimension = fetch.dimension;
  key_out.width_minus_1 = width_minus_1;
  key_out.height_minus_1 = height_minus_1;
  key_out.depth_or_array_size_minus_1 = depth_or_array_size_minus_1;
  key_out.pitch = fetch.pitch;
  key_out.mip_max_level = mip_max_level;
  key_out.tiled = fetch.tiled;
  key_out.packed_mips = fetch.packed_mips;
  key_out.format = GetBaseFormat(fetch.format);
  key_out.endianness = fetch.endianness;
  key_out.is_valid = 1;
  if (swizzled_signs_out) *swizzled_signs_out = texture_util::SwizzleSigns(fetch);
}

// The stream's texture dimensions: 0 2D array (1D and 2D), 1 3D, 2 cube.
uint32_t StreamDimension(xenos::DataDimension dimension) {
  switch (dimension) {
    case xenos::DataDimension::k3D: return 1;
    case xenos::DataDimension::kCube: return 2;
    default: return 0;
  }
}

// TextureCache::FindOrCreateTexture and VulkanTextureCache::CreateTexture.
Texture* FindOrCreateTexture(const TextureKey& key) {
  Cache& c = cache();
  // WebGPU guaranteed limits (maxTextureDimension2D / 3D, array layers).
  constexpr uint32_t kMax2D = 8192, kMax3D = 2048, kMaxLayers = 256;
  const uint32_t max_width_height = key.dimension == xenos::DataDimension::k3D ? kMax3D : kMax2D;
  const uint32_t max_depth = key.dimension == xenos::DataDimension::k3D ? kMax3D
                             : key.dimension == xenos::DataDimension::kCube ? 6u
                                                                            : kMaxLayers;
  if (key.GetWidth() > max_width_height || key.GetHeight() > max_width_height ||
      key.GetDepthOrArraySize() > max_depth) {
    return nullptr;
  }
  if (auto it = c.textures.find(key); it != c.textures.end()) return it->second.get();
  const HostFormat& host_format = GetHostFormat(key);
  if (!host_format.format || host_format.load_shader == kUnknown) return nullptr;
  auto texture = std::make_unique<Texture>();
  texture->key = key;
  texture->id = c.next_id++;
  texture->guest_layout = key.GetGuestLayout();
  uint32_t* w = GpuStream().Begin(kGpuStreamTexture, 7);
  w[0] = texture->id;
  w[1] = host_format.format;
  w[2] = StreamDimension(key.dimension);
  w[3] = key.GetWidth();
  w[4] = key.GetHeight();
  w[5] = key.GetDepthOrArraySize();
  w[6] = key.mip_max_level + 1;
  ++c.created;
  Texture* result = texture.get();
  c.textures.emplace(key, std::move(texture));
  return result;
}

void SendLoadShader(LoadShaderIndex index) {
  Cache& c = cache();
  if (c.load_shader_sent[index]) return;
  c.load_shader_sent[index] = true;
  const LoadShader& shader = kLoadShaders[index];
  uint32_t* w = GpuStream().Begin(kGpuStreamLoadShader, 2 + shader.spirv_bytes / 4);
  w[0] = index;
  w[1] = shader.spirv_bytes / 4;
  std::memcpy(w + 2, shader.spirv, shader.spirv_bytes);
}

// VulkanTextureCache::LoadTextureDataFromResidentMemoryImpl: the load
// shader dispatches into a scratch buffer and the copies from it into the
// texture, as one stream op. Host rows are padded to WebGPU's 256-byte
// bytesPerRow alignment for buffer to texture copies.
bool LoadTextureData(Texture& texture, bool load_base, bool load_mips) {
  const TextureKey& key = texture.key;
  const HostFormat& host_format = GetHostFormat(key);
  const LoadShaderIndex load_shader = host_format.load_shader;
  if (load_shader == kUnknown) return false;
  const Types::LoadShaderInfo& load_shader_info = kLoadShaders[load_shader].info;

  const texture_util::TextureGuestLayout& guest_layout = texture.guest_layout;
  const xenos::DataDimension dimension = key.dimension;
  const bool is_3d = dimension == xenos::DataDimension::k3D;
  const uint32_t width = key.GetWidth(), height = key.GetHeight();
  const uint32_t depth_or_array_size = key.GetDepthOrArraySize();
  const uint32_t depth = is_3d ? depth_or_array_size : 1;
  const uint32_t array_size = is_3d ? 1 : depth_or_array_size;
  const xenos::TextureFormat guest_format = key.format;
  const FormatInfo* guest_format_info = FormatInfo::Get(guest_format);
  const uint32_t block_width = guest_format_info->block_width;
  const uint32_t block_height = guest_format_info->block_height;
  const uint32_t bytes_per_block = guest_format_info->bytes_per_block();
  const uint32_t level_first = load_base ? 0 : 1;
  const uint32_t level_last = load_mips ? key.mip_max_level : 0;
  if (level_first > level_last) return true;
  const uint32_t level_packed = guest_layout.packed_level;
  const uint32_t level_stored_first = std::min(level_first, level_packed);
  const uint32_t level_stored_last = std::min(level_last, level_packed);
  uint32_t loop_level_first, loop_level_last;
  if (level_packed == 0) {
    loop_level_first = uint32_t(level_first != 0);
    loop_level_last = uint32_t(level_last != 0);
  } else {
    loop_level_first = level_stored_first;
    loop_level_last = level_stored_last;
  }

  // Host layout (no resolution scale, host formats never block-compressed).
  uint32_t host_x_blocks_per_thread = (1u << load_shader_info.guest_x_blocks_per_thread_log2) * block_width;
  // bytesPerRow multiple of 256 (of 128 when expanded to twice the size).
  const uint32_t row_alignment_bytes =
      (host_format.expand >= kWebGpuExpand565 && host_format.expand <= kWebGpuExpand4444) ? 128u : 256u;
  const uint32_t row_alignment_blocks = std::max(row_alignment_bytes / load_shader_info.bytes_per_host_block, 1u);
  const uint32_t x_pitch_alignment = std::max(host_x_blocks_per_thread, row_alignment_blocks);
  struct HostLayout {
    uint32_t offset_bytes, slice_size_bytes, x_pitch_blocks, y_pitch_blocks;
  };
  HostLayout host_layout_base{}, host_layout_mips[xenos::kTextureMaxMips]{};
  uint32_t host_buffer_size = 0;
  for (uint32_t loop_level = loop_level_first; loop_level <= loop_level_last; ++loop_level) {
    const bool is_base = loop_level == 0;
    const uint32_t level = level_packed == 0 ? 0 : loop_level;
    HostLayout& l = is_base ? host_layout_base : host_layout_mips[level];
    l.offset_bytes = host_buffer_size;
    uint32_t x_texels, y_texels, z_texels;
    if (level == level_packed) {
      const auto& packed = is_base ? guest_layout.base : guest_layout.mips[level];
      x_texels = packed.x_extent_blocks * block_width;
      y_texels = packed.y_extent_blocks * block_height;
      z_texels = packed.z_extent;
    } else {
      x_texels = std::max(width >> level, 1u);
      y_texels = std::max(height >> level, 1u);
      z_texels = std::max(depth >> level, 1u);
    }
    l.x_pitch_blocks = xe::round_up(x_texels, x_pitch_alignment);
    l.y_pitch_blocks = y_texels;
    l.slice_size_bytes = load_shader_info.bytes_per_host_block * l.x_pitch_blocks * l.y_pitch_blocks * z_texels;
    host_buffer_size += l.slice_size_bytes * array_size;
  }
  host_buffer_size = xe::align(host_buffer_size, 16u);

  // Guest data in the shared memory buffer.
  const uint32_t base_offset = key.base_page << 12, mips_offset = key.mip_page << 12;
  const uint32_t base_size = xe::align(texture.GetGuestBaseSize(), 16u);
  const uint32_t mips_size = xe::align(texture.GetGuestMipsSize(), 16u);
  if (level_first == 0 && !GpuSharedMemory().RequestRange(base_offset, base_size)) return false;
  if (level_last != 0 && !GpuSharedMemory().RequestRange(mips_offset, mips_size)) return false;
  SendLoadShader(load_shader);

  // Dispatches: source (0 base, 1 mips), LoadConstants (10 words), groups.
  struct Dispatch {
    uint32_t source;
    Types::LoadConstants constants;
    uint32_t groups[3];
  };
  static_assert(sizeof(Types::LoadConstants) == 40, "LoadConstants layout");
  std::vector<Dispatch> dispatches;
  Types::LoadConstants load_constants{};
  load_constants.is_tiled_3d_endian_scale = uint32_t(key.tiled) | (uint32_t(is_3d) << 1) |
                                            (uint32_t(key.endianness) << 2) | (1u << 4) | (1u << 7);
  const uint32_t guest_x_blocks_per_group_log2 =
      Types::kLoadGuestXThreadsPerGroupLog2 + load_shader_info.guest_x_blocks_per_thread_log2;
  for (uint32_t loop_level = loop_level_first; loop_level <= loop_level_last; ++loop_level) {
    const bool is_base = loop_level == 0;
    const uint32_t level = level_packed == 0 ? 0 : loop_level;
    load_constants.guest_offset = is_base ? 0 : guest_layout.mip_offsets_bytes[level];
    const auto& level_guest_layout = is_base ? guest_layout.base : guest_layout.mips[level];
    load_constants.guest_pitch_aligned = level_guest_layout.row_pitch_bytes / bytes_per_block;
    load_constants.guest_z_stride_block_rows_aligned = level_guest_layout.z_slice_stride_block_rows;
    uint32_t level_width, level_height, level_depth;
    if (level == level_packed) {
      level_width = level_guest_layout.x_extent_blocks * block_width;
      level_height = level_guest_layout.y_extent_blocks * block_height;
      level_depth = level_guest_layout.z_extent;
    } else {
      level_width = std::max(width >> level, 1u);
      level_height = std::max(height >> level, 1u);
      level_depth = std::max(depth >> level, 1u);
    }
    load_constants.size_blocks[0] = (level_width + (block_width - 1)) / block_width;
    load_constants.size_blocks[1] = (level_height + (block_height - 1)) / block_height;
    load_constants.size_blocks[2] = level_depth;
    load_constants.height_texels = level_height;
    const uint32_t group_count_x =
        (load_constants.size_blocks[0] + ((1u << guest_x_blocks_per_group_log2) - 1)) >>
        guest_x_blocks_per_group_log2;
    const uint32_t group_count_y =
        (load_constants.size_blocks[1] + ((1u << Types::kLoadGuestYBlocksPerGroupLog2) - 1)) >>
        Types::kLoadGuestYBlocksPerGroupLog2;
    const HostLayout& l = is_base ? host_layout_base : host_layout_mips[level];
    load_constants.host_offset = l.offset_bytes;
    load_constants.host_pitch = load_shader_info.bytes_per_host_block * l.x_pitch_blocks;
    for (uint32_t slice = 0; slice < array_size; ++slice) {
      dispatches.push_back({is_base ? 0u : 1u, load_constants, {group_count_x, group_count_y, load_constants.size_blocks[2]}});
      load_constants.guest_offset += level_guest_layout.array_slice_stride_bytes;
      load_constants.host_offset += l.slice_size_bytes;
    }
  }

  // Copies: buffer offset, bytes per row, rows per image, mip level,
  // layers, width, height, depth.
  struct Copy {
    uint32_t words[8];
  };
  std::vector<Copy> copies;
  for (uint32_t level = level_first; level <= level_last; ++level) {
    const HostLayout& l = level != 0 ? host_layout_mips[std::min(level, level_packed)] : host_layout_base;
    uint32_t buffer_offset = l.offset_bytes;
    if (level >= level_packed) {
      uint32_t offset_x, offset_y, offset_z;
      texture_util::GetPackedMipOffset(width, height, depth, guest_format, level, offset_x, offset_y,
                                       offset_z);
      offset_x *= block_width;
      offset_y *= block_height;
      buffer_offset += load_shader_info.bytes_per_host_block *
                       (offset_x + l.x_pitch_blocks * (offset_y + l.y_pitch_blocks * offset_z));
    }
    copies.push_back({{buffer_offset, l.x_pitch_blocks * load_shader_info.bytes_per_host_block, l.y_pitch_blocks,
                       level, array_size, std::max(width >> level, 1u), std::max(height >> level, 1u),
                       std::max(depth >> level, 1u)}});
  }

  // id, load shader, expand, host buffer size, base offset / size, mips
  // offset / size, dispatch count, copy count, dispatches (14 words), copies
  // (8 words).
  const uint32_t words = 10 + uint32_t(dispatches.size()) * 14 + uint32_t(copies.size()) * 8;
  uint32_t* w = GpuStream().Begin(kGpuStreamTextureLoad, words);
  w[0] = texture.id;
  w[1] = load_shader;
  w[2] = host_format.expand;
  w[3] = host_buffer_size;
  w[4] = base_offset;
  w[5] = base_size;
  w[6] = mips_offset;
  w[7] = mips_size;
  w[8] = uint32_t(dispatches.size());
  w[9] = uint32_t(copies.size());
  w += 10;
  for (const Dispatch& d : dispatches) {
    *w++ = d.source;
    std::memcpy(w, &d.constants, sizeof(d.constants));
    w += 10;
    *w++ = d.groups[0];
    *w++ = d.groups[1];
    *w++ = d.groups[2];
  }
  for (const Copy& copy : copies) {
    std::memcpy(w, copy.words, sizeof(copy.words));
    w += 8;
  }
  return true;
}

// TextureCache::LoadTextureData: loads what CPU writes have outdated.
void MakeUpToDate(Texture& texture) {
  const bool has_base = texture.key.base_page != 0;
  const bool has_mips = texture.key.mip_max_level != 0 && texture.key.mip_page != 0;
  const bool base_outdated = has_base && (!texture.loaded_base || texture.base_pages.Outdated());
  const bool mips_outdated = has_mips && (!texture.loaded_mips || texture.mip_pages.Outdated());
  if (!base_outdated && !mips_outdated) return;
  Cache& c = cache();
  if (!LoadTextureData(texture, base_outdated, mips_outdated)) {
    ++c.load_failures;
    return;
  }
  ++c.loads;
  if (base_outdated) {
    texture.loaded_base = true;
    texture.base_pages.Watch(texture.key.base_page << 12, texture.GetGuestBaseSize());
  }
  if (mips_outdated) {
    texture.loaded_mips = true;
    texture.mip_pages.Watch(texture.key.mip_page << 12, texture.GetGuestMipsSize());
  }
}

}  // namespace

// TextureCache::RequestTextures, rechecking every used binding each draw
// (the bindings stay as Xenia keeps them; pages are checked against their
// write generations instead of watch callbacks).
void WebGpuRequestTextures(const RegisterFile& regs, uint32_t used_texture_mask) {
  Cache& c = cache();
  uint32_t remaining = used_texture_mask, index;
  while (xe::bit_scan_forward(remaining, &index)) {
    remaining &= ~(1u << index);
    TextureBinding& binding = c.bindings[index];
    const xenos::xe_gpu_texture_fetch_t fetch = regs.GetTextureFetch(index);
    TextureKey key;
    uint8_t swizzled_signs;
    BindingInfoFromFetchConstant(fetch, key, &swizzled_signs);
    if (!key.is_valid) {
      binding.Reset();
      continue;
    }
    binding.key = key;
    binding.swizzled_signs = swizzled_signs;
    binding.host_swizzle = Types::GuestToHostSwizzle(fetch.swizzle, GetHostFormatPair(key).swizzle);
    binding.texture = nullptr;
    binding.texture_signed = nullptr;
    if (IsSignedVersionSeparateForFormat(key)) {
      if (texture_util::IsAnySignNotSigned(swizzled_signs)) binding.texture = FindOrCreateTexture(key);
      if (texture_util::IsAnySignSigned(swizzled_signs)) {
        TextureKey signed_key = key;
        signed_key.signed_separate = 1;
        binding.texture_signed = FindOrCreateTexture(signed_key);
      }
    } else {
      binding.texture = FindOrCreateTexture(key);
    }
    if (binding.texture) MakeUpToDate(*binding.texture);
    if (binding.texture_signed) MakeUpToDate(*binding.texture_signed);
  }
}

// VulkanTextureCache::GetActiveBindingOrNullImageView.
uint32_t WebGpuTextureForBinding(const SpirvShader::TextureBinding& shader_binding) {
  const TextureBinding& binding = cache().bindings[shader_binding.fetch_constant];
  if (!binding.key.is_valid ||
      !Types::AreDimensionsCompatible(shader_binding.dimension, binding.key.dimension)) {
    return 0;
  }
  const Texture* texture = binding.texture;
  if (shader_binding.is_signed && IsSignedVersionSeparateForFormat(binding.key)) {
    texture = binding.texture_signed;
  }
  return texture && (texture->loaded_base || texture->loaded_mips) ? texture->id : 0;
}

// VulkanTextureCache::RequestSwapTexture.
uint32_t WebGpuSwapTexture(const uint32_t* fetch_constant) {
  xenos::xe_gpu_texture_fetch_t fetch;
  std::memcpy(&fetch, fetch_constant, sizeof(fetch));
  TextureKey key;
  BindingInfoFromFetchConstant(fetch, key, nullptr);
  if (!key.is_valid || !key.base_page || key.dimension != xenos::DataDimension::k2DOrStacked) return 0;
  Texture* texture = FindOrCreateTexture(key);
  if (!texture) return 0;
  MakeUpToDate(*texture);
  return texture->loaded_base ? texture->id : 0;
}

void WebGpuTexturesMarkRangeResolved(uint32_t start, uint32_t length) {
  if (!length) return;
  const uint32_t end = start + length;
  for (auto& [key, texture] : cache().textures) {
    const uint32_t base = key.base_page << 12, mips = key.mip_page << 12;
    if (texture->loaded_base && base < end && start < base + texture->GetGuestBaseSize()) {
      texture->loaded_base = false;
    }
    if (texture->loaded_mips && mips < end && start < mips + texture->GetGuestMipsSize()) {
      texture->loaded_mips = false;
    }
  }
}

uint32_t WebGpuTextureHostSwizzle(uint32_t fetch_constant) {
  const TextureBinding& binding = cache().bindings[fetch_constant & 31];
  return binding.key.is_valid ? binding.host_swizzle : xenos::XE_GPU_TEXTURE_SWIZZLE_0000;
}

uint8_t WebGpuTextureSwizzledSigns(uint32_t fetch_constant) {
  const TextureBinding& binding = cache().bindings[fetch_constant & 31];
  return binding.key.is_valid ? binding.swizzled_signs
                              : uint8_t(xenos::TextureSign::kUnsigned) * uint8_t(0b01010101);
}

// VulkanTextureCache::GetSamplerParameters, packed: clamp x / y / z (3 bits
// each), border color (2), mag / min / mip linear, aniso filter (3), mip
// base map, mip min level (4).
uint32_t WebGpuSamplerParameters(const RegisterFile& regs, const SpirvShader::SamplerBinding& binding) {
  const xenos::xe_gpu_texture_fetch_t fetch = regs.GetTextureFetch(binding.fetch_constant);
  xenos::ClampMode clamp[3];
  texture_util::GetClampModesForDimension(fetch, clamp[0], clamp[1], clamp[2]);
  // NormalizeClampMode: no clamp to halfway; mirror clamp falls back to
  // mirrored repeat (WebGPU has neither mirror clamp nor border colors).
  for (auto& mode : clamp) {
    if (mode == xenos::ClampMode::kClampToHalfway) mode = xenos::ClampMode::kClampToEdge;
    if (mode == xenos::ClampMode::kMirrorClampToEdge || mode == xenos::ClampMode::kMirrorClampToHalfway ||
        mode == xenos::ClampMode::kMirrorClampToBorder) {
      mode = xenos::ClampMode::kMirroredRepeat;
    }
  }
  const bool border = xenos::ClampModeUsesBorder(clamp[0]) || xenos::ClampModeUsesBorder(clamp[1]) ||
                      xenos::ClampModeUsesBorder(clamp[2]);
  const uint32_t border_color = border ? uint32_t(fetch.border_color) : 0u;
  auto filter = [](xenos::TextureFilter binding_filter, xenos::TextureFilter fetch_filter) {
    return binding_filter == xenos::TextureFilter::kUseFetchConst ? fetch_filter : binding_filter;
  };
  const xenos::TextureFilter mip_filter = filter(binding.mip_filter, fetch.mip_filter);
  bool mag_linear = filter(binding.mag_filter, fetch.mag_filter) == xenos::TextureFilter::kLinear;
  bool min_linear = filter(binding.min_filter, fetch.min_filter) == xenos::TextureFilter::kLinear;
  bool mip_linear = mip_filter == xenos::TextureFilter::kLinear;
  if (mag_linear || min_linear || mip_linear) {
    TextureKey key;
    uint8_t signs;
    BindingInfoFromFetchConstant(fetch, key, &signs);
    bool linear_filterable = key.is_valid;
    if (key.is_valid) {
      const HostFormatPair& pair = GetHostFormatPair(key);
      if ((texture_util::IsAnySignNotSigned(signs) && !pair.format_unsigned.linear_filterable) ||
          (texture_util::IsAnySignSigned(signs) && !pair.format_signed.linear_filterable)) {
        linear_filterable = false;
      }
    }
    if (!linear_filterable) mag_linear = min_linear = mip_linear = false;
  }
  const xenos::AnisoFilter aniso_filter = std::min(
      binding.aniso_filter == xenos::AnisoFilter::kUseFetchConst ? fetch.aniso_filter : binding.aniso_filter,
      xenos::AnisoFilter::kMax_16_1);
  uint32_t mip_min_level;
  texture_util::GetSubresourcesFromFetchConstant(fetch, nullptr, nullptr, nullptr, nullptr, nullptr,
                                                 &mip_min_level, nullptr);
  return uint32_t(clamp[0]) | (uint32_t(clamp[1]) << 3) | (uint32_t(clamp[2]) << 6) | (border_color << 9) |
         (uint32_t(mag_linear) << 11) | (uint32_t(min_linear) << 12) | (uint32_t(mip_linear) << 13) |
         (uint32_t(aniso_filter) << 14) | (uint32_t(mip_filter == xenos::TextureFilter::kBaseMap) << 17) |
         (std::min(mip_min_level, 15u) << 18);
}

}  // namespace render360::xenia_web

namespace rx = render360::xenia_web;

extern "C" {
// 0 textures, 1 created, 2 loads, 3 load failures.
__attribute__((used, export_name("r360_gpu_texture_stat")))
uint32_t r360_gpu_texture_stat(uint32_t index) {
  auto& c = rx::cache();
  switch (index) {
    case 0: return uint32_t(c.textures.size());
    case 1: return c.created;
    case 2: return c.loads;
    case 3: return c.load_failures;
    default: return 0;
  }
}
}  // extern "C"
