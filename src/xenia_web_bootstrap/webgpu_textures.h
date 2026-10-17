#pragma once

// WebGPU texture cache (webgpu_textures.cpp): a port of Xenia's TextureCache
// (src/xenia/gpu/texture_cache.cc) with VulkanTextureCache's host formats and
// texture loading. Textures are untiled and converted on the GPU by Xenia's
// texture_load_* compute shaders reading the shared memory buffer, as Xenia
// does, then copied into WebGPU textures.

#include <cstdint>

#include "xenia/gpu/register_file.h"
#include "xenia/gpu/spirv_shader.h"

namespace render360::xenia_web {

// WebGPU texture formats (render360-webgpu-backend.mjs TEXTURE_FORMATS).
enum WebGpuTextureFormat : uint32_t {
  kWebGpuFormatNone = 0,
  kWebGpuFormatR8Unorm,
  kWebGpuFormatR8Snorm,
  kWebGpuFormatRG8Unorm,
  kWebGpuFormatRG8Snorm,
  kWebGpuFormatRGBA8Unorm,
  kWebGpuFormatRGBA8Snorm,
  kWebGpuFormatRGB10A2Unorm,
  kWebGpuFormatR16Float,
  kWebGpuFormatRG16Float,
  kWebGpuFormatRGBA16Float,
  kWebGpuFormatR32Float,
  kWebGpuFormatRG32Float,
  kWebGpuFormatRGBA32Float,
};

// Second pass over the load shader output where WebGPU has no format for
// what Xenia's Vulkan backend loads into (render360-webgpu-backend.mjs).
enum WebGpuTextureExpand : uint32_t {
  kWebGpuExpandNone = 0,
  // Guest 16-bit packed texels (16bpb load: untiled, endian-swapped) to
  // RGBA8 with the host component order of Xenia's Vulkan formats.
  kWebGpuExpand565,
  kWebGpuExpand655,
  kWebGpuExpand1555,
  kWebGpuExpand4444,
  // 16-bit normalized components (Xenia's R16G16B16A16_UNORM / SNORM
  // outputs) to float16 in place.
  kWebGpuExpandUnorm16ToFloat,
  kWebGpuExpandSnorm16ToFloat,
};

// Makes the textures of the fetch constants in `used_texture_mask` resident
// and up to date (Xenia's TextureCache::RequestTextures), recording texture
// creation and load ops.
void WebGpuRequestTextures(const xe::gpu::RegisterFile& regs, uint32_t used_texture_mask);

// For the bindings of the last WebGpuRequestTextures: stream texture id for
// a shader texture binding (0: null texture), host swizzle and swizzled
// signs for the system constants, and the packed sampler parameters
// (render360-webgpu-backend.mjs sampler()).
uint32_t WebGpuTextureForBinding(const xe::gpu::SpirvShader::TextureBinding& binding);
uint32_t WebGpuTextureHostSwizzle(uint32_t fetch_constant);
uint8_t WebGpuTextureSwizzledSigns(uint32_t fetch_constant);
uint32_t WebGpuSamplerParameters(const xe::gpu::RegisterFile& regs,
                                 const xe::gpu::SpirvShader::SamplerBinding& binding);

// The front buffer texture of a swap (6 fetch constant words), loaded; 0
// if there is none.
uint32_t WebGpuSwapTexture(const uint32_t* fetch_constant);

// Forgets every texture (a new stream consumer, r360_gpu_set_mode).
void WebGpuTexturesReset();

// A resolve wrote the range on the GPU (TextureCache::MarkRangeAsResolved):
// textures in it are reloaded on their next use.
void WebGpuTexturesMarkRangeResolved(uint32_t start, uint32_t length);

}  // namespace render360::xenia_web
