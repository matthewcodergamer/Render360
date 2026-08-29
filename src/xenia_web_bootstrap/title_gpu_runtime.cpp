#include "title_gpu_runtime.h"

#include <cstdint>

#include "sparse_guest_memory.h"

namespace render360::xenia_web {
namespace {

constexpr uint32_t kModuleXboxkrnl = 1;
constexpr uint32_t kGpuMmioBase = 0x7FC80000u;
constexpr uint32_t kGpuMmioMask = 0xFFFF0000u;
constexpr uint32_t kRegisterCpRbRptr = 0x01C4u;
constexpr uint32_t kRegisterCpRbWptr = 0x01C5u;

// Runtime status is intentionally monotonic for bring-up telemetry.
// 0 idle, 1 ring initialized, 2 write pointer observed, 3 ring word readable.
uint32_t g_status = 0;
uint32_t g_ring_base = 0;
uint32_t g_ring_size_log2 = 0;
uint32_t g_write_pointer = 0;
uint32_t g_rptr_writeback = 0;
uint32_t g_rptr_block_size_log2 = 0;
uint32_t g_mmio_writes = 0;

bool IsGpuMmio(uint32_t address) {
  return (address & kGpuMmioMask) == kGpuMmioBase;
}

uint32_t RegisterIndex(uint32_t address) {
  return (address & 0xFFFFu) / 4u;
}

void CaptureRing(uint32_t base, uint32_t size_log2) {
  g_ring_base = base;
  g_ring_size_log2 = size_log2;
  g_write_pointer = 0;
  if (base && size_log2 < 29u) g_status = g_status < 1u ? 1u : g_status;
}

}  // namespace

void ResetTitleGpuRuntime() {
  g_status = 0;
  g_ring_base = 0;
  g_ring_size_log2 = 0;
  g_write_pointer = 0;
  g_rptr_writeback = 0;
  g_rptr_block_size_log2 = 0;
  g_mmio_writes = 0;
}

bool TryTitleGpuKernelService(uint32_t module, uint32_t ordinal,
                              uint32_t r3, uint32_t r4, uint32_t,
                              uint32_t, uint32_t, uint32_t,
                              uint32_t, uint32_t, uint32_t* result) {
  if (!result || module != kModuleXboxkrnl) return false;
  switch (ordinal) {
    case 0x00BE:  // MmGetPhysicalAddress - identity in the bounded web VM.
      *result = r3;
      return true;
    case 0x01B4:  // VdEnableDisableClockGating
      *result = 0;
      return true;
    case 0x01B6:  // VdEnableRingBufferRPtrWriteBack(ptr, block_size_log2)
      g_rptr_writeback = r3;
      g_rptr_block_size_log2 = r4;
      *result = 0;
      return true;
    case 0x01BC:  // VdGetGraphicsAsicID
      *result = 0x11u;
      return true;
    case 0x01C2:  // VdInitializeEngines
      *result = 1u;
      return true;
    case 0x01C3:  // VdInitializeRingBuffer(ptr, size_log2)
      CaptureRing(r3, r4);
      *result = 0;
      return true;
    case 0x01C6:  // VdIsHSIOTrainingSucceeded
      *result = 1u;
      return true;
    case 0x01C9:  // VdQueryVideoFlags - widescreen + HD.
      *result = 3u;
      return true;
    case 0x01D3:  // VdSetDisplayMode
    case 0x01D4:  // VdSetDisplayModeOverride
      *result = 0;
      return true;
    default:
      return false;
  }
}

bool ReadTitleGpuMmio(uint32_t address, uint32_t* value) {
  if (!value || !IsGpuMmio(address)) return false;
  switch (RegisterIndex(address)) {
    case kRegisterCpRbRptr:
      *value = 0u;  // No packets are retired until the browser submits them.
      return true;
    case kRegisterCpRbWptr:
      *value = g_write_pointer;
      return true;
    default:
      return false;
  }
}

bool WriteTitleGpuMmio(uint32_t address, uint32_t value) {
  if (!IsGpuMmio(address)) return false;
  ++g_mmio_writes;
  switch (RegisterIndex(address)) {
    case kRegisterCpRbWptr:
      g_write_pointer = value;
      if (g_ring_base) g_status = g_status < 2u ? 2u : g_status;
      return true;
    default:
      // Other GPU registers are not claimed as supported here. They must reach
      // the PM4/register path or become an explicit blocker instead of being
      // silently swallowed.
      return false;
  }
}

uint32_t TitleGpuRingBase() { return g_ring_base; }
uint32_t TitleGpuRingSizeLog2() { return g_ring_size_log2; }
uint32_t TitleGpuRingBytes() {
  return g_ring_base && g_ring_size_log2 < 29u
             ? (uint32_t{1} << (g_ring_size_log2 + 3u))
             : 0u;
}
uint32_t TitleGpuRingWordCapacity() { return TitleGpuRingBytes() / 4u; }
uint32_t TitleGpuWritePointer() { return g_write_pointer; }
uint32_t TitleGpuReadPointerWriteback() { return g_rptr_writeback; }
uint32_t TitleGpuReadPointerBlockSizeLog2() {
  return g_rptr_block_size_log2;
}
uint32_t TitleGpuMmioWrites() { return g_mmio_writes; }
uint32_t TitleGpuStatus() { return g_status; }

uint32_t TitleGpuRingWord(uint32_t index, bool* ok) {
  if (ok) *ok = false;
  const uint32_t capacity = TitleGpuRingWordCapacity();
  if (!capacity || index >= capacity) return 0;
  const uint64_t address64 = uint64_t(g_ring_base) + uint64_t(index) * 4u;
  if (address64 > UINT32_MAX) return 0;
  uint8_t bytes[4] = {};
  if (!ReadSparseGuestMemory(static_cast<uint32_t>(address64), bytes,
                             sizeof(bytes))) {
    return 0;
  }
  const uint32_t value = (uint32_t(bytes[0]) << 24) |
                         (uint32_t(bytes[1]) << 16) |
                         (uint32_t(bytes[2]) << 8) | uint32_t(bytes[3]);
  if (ok) *ok = true;
  if (g_status < 3u) g_status = 3u;
  return value;
}

}  // namespace render360::xenia_web

