#include "title_gpu_runtime.h"

#include <cstdint>

#include "sparse_guest_memory.h"

extern "C" {
void r360_xenos_reset();
uint32_t r360_xenos_ring_buffer();
uint32_t r360_xenos_ring_capacity();
uint32_t r360_xenos_submit(uint32_t words);
uint32_t r360_xenos_status();
uint32_t r360_xenos_last_fault_word();
}

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
uint32_t g_read_pointer = 0;
uint32_t g_write_pointer = 0;
uint32_t g_rptr_writeback = 0;
uint32_t g_rptr_block_size_log2 = 0;
uint32_t g_mmio_writes = 0;
uint32_t g_xenos_submissions = 0;
uint32_t g_xenos_rejections = 0;
uint32_t g_last_xenos_status = 0;
uint32_t g_last_xenos_fault_word = 0;

bool IsGpuMmio(uint32_t address) {
  return (address & kGpuMmioMask) == kGpuMmioBase;
}

uint32_t RegisterIndex(uint32_t address) {
  return (address & 0xFFFFu) / 4u;
}

uint32_t RingBytesInternal() {
  return g_ring_base && g_ring_size_log2 < 29u
             ? (uint32_t{1} << (g_ring_size_log2 + 3u))
             : 0u;
}

uint32_t RingCapacityInternal() { return RingBytesInternal() / 4u; }

bool ReadRingWordInternal(uint32_t index, uint32_t* out_value) {
  if (!out_value) return false;
  const uint32_t capacity = RingCapacityInternal();
  if (!capacity || index >= capacity) return false;
  const uint64_t address64 = uint64_t(g_ring_base) + uint64_t(index) * 4u;
  if (address64 > UINT32_MAX) return false;
  uint8_t bytes[4] = {};
  if (!ReadSparseGuestMemory(static_cast<uint32_t>(address64), bytes,
                             sizeof(bytes))) {
    return false;
  }
  *out_value = (uint32_t(bytes[0]) << 24) |
               (uint32_t(bytes[1]) << 16) |
               (uint32_t(bytes[2]) << 8) | uint32_t(bytes[3]);
  if (g_status < 3u) g_status = 3u;
  return true;
}

bool PublishReadPointer() {
  if (!g_rptr_writeback) return true;
  const uint8_t bytes[4] = {static_cast<uint8_t>(g_read_pointer >> 24),
                            static_cast<uint8_t>(g_read_pointer >> 16),
                            static_cast<uint8_t>(g_read_pointer >> 8),
                            static_cast<uint8_t>(g_read_pointer)};
  return WriteSparseGuestMemory(g_rptr_writeback, bytes, sizeof(bytes));
}

bool DrainPendingRingToXenos() {
  const uint32_t capacity = RingCapacityInternal();
  if (!capacity || g_read_pointer >= capacity || g_write_pointer >= capacity) {
    ++g_xenos_rejections;
    return false;
  }
  if (g_read_pointer == g_write_pointer) return true;

  const uint32_t pending = g_write_pointer >= g_read_pointer
                               ? g_write_pointer - g_read_pointer
                               : (capacity - g_read_pointer) + g_write_pointer;
  const uint32_t decoder_capacity = r360_xenos_ring_capacity();
  const uint32_t decoder_ptr = r360_xenos_ring_buffer();
  if (!pending || !decoder_ptr || pending > decoder_capacity) {
    ++g_xenos_rejections;
    g_last_xenos_status = r360_xenos_status();
    g_last_xenos_fault_word = r360_xenos_last_fault_word();
    return false;
  }

  auto* decoder = reinterpret_cast<uint32_t*>(static_cast<uintptr_t>(decoder_ptr));
  for (uint32_t i = 0; i < pending; ++i) {
    const uint32_t ring_index = (g_read_pointer + i) % capacity;
    if (!ReadRingWordInternal(ring_index, &decoder[i])) {
      ++g_xenos_rejections;
      return false;
    }
  }

  if (!r360_xenos_submit(pending)) {
    ++g_xenos_rejections;
    g_last_xenos_status = r360_xenos_status();
    g_last_xenos_fault_word = r360_xenos_last_fault_word();
    return false;
  }

  ++g_xenos_submissions;
  g_last_xenos_status = r360_xenos_status();
  g_last_xenos_fault_word = r360_xenos_last_fault_word();
  g_read_pointer = g_write_pointer;
  return PublishReadPointer();
}

void CaptureRing(uint32_t base, uint32_t size_log2) {
  g_ring_base = base;
  g_ring_size_log2 = size_log2;
  g_read_pointer = 0;
  g_write_pointer = 0;
  g_xenos_submissions = 0;
  g_xenos_rejections = 0;
  g_last_xenos_status = 0;
  g_last_xenos_fault_word = 0;
  r360_xenos_reset();
  if (base && size_log2 < 29u) g_status = g_status < 1u ? 1u : g_status;
}

}  // namespace

void ResetTitleGpuRuntime() {
  g_status = 0;
  g_ring_base = 0;
  g_ring_size_log2 = 0;
  g_read_pointer = 0;
  g_write_pointer = 0;
  g_rptr_writeback = 0;
  g_rptr_block_size_log2 = 0;
  g_mmio_writes = 0;
  g_xenos_submissions = 0;
  g_xenos_rejections = 0;
  g_last_xenos_status = 0;
  g_last_xenos_fault_word = 0;
  r360_xenos_reset();
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
      PublishReadPointer();
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
      *value = g_read_pointer;
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
      // GPU consumption is coupled to the real producer MMIO write so guest
      // code polling CP_RB_RPTR can make forward progress while the PPC entry
      // function is still executing. Decoder rejection intentionally leaves
      // RPTR unchanged and is surfaced by Xenos telemetry as the real blocker.
      if (g_ring_base) DrainPendingRingToXenos();
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
uint32_t TitleGpuRingBytes() { return RingBytesInternal(); }
uint32_t TitleGpuRingWordCapacity() { return RingCapacityInternal(); }
uint32_t TitleGpuWritePointer() { return g_write_pointer; }
uint32_t TitleGpuReadPointerWriteback() { return g_rptr_writeback; }
uint32_t TitleGpuReadPointerBlockSizeLog2() {
  return g_rptr_block_size_log2;
}
uint32_t TitleGpuMmioWrites() { return g_mmio_writes; }
uint32_t TitleGpuStatus() { return g_status; }

uint32_t TitleGpuRingWord(uint32_t index, bool* ok) {
  if (ok) *ok = false;
  uint32_t value = 0;
  if (!ReadRingWordInternal(index, &value)) return 0;
  if (ok) *ok = true;
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
