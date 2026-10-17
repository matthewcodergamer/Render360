#pragma once

#include <cstdint>
#include <vector>

// WebGPU Xenos backend (docs/gpu/WEBGPU_BACKEND.md): a port of Xenia's Vulkan
// backend that records a command stream which render360-webgpu-xenos.mjs
// replays into WebGPU, as Xenia's VulkanCommandProcessor records into a
// DeferredCommandBuffer.
namespace render360::xenia_web {

// Command stream words: [op | (payload words << 8)] then the payload.
enum GpuStreamOp : uint32_t {
  // dest offset in the shared memory buffer, byte length, then the bytes
  // (padded to 4). Copied at record time: the guest may rewrite the source
  // before the stream is replayed.
  kGpuStreamUpload = 1,
  // A translated shader, once per (ucode, modification): id, stage (0 vertex,
  // 1 pixel), texture binding count, sampler binding count, SPIR-V word
  // count, then the texture bindings (fetch constant | dimension << 5 |
  // signed << 7), the sampler bindings (fetch constant | mag << 5 | min << 7
  // | mip << 9 | aniso << 11) and the SPIR-V words.
  kGpuStreamShader = 2,
  // A render pipeline, once per description: id, then the
  // WebGpuPipelineDescription words.
  kGpuStreamPipeline = 3,
  // The render targets subsequent draws write: WebGpuRenderTargetsKey words.
  kGpuStreamRenderTargets = 4,
  // A draw: WebGpuDrawHeader, the system constants, vertex and pixel float
  // constants, bool/loop constants, fetch constants, then the indices.
  kGpuStreamDraw = 5,
  // A swap: the front buffer's texture fetch constant (6 words).
  kGpuStreamSwap = 6,
};

// Pipeline state, following Xenia's VulkanPipelineCache::PipelineDescription.
struct WebGpuPipelineDescription {
  uint32_t vertex_shader;  // stream shader id
  uint32_t pixel_shader;   // 0: none (depth only)
  uint32_t topology;       // 0 points, 1 lines, 2 line strip, 3 triangles, 4 triangle strip
  uint32_t cull_mode;      // 0 none, 1 front, 2 back
  uint32_t front_face_cw;
  uint32_t depth_compare;  // xenos::CompareFunction, kAlways when the test is off
  uint32_t depth_write;
  uint32_t stencil;        // RB_DEPTHCONTROL bits 0x7FFF00 when stencil is on, else 0
  uint32_t stencil_masks;  // RB_STENCILREFMASK (front) read/write masks
  uint32_t color_formats[4];   // xenos::ColorRenderTargetFormat + 1, 0: unused
  uint32_t color_write_masks;  // 4 bits per render target
  uint32_t blend_control[4];   // RB_BLENDCONTROL & 0x1FFF1FFF per render target
  uint32_t depth_format;       // xenos::DepthRenderTargetFormat + 1, 0: no depth
  uint32_t msaa_samples;       // xenos::MsaaSamples
};

// Bound render targets, keyed like Xenia's RenderTargetCache: EDRAM base
// (tiles), pitch (pixels), format; 0xFFFFFFFF base when unused.
struct WebGpuRenderTargetsKey {
  uint32_t surface_pitch;
  uint32_t msaa_samples;
  uint32_t height;  // pixels the draws can reach (viewport / scissor bound)
  uint32_t color_base[4];
  uint32_t color_format[4];
  uint32_t depth_base;
  uint32_t depth_format;
};

struct WebGpuDrawHeader {
  uint32_t pipeline;
  uint32_t viewport[4];  // x, y, width, height (pixels)
  float depth_range[2];
  uint32_t scissor[4];
  uint32_t stencil_reference;
  float blend_constant[4];
  uint32_t system_constant_words;
  uint32_t float_vertex_words;
  uint32_t float_pixel_words;
  uint32_t bool_loop_words;
  uint32_t fetch_words;
  uint32_t index_format;  // 0 none (vertex_count vertices), 1 uint16, 2 uint32
  uint32_t vertex_count;  // indices, or vertices without an index buffer
  uint32_t vertex_texture_mask;  // fetch constants the shaders sample
  uint32_t pixel_texture_mask;
};

// Records draws for the WebGPU backend when enabled (r360_gpu_set_mode);
// false when the draw uses something not implemented yet (counted).
struct XenosSoftDraw;
bool WebGpuIssueDraw(const XenosSoftDraw& draw);
bool WebGpuBackendEnabled();
// PM4 XE_SWAP: the front buffer texture fetch constant (6 words).
void WebGpuSwap(const uint32_t* fetch_constant);

class GpuCommandStream {
 public:
  void Reset() { words_.clear(); }
  // Payload of `words` words for `op`; valid until the next Begin.
  uint32_t* Begin(GpuStreamOp op, uint32_t words);
  const std::vector<uint32_t>& words() const { return words_; }

 private:
  std::vector<uint32_t> words_;
};
GpuCommandStream& GpuStream();

// Port of Xenia's SharedMemory (src/xenia/gpu/shared_memory.cc): the 512 MiB
// GPU copy of guest physical memory. RequestRange uploads the pages of a
// range that are not valid on the GPU; CPU writes invalidate pages. Xenia
// learns of CPU writes through physical memory access watches; here every
// uploaded page arms the sparse guest memory GPU watch
// (SparseGuestGpuWatch) and stays valid while its write generation is
// unchanged.
class WebGpuSharedMemory {
 public:
  static constexpr uint32_t kBufferSizeLog2 = 29;
  static constexpr uint32_t kBufferSize = 1u << kBufferSizeLog2;
  static constexpr uint32_t kPageSizeLog2 = 12;
  static constexpr uint32_t kPageCount = kBufferSize >> kPageSizeLog2;

  void ClearCache();
  // False if the range is outside physical memory.
  bool RequestRange(uint32_t start, uint32_t length);
  // A resolve wrote the range on the GPU: valid there, no upload needed
  // until the CPU writes it.
  void RangeWrittenByGpu(uint32_t start, uint32_t length);

  uint64_t uploaded_bytes() const { return uploaded_bytes_; }
  uint32_t upload_ranges() const { return upload_ranges_; }

 private:
  bool PageValid(uint32_t page) const;
  void MarkValid(uint32_t page);
  void Upload(uint32_t page_first, uint32_t page_count);

  // Write generation each page had when it was made valid (0: not valid).
  std::vector<uint32_t> valid_generation_;
  uint64_t uploaded_bytes_ = 0;
  uint32_t upload_ranges_ = 0;
};
WebGpuSharedMemory& GpuSharedMemory();

}  // namespace render360::xenia_web