extern "C" {
void r360_title_gpu_reset() {
  render360::xenia_web::ResetTitleGpuRuntime();
}
uint32_t r360_title_gpu_ring_base() {
  return render360::xenia_web::TitleGpuRingBase();
}
uint32_t r360_title_gpu_ring_size_log2() {
  return render360::xenia_web::TitleGpuRingSizeLog2();
}
uint32_t r360_title_gpu_ring_bytes() {
  return render360::xenia_web::TitleGpuRingBytes();
}
uint32_t r360_title_gpu_ring_word_capacity() {
  return render360::xenia_web::TitleGpuRingWordCapacity();
}
uint32_t r360_title_gpu_write_pointer() {
  return render360::xenia_web::TitleGpuWritePointer();
}
uint32_t r360_title_gpu_rptr_writeback() {
  return render360::xenia_web::TitleGpuReadPointerWriteback();
}
uint32_t r360_title_gpu_rptr_block_size_log2() {
  return render360::xenia_web::TitleGpuReadPointerBlockSizeLog2();
}
uint32_t r360_title_gpu_mmio_writes() {
  return render360::xenia_web::TitleGpuMmioWrites();
}
uint32_t r360_title_gpu_status() {
  return render360::xenia_web::TitleGpuStatus();
}
uint32_t r360_title_gpu_ring_word(uint32_t index, uint32_t* out_value) {
  if (!out_value) return 0u;
  bool ok = false;
  const uint32_t value = render360::xenia_web::TitleGpuRingWord(index, &ok);
  if (!ok) return 0u;
  *out_value = value;
  return 1u;
}
uint32_t r360_title_gpu_mmio_read(uint32_t address, uint32_t* out_value) {
  return render360::xenia_web::ReadTitleGpuMmio(address, out_value) ? 1u : 0u;
}
uint32_t r360_title_gpu_mmio_write(uint32_t address, uint32_t value) {
  return render360::xenia_web::WriteTitleGpuMmio(address, value) ? 1u : 0u;
}
}
