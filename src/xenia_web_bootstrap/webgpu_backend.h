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
};

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
