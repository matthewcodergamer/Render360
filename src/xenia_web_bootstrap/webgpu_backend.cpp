// WebGPU Xenos backend (see webgpu_backend.h, docs/gpu/WEBGPU_BACKEND.md).
#include "webgpu_backend.h"

#include <algorithm>
#include <cstring>

#include "sparse_guest_memory.h"

extern "C" uint32_t r360_kernel_gpu_address_to_virtual(uint32_t address);

namespace render360::xenia_web {

uint32_t* GpuCommandStream::Begin(GpuStreamOp op, uint32_t words) {
  const size_t at = words_.size();
  words_.resize(at + 1 + words);
  words_[at] = uint32_t(op) | (words << 8);
  return words_.data() + at + 1;
}

GpuCommandStream& GpuStream() {
  static GpuCommandStream stream;
  return stream;
}

namespace {
// Guest virtual address through which the core maps physical `page`.
uint32_t PageVirtual(uint32_t page) {
  return r360_kernel_gpu_address_to_virtual(page << WebGpuSharedMemory::kPageSizeLog2);
}
}  // namespace

void WebGpuSharedMemory::ClearCache() {
  valid_generation_.assign(kPageCount, 0u);
}

bool WebGpuSharedMemory::PageValid(uint32_t page) const {
  const uint32_t generation = valid_generation_[page];
  return generation && generation == SparseGuestGpuGeneration(PageVirtual(page));
}

void WebGpuSharedMemory::MarkValid(uint32_t page) {
  // Arming returns the generation the next CPU write will change.
  valid_generation_[page] = SparseGuestGpuWatch(PageVirtual(page));
}

void WebGpuSharedMemory::Upload(uint32_t page_first, uint32_t page_count) {
  constexpr uint32_t kPageBytes = 1u << kPageSizeLog2;
  const uint32_t length = page_count * kPageBytes;
  uint32_t* payload = GpuStream().Begin(kGpuStreamUpload, 2 + length / 4);
  payload[0] = page_first * kPageBytes;
  payload[1] = length;
  uint8_t* bytes = reinterpret_cast<uint8_t*>(payload + 2);
  for (uint32_t i = 0; i < page_count; ++i) {
    // Unmapped physical pages read as zeros, as never-written GPU memory.
    const uint8_t* host = SparseGuestPageHost(PageVirtual(page_first + i));
    if (host) {
      std::memcpy(bytes + i * kPageBytes, host, kPageBytes);
    } else {
      std::memset(bytes + i * kPageBytes, 0, kPageBytes);
    }
    MarkValid(page_first + i);
  }
  uploaded_bytes_ += length;
  ++upload_ranges_;
}

bool WebGpuSharedMemory::RequestRange(uint32_t start, uint32_t length) {
  // Some texture or buffer is empty: nothing to upload.
  if (!length) return true;
  if (start > kBufferSize || kBufferSize - start < length) return false;
  if (valid_generation_.empty()) ClearCache();
  const uint32_t page_first = start >> kPageSizeLog2;
  const uint32_t page_last = (start + length - 1) >> kPageSizeLog2;
  // Contiguous runs of pages not valid on the GPU, as Xenia's
  // SharedMemory::RequestRange builds its upload_ranges_.
  uint32_t run_start = UINT32_MAX;
  for (uint32_t page = page_first; page <= page_last; ++page) {
    if (!PageValid(page)) {
      if (run_start == UINT32_MAX) run_start = page;
      continue;
    }
    if (run_start != UINT32_MAX) {
      Upload(run_start, page - run_start);
      run_start = UINT32_MAX;
    }
  }
  if (run_start != UINT32_MAX) Upload(run_start, page_last + 1 - run_start);
  return true;
}

void WebGpuSharedMemory::RangeWrittenByGpu(uint32_t start, uint32_t length) {
  if (!length || start >= kBufferSize) return;
  if (valid_generation_.empty()) ClearCache();
  length = std::min(length, kBufferSize - start);
  const uint32_t page_first = start >> kPageSizeLog2;
  const uint32_t page_last = (start + length - 1) >> kPageSizeLog2;
  for (uint32_t page = page_first; page <= page_last; ++page) MarkValid(page);
}

WebGpuSharedMemory& GpuSharedMemory() {
  static WebGpuSharedMemory shared_memory;
  return shared_memory;
}

}  // namespace render360::xenia_web

namespace rx = render360::xenia_web;

extern "C" {
// The recorded command stream (words) for render360-webgpu-xenos.mjs.
__attribute__((used, export_name("r360_gpu_stream_data")))
uint32_t r360_gpu_stream_data() {
  return uint32_t(reinterpret_cast<uintptr_t>(rx::GpuStream().words().data()));
}
__attribute__((used, export_name("r360_gpu_stream_words")))
uint32_t r360_gpu_stream_words() { return uint32_t(rx::GpuStream().words().size()); }
__attribute__((used, export_name("r360_gpu_stream_reset")))
void r360_gpu_stream_reset() { rx::GpuStream().Reset(); }

__attribute__((used, export_name("r360_gpu_shared_memory_request")))
uint32_t r360_gpu_shared_memory_request(uint32_t start, uint32_t length) {
  return rx::GpuSharedMemory().RequestRange(start, length) ? 1u : 0u;
}
__attribute__((used, export_name("r360_gpu_shared_memory_written_by_gpu")))
void r360_gpu_shared_memory_written_by_gpu(uint32_t start, uint32_t length) {
  rx::GpuSharedMemory().RangeWrittenByGpu(start, length);
}
__attribute__((used, export_name("r360_gpu_shared_memory_clear")))
void r360_gpu_shared_memory_clear() { rx::GpuSharedMemory().ClearCache(); }
__attribute__((used, export_name("r360_gpu_shared_memory_uploaded_kb")))
uint32_t r360_gpu_shared_memory_uploaded_kb() {
  return uint32_t(rx::GpuSharedMemory().uploaded_bytes() / 1024u);
}
__attribute__((used, export_name("r360_gpu_shared_memory_upload_ranges")))
uint32_t r360_gpu_shared_memory_upload_ranges() { return rx::GpuSharedMemory().upload_ranges(); }
}  // extern "C"
