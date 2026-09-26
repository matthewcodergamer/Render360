// Render360 native xboxkrnl/XAM service layer.
//
// Each service below is a port of the matching upstream Xenia export
// (src/xenia/kernel/xboxkrnl/*.cc and src/xenia/kernel/xam/*.cc) onto
// Render360's browser primitives: sparse big-endian guest memory, the native
// guest-thread registry and a cooperative scheduler. Xenia remains the
// semantic source of truth; the comments name the upstream function each case
// follows and call out every place where the browser runtime must differ.
//
// Differences from Xenia that are deliberate:
//  * Xenia terminates the host process for HalReturnToFirmware, KeBugCheck and
//    XamLoaderTerminateTitle. Render360 reports a terminal boundary instead.
//  * Xenia blocks a host thread inside waits. The synchronous PPC probe cannot
//    run another guest thread from inside a kernel call, so an unsatisfiable
//    infinite wait stops at an exact would-block boundary. A bounded wait that
//    cannot be satisfied elapses (STATUS_TIMEOUT), which is a legal outcome.
//  * Kernel pool allocations come from a sparse arena at 0x5A000000 rather than
//    Xenia's system heap in the 0x80000000 XEX range.

#include "kernel_xboxkrnl_services.h"

#include <algorithm>
#include <array>
#include <cstdint>
#include <cstring>
#include <ctime>
#include <map>
#include <string>
#include <vector>

#include "kernel_export_ordinals.h"
#include "kernel_ntstatus_table.h"
#include "sparse_guest_memory.h"

#if defined(__wasm__)
#define R360_WASM_EXPORT(name) __attribute__((used, export_name(name)))
#else
#define R360_WASM_EXPORT(name)
#endif

extern "C" {
uint32_t r360_guest_thread_create(uint32_t entry, uint32_t context,
                                  uint32_t stack_size, uint32_t flags);
uint32_t r360_guest_thread_current();
uint32_t r360_guest_thread_suspend(uint32_t handle);
uint32_t r360_guest_thread_resume(uint32_t handle);
uint32_t r360_guest_thread_terminate(uint32_t handle, uint32_t exit_code);
uint32_t r360_guest_thread_state(uint32_t handle);
uint32_t r360_guest_thread_stack_base(uint32_t handle);
uint32_t r360_guest_thread_stack_top(uint32_t handle);
uint32_t r360_guest_thread_stack_size(uint32_t handle);
uint32_t r360_guest_thread_set_guest_objects(uint32_t handle, uint32_t pcr,
                                             uint32_t kthread, uint32_t arg1,
                                             uint32_t thread_id);
uint32_t r360_guest_thread_kthread(uint32_t handle);
uint32_t r360_guest_thread_external(uint32_t handle);
uint32_t r360_guest_thread_find_by_kthread(uint32_t kthread);
}

namespace render360::xenia_web {
namespace {

namespace kx = ordinals::xboxkrnl;
namespace xam = ordinals::xam;

constexpr uint32_t kModuleXboxkrnl = 1;
constexpr uint32_t kModuleXam = 2;

// NTSTATUS values (xenia/xbox.h).
constexpr uint32_t X_STATUS_SUCCESS = 0x00000000u;
constexpr uint32_t X_STATUS_ABANDONED_WAIT_0 = 0x00000080u;
constexpr uint32_t X_STATUS_TIMEOUT = 0x00000102u;
constexpr uint32_t X_STATUS_OBJECT_NAME_EXISTS = 0x40000000u;
constexpr uint32_t X_STATUS_BUFFER_OVERFLOW = 0x80000005u;
constexpr uint32_t X_STATUS_UNSUCCESSFUL = 0xC0000001u;
constexpr uint32_t X_STATUS_INVALID_HANDLE = 0xC0000008u;
constexpr uint32_t X_STATUS_INVALID_PARAMETER = 0xC000000Du;
constexpr uint32_t X_STATUS_NO_MEMORY = 0xC0000017u;
constexpr uint32_t X_STATUS_BUFFER_TOO_SMALL = 0xC0000023u;
constexpr uint32_t X_STATUS_OBJECT_TYPE_MISMATCH = 0xC0000024u;
constexpr uint32_t X_STATUS_MUTANT_NOT_OWNED = 0xC0000046u;
constexpr uint32_t X_STATUS_SEMAPHORE_LIMIT_EXCEEDED = 0xC0000047u;
constexpr uint32_t X_STATUS_NOT_FOUND = 0xC0000225u;
constexpr uint32_t X_STATUS_INVALID_PARAMETER_1 = 0xC00000EFu;
constexpr uint32_t X_STATUS_INVALID_PARAMETER_2 = 0xC00000F0u;
constexpr uint32_t X_STATUS_INVALID_PARAMETER_3 = 0xC00000F1u;

// Win32 / HRESULT values used by XAM.
constexpr uint32_t X_ERROR_SUCCESS = 0x00000000u;
constexpr uint32_t X_ERROR_INVALID_PARAMETER = 0x00000057u;
constexpr uint32_t X_ERROR_BAD_ARGUMENTS = 0x000000A0u;
constexpr uint32_t X_ERROR_DEVICE_NOT_CONNECTED = 0x0000048Fu;
constexpr uint32_t X_ERROR_NOT_FOUND = 0x00000490u;
constexpr uint32_t X_ERROR_NO_SUCH_USER = 0x00000525u;
constexpr uint32_t X_E_SUCCESS = 0x00000000u;
constexpr uint32_t X_E_INVALIDARG = 0x80070057u;
constexpr uint32_t X_E_NO_SUCH_USER = 0x80070525u;

constexpr uint32_t kPageSize = 4096u;
constexpr uint32_t kCurrentThreadPseudoHandle = 0xFFFFFFFEu;
constexpr uint32_t kCurrentProcessPseudoHandle = 0xFFFFFFFFu;

// Dispatcher object types (X_DISPATCH_HEADER::type).
constexpr uint8_t kDispNotificationEvent = 0;
constexpr uint8_t kDispSynchronizationEvent = 1;
constexpr uint8_t kDispMutant = 2;
constexpr uint8_t kDispSemaphore = 5;
constexpr uint8_t kDispThread = 6;
constexpr uint8_t kDispNotificationTimer = 8;
constexpr uint8_t kDispSynchronizationTimer = 9;

// XEX optional header keys.
constexpr uint32_t kXexHeaderResourceInfo = 0x000002FFu;
constexpr uint32_t kXexHeaderEntryPoint = 0x00010100u;
constexpr uint32_t kXexHeaderTlsInfo = 0x00020104u;
constexpr uint32_t kXexHeaderDefaultStackSize = 0x00020200u;
constexpr uint32_t kXexHeaderSystemFlags = 0x00030000u;
constexpr uint32_t kXexHeaderExecutionInfo = 0x00040006u;

// Kernel pool arena. Sparse pages are mapped on first use.
constexpr uint32_t kPoolBase = 0x5A000000u;
constexpr uint32_t kPoolEnd = 0x5F000000u;

// ---------------------------------------------------------------------------
// Guest memory helpers (big-endian, sparse, fail-closed).

bool Rd(uint32_t address, void* out, uint32_t size) {
  return ReadSparseGuestMemory(address, out, size);
}
bool Wr(uint32_t address, const void* data, uint32_t size) {
  return WriteSparseGuestMemory(address, data, size);
}
bool Rd8(uint32_t a, uint8_t* v) { return Rd(a, v, 1); }
bool Rd16(uint32_t a, uint16_t* v) {
  uint8_t b[2];
  if (!Rd(a, b, 2)) return false;
  *v = uint16_t((b[0] << 8) | b[1]);
  return true;
}
bool Rd32(uint32_t a, uint32_t* v) {
  uint8_t b[4];
  if (!Rd(a, b, 4)) return false;
  *v = (uint32_t(b[0]) << 24) | (uint32_t(b[1]) << 16) | (uint32_t(b[2]) << 8) |
       uint32_t(b[3]);
  return true;
}
bool Rd64(uint32_t a, uint64_t* v) {
  uint32_t hi = 0, lo = 0;
  if (!Rd32(a, &hi) || !Rd32(a + 4u, &lo)) return false;
  *v = (uint64_t(hi) << 32) | lo;
  return true;
}
bool Wr8(uint32_t a, uint8_t v) { return Wr(a, &v, 1); }
bool Wr16(uint32_t a, uint16_t v) {
  const uint8_t b[2] = {uint8_t(v >> 8), uint8_t(v)};
  return Wr(a, b, 2);
}
bool Wr32(uint32_t a, uint32_t v) {
  const uint8_t b[4] = {uint8_t(v >> 24), uint8_t(v >> 16), uint8_t(v >> 8),
                        uint8_t(v)};
  return Wr(a, b, 4);
}
bool Wr64(uint32_t a, uint64_t v) {
  return Wr32(a, uint32_t(v >> 32)) && Wr32(a + 4u, uint32_t(v));
}
bool WrF32(uint32_t a, float f) {
  uint32_t bits = 0;
  std::memcpy(&bits, &f, sizeof(bits));
  return Wr32(a, bits);
}
bool ZeroGuest(uint32_t address, uint32_t size) {
  static const uint8_t zeros[256] = {};
  while (size) {
    const uint32_t chunk = std::min<uint32_t>(size, sizeof(zeros));
    if (!Wr(address, zeros, chunk)) return false;
    address += chunk;
    size -= chunk;
  }
  return true;
}
bool FillGuest32(uint32_t address, uint32_t count, uint32_t value) {
  for (uint32_t i = 0; i < count; ++i) {
    if (!Wr32(address + i * 4u, value)) return false;
  }
  return true;
}
bool CopyGuest(uint32_t dst, uint32_t src, uint32_t size) {
  uint8_t buffer[512];
  while (size) {
    const uint32_t chunk = std::min<uint32_t>(size, sizeof(buffer));
    if (!Rd(src, buffer, chunk) || !Wr(dst, buffer, chunk)) return false;
    dst += chunk;
    src += chunk;
    size -= chunk;
  }
  return true;
}
bool ReadCString(uint32_t address, std::string* out, uint32_t max = 4096) {
  out->clear();
  if (!address) return false;
  for (uint32_t i = 0; i < max; ++i) {
    uint8_t c = 0;
    if (!Rd8(address + i, &c)) return false;
    if (!c) return true;
    out->push_back(char(c));
  }
  return true;
}
bool ReadU16String(uint32_t address, std::u16string* out, uint32_t max = 4096) {
  out->clear();
  if (!address) return false;
  for (uint32_t i = 0; i < max; ++i) {
    uint16_t c = 0;
    if (!Rd16(address + i * 2u, &c)) return false;
    if (!c) return true;
    out->push_back(char16_t(c));
  }
  return true;
}
std::string Utf16ToUtf8(const std::u16string& in) {
  std::string out;
  for (size_t i = 0; i < in.size(); ++i) {
    uint32_t cp = in[i];
    if (cp >= 0xD800 && cp <= 0xDBFF && i + 1 < in.size() &&
        in[i + 1] >= 0xDC00 && in[i + 1] <= 0xDFFF) {
      cp = 0x10000u + ((cp - 0xD800u) << 10) + (in[i + 1] - 0xDC00u);
      ++i;
    }
    if (cp < 0x80) {
      out.push_back(char(cp));
    } else if (cp < 0x800) {
      out.push_back(char(0xC0 | (cp >> 6)));
      out.push_back(char(0x80 | (cp & 0x3F)));
    } else if (cp < 0x10000) {
      out.push_back(char(0xE0 | (cp >> 12)));
      out.push_back(char(0x80 | ((cp >> 6) & 0x3F)));
      out.push_back(char(0x80 | (cp & 0x3F)));
    } else {
      out.push_back(char(0xF0 | (cp >> 18)));
      out.push_back(char(0x80 | ((cp >> 12) & 0x3F)));
      out.push_back(char(0x80 | ((cp >> 6) & 0x3F)));
      out.push_back(char(0x80 | (cp & 0x3F)));
    }
  }
  return out;
}
uint32_t RoundUp(uint32_t value, uint32_t alignment) {
  return (value + alignment - 1u) & ~(alignment - 1u);
}

// ---------------------------------------------------------------------------
// Title/kernel state installed by the browser loader.

struct ExecutableModule {
  uint32_t hmodule = 0;
  uint32_t xex_header = 0;
};
ExecutableModule g_exe;
uint32_t g_process_info_block = 0;
uint32_t g_caller_r13 = 0;
uint32_t g_caller_lr = 0;
uint32_t g_caller_r1 = 0;
uint32_t g_irql = 0;
uint32_t g_next_thread_id = 2;  // The primary thread is thread id 1.
uint64_t g_virtual_time_100ns = 0;
uint32_t g_timestamp_bundle = 0;
uint64_t g_uptime_origin_ms = 0;
uint32_t g_graphics_interrupt_callback = 0;
uint32_t g_graphics_interrupt_user_data = 0;

struct TerminalInfo {
  uint32_t kind = kTerminalNone;
  uint32_t code = 0;
  uint32_t ordinal = 0;
  uint32_t module = 0;
  uint32_t lr = 0;
  std::array<uint32_t, 4> args{};
};
TerminalInfo g_terminal;

struct WaitInfo {
  uint32_t ordinal = 0;
  uint32_t module = 0;
  uint32_t object = 0;
  uint32_t handle = 0;
  uint32_t object_type = 0;
  uint32_t reason = 0;  // 1 infinite wait, 2 spinning bounded wait, 3 lock.
};
WaitInfo g_wait;

struct TimeoutSpin {
  uint32_t object = 0;
  uint32_t count = 0;
};
TimeoutSpin g_timeout_spin;
constexpr uint32_t kMaxConsecutiveTimeouts = 4096;

// The published bootstrap is linked with --no-entry and never runs C++ global
// constructors, so every non-trivially-constructible container is a
// function-local static constructed on first use.
std::vector<std::string>& DebugLogEntries() {
  static std::vector<std::string> entries;
  return entries;
}
constexpr size_t kMaxDebugLog = 64;
uint32_t g_debug_log_total = 0;

void DebugLog(std::string text) {
  if (text.size() > 512) text.resize(512);
  ++g_debug_log_total;
  if (DebugLogEntries().size() >= kMaxDebugLog) DebugLogEntries().erase(DebugLogEntries().begin());
  DebugLogEntries().push_back(std::move(text));
}

struct InputPad {
  bool connected = false;
  uint32_t packet = 0;
  uint16_t buttons = 0;
  uint8_t left_trigger = 0;
  uint8_t right_trigger = 0;
  int16_t thumb_lx = 0, thumb_ly = 0, thumb_rx = 0, thumb_ry = 0;
  uint16_t vibration_left = 0, vibration_right = 0;
};
// Render360 exposes one controller (touch overlay or physical gamepad) as
// user 0. The browser updates it through r360_input_set_gamepad.
std::array<InputPad, 4>& Input() {
  static std::array<InputPad, 4> pads = [] {
    std::array<InputPad, 4> initial{};
    initial[0].connected = true;
    return initial;
  }();
  return pads;
}

// ---------------------------------------------------------------------------
// Time. Xbox system time is a FILETIME (100 ns ticks since 1601-01-01).

constexpr uint64_t kUnixEpochAsFileTime = 116444736000000000ull;

uint64_t QueryGuestSystemTime() {
  struct timespec ts {};
  clock_gettime(CLOCK_REALTIME, &ts);
  const uint64_t unix_100ns =
      uint64_t(ts.tv_sec) * 10000000ull + uint64_t(ts.tv_nsec) / 100ull;
  return kUnixEpochAsFileTime + unix_100ns + g_virtual_time_100ns;
}

uint64_t MonotonicMillis() {
  struct timespec ts {};
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return uint64_t(ts.tv_sec) * 1000ull + uint64_t(ts.tv_nsec) / 1000000ull;
}

// KeTimeStampBundle.tick_count (+0x10) is a millisecond uptime counter that
// Xenia refreshes from a 1 ms host timer. Refresh it on every kernel entry.
void RefreshTimeStampBundle() {
  if (!g_timestamp_bundle) return;
  const uint64_t now = MonotonicMillis();
  if (!g_uptime_origin_ms) g_uptime_origin_ms = now;
  const uint64_t uptime = now - g_uptime_origin_ms + g_virtual_time_100ns / 10000ull;
  Wr32(g_timestamp_bundle + 0x10u, uint32_t(uptime));
}

void AdvanceVirtualTime(uint64_t timeout_value) {
  // Negative intervals are relative; positive values are absolute FILETIMEs.
  const int64_t signed_value = int64_t(timeout_value);
  if (signed_value < 0) {
    g_virtual_time_100ns += uint64_t(-signed_value);
  } else if (signed_value > 0) {
    const uint64_t now = QueryGuestSystemTime();
    if (timeout_value > now) g_virtual_time_100ns += timeout_value - now;
  }
}

// Howard Hinnant's civil-from-days / days-from-civil algorithms.
int64_t DaysFromCivil(int64_t y, uint32_t m, uint32_t d) {
  y -= m <= 2;
  const int64_t era = (y >= 0 ? y : y - 399) / 400;
  const uint32_t yoe = uint32_t(y - era * 400);
  const uint32_t doy = (153 * (m + (m > 2 ? -3 : 9)) + 2) / 5 + d - 1;
  const uint32_t doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
  return era * 146097 + int64_t(doe) - 719468;
}
void CivilFromDays(int64_t z, int64_t* y, uint32_t* m, uint32_t* d) {
  z += 719468;
  const int64_t era = (z >= 0 ? z : z - 146096) / 146097;
  const uint32_t doe = uint32_t(z - era * 146097);
  const uint32_t yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
  const uint32_t doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
  const uint32_t mp = (5 * doy + 2) / 153;
  *d = doy - (153 * mp + 2) / 5 + 1;
  *m = mp < 10 ? mp + 3 : mp - 9;
  *y = int64_t(yoe) + era * 400 + (*m <= 2);
}
// Days between 1601-01-01 and 1970-01-01.
constexpr int64_t kDays1601To1970 = 134774;

// ---------------------------------------------------------------------------
// XEX optional headers (same semantics as RtlImageXexHeaderField).

bool XexOptionalHeader(uint32_t key, uint32_t* out) {
  *out = 0;
  if (!g_exe.xex_header) return false;
  uint32_t magic = 0, header_size = 0, count = 0;
  if (!Rd32(g_exe.xex_header, &magic) || magic != 0x58455832u ||
      !Rd32(g_exe.xex_header + 8u, &header_size) ||
      !Rd32(g_exe.xex_header + 0x14u, &count) || count > 4096u) {
    return false;
  }
  for (uint32_t i = 0; i < count; ++i) {
    const uint32_t entry = g_exe.xex_header + 0x18u + i * 8u;
    uint32_t k = 0, v = 0;
    if (!Rd32(entry, &k) || !Rd32(entry + 4u, &v)) return false;
    if (k != key) continue;
    switch (k & 0xFFu) {
      case 0x00u:
        *out = v;
        break;
      case 0x01u:
        *out = entry + 4u;
        break;
      default:
        *out = g_exe.xex_header + v;
        break;
    }
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Kernel pool (Xenia SystemHeapAlloc equivalent).

std::map<uint32_t, uint32_t>& PoolUsed() {
  static std::map<uint32_t, uint32_t> used;
  return used;
}
std::map<uint32_t, uint32_t>& PoolFreeList() {
  static std::map<uint32_t, uint32_t> free_list;
  return free_list;
}
uint32_t g_pool_top = kPoolBase;

bool EnsureMapped(uint32_t address, uint32_t size) {
  const uint32_t first = address & ~(kPageSize - 1u);
  const uint64_t end = uint64_t(address) + size;
  uint32_t page = first;
  while (uint64_t(page) < end) {
    if (SparseGuestMemoryPageMapped(page)) {
      page += kPageSize;
      continue;
    }
    uint32_t run = 0;
    uint32_t cursor = page;
    while (uint64_t(cursor) < end && !SparseGuestMemoryPageMapped(cursor)) {
      ++run;
      cursor += kPageSize;
    }
    const uint32_t backing = AllocateSparseGuestBacking(run);
    if (!backing ||
        !MapSparseGuestMemory(page, run, backing, 0, kGuestRead | kGuestWrite)) {
      return false;
    }
    page = cursor;
  }
  return true;
}

void PoolInsertFree(uint32_t address, uint32_t size) {
  if (!size) return;
  auto next = PoolFreeList().lower_bound(address);
  if (next != PoolFreeList().end() && address + size == next->first) {
    size += next->second;
    next = PoolFreeList().erase(next);
  }
  if (next != PoolFreeList().begin()) {
    auto prev = std::prev(next);
    if (prev->first + prev->second == address) {
      prev->second += size;
      return;
    }
  }
  PoolFreeList()[address] = size;
}

uint32_t PoolAlloc(uint32_t size, uint32_t alignment = 16u) {
  if (!size) size = 1;
  if (alignment < 16u) alignment = 16u;
  size = RoundUp(size, 16u);
  for (auto it = PoolFreeList().begin(); it != PoolFreeList().end(); ++it) {
    const uint32_t block = it->first, block_size = it->second;
    const uint32_t aligned = RoundUp(block, alignment);
    if (uint64_t(aligned) + size > uint64_t(block) + block_size) continue;
    PoolFreeList().erase(it);
    PoolInsertFree(block, aligned - block);
    PoolInsertFree(aligned + size, block + block_size - (aligned + size));
    if (!EnsureMapped(aligned, size) || !ZeroGuest(aligned, size)) return 0;
    PoolUsed()[aligned] = size;
    return aligned;
  }
  const uint32_t aligned = RoundUp(g_pool_top, alignment);
  if (uint64_t(aligned) + size > kPoolEnd) return 0;
  if (!EnsureMapped(aligned, size) || !ZeroGuest(aligned, size)) return 0;
  PoolInsertFree(g_pool_top, aligned - g_pool_top);
  g_pool_top = aligned + size;
  PoolUsed()[aligned] = size;
  return aligned;
}

bool PoolFree(uint32_t address) {
  auto it = PoolUsed().find(address);
  if (it == PoolUsed().end()) return false;
  const uint32_t size = it->second;
  PoolUsed().erase(it);
  PoolInsertFree(address, size);
  return true;
}

uint32_t PoolBlockSize(uint32_t address) {
  auto it = PoolUsed().find(address);
  return it == PoolUsed().end() ? 0u : it->second;
}

// ---------------------------------------------------------------------------
// Physical memory (MmAllocatePhysicalMemoryEx). Xenia allocates top-down from
// the vA0000000 (64 KiB), vC0000000 (16 MiB) and vE0000000 (4 KiB) views of
// the shared 512 MiB physical heap.

struct PhysicalAllocation {
  uint32_t virtual_address = 0;
  uint32_t physical_address = 0;
  uint32_t size = 0;
  uint32_t page_size = 0;
  uint32_t protect = 0;
};
std::map<uint32_t, PhysicalAllocation>& PhysicalByVirtual() {
  static std::map<uint32_t, PhysicalAllocation> allocations;
  return allocations;
}
std::map<uint32_t, uint32_t>& PhysicalRanges() {  // physical base -> size
  static std::map<uint32_t, uint32_t> ranges;
  return ranges;
}

uint32_t PhysicalViewBase(uint32_t page_size) {
  if (page_size <= 4096u) return 0xE0000000u;
  if (page_size <= 65536u) return 0xA0000000u;
  return 0xC0000000u;
}
// PhysicalHeap::GetPhysicalAddress: the vE0000000 view is offset by 0x1000.
uint32_t PhysicalViewOffset(uint32_t page_size) {
  return page_size <= 4096u ? 0x1000u : 0u;
}

bool PhysicalRangeFree(uint32_t base, uint32_t size) {
  const uint64_t end = uint64_t(base) + size;
  for (const auto& [b, s] : PhysicalRanges()) {
    if (uint64_t(base) < uint64_t(b) + s && uint64_t(b) < end) return false;
  }
  return true;
}

uint32_t AllocatePhysical(uint32_t size, uint32_t protect_bits,
                          uint32_t min_address, uint32_t max_address,
                          uint32_t alignment) {
  // Xenia: protect must include READONLY or READWRITE.
  if (!(protect_bits & (0x02u | 0x04u))) return 0;
  uint32_t page_size = 4096u;
  if (protect_bits & 0x20000000u) {
    page_size = 64u * 1024u;
  } else if (protect_bits & 0x80000000u) {
    page_size = 16u * 1024u * 1024u;
  }
  if (!size) return 0;
  const uint64_t adjusted64 = (uint64_t(size) + page_size - 1u) & ~uint64_t(page_size - 1u);
  if (adjusted64 > 0x20000000ull) return 0;
  const uint32_t adjusted_size = uint32_t(adjusted64);
  const uint32_t adjusted_alignment =
      std::max(page_size, RoundUp(alignment ? alignment : 1u, page_size));
  const uint32_t view_base = PhysicalViewBase(page_size);
  const uint32_t view_offset = PhysicalViewOffset(page_size);
  const uint32_t view_size = page_size <= 4096u ? 0x1FD00000u : 0x20000000u;
  // min/max are physical bounds; clamp them into this view's physical span.
  uint64_t low = std::max<uint64_t>(min_address, view_offset);
  uint64_t high = std::min<uint64_t>(uint64_t(max_address ? max_address : 0x1FFFFFFFu),
                                     uint64_t(view_offset) + view_size - 1u);
  if (high < low || high - low + 1 < adjusted_size) return 0;
  // Top-down placement, as Xenia's MmAllocatePhysicalMemoryEx requests.
  uint64_t candidate = (high + 1 - adjusted_size) & ~uint64_t(adjusted_alignment - 1u);
  while (candidate >= low) {
    if (PhysicalRangeFree(uint32_t(candidate), adjusted_size)) {
      const uint32_t physical = uint32_t(candidate);
      const uint32_t virtual_address = view_base + physical - view_offset;
      if (!EnsureMapped(virtual_address, adjusted_size) ||
          !ZeroGuest(virtual_address, adjusted_size)) {
        return 0;
      }
      PhysicalRanges()[physical] = adjusted_size;
      PhysicalByVirtual()[virtual_address] = {virtual_address, physical,
                                                adjusted_size, page_size,
                                                protect_bits};
      return virtual_address;
    }
    if (candidate < adjusted_alignment) break;
    candidate -= adjusted_alignment;
  }
  return 0;
}

const PhysicalAllocation* FindPhysical(uint32_t address) {
  auto it = PhysicalByVirtual().upper_bound(address);
  if (it == PhysicalByVirtual().begin()) return nullptr;
  --it;
  const auto& a = it->second;
  return address - a.virtual_address < a.size ? &a : nullptr;
}

// ---------------------------------------------------------------------------
// Object table (Xenia ObjectTable). Handles are 0xF8000000 + slot * 4.

enum class ObjectType : uint8_t {
  kNone,
  kEvent,
  kSemaphore,
  kMutant,
  kTimer,
  kThread,
  kNotifyListener,
};

struct KernelObject {
  bool used = false;
  ObjectType type = ObjectType::kNone;
  uint32_t guest = 0;          // Guest dispatcher object / KTHREAD.
  uint32_t handle_count = 0;   // Open handles.
  uint32_t pointer_count = 0;  // ObReferenceObject* references.
  uint32_t thread = 0;         // Native guest-thread registry handle.
  bool owns_guest = false;     // Guest struct allocated from the pool.
  std::string name;
  // Timer state.
  uint64_t due_time = 0;
  uint32_t period_ms = 0;
  bool armed = false;
};

constexpr uint32_t kHandleBase = 0xF8000000u;
constexpr uint32_t kMaxObjects = 4096u;
std::vector<KernelObject>& Objects() {
  static std::vector<KernelObject> objects;
  return objects;
}

uint32_t HandleForSlot(uint32_t slot) { return kHandleBase + (slot << 2); }
bool SlotForHandle(uint32_t handle, uint32_t* slot) {
  if (handle < kHandleBase || (handle & 3u)) return false;
  const uint32_t s = (handle - kHandleBase) >> 2;
  if (s >= Objects().size() || !Objects()[s].used) return false;
  *slot = s;
  return true;
}

uint32_t CreateObject(ObjectType type, uint32_t guest, bool owns_guest,
                      const std::string& name = std::string()) {
  for (uint32_t i = 0; i < Objects().size(); ++i) {
    if (!Objects()[i].used) {
      Objects()[i] = {};
      Objects()[i].used = true;
      Objects()[i].type = type;
      Objects()[i].guest = guest;
      Objects()[i].owns_guest = owns_guest;
      Objects()[i].handle_count = 1;
      Objects()[i].name = name;
      return HandleForSlot(i);
    }
  }
  if (Objects().size() >= kMaxObjects) return 0;
  KernelObject object;
  object.used = true;
  object.type = type;
  object.guest = guest;
  object.owns_guest = owns_guest;
  object.handle_count = 1;
  object.name = name;
  Objects().push_back(object);
  return HandleForSlot(uint32_t(Objects().size() - 1u));
}

KernelObject* FindObjectByGuest(uint32_t guest) {
  for (auto& object : Objects()) {
    if (object.used && object.guest == guest) return &object;
  }
  return nullptr;
}

KernelObject* FindObjectByName(const std::string& name) {
  if (name.empty()) return nullptr;
  for (auto& object : Objects()) {
    if (object.used && object.name == name) return &object;
  }
  return nullptr;
}

void MaybeDestroyObject(uint32_t slot) {
  auto& object = Objects()[slot];
  if (!object.used || object.handle_count || object.pointer_count) return;
  if (object.owns_guest && object.guest) PoolFree(object.guest);
  object = {};
}

// Current thread identity: the KTHREAD pointer at KPCR+0x100, exactly as the
// Xbox kernel derives it from r13.
uint32_t CurrentKThread() {
  if (g_caller_r13) {
    uint32_t kthread = 0;
    if (Rd32(g_caller_r13 + 0x100u, &kthread) && kthread) return kthread;
  }
  const uint32_t native = r360_guest_thread_current();
  if (native) {
    const uint32_t kthread = r360_guest_thread_kthread(native);
    if (kthread) return kthread;
    return native;
  }
  return 0;
}

uint32_t NativeThreadForKThread(uint32_t kthread) {
  if (!kthread) return 0;
  return r360_guest_thread_find_by_kthread(kthread);
}

KernelObject* ResolveHandle(uint32_t handle) {
  if (handle == kCurrentThreadPseudoHandle) {
    const uint32_t kthread = CurrentKThread();
    if (!kthread) return nullptr;
    if (auto* existing = FindObjectByGuest(kthread)) return existing;
    const uint32_t created = CreateObject(ObjectType::kThread, kthread, false);
    uint32_t slot = 0;
    if (!created || !SlotForHandle(created, &slot)) return nullptr;
    Objects()[slot].handle_count = 0;  // Pseudo handles are not owned.
    Objects()[slot].pointer_count = 1;  // Keep the thread object alive.
    Objects()[slot].thread = NativeThreadForKThread(kthread);
    return &Objects()[slot];
  }
  uint32_t slot = 0;
  return SlotForHandle(handle, &slot) ? &Objects()[slot] : nullptr;
}

std::string ObjectAttributesName(uint32_t attributes_ptr) {
  // X_OBJECT_ATTRIBUTES { root_directory, name_ptr (X_ANSI_STRING*), attributes }
  if (!attributes_ptr) return std::string();
  uint32_t name_ptr = 0;
  if (!Rd32(attributes_ptr + 4u, &name_ptr) || !name_ptr) return std::string();
  uint16_t length = 0;
  uint32_t buffer = 0;
  if (!Rd16(name_ptr, &length) || !Rd32(name_ptr + 4u, &buffer) || !buffer) {
    return std::string();
  }
  std::string name(length, '\0');
  if (length && !Rd(buffer, name.data(), length)) return std::string();
  return name;
}

// ---------------------------------------------------------------------------
// Dispatcher objects in guest memory (X_DISPATCH_HEADER).

bool ReadDispatcher(uint32_t object, uint8_t* type, int32_t* signal_state) {
  uint32_t state = 0;
  if (!Rd8(object, type) || !Rd32(object + 4u, &state)) return false;
  *signal_state = int32_t(state);
  return true;
}

bool InitDispatcher(uint32_t object, uint8_t type, uint32_t size_bytes,
                    int32_t signal_state) {
  if (!ZeroGuest(object, 16)) return false;
  // Wait list heads point at themselves when empty.
  return Wr8(object, type) && Wr8(object + 2u, uint8_t(size_bytes / 4u)) &&
         Wr32(object + 4u, uint32_t(signal_state)) &&
         Wr32(object + 8u, object + 8u) && Wr32(object + 12u, object + 8u);
}

uint32_t ThreadStateForKThread(uint32_t kthread) {
  const uint32_t native = NativeThreadForKThread(kthread);
  return native ? r360_guest_thread_state(native) : 0u;
}

// Returns true when a wait on |object| can be satisfied right now.
bool DispatcherSignaled(uint32_t object, bool* known) {
  *known = true;
  uint8_t type = 0;
  int32_t state = 0;
  if (!ReadDispatcher(object, &type, &state)) {
    *known = false;
    return false;
  }
  switch (type) {
    case kDispNotificationEvent:
    case kDispSynchronizationEvent:
    case kDispNotificationTimer:
    case kDispSynchronizationTimer:
      return state != 0;
    case kDispSemaphore:
      return state > 0;
    case kDispMutant: {
      uint32_t owner = 0;
      Rd32(object + 0x18u, &owner);
      return state > 0 || owner == CurrentKThread();
    }
    case kDispThread:
      return state != 0 || ThreadStateForKThread(object) == 4u;
    default:
      *known = false;
      return false;
  }
}

void ConsumeSignal(uint32_t object) {
  uint8_t type = 0;
  int32_t state = 0;
  if (!ReadDispatcher(object, &type, &state)) return;
  switch (type) {
    case kDispSynchronizationEvent:
    case kDispSynchronizationTimer:
      Wr32(object + 4u, 0);
      break;
    case kDispSemaphore:
      Wr32(object + 4u, uint32_t(state - 1));
      break;
    case kDispMutant: {
      // KMUTANT: header, +0x10 list entry, +0x18 owner, +0x1C abandoned.
      Wr32(object + 4u, uint32_t(state - 1));
      Wr32(object + 0x18u, CurrentKThread());
      break;
    }
    default:
      break;
  }
}

void UpdateTimer(KernelObject& object) {
  if (object.type != ObjectType::kTimer || !object.armed) return;
  if (QueryGuestSystemTime() < object.due_time) return;
  Wr32(object.guest + 4u, 1);
  if (object.period_ms) {
    object.due_time += uint64_t(object.period_ms) * 10000ull;
  } else {
    object.armed = false;
  }
}

void UpdateTimerByGuest(uint32_t guest) {
  if (auto* object = FindObjectByGuest(guest)) UpdateTimer(*object);
}

// ---------------------------------------------------------------------------
// Service outcome plumbing.

uint32_t g_status = kKernelServiceSuccess;
bool g_handled = true;

uint32_t Terminal(uint32_t kind, uint32_t code, uint32_t module,
                  uint32_t ordinal, const uint32_t* args) {
  g_terminal = {};
  g_terminal.kind = kind;
  g_terminal.code = code;
  g_terminal.module = module;
  g_terminal.ordinal = ordinal;
  g_terminal.lr = g_caller_lr;
  for (uint32_t i = 0; i < g_terminal.args.size(); ++i) g_terminal.args[i] = args[i];
  g_status = kKernelServiceTerminal;
  return 0;
}

uint32_t WouldBlock(uint32_t module, uint32_t ordinal, uint32_t object,
                    uint32_t handle, uint32_t reason) {
  g_wait = {};
  g_wait.module = module;
  g_wait.ordinal = ordinal;
  g_wait.object = object;
  g_wait.handle = handle;
  g_wait.reason = reason;
  uint8_t type = 0xFF;
  if (object) Rd8(object, &type);
  g_wait.object_type = type;
  g_status = kKernelServiceWouldBlock;
  return 0;
}

uint32_t Invalid() {
  g_status = kKernelServiceInvalid;
  return 0;
}

// Arguments beyond r3..r10 live in the caller's parameter save area. Xenia's
// shim reads dword argument n (n >= 8) at r1 + 0x54 + (n - 8) * 8.
bool StackArg(uint32_t index, uint32_t* value) {
  if (index < 8 || !g_caller_r1) return false;
  return Rd32(g_caller_r1 + 0x54u + (index - 8u) * 8u, value);
}

// Wait on guest dispatcher objects (Xenia XObject::Wait / WaitMultiple).
// |timeout_ptr| == 0 means infinite. Returns the NTSTATUS for the guest.
uint32_t WaitObjects(uint32_t module, uint32_t ordinal,
                     const std::vector<uint32_t>& objects,
                     const std::vector<uint32_t>& handles, bool wait_all,
                     uint32_t timeout_ptr) {
  if (objects.empty() || objects.size() > 64) return X_STATUS_INVALID_PARAMETER;
  for (uint32_t object : objects) UpdateTimerByGuest(object);
  std::vector<bool> signaled(objects.size());
  for (size_t i = 0; i < objects.size(); ++i) {
    bool known = false;
    signaled[i] = DispatcherSignaled(objects[i], &known);
    if (!known) return Invalid();
  }
  if (wait_all) {
    if (std::all_of(signaled.begin(), signaled.end(), [](bool b) { return b; })) {
      for (uint32_t object : objects) ConsumeSignal(object);
      g_timeout_spin = {};
      return X_STATUS_SUCCESS;
    }
  } else {
    for (size_t i = 0; i < objects.size(); ++i) {
      if (!signaled[i]) continue;
      ConsumeSignal(objects[i]);
      g_timeout_spin = {};
      return X_STATUS_SUCCESS + uint32_t(i);
    }
  }
  const uint32_t first_blocked = objects.front();
  const uint32_t first_handle = handles.empty() ? 0u : handles.front();
  if (!timeout_ptr) {
    return WouldBlock(module, ordinal, first_blocked, first_handle, 1);
  }
  uint64_t timeout = 0;
  if (!Rd64(timeout_ptr, &timeout)) return Invalid();
  if (timeout) {
    // No other guest thread can signal during this synchronous kernel call, so
    // a bounded wait elapses. Detect a guest spinning on the same unsignalled
    // object so the probe reports the wait rather than burning its budget.
    if (g_timeout_spin.object == first_blocked) {
      if (++g_timeout_spin.count >= kMaxConsecutiveTimeouts) {
        g_timeout_spin = {};
        return WouldBlock(module, ordinal, first_blocked, first_handle, 2);
      }
    } else {
      g_timeout_spin = {first_blocked, 1};
    }
    AdvanceVirtualTime(timeout);
  }
  return X_STATUS_TIMEOUT;
}

bool GuestObjectForHandle(uint32_t handle, uint32_t* guest) {
  KernelObject* object = ResolveHandle(handle);
  if (!object || !object->guest) return false;
  *guest = object->guest;
  return true;
}

// ---------------------------------------------------------------------------
// Threads (Xenia XThread::Create / InitializeGuestObject).

struct TlsLayout {
  uint32_t slots = 1024;
  uint32_t data_size = 0;
  uint32_t raw_address = 0;
  uint32_t raw_size = 0;
};

TlsLayout ExecutableTlsLayout() {
  TlsLayout layout;
  uint32_t tls = 0;
  if (XexOptionalHeader(kXexHeaderTlsInfo, &tls) && tls) {
    uint32_t slot_count = 0;
    Rd32(tls + 0x0u, &slot_count);
    Rd32(tls + 0x4u, &layout.raw_address);
    Rd32(tls + 0x8u, &layout.data_size);
    Rd32(tls + 0xCu, &layout.raw_size);
    if (slot_count) layout.slots = slot_count;
  }
  return layout;
}

uint32_t ExecutableStackSize() {
  uint32_t size = 0;
  XexOptionalHeader(kXexHeaderDefaultStackSize, &size);
  return size ? size : 0x40000u;
}

bool InitializeKThread(uint32_t kthread, uint32_t stack_base,
                       uint32_t stack_limit, uint32_t tls_address,
                       uint32_t thread_id, uint32_t start_address,
                       uint32_t creation_flags) {
  if (!ZeroGuest(kthread, 0xAB0u)) return false;
  bool ok = Wr8(kthread + 0x00u, kDispThread) &&
            Wr8(kthread + 0xBCu, (creation_flags & 1u) ? 1u : 0u);
  const auto self = [&](uint32_t off, uint32_t target) {
    ok = ok && Wr32(kthread + off, kthread + target);
  };
  self(0x008u, 0x008u);  // Dispatcher wait list head.
  self(0x00Cu, 0x008u);
  self(0x010u, 0x010u);
  self(0x014u, 0x010u);
  self(0x040u, 0x020u);
  self(0x044u, 0x020u);
  self(0x048u, 0x000u);
  self(0x04Cu, 0x018u);
  ok = ok && Wr16(kthread + 0x054u, 0x102u) && Wr16(kthread + 0x056u, 1u) &&
       Wr32(kthread + 0x05Cu, stack_base) && Wr32(kthread + 0x060u, stack_limit) &&
       Wr32(kthread + 0x068u, tls_address);
  self(0x074u, 0x074u);
  self(0x078u, 0x074u);
  self(0x07Cu, 0x07Cu);
  self(0x080u, 0x07Cu);
  ok = ok && Wr32(kthread + 0x084u, g_process_info_block) &&
       Wr8(kthread + 0x08Bu, 1) && Wr32(kthread + 0x09Cu, 0xFDFFD7FFu) &&
       Wr32(kthread + 0x0D0u, stack_base) &&
       Wr64(kthread + 0x130u, QueryGuestSystemTime());
  self(0x144u, 0x144u);
  self(0x148u, 0x144u);
  ok = ok && Wr32(kthread + 0x14Cu, thread_id) &&
       Wr32(kthread + 0x150u, start_address);
  self(0x154u, 0x154u);
  self(0x158u, 0x154u);
  ok = ok && Wr32(kthread + 0x160u, 0) &&
       Wr32(kthread + 0x16Cu, creation_flags) && Wr32(kthread + 0x17Cu, 1u);
  return ok;
}

// Allocates KTHREAD, KPCR and TLS for a native registry thread whose stack is
// already mapped. Returns the KTHREAD address or 0.
uint32_t PrepareThreadObjects(uint32_t native, uint32_t start_address,
                              uint32_t creation_flags, uint32_t arg1) {
  const uint32_t stack_base = r360_guest_thread_stack_top(native);
  const uint32_t stack_limit = r360_guest_thread_stack_base(native);
  if (!stack_base || !stack_limit) return 0;
  const TlsLayout tls = ExecutableTlsLayout();
  const uint32_t tls_total = tls.slots * 4u + tls.data_size;
  const uint32_t tls_address = PoolAlloc(tls_total ? tls_total : 4u, 16u);
  const uint32_t kthread = PoolAlloc(0xAB0u, 16u);
  const uint32_t pcr = PoolAlloc(0x2D8u, 16u);
  if (!tls_address || !kthread || !pcr) return 0;
  if (tls.data_size && tls.raw_address && tls.raw_size &&
      !CopyGuest(tls_address, tls.raw_address,
                 std::min(tls.raw_size, tls.data_size))) {
    return 0;
  }
  const uint32_t thread_id = g_next_thread_id++;
  if (!InitializeKThread(kthread, stack_base, stack_limit, tls_address,
                         thread_id, start_address, creation_flags)) {
    return 0;
  }
  // X_KPCR: tls_ptr 0x0, pcr_ptr 0x30, stack base/end 0x70/0x74,
  // current_thread 0x100, current_cpu 0x10C, dpc_active 0x150.
  if (!Wr32(pcr + 0x000u, tls_address) || !Wr32(pcr + 0x030u, pcr) ||
      !Wr32(pcr + 0x070u, stack_base) || !Wr32(pcr + 0x074u, stack_limit) ||
      !Wr32(pcr + 0x100u, kthread) ||
      !Wr8(pcr + 0x10Cu, uint8_t((creation_flags >> 24) & 7u)) ||
      !Wr32(pcr + 0x150u, 0)) {
    return 0;
  }
  if (!r360_guest_thread_set_guest_objects(native, pcr, kthread, arg1,
                                           thread_id)) {
    return 0;
  }
  return kthread;
}

void MarkThreadExited(uint32_t kthread, uint32_t exit_code) {
  if (!kthread) return;
  Wr32(kthread + 4u, 1);  // Threads become signalled when they exit.
  Wr32(kthread + 0x140u, exit_code);
  Wr64(kthread + 0x138u, QueryGuestSystemTime());
}

// X_LDR_DATA_TABLE_ENTRY stand-ins for xboxkrnl.exe / xam.xex so
// XexGetModuleHandle succeeds for kernel modules as it does in Xenia.
std::array<uint32_t, 2> g_kernel_module_handles{};
uint32_t KernelModuleHandle(uint32_t index) {
  if (!g_kernel_module_handles[index]) {
    g_kernel_module_handles[index] = PoolAlloc(0x60u, 16u);
  }
  return g_kernel_module_handles[index];
}

std::map<uint32_t, int32_t>& ThreadPriority() {
  static std::map<uint32_t, int32_t> priority;
  return priority;
}
std::map<uint32_t, uint32_t>& ThreadAffinity() {
  static std::map<uint32_t, uint32_t> affinity;
  return affinity;
}

// ---------------------------------------------------------------------------
// Critical sections (Xenia xboxkrnl_rtl.cc).

void InitCriticalSection(uint32_t cs, uint32_t spin_count) {
  uint32_t spin_div_256 = (spin_count + 255u) >> 8;
  if (spin_div_256 > 255u) spin_div_256 = 255u;
  Wr8(cs + 0x0u, kDispSynchronizationEvent);
  Wr8(cs + 0x1u, uint8_t(spin_div_256));
  Wr32(cs + 0x4u, 0);
  Wr32(cs + 0x10u, 0xFFFFFFFFu);  // lock_count = -1
  Wr32(cs + 0x14u, 0);            // recursion_count
  Wr32(cs + 0x18u, 0);            // owning_thread
}

// ---------------------------------------------------------------------------
// Spin locks and IRQL.

uint32_t AcquireSpinLock(uint32_t lock, uint32_t module, uint32_t ordinal) {
  uint32_t value = 0;
  if (!Rd32(lock, &value)) return Invalid();
  if (value != 0) return WouldBlock(module, ordinal, lock, 0, 3);
  if (!Wr32(lock, 1)) return Invalid();
  return 1;
}

// ---------------------------------------------------------------------------
// Rtl helpers.

uint32_t NtStatusToDosError(uint32_t source_status) {
  uint32_t status = source_status;
  if (!status || (status & 0x20000000u)) return status;
  if ((status >> 16) == 0x8007u) return status & 0xFFFFu;
  if ((status & 0xF0000000u) == 0xD0000000u) status &= ~0x30000000u;
  const auto* table = &ntstatus::error_tables[0];
  while (table->base_code) {
    if (status < table->base_code) break;
    const uint32_t index = status - table->base_code;
    if (index < table->count) {
      const uint32_t result = table->entries[index];
      if (!result) break;
      return result;
    }
    ++table;
  }
  if ((status >> 16) == 0xC001u) return status & 0xFFFFu;
  return 317;  // ERROR_MR_MID_NOT_FOUND
}

int CompareBytes(const std::string& a, const std::string& b, size_t n,
                 bool case_insensitive) {
  for (size_t i = 0; i < n; ++i) {
    int ca = i < a.size() ? uint8_t(a[i]) : 0;
    int cb = i < b.size() ? uint8_t(b[i]) : 0;
    if (case_insensitive) {
      if (ca >= 'A' && ca <= 'Z') ca += 32;
      if (cb >= 'A' && cb <= 'Z') cb += 32;
    }
    if (ca != cb) return ca - cb;
    if (!ca) return 0;
  }
  return 0;
}

bool ReadAnsiString(uint32_t string_ptr, std::string* out) {
  uint16_t length = 0;
  uint32_t buffer = 0;
  if (!Rd16(string_ptr, &length) || !Rd32(string_ptr + 4u, &buffer)) return false;
  out->assign(length, '\0');
  return !length || Rd(buffer, out->data(), length);
}

// ---------------------------------------------------------------------------
// Video (Xenia xboxkrnl_video.cc VdQueryVideoMode defaults).

bool WriteVideoMode(uint32_t mode) {
  return ZeroGuest(mode, 48) && Wr32(mode + 0x00u, 1280) &&
         Wr32(mode + 0x04u, 720) && Wr32(mode + 0x08u, 0) &&
         Wr32(mode + 0x0Cu, 1) && Wr32(mode + 0x10u, 1) &&
         WrF32(mode + 0x14u, 60.0f) && Wr32(mode + 0x18u, 1) &&
         Wr32(mode + 0x1Cu, 0x4A) && Wr32(mode + 0x20u, 0x01);
}

// ---------------------------------------------------------------------------
// XAM input (Xenia xam_input.cc against Render360's controller state).

bool WriteGamepad(uint32_t address, const InputPad& pad) {
  return Wr16(address + 0x0u, pad.buttons) &&
         Wr8(address + 0x2u, pad.left_trigger) &&
         Wr8(address + 0x3u, pad.right_trigger) &&
         Wr16(address + 0x4u, uint16_t(pad.thumb_lx)) &&
         Wr16(address + 0x6u, uint16_t(pad.thumb_ly)) &&
         Wr16(address + 0x8u, uint16_t(pad.thumb_rx)) &&
         Wr16(address + 0xAu, uint16_t(pad.thumb_ry));
}

uint32_t InputUserIndex(uint32_t user_index, uint32_t flags) {
  // XINPUT_FLAG_ANY_USER = 0x40000000. Xenia pins "any user" to user 0.
  if ((user_index & 0xFFu) == 0xFFu || (flags & 0x40000000u)) return 0;
  return user_index;
}

// ---------------------------------------------------------------------------
// xboxkrnl dispatch.

uint32_t DispatchXboxkrnl(uint32_t ordinal, const uint32_t* a) {
  const uint32_t r3 = a[0], r4 = a[1], r5 = a[2], r6 = a[3], r7 = a[4],
                 r8 = a[5], r9 = a[6];
  switch (ordinal) {
    // --- Debug / fatal -----------------------------------------------------
    case kx::DbgPrint: {
      std::string text;
      ReadCString(r3, &text, 1024);
      DebugLog(text);
      return X_STATUS_SUCCESS;
    }
    case kx::DbgBreakPoint:
    case kx::DbgBreakPointWithStatus:
      // Xenia breaks into an attached host debugger only; retail flow resumes.
      DebugLog("DbgBreakPoint");
      return 0;
    case kx::KeBugCheck:
      return Terminal(kTerminalBugCheck, r3, kModuleXboxkrnl, ordinal, a);
    case kx::KeBugCheckEx:
      return Terminal(kTerminalBugCheck, r3, kModuleXboxkrnl, ordinal, a);
    case kx::HalReturnToFirmware:
      // Xenia: "Game requested shutdown via HalReturnToFirmware"; exit(0).
      return Terminal(kTerminalHalReturnToFirmware, r3, kModuleXboxkrnl,
                      ordinal, a);
    case kx::ExTerminateTitleProcess:
      return Terminal(kTerminalProcessExit, r3, kModuleXboxkrnl, ordinal, a);

    // --- Configuration -----------------------------------------------------
    case kx::ExGetXConfigSetting: {
      const uint16_t category = uint16_t(r3), setting = uint16_t(r4);
      const uint32_t buffer = r5;
      const uint16_t buffer_size = uint16_t(r6);
      const uint32_t required_size_ptr = r7;
      uint16_t setting_size = 0;
      uint8_t value[4] = {};
      const auto be = [&](uint32_t v) {
        value[0] = uint8_t(v >> 24);
        value[1] = uint8_t(v >> 16);
        value[2] = uint8_t(v >> 8);
        value[3] = uint8_t(v);
        setting_size = 4;
      };
      uint32_t status = X_STATUS_SUCCESS;
      if (category == 0x0002) {
        if (setting == 0x0002) {
          be(0x00001000u);  // XCONFIG_SECURED_AV_REGION: USA/Canada.
        } else {
          status = X_STATUS_INVALID_PARAMETER_2;
        }
      } else if (category == 0x0003) {
        switch (setting) {
          case 0x0001: case 0x0002: case 0x0003: case 0x0004:
          case 0x0005: case 0x0006: case 0x0007: case 0x000C:
            be(0);
            break;
          case 0x0009:
            be(1);  // XCONFIG_USER_LANGUAGE: English (Xenia default).
            break;
          case 0x000A:
            be(0x00040000u);  // XCONFIG_USER_VIDEO_FLAGS.
            break;
          case 0x000E:
            value[0] = 103;  // XCONFIG_USER_COUNTRY: US.
            setting_size = 1;
            break;
          default:
            status = X_STATUS_INVALID_PARAMETER_2;
            break;
        }
      } else {
        status = X_STATUS_INVALID_PARAMETER_1;
      }
      if (status == X_STATUS_SUCCESS) {
        if (buffer) {
          if (buffer_size < setting_size) {
            status = X_STATUS_BUFFER_TOO_SMALL;
          } else if (!Wr(buffer, value, setting_size)) {
            return Invalid();
          }
        } else if (buffer_size) {
          status = X_STATUS_INVALID_PARAMETER_3;
        }
      }
      if (required_size_ptr && !Wr16(required_size_ptr, setting_size)) return Invalid();
      return status;
    }
    case kx::ExSetXConfigSetting:
      return X_STATUS_SUCCESS;

    // --- Modules -----------------------------------------------------------
    case kx::XexCheckExecutablePrivilege: {
      uint32_t flags = 0;
      XexOptionalHeader(kXexHeaderSystemFlags, &flags);
      return (flags & (1u << (r3 & 31u))) ? 1u : 0u;
    }
    case kx::XexGetModuleHandle: {
      // Xenia: null name = executable; otherwise KernelState::GetModule,
      // which knows xboxkrnl.exe, xam.xex and loaded user modules.
      uint32_t hmodule = 0;
      if (!r3) {
        hmodule = g_exe.hmodule;
      } else {
        std::string name;
        if (!ReadCString(r3, &name, 260)) return Invalid();
        for (auto& c : name) c = char(c >= 'A' && c <= 'Z' ? c + 32 : c);
        const size_t slash = name.find_last_of("\\/:");
        if (slash != std::string::npos) name = name.substr(slash + 1);
        if (name == "xboxkrnl.exe" || name == "xam.xex") {
          hmodule = KernelModuleHandle(name == "xam.xex" ? 1u : 0u);
        } else if (name == "default.xex") {
          hmodule = g_exe.hmodule;
        }
      }
      if (r4 && !Wr32(r4, hmodule)) return Invalid();
      return hmodule ? X_ERROR_SUCCESS : X_ERROR_NOT_FOUND;
    }
    case kx::XexGetModuleSection: {
      if (!r3 || r3 != g_exe.hmodule) return X_STATUS_INVALID_HANDLE;
      std::string name;
      if (!ReadCString(r4, &name, 64)) return Invalid();
      uint32_t info = 0;
      if (!XexOptionalHeader(kXexHeaderResourceInfo, &info) || !info) {
        return X_STATUS_NOT_FOUND;
      }
      uint32_t info_size = 0;
      if (!Rd32(info, &info_size) || info_size < 4u) return X_STATUS_NOT_FOUND;
      const uint32_t count = (info_size - 4u) / 16u;
      for (uint32_t i = 0; i < count; ++i) {
        const uint32_t entry = info + 4u + i * 16u;
        char raw[9] = {};
        uint32_t address = 0, size = 0;
        if (!Rd(entry, raw, 8) || !Rd32(entry + 8u, &address) ||
            !Rd32(entry + 12u, &size)) {
          return Invalid();
        }
        if (name == std::string(raw)) {
          if (!Wr32(r5, address) || !Wr32(r6, size)) return Invalid();
          return X_STATUS_SUCCESS;
        }
      }
      return X_STATUS_NOT_FOUND;
    }

    // --- Time --------------------------------------------------------------
    case kx::KeQuerySystemTime:
      if (r3 && !Wr64(r3, QueryGuestSystemTime())) return Invalid();
      return 0;
    case kx::RtlTimeToTimeFields: {
      uint64_t file_time = 0;
      if (!Rd64(r3, &file_time)) return Invalid();
      const uint64_t ms_total = file_time / 10000ull;
      const int64_t days = int64_t(ms_total / 86400000ull) - kDays1601To1970;
      uint64_t ms_of_day = ms_total % 86400000ull;
      int64_t year = 0;
      uint32_t month = 0, day = 0;
      CivilFromDays(days, &year, &month, &day);
      // 1970-01-01 was a Thursday (4).
      const int64_t weekday = ((days % 7) + 7 + 4) % 7;
      const uint32_t out = r4;
      if (!Wr16(out + 0, uint16_t(year)) || !Wr16(out + 2, uint16_t(month)) ||
          !Wr16(out + 4, uint16_t(day)) ||
          !Wr16(out + 6, uint16_t(ms_of_day / 3600000ull)) ||
          !Wr16(out + 8, uint16_t((ms_of_day / 60000ull) % 60ull)) ||
          !Wr16(out + 10, uint16_t((ms_of_day / 1000ull) % 60ull)) ||
          !Wr16(out + 12, uint16_t(ms_of_day % 1000ull)) ||
          !Wr16(out + 14, uint16_t(weekday))) {
        return Invalid();
      }
      return 0;
    }
    case kx::RtlTimeFieldsToTime: {
      uint16_t f[7] = {};
      for (uint32_t i = 0; i < 7; ++i) {
        if (!Rd16(r3 + i * 2u, &f[i])) return Invalid();
      }
      const uint16_t year = f[0], month = f[1], day = f[2], hour = f[3],
                     minute = f[4], second = f[5], ms = f[6];
      if (year < 1601 || month < 1 || month > 12 || day < 1 || day > 31 ||
          hour > 23 || minute > 59 || second > 59 || ms > 999) {
        return 0;
      }
      static const uint8_t kDaysInMonth[] = {31, 28, 31, 30, 31, 30,
                                             31, 31, 30, 31, 30, 31};
      const bool leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
      const uint32_t max_day = kDaysInMonth[month - 1] + (month == 2 && leap);
      if (day > max_day) return 0;
      const int64_t days = DaysFromCivil(year, month, day) + kDays1601To1970;
      const uint64_t ms_total = uint64_t(days) * 86400000ull +
                                uint64_t(hour) * 3600000ull +
                                uint64_t(minute) * 60000ull +
                                uint64_t(second) * 1000ull + ms;
      if (!Wr64(r4, ms_total * 10000ull)) return Invalid();
      return 1;
    }

    // --- IRQL / spin locks / critical regions ------------------------------
    case kx::KeRaiseIrqlToDpcLevel: {
      const uint32_t old = g_irql;
      g_irql = 2;
      return old;
    }
    case kx::KfLowerIrql:
      g_irql = r3 & 0xFFu;
      return 0;
    case kx::KfAcquireSpinLock: {
      if (!AcquireSpinLock(r3, kModuleXboxkrnl, ordinal)) return 0;
      const uint32_t old = g_irql;
      g_irql = 2;
      return old;
    }
    case kx::KfReleaseSpinLock: {
      g_irql = r4 & 0xFFu;
      uint32_t value = 0;
      if (!Rd32(r3, &value) || !Wr32(r3, value - 1u)) return Invalid();
      return 0;
    }
    case kx::KeAcquireSpinLockAtRaisedIrql:
      AcquireSpinLock(r3, kModuleXboxkrnl, ordinal);
      return 0;
    case kx::KeTryToAcquireSpinLockAtRaisedIrql: {
      uint32_t value = 0;
      if (!Rd32(r3, &value)) return Invalid();
      if (value) return 0;
      if (!Wr32(r3, 1)) return Invalid();
      return 1;
    }
    case kx::KeReleaseSpinLockFromRaisedIrql: {
      uint32_t value = 0;
      if (!Rd32(r3, &value) || !Wr32(r3, value - 1u)) return Invalid();
      return 0;
    }
    case kx::KeEnterCriticalRegion:
    case kx::KeLeaveCriticalRegion: {
      const uint32_t kthread = CurrentKThread();
      uint32_t count = 0;
      if (kthread >= 0x10000u && Rd32(kthread + 0xB0u, &count)) {
        count += ordinal == kx::KeEnterCriticalRegion ? uint32_t(-1) : 1u;
        Wr32(kthread + 0xB0u, count);
      }
      return 0;
    }
    case kx::KeLockL2:
      return 0;
    case kx::KeUnlockL2:
      return 0;
    case kx::KeEnableFpuExceptions:
      return 0;

    // --- Events ------------------------------------------------------------
    case kx::KeInitializeEvent:
      if (!InitDispatcher(r3, r4 ? kDispSynchronizationEvent
                                 : kDispNotificationEvent,
                          16, r5 ? 1 : 0)) {
        return Invalid();
      }
      return 0;
    case kx::KeSetEvent:
    case kx::KePulseEvent: {
      uint8_t type = 0;
      int32_t state = 0;
      if (!ReadDispatcher(r3, &type, &state)) return Invalid();
      // Nobody else can be waiting in the synchronous probe, so a pulse is
      // observable only as the previous state.
      if (!Wr32(r3 + 4u, ordinal == kx::KeSetEvent ? 1u : 0u)) return Invalid();
      return uint32_t(state);
    }
    case kx::KeResetEvent: {
      uint8_t type = 0;
      int32_t state = 0;
      if (!ReadDispatcher(r3, &type, &state) || !Wr32(r3 + 4u, 0)) return Invalid();
      return uint32_t(state);
    }
    case kx::NtCreateEvent: {
      // (handle_ptr, obj_attributes, event_type, initial_state). Xenia:
      // event_type 0 = notification (manual reset), 1 = synchronization.
      const std::string name = ObjectAttributesName(r4);
      if (auto* existing = FindObjectByName(name)) {
        if (existing->type != ObjectType::kEvent) return X_STATUS_INVALID_HANDLE;
        ++existing->handle_count;
        const uint32_t slot = uint32_t(existing - Objects().data());
        if (r3 && !Wr32(r3, HandleForSlot(slot))) return Invalid();
        return X_STATUS_OBJECT_NAME_EXISTS;
      }
      const uint32_t event = PoolAlloc(16);
      if (!event || !InitDispatcher(event, r5 ? kDispSynchronizationEvent
                                              : kDispNotificationEvent,
                                    16, r6 ? 1 : 0)) {
        return X_STATUS_NO_MEMORY;
      }
      const uint32_t handle = CreateObject(ObjectType::kEvent, event, true, name);
      if (!handle) return X_STATUS_NO_MEMORY;
      if (r3 && !Wr32(r3, handle)) return Invalid();
      return X_STATUS_SUCCESS;
    }
    case kx::NtSetEvent:
    case kx::NtPulseEvent: {
      KernelObject* object = ResolveHandle(r3);
      if (!object || object->type != ObjectType::kEvent) return X_STATUS_INVALID_HANDLE;
      uint8_t type = 0;
      int32_t state = 0;
      if (!ReadDispatcher(object->guest, &type, &state) ||
          !Wr32(object->guest + 4u, ordinal == kx::NtSetEvent ? 1u : 0u)) {
        return Invalid();
      }
      if (r4 && !Wr32(r4, uint32_t(state))) return Invalid();
      return X_STATUS_SUCCESS;
    }
    case kx::NtClearEvent: {
      KernelObject* object = ResolveHandle(r3);
      if (!object || object->type != ObjectType::kEvent) return X_STATUS_INVALID_HANDLE;
      if (!Wr32(object->guest + 4u, 0)) return Invalid();
      return X_STATUS_SUCCESS;
    }

    // --- Semaphores / mutants ----------------------------------------------
    case kx::KeInitializeSemaphore:
      if (!InitDispatcher(r3, kDispSemaphore, 20, int32_t(r4)) ||
          !Wr32(r3 + 0x10u, r5)) {
        return Invalid();
      }
      return 0;
    case kx::KeReleaseSemaphore: {
      // (semaphore, increment, adjustment, wait) -> previous count.
      uint8_t type = 0;
      int32_t state = 0;
      uint32_t limit = 0;
      if (!ReadDispatcher(r3, &type, &state) || !Rd32(r3 + 0x10u, &limit)) {
        return Invalid();
      }
      const int64_t next = int64_t(state) + int32_t(r5);
      if (next > int64_t(int32_t(limit)) || next < 0) return uint32_t(state);
      if (!Wr32(r3 + 4u, uint32_t(next))) return Invalid();
      return uint32_t(state);
    }
    case kx::NtCreateSemaphore: {
      // (handle_ptr, obj_attributes, count, limit)
      const std::string name = ObjectAttributesName(r4);
      if (auto* existing = FindObjectByName(name)) {
        if (existing->type != ObjectType::kSemaphore) return X_STATUS_INVALID_HANDLE;
        ++existing->handle_count;
        const uint32_t slot = uint32_t(existing - Objects().data());
        if (r3 && !Wr32(r3, HandleForSlot(slot))) return Invalid();
        return X_STATUS_OBJECT_NAME_EXISTS;
      }
      if (int32_t(r6) <= 0 || int32_t(r5) < 0 || int32_t(r5) > int32_t(r6)) {
        if (r3) Wr32(r3, 0);
        return X_STATUS_INVALID_PARAMETER;
      }
      const uint32_t semaphore = PoolAlloc(20);
      if (!semaphore || !InitDispatcher(semaphore, kDispSemaphore, 20, int32_t(r5)) ||
          !Wr32(semaphore + 0x10u, r6)) {
        return X_STATUS_NO_MEMORY;
      }
      const uint32_t handle =
          CreateObject(ObjectType::kSemaphore, semaphore, true, name);
      if (!handle) return X_STATUS_NO_MEMORY;
      if (r3 && !Wr32(r3, handle)) return Invalid();
      return X_STATUS_SUCCESS;
    }
    case kx::NtReleaseSemaphore: {
      KernelObject* object = ResolveHandle(r3);
      if (!object || object->type != ObjectType::kSemaphore) {
        if (r5) Wr32(r5, 0);
        return X_STATUS_INVALID_HANDLE;
      }
      uint8_t type = 0;
      int32_t state = 0;
      uint32_t limit = 0;
      if (!ReadDispatcher(object->guest, &type, &state) ||
          !Rd32(object->guest + 0x10u, &limit)) {
        return Invalid();
      }
      const int64_t next = int64_t(state) + int32_t(r4);
      if (r5 && !Wr32(r5, uint32_t(state))) return Invalid();
      if (next > int64_t(int32_t(limit))) return X_STATUS_SEMAPHORE_LIMIT_EXCEEDED;
      if (!Wr32(object->guest + 4u, uint32_t(next))) return Invalid();
      return X_STATUS_SUCCESS;
    }
    case kx::NtCreateMutant: {
      // (handle_out, obj_attributes, initial_owner)
      const std::string name = ObjectAttributesName(r4);
      if (auto* existing = FindObjectByName(name)) {
        if (existing->type != ObjectType::kMutant) return X_STATUS_INVALID_HANDLE;
        ++existing->handle_count;
        const uint32_t slot = uint32_t(existing - Objects().data());
        if (r3 && !Wr32(r3, HandleForSlot(slot))) return Invalid();
        return X_STATUS_OBJECT_NAME_EXISTS;
      }
      const uint32_t mutant = PoolAlloc(0x20);
      if (!mutant || !InitDispatcher(mutant, kDispMutant, 0x20, r5 ? 0 : 1)) {
        return X_STATUS_NO_MEMORY;
      }
      if (r5 && !Wr32(mutant + 0x18u, CurrentKThread())) return Invalid();
      const uint32_t handle = CreateObject(ObjectType::kMutant, mutant, true, name);
      if (!handle) return X_STATUS_NO_MEMORY;
      if (r3 && !Wr32(r3, handle)) return Invalid();
      return X_STATUS_SUCCESS;
    }
    case kx::NtReleaseMutant: {
      KernelObject* object = ResolveHandle(r3);
      if (!object || object->type != ObjectType::kMutant) return X_STATUS_INVALID_HANDLE;
      uint8_t type = 0;
      int32_t state = 0;
      uint32_t owner = 0;
      if (!ReadDispatcher(object->guest, &type, &state) ||
          !Rd32(object->guest + 0x18u, &owner)) {
        return Invalid();
      }
      if (owner != CurrentKThread() || state > 0) return X_STATUS_MUTANT_NOT_OWNED;
      ++state;
      if (!Wr32(object->guest + 4u, uint32_t(state)) ||
          (state > 0 && !Wr32(object->guest + 0x18u, 0))) {
        return Invalid();
      }
      return X_STATUS_SUCCESS;
    }

    // --- Timers ------------------------------------------------------------
    case kx::NtCreateTimer: {
      // (handle_ptr, obj_attributes, timer_type 0 notification / 1 sync)
      const std::string name = ObjectAttributesName(r4);
      if (auto* existing = FindObjectByName(name)) {
        if (existing->type != ObjectType::kTimer) return X_STATUS_INVALID_HANDLE;
        ++existing->handle_count;
        const uint32_t slot = uint32_t(existing - Objects().data());
        if (r3 && !Wr32(r3, HandleForSlot(slot))) return Invalid();
        return X_STATUS_OBJECT_NAME_EXISTS;
      }
      const uint32_t timer = PoolAlloc(0x28);
      if (!timer || !InitDispatcher(timer, r5 ? kDispSynchronizationTimer
                                              : kDispNotificationTimer,
                                    0x28, 0)) {
        return X_STATUS_NO_MEMORY;
      }
      const uint32_t handle = CreateObject(ObjectType::kTimer, timer, true, name);
      if (!handle) return X_STATUS_NO_MEMORY;
      if (r3 && !Wr32(r3, handle)) return Invalid();
      return X_STATUS_SUCCESS;
    }
    case kx::NtSetTimerEx: {
      // (handle, due_time_ptr, apc_routine, unk_one, apc_arg, resume, period_ms)
      KernelObject* object = ResolveHandle(r3);
      if (!object || object->type != ObjectType::kTimer) return X_STATUS_INVALID_HANDLE;
      if (r5) {
        // APC completion routines need guest callbacks from the kernel, which
        // the synchronous probe cannot deliver yet. Keep this fail-closed.
        g_status = kKernelServiceUnsupported;
        return 0;
      }
      uint64_t due = 0;
      if (!Rd64(r4, &due)) return Invalid();
      const uint64_t now = QueryGuestSystemTime();
      object->due_time = int64_t(due) < 0 ? now + uint64_t(-int64_t(due)) : due;
      object->period_ms = r9;
      object->armed = true;
      if (!Wr32(object->guest + 4u, 0)) return Invalid();
      return X_STATUS_SUCCESS;
    }
    case kx::NtCancelTimer: {
      KernelObject* object = ResolveHandle(r3);
      if (!object || object->type != ObjectType::kTimer) return X_STATUS_INVALID_HANDLE;
      object->armed = false;
      if (r4 && !Wr32(r4, 0)) return Invalid();
      return X_STATUS_SUCCESS;
    }

    // --- Waits / delays ----------------------------------------------------
    case kx::KeWaitForSingleObject:
      // (object, wait_reason, processor_mode, alertable, timeout_ptr)
      return WaitObjects(kModuleXboxkrnl, ordinal, {r3}, {}, false, r7);
    case kx::NtWaitForSingleObjectEx: {
      // (handle, wait_mode, alertable, timeout_ptr)
      uint32_t guest = 0;
      if (!GuestObjectForHandle(r3, &guest)) {
        if ((r3 & 0xFF000000u) == 0x37000000u) {
          // XamNotifyCreateListener handles: no queued notifications.
          if (!r6) return WouldBlock(kModuleXboxkrnl, ordinal, 0, r3, 1);
          return X_STATUS_TIMEOUT;
        }
        return X_STATUS_INVALID_HANDLE;
      }
      return WaitObjects(kModuleXboxkrnl, ordinal, {guest}, {r3}, false, r6);
    }
    case kx::KeWaitForMultipleObjects: {
      // (count, objects_ptr, wait_type, reason, mode, alertable, timeout, blocks)
      if (!r3 || r3 > 64) return X_STATUS_INVALID_PARAMETER;
      std::vector<uint32_t> objects(r3);
      for (uint32_t i = 0; i < r3; ++i) {
        if (!Rd32(r4 + i * 4u, &objects[i])) return Invalid();
      }
      return WaitObjects(kModuleXboxkrnl, ordinal, objects, {}, r5 == 0, r9);
    }
    case kx::NtWaitForMultipleObjectsEx: {
      // (count, handles, wait_type, wait_mode, alertable, timeout_ptr)
      if (!r3 || r3 > 64) return X_STATUS_INVALID_PARAMETER;
      std::vector<uint32_t> handles(r3), objects(r3);
      for (uint32_t i = 0; i < r3; ++i) {
        if (!Rd32(r4 + i * 4u, &handles[i])) return Invalid();
        if (!GuestObjectForHandle(handles[i], &objects[i])) {
          return X_STATUS_INVALID_PARAMETER;
        }
      }
      return WaitObjects(kModuleXboxkrnl, ordinal, objects, handles, r5 == 0, r8);
    }
    case kx::NtSignalAndWaitForSingleObjectEx: {
      // (signal_handle, wait_handle, alertable, r6, timeout_ptr)
      KernelObject* signal = ResolveHandle(r3);
      uint32_t wait_guest = 0;
      if (!signal || !GuestObjectForHandle(r4, &wait_guest)) {
        return X_STATUS_INVALID_HANDLE;
      }
      if (signal->type == ObjectType::kEvent) {
        Wr32(signal->guest + 4u, 1);
      } else if (signal->type == ObjectType::kSemaphore) {
        uint8_t type = 0;
        int32_t state = 0;
        ReadDispatcher(signal->guest, &type, &state);
        Wr32(signal->guest + 4u, uint32_t(state + 1));
      } else if (signal->type == ObjectType::kMutant) {
        uint8_t type = 0;
        int32_t state = 0;
        ReadDispatcher(signal->guest, &type, &state);
        Wr32(signal->guest + 4u, uint32_t(state + 1));
        if (state + 1 > 0) Wr32(signal->guest + 0x18u, 0);
      } else {
        return X_STATUS_OBJECT_TYPE_MISMATCH;
      }
      return WaitObjects(kModuleXboxkrnl, ordinal, {wait_guest}, {r4}, false, r7);
    }
    case kx::KeDelayExecutionThread: {
      // (processor_mode, alertable, interval_ptr)
      uint64_t interval = 0;
      if (!Rd64(r5, &interval)) return Invalid();
      AdvanceVirtualTime(interval);
      return X_STATUS_SUCCESS;
    }
    case kx::NtYieldExecution:
      return X_STATUS_SUCCESS;

    // --- Threads -----------------------------------------------------------
    case kx::ExCreateThread: {
      // (handle_ptr, stack_size, thread_id_ptr, xapi_thread_startup,
      //  start_address, start_context, creation_flags)
      uint32_t stack_size = r4 ? r4 : ExecutableStackSize();
      stack_size = std::max<uint32_t>(0x4000u, (stack_size + 0xFFFu) & 0xFFFFF000u);
      const uint32_t xapi_startup = r6, start_address = r7, start_context = r8;
      const uint32_t flags = r9;
      const uint32_t entry = xapi_startup ? xapi_startup : start_address;
      const uint32_t context = xapi_startup ? start_address : start_context;
      const uint32_t arg1 = xapi_startup ? start_context : 0u;
      if (!entry) return X_STATUS_INVALID_PARAMETER;
      const uint32_t native = r360_guest_thread_create(entry, context, stack_size, flags);
      if (!native) return X_STATUS_NO_MEMORY;
      const uint32_t kthread = PrepareThreadObjects(native, start_address, flags, arg1);
      if (!kthread) {
        r360_guest_thread_terminate(native, 0);
        return X_STATUS_NO_MEMORY;
      }
      if (flags & 1u) r360_guest_thread_suspend(native);
      const uint32_t handle = CreateObject(ObjectType::kThread, kthread, false);
      if (!handle) return X_STATUS_NO_MEMORY;
      uint32_t slot = 0;
      SlotForHandle(handle, &slot);
      Objects()[slot].thread = native;
      uint32_t thread_id = 0;
      Rd32(kthread + 0x14Cu, &thread_id);
      if (r3 && !Wr32(r3, (flags & 0x80u) ? kthread : handle)) return Invalid();
      if (r5 && !Wr32(r5, thread_id)) return Invalid();
      return X_STATUS_SUCCESS;
    }
    case kx::ExTerminateThread: {
      const uint32_t kthread = CurrentKThread();
      const uint32_t native = NativeThreadForKThread(kthread);
      if (native && !r360_guest_thread_external(native)) {
        MarkThreadExited(kthread, r3);
        r360_guest_thread_terminate(native, r3);
        return Terminal(kTerminalThreadExit, r3, kModuleXboxkrnl, ordinal, a);
      }
      // The primary thread leaving ends the title, as on the console.
      MarkThreadExited(kthread, r3);
      return Terminal(kTerminalProcessExit, r3, kModuleXboxkrnl, ordinal, a);
    }
    case kx::KeResumeThread:
    case kx::KeSuspendThread: {
      const uint32_t native = NativeThreadForKThread(r3);
      if (!native) return 0;
      const uint32_t previous = ordinal == kx::KeResumeThread
                                    ? r360_guest_thread_resume(native)
                                    : r360_guest_thread_suspend(native);
      if (previous == 0xFFFFFFFFu) return 0;
      Wr8(r3 + 0xBCu, uint8_t(ordinal == kx::KeResumeThread ? previous - 1u
                                                            : previous + 1u));
      return previous;
    }
    case kx::NtResumeThread:
    case kx::NtSuspendThread: {
      KernelObject* object = ResolveHandle(r3);
      if (!object || object->type != ObjectType::kThread) return X_STATUS_INVALID_HANDLE;
      const uint32_t native = object->thread ? object->thread
                                             : NativeThreadForKThread(object->guest);
      uint32_t previous = 0;
      if (native) {
        previous = ordinal == kx::NtResumeThread ? r360_guest_thread_resume(native)
                                                 : r360_guest_thread_suspend(native);
        if (previous == 0xFFFFFFFFu) previous = 0;
      }
      if (r4 && !Wr32(r4, previous)) return Invalid();
      return X_STATUS_SUCCESS;
    }
    case kx::KeSetAffinityThread: {
      if (!r4) return X_STATUS_INVALID_PARAMETER;
      const uint32_t previous = ThreadAffinity().count(r3) ? ThreadAffinity()[r3] : 1u;
      if (r5 && !Wr32(r5, previous)) return Invalid();
      uint32_t lowest = 1u;
      while (lowest && !(r4 & lowest)) lowest <<= 1;
      ThreadAffinity()[r3] = lowest ? lowest : 1u;
      return X_STATUS_SUCCESS;
    }
    case kx::KeQueryBasePriorityThread:
      return uint32_t(ThreadPriority().count(r3) ? ThreadPriority()[r3] : 0);
    case kx::KeSetBasePriorityThread: {
      const int32_t previous = ThreadPriority().count(r3) ? ThreadPriority()[r3] : 0;
      ThreadPriority()[r3] = int32_t(r4);
      return uint32_t(previous);
    }
    case kx::KeSetDisableBoostThread:
      return 0;

    // --- Object manager ----------------------------------------------------
    case kx::NtClose: {
      if (r3 == kCurrentThreadPseudoHandle || r3 == kCurrentProcessPseudoHandle ||
          (r3 & 0xFF000000u) == 0x37000000u) {
        return X_STATUS_SUCCESS;
      }
      uint32_t slot = 0;
      if (!SlotForHandle(r3, &slot) || !Objects()[slot].handle_count) {
        return X_STATUS_INVALID_HANDLE;
      }
      --Objects()[slot].handle_count;
      MaybeDestroyObject(slot);
      return X_STATUS_SUCCESS;
    }
    case kx::NtDuplicateObject: {
      // (handle, new_handle_ptr, options). DUPLICATE_CLOSE_SOURCE = 1.
      KernelObject* object = ResolveHandle(r3);
      if (!object) {
        if (r4) Wr32(r4, 0xFFFFFFFFu);
        return X_STATUS_INVALID_HANDLE;
      }
      const uint32_t slot = uint32_t(object - Objects().data());
      ++object->handle_count;
      if (r4 && !Wr32(r4, HandleForSlot(slot))) return Invalid();
      if (r5 == 1u && r3 != kCurrentThreadPseudoHandle) {
        --Objects()[slot].handle_count;
      }
      return X_STATUS_SUCCESS;
    }
    case kx::ObReferenceObjectByHandle: {
      // (handle, object_type_ptr, out_object_ptr). Xenia compares object types
      // against its D###BEEF placeholders for unmapped *ObjectType variables.
      KernelObject* object = ResolveHandle(r3);
      if (!object) return X_STATUS_INVALID_HANDLE;
      uint32_t expected = 0;
      switch (object->type) {
        case ObjectType::kEvent: expected = 0xD00EBEEFu; break;
        case ObjectType::kSemaphore: expected = 0xD017BEEFu; break;
        case ObjectType::kThread: expected = 0xD01BBEEFu; break;
        default: break;
      }
      if (expected && r4 && r4 != expected) return X_STATUS_OBJECT_TYPE_MISMATCH;
      ++object->pointer_count;
      if (r5 && !Wr32(r5, expected ? object->guest : 0xDEADF00Du)) return Invalid();
      return X_STATUS_SUCCESS;
    }
    case kx::ObReferenceObject: {
      if (auto* object = FindObjectByGuest(r3)) ++object->pointer_count;
      return 0;
    }
    case kx::ObDereferenceObject: {
      if (auto* object = FindObjectByGuest(r3)) {
        if (object->pointer_count) --object->pointer_count;
        MaybeDestroyObject(uint32_t(object - Objects().data()));
      }
      return 0;
    }
    case kx::ObCreateSymbolicLink:
    case kx::ObDeleteSymbolicLink:
      return X_STATUS_SUCCESS;

    // --- Memory ------------------------------------------------------------
    case kx::MmAllocatePhysicalMemoryEx:
      // (flags, size, protect, min_addr, max_addr, alignment)
      return AllocatePhysical(r4, r5, r6, r7, r8);
    case kx::MmAllocatePhysicalMemory:
      // (flags, size, protect) == Ex(flags, size, protect, 0, -1, 0).
      return AllocatePhysical(r4, r5, 0, 0xFFFFFFFFu, 0);
    case kx::MmFreePhysicalMemory: {
      auto it = PhysicalByVirtual().find(r4);
      if (it != PhysicalByVirtual().end()) {
        PhysicalRanges().erase(it->second.physical_address);
        PhysicalByVirtual().erase(it);
      }
      return 0;
    }
    case kx::MmQueryAllocationSize: {
      if (const auto* p = FindPhysical(r3)) return p->size;
      if (const uint32_t pool = PoolBlockSize(r3)) return pool;
      return 0;
    }
    case kx::MmQueryAddressProtect: {
      if (const auto* p = FindPhysical(r3)) return p->protect & 0x7FFu;
      return SparseGuestMemoryPageMapped(r3) ? 0x04u : 0u;
    }
    case kx::MmSetAddressProtect:
      return 0;
    case kx::MmQueryStatistics: {
      // X_MM_QUERY_STATISTICS_RESULT, 104 bytes. Xenia's constants.
      uint32_t size = 0;
      if (!r3) return X_STATUS_INVALID_PARAMETER;
      if (!Rd32(r3, &size)) return Invalid();
      if (size != 104u) return X_STATUS_BUFFER_TOO_SMALL;
      uint32_t used_pages = 0;
      for (const auto& [base, bytes] : PhysicalRanges()) used_pages += bytes / 4096u;
      const uint32_t values[] = {
          104, 0x00020000u, 0x00000300u,
          // title
          0x00020000u - used_pages, 0x2FFF0000u, 0x00160000u, 0x00001000u,
          0x10u, 0x100u, 0x100u, 0x100u, 0x100u, 0x100u, 0x100u,
          // system
          0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
          0x0001FFFFu};
      for (uint32_t i = 0; i < 26; ++i) {
        if (!Wr32(r3 + i * 4u, values[i])) return Invalid();
      }
      return X_STATUS_SUCCESS;
    }
    case kx::NtQueryVirtualMemory: {
      // (base_address, X_MEMORY_BASIC_INFORMATION*) 28 bytes.
      const uint32_t base = r3 & ~(kPageSize - 1u);
      const bool mapped = SparseGuestMemoryPageMapped(base);
      uint32_t region = kPageSize;
      while (region < 0x10000000u &&
             SparseGuestMemoryPageMapped(base + region) == mapped) {
        region += kPageSize;
      }
      const uint32_t state = mapped ? 0x1000u : 0x10000u;  // COMMIT : FREE
      const uint32_t protect = mapped ? 0x04u : 0x01u;
      if (!Wr32(r4 + 0x00u, base) || !Wr32(r4 + 0x04u, base) ||
          !Wr32(r4 + 0x08u, protect) || !Wr32(r4 + 0x0Cu, region) ||
          !Wr32(r4 + 0x10u, state) || !Wr32(r4 + 0x14u, protect) ||
          !Wr32(r4 + 0x18u, 0x20000u)) {
        return Invalid();
      }
      return X_STATUS_SUCCESS;
    }
    case kx::ExAllocatePool:
    case kx::ExAllocatePoolWithTag:
    case kx::ExAllocatePoolTypeWithTag: {
      uint32_t size = r3;
      uint32_t alignment = 8u;
      if (size < 4096u) {
        size = RoundUp(size, 4096u);
      } else {
        alignment = 4096u;
      }
      return PoolAlloc(size, alignment);
    }
    case kx::ExFreePool:
      PoolFree(r3);
      return 0;
    case kx::ExQueryPoolBlockSize:
      return PoolBlockSize(r3);
    case kx::MmGetPhysicalAddress: {
      if (const auto* p = FindPhysical(r3)) {
        return p->physical_address + (r3 - p->virtual_address);
      }
      return r3;
    }

    // --- Rtl strings and memory ----------------------------------------------
    case kx::RtlInitAnsiString: {
      // (destination, source)
      std::string source;
      if (r4) {
        if (!ReadCString(r4, &source, 0xFFFE)) return Invalid();
        if (!Wr16(r3, uint16_t(source.size())) ||
            !Wr16(r3 + 2u, uint16_t(source.size() + 1u))) {
          return Invalid();
        }
      } else if (!Wr32(r3, 0)) {
        return Invalid();
      }
      if (!Wr32(r3 + 4u, r4)) return Invalid();
      return 0;
    }
    case kx::RtlInitUnicodeString: {
      std::u16string source;
      if (r4) {
        if (!ReadU16String(r4, &source, 0x7FFE)) return Invalid();
        if (!Wr16(r3, uint16_t(source.size() * 2u)) ||
            !Wr16(r3 + 2u, uint16_t((source.size() + 1u) * 2u)) ||
            !Wr32(r3 + 4u, r4)) {
          return Invalid();
        }
      } else if (!Wr32(r3, 0) || !Wr32(r3 + 4u, 0)) {
        return Invalid();
      }
      return 0;
    }
    case kx::RtlFreeAnsiString:
    case kx::RtlFreeUnicodeString: {
      uint32_t buffer = 0;
      if (!Rd32(r3 + 4u, &buffer)) return Invalid();
      if (buffer) PoolFree(buffer);
      if (!Wr32(r3, 0) || !Wr32(r3 + 4u, 0)) return Invalid();
      return 0;
    }
    case kx::RtlCopyString:
    case kx::RtlCopyUnicodeString: {
      const uint32_t unit = ordinal == kx::RtlCopyString ? 1u : 2u;
      if (!r4) {
        if (!Wr16(r3, 0)) return Invalid();
        return 0;
      }
      uint16_t dst_max = 0, src_len = 0;
      uint32_t dst_buf = 0, src_buf = 0;
      if (!Rd16(r3 + 2u, &dst_max) || !Rd32(r3 + 4u, &dst_buf) ||
          !Rd16(r4, &src_len) || !Rd32(r4 + 4u, &src_buf)) {
        return Invalid();
      }
      const uint16_t length = std::min(dst_max, src_len);
      if (length && !CopyGuest(dst_buf, src_buf, length * unit)) return Invalid();
      if (!Wr16(r3, length)) return Invalid();
      return 0;
    }
    case kx::RtlUnicodeStringToAnsiString: {
      // (destination, source, allocate)
      uint16_t source_length = 0;
      uint32_t source_buffer = 0;
      if (!Rd16(r4, &source_length) || !Rd32(r4 + 4u, &source_buffer)) {
        return Invalid();
      }
      std::u16string unicode(source_length / 2u, u'\0');
      for (uint32_t i = 0; i < unicode.size(); ++i) {
        uint16_t c = 0;
        if (!Rd16(source_buffer + i * 2u, &c)) return Invalid();
        unicode[i] = char16_t(c);
      }
      const std::string ansi = Utf16ToUtf8(unicode);
      if (ansi.size() > 0xFFFEu) return X_STATUS_INVALID_PARAMETER_2;
      if (r5) {
        const uint32_t buffer = PoolAlloc(uint32_t(ansi.size() + 1u));
        if (!buffer) return X_STATUS_NO_MEMORY;
        if ((!ansi.empty() && !Wr(buffer, ansi.data(), uint32_t(ansi.size()))) ||
            !Wr16(r3, uint16_t(ansi.size())) ||
            !Wr16(r3 + 2u, uint16_t(ansi.size() + 1u)) || !Wr32(r3 + 4u, buffer)) {
          return Invalid();
        }
        return X_STATUS_SUCCESS;
      }
      uint16_t capacity = 0;
      uint32_t buffer = 0;
      if (!Rd16(r3 + 2u, &capacity) || !Rd32(r3 + 4u, &buffer)) return Invalid();
      if (!capacity) return X_STATUS_BUFFER_OVERFLOW;
      uint32_t status = X_STATUS_SUCCESS;
      uint32_t copy = uint32_t(ansi.size());
      if (capacity < ansi.size() + 1u) {
        status = X_STATUS_BUFFER_OVERFLOW;
        copy = capacity - 1u;
      }
      if ((copy && !Wr(buffer, ansi.data(), copy)) || !Wr8(buffer + copy, 0) ||
          !Wr16(r3, uint16_t(copy))) {
        return Invalid();
      }
      return status;
    }
    case kx::RtlMultiByteToUnicodeN: {
      // (dst, dst_len_bytes, written_ptr, src, src_len)
      uint32_t count = r4 >> 1;
      if (count > r7) count = r7;
      for (uint32_t i = 0; i < count; ++i) {
        uint8_t c = 0;
        if (!Rd8(r6 + i, &c) || !Wr16(r3 + i * 2u, c)) return Invalid();
      }
      if (r5 && !Wr32(r5, count << 1)) return Invalid();
      return 0;
    }
    case kx::RtlUnicodeToMultiByteN: {
      // (dst, dst_len, written_ptr, src, src_len_bytes)
      uint32_t count = r7 >> 1;
      if (count > r4) count = r4;
      for (uint32_t i = 0; i < count; ++i) {
        uint16_t c = 0;
        if (!Rd16(r6 + i * 2u, &c) || !Wr8(r3 + i, c < 256 ? uint8_t(c) : '?')) {
          return Invalid();
        }
      }
      if (r5 && !Wr32(r5, count)) return Invalid();
      return 0;
    }
    case kx::RtlUpcaseUnicodeChar: {
      const uint32_t c = r3 & 0xFFFFu;
      if (c >= 'a' && c <= 'z') return c - 32u;
      if (c >= 0xE0u && c <= 0xFEu && c != 0xF7u) return c - 32u;
      return c;
    }
    case kx::RtlCompareMemory: {
      uint32_t matches = 0;
      for (uint32_t i = 0; i < r5; ++i) {
        uint8_t x = 0, y = 0;
        if (!Rd8(r3 + i, &x) || !Rd8(r4 + i, &y)) return Invalid();
        if (x == y) ++matches;
      }
      return matches;
    }
    case kx::RtlCompareMemoryUlong: {
      if ((r3 & 3u) || (r4 & 3u)) return 0;
      uint32_t matches = 0;
      for (uint32_t i = 0; i < r4 / 4u; ++i) {
        uint32_t value = 0;
        if (!Rd32(r3 + i * 4u, &value)) return Invalid();
        if (value == r5) ++matches;
      }
      return matches;
    }
    case kx::RtlFillMemoryUlong:
      if (!FillGuest32(r3, r4 >> 2, r5)) return Invalid();
      return 0;
    case kx::RtlCompareString: {
      // (PSTRING, PSTRING, case_insensitive) with NT semantics.
      std::string x, y;
      if (!ReadAnsiString(r3, &x) || !ReadAnsiString(r4, &y)) return Invalid();
      const size_t n = std::min(x.size(), y.size());
      int result = CompareBytes(x, y, n, r5 != 0);
      if (!result) result = int(x.size()) - int(y.size());
      return uint32_t(result);
    }
    case kx::RtlCompareStringN: {
      // (char*, len1, char*, len2, case_insensitive); 0xFFFF means strlen.
      std::string x, y;
      if (!ReadCString(r3, &x, 0x10000) || !ReadCString(r5, &y, 0x10000)) {
        return Invalid();
      }
      const uint32_t len = std::min(r4, r6);
      return uint32_t(CompareBytes(x, y, len, r7 != 0));
    }
    case kx::RtlNtStatusToDosError:
      return NtStatusToDosError(r3);
    case kx::RtlRaiseException: {
      // EXCEPTION_RECORD.ExceptionCode at +0. 0x406D1388 is the MSVC
      // "set thread name" exception, which Xenia consumes and continues.
      uint32_t code = 0;
      if (!Rd32(r3, &code)) return Invalid();
      if (code == 0x406D1388u) {
        DebugLog("SetThreadName");
        return 0;
      }
      g_status = kKernelServiceUnsupported;
      return 0;
    }
    case kx::RtlComputeCrc32: {
      uint32_t hash = ~r3;
      for (uint32_t i = 0; i < r5; ++i) {
        uint8_t b = 0;
        if (!Rd8(r4 + i, &b)) return Invalid();
        hash ^= b;
        for (int k = 0; k < 8; ++k) hash = (hash >> 1) ^ (0xEDB88320u & (0u - (hash & 1u)));
      }
      return r5 ? ~hash : r3;
    }

    // --- Critical sections ---------------------------------------------------
    case kx::RtlInitializeCriticalSection:
      InitCriticalSection(r3, 0);
      return 0;
    case kx::RtlInitializeCriticalSectionAndSpinCount:
      InitCriticalSection(r3, r4);
      return X_STATUS_SUCCESS;
    case kx::RtlEnterCriticalSection: {
      const uint32_t current = CurrentKThread();
      uint32_t lock_count = 0, recursion = 0, owner = 0;
      if (!Rd32(r3 + 0x10u, &lock_count) || !Rd32(r3 + 0x14u, &recursion) ||
          !Rd32(r3 + 0x18u, &owner)) {
        return Invalid();
      }
      if (owner == current && owner) {
        Wr32(r3 + 0x10u, lock_count + 1u);
        Wr32(r3 + 0x14u, recursion + 1u);
        return 0;
      }
      if (int32_t(lock_count) != -1) {
        return WouldBlock(kModuleXboxkrnl, ordinal, r3, 0, 3);
      }
      Wr32(r3 + 0x10u, 0);
      Wr32(r3 + 0x18u, current);
      Wr32(r3 + 0x14u, 1);
      return 0;
    }
    case kx::RtlTryEnterCriticalSection: {
      const uint32_t current = CurrentKThread();
      uint32_t lock_count = 0, recursion = 0, owner = 0;
      if (!Rd32(r3 + 0x10u, &lock_count) || !Rd32(r3 + 0x14u, &recursion) ||
          !Rd32(r3 + 0x18u, &owner)) {
        return Invalid();
      }
      if (int32_t(lock_count) == -1) {
        Wr32(r3 + 0x10u, 0);
        Wr32(r3 + 0x18u, current);
        Wr32(r3 + 0x14u, 1);
        return 1;
      }
      if (owner == current && owner) {
        Wr32(r3 + 0x10u, lock_count + 1u);
        Wr32(r3 + 0x14u, recursion + 1u);
        return 1;
      }
      return 0;
    }
    case kx::RtlLeaveCriticalSection: {
      uint32_t lock_count = 0, recursion = 0;
      if (!Rd32(r3 + 0x10u, &lock_count) || !Rd32(r3 + 0x14u, &recursion)) {
        return Invalid();
      }
      if (recursion == 0) return 0;  // Not owned; Xenia asserts.
      --recursion;
      Wr32(r3 + 0x14u, recursion);
      if (recursion) {
        Wr32(r3 + 0x10u, lock_count - 1u);
        return 0;
      }
      Wr32(r3 + 0x18u, 0);
      Wr32(r3 + 0x10u, lock_count - 1u);
      // Waiters would be woken via the embedded event; none can exist while
      // the probe is single-threaded.
      return 0;
    }

    // --- Reader/writer locks (Xenia X_ERWLOCK) -------------------------------
    case kx::ExInitializeReadWriteLock:
      if (!Wr32(r3 + 0x0u, 0xFFFFFFFFu) || !Wr32(r3 + 0x4u, 0) ||
          !Wr32(r3 + 0x8u, 0) || !Wr32(r3 + 0xCu, 0) ||
          !InitDispatcher(r3 + 0x10u, kDispSynchronizationEvent, 16, 0) ||
          !InitDispatcher(r3 + 0x20u, kDispSemaphore, 20, 0) ||
          !Wr32(r3 + 0x30u, 0x7FFFFFFFu) || !Wr32(r3 + 0x34u, 0)) {
        return Invalid();
      }
      return 0;
    case kx::ExAcquireReadWriteLockExclusive:
    case kx::ExTryToAcquireReadWriteLockExclusive: {
      uint32_t lock_count = 0;
      if (!Rd32(r3, &lock_count)) return Invalid();
      if (int32_t(lock_count) < 0) {
        Wr32(r3, 0);
        return 1;
      }
      if (ordinal == kx::ExTryToAcquireReadWriteLockExclusive) return 0;
      return WouldBlock(kModuleXboxkrnl, ordinal, r3, 0, 3);
    }
    case kx::ExAcquireReadWriteLockShared:
    case kx::ExTryToAcquireReadWriteLockShared: {
      uint32_t lock_count = 0, writers_waiting = 0, readers_entry = 0;
      if (!Rd32(r3, &lock_count) || !Rd32(r3 + 4u, &writers_waiting) ||
          !Rd32(r3 + 0xCu, &readers_entry)) {
        return Invalid();
      }
      if (int32_t(lock_count) < 0 || (readers_entry && !writers_waiting)) {
        Wr32(r3, lock_count + 1u);
        Wr32(r3 + 0xCu, readers_entry + 1u);
        return 1;
      }
      if (ordinal == kx::ExTryToAcquireReadWriteLockShared) return 0;
      return WouldBlock(kModuleXboxkrnl, ordinal, r3, 0, 3);
    }
    case kx::ExReleaseReadWriteLock: {
      uint32_t lock_count = 0, readers_entry = 0;
      if (!Rd32(r3, &lock_count) || !Rd32(r3 + 0xCu, &readers_entry)) {
        return Invalid();
      }
      --lock_count;
      Wr32(r3, lock_count);
      if (int32_t(lock_count) < 0) {
        Wr32(r3 + 0xCu, 0);
      } else if (readers_entry) {
        Wr32(r3 + 0xCu, readers_entry - 1u);
      }
      return 0;
    }

    // --- Interlocked singly linked lists ---------------------------------------
    case kx::InterlockedPushEntrySList: {
      // X_SLIST_HEADER { next, depth(be16), sequence(be16) }
      uint32_t head = 0;
      uint16_t depth = 0, sequence = 0;
      if (!Rd32(r3, &head) || !Rd16(r3 + 4u, &depth) ||
          !Rd16(r3 + 6u, &sequence) || !Wr32(r4, head) || !Wr32(r3, r4) ||
          !Wr16(r3 + 4u, uint16_t(depth + 1u)) ||
          !Wr16(r3 + 6u, uint16_t(sequence + 1u))) {
        return Invalid();
      }
      return head;
    }
    case kx::InterlockedPopEntrySList: {
      uint32_t head = 0, next = 0;
      uint16_t depth = 0;
      if (!Rd32(r3, &head) || !Rd16(r3 + 4u, &depth)) return Invalid();
      if (!head) return 0;
      if (!Rd32(head, &next) || !Wr32(r3, next) ||
          !Wr16(r3 + 4u, uint16_t(depth - 1u))) {
        return Invalid();
      }
      return head;
    }
    case kx::InterlockedFlushSList: {
      uint32_t head = 0;
      if (!Rd32(r3, &head) || !Wr32(r3, 0) || !Wr32(r3 + 4u, 0)) return Invalid();
      return head;
    }

    // --- DPCs (Xenia initializes and queues but never dispatches) -------------
    case kx::KeInitializeDpc:
      if (!Wr32(r3 + 0x00u, 19u << 24) || !Wr32(r3 + 0x04u, 0) ||
          !Wr32(r3 + 0x08u, 0) || !Wr32(r3 + 0x0Cu, r4) ||
          !Wr32(r3 + 0x10u, r5) || !Wr32(r3 + 0x14u, 0) || !Wr32(r3 + 0x18u, 0)) {
        return Invalid();
      }
      return 0;

    // --- Video helpers not owned by title_gpu_runtime ---------------------------
    case kx::VdQueryVideoMode:
      if (!WriteVideoMode(r3)) return Invalid();
      return 0;
    case kx::VdGetCurrentDisplayGamma:
      if ((r3 && !Wr32(r3, 2)) || (r4 && !WrF32(r4, 2.22222233f))) return Invalid();
      return 0;
    case kx::VdGetCurrentDisplayInformation: {
      const uint32_t d = r3;
      if (!ZeroGuest(d, 0x58) || !Wr16(d + 0x00u, 1280) || !Wr16(d + 0x02u, 720) ||
          !Wr32(d + 0x08u + 0x08u, 1280) || !Wr32(d + 0x08u + 0x0Cu, 720) ||
          !Wr32(d + 0x08u + 0x10u, 1280) || !Wr32(d + 0x08u + 0x14u, 720) ||
          !Wr32(d + 0x08u + 0x18u, 1) || !Wr32(d + 0x08u + 0x28u, 1) ||
          !Wr16(d + 0x40u, 320) || !Wr16(d + 0x42u, 180) ||
          !Wr16(d + 0x44u, 320) || !Wr16(d + 0x46u, 180) ||
          !Wr16(d + 0x48u, 1280) || !Wr16(d + 0x4Au, 720) ||
          !WrF32(d + 0x4Cu, 60.0f) || !Wr16(d + 0x56u, 1280)) {
        return Invalid();
      }
      return 0;
    }
    case kx::VdShutdownEngines:
      return 0;
    case kx::VdSetGraphicsInterruptCallback:
      g_graphics_interrupt_callback = r3;
      g_graphics_interrupt_user_data = r4;
      return 0;
    case kx::VdGetSystemCommandBuffer:
      if (!ZeroGuest(r3, 0x94) || !Wr32(r3, 0xBEEF0000u) || !Wr32(r4, 0xBEEF0001u)) {
        return Invalid();
      }
      return 0;
    case kx::VdSetSystemCommandBufferGpuIdentifierAddress:
      return 0;
    case kx::VdInitializeScalerCommandBuffer: {
      // Twelve arguments: dest_ptr (10) and dest_count (11) are on the stack.
      // Xenia fills the destination with type-2 PM4 NOPs and returns the
      // word count, which is all titles check.
      uint32_t dest = 0, count = 0;
      if (!StackArg(10, &dest) || !StackArg(11, &count)) return Invalid();
      if (count > 0x10000u || !FillGuest32(dest, count, 0x80000000u)) {
        return Invalid();
      }
      return count;
    }
    case kx::VdCallGraphicsNotificationRoutines:
      return 0;
    case kx::VdPersistDisplay: {
      if (r4) {
        const uint32_t block = AllocatePhysical(64, 0x20000004u, 0, 0x1FFFFFFFu, 32);
        if (!block || !Wr32(r4, block)) return Invalid();
      }
      return 1;
    }
    case kx::VdRetrainEDRAMWorker:
    case kx::VdRetrainEDRAM:
      return 0;

    // --- Crypto (Xenia xboxkrnl_crypt.cc) --------------------------------------
    case kx::XeCryptBnQwBeSigVerify:
      return 1;  // Xenia reports every signature as valid.

    default:
      g_handled = false;
      return 0;
  }
}

// ---------------------------------------------------------------------------
// XAM dispatch.

uint32_t DispatchXam(uint32_t ordinal, const uint32_t* a) {
  const uint32_t r3 = a[0], r4 = a[1], r5 = a[2];
  switch (ordinal) {
    case xam::XGetAVPack:
      return 6;  // Xenia: VGA.
    case xam::XGetGameRegion:
      return 0xFFFFu;
    case xam::XGetVideoMode:
      if (!WriteVideoMode(r3)) return Invalid();
      return 0;
    case xam::XamGetSystemVersion:
      return 0;
    case xam::XamGetExecutionId: {
      uint32_t info = 0;
      if (!XexOptionalHeader(kXexHeaderExecutionInfo, &info) || !info) {
        return X_STATUS_NOT_FOUND;
      }
      if (!Wr32(r3, info)) return Invalid();
      return X_STATUS_SUCCESS;
    }
    case xam::XamGetCurrentTitleId: {
      uint32_t info = 0, title_id = 0;
      if (XexOptionalHeader(kXexHeaderExecutionInfo, &info) && info) {
        Rd32(info + 0x0Cu, &title_id);
      }
      return title_id;
    }
    case xam::XamIsCurrentTitleDash:
      return 0;
    case xam::XamLoaderTerminateTitle:
      return Terminal(kTerminalTitleTerminate, 0, kModuleXam, ordinal, a);
    case xam::XamLoaderLaunchTitle:
      return Terminal(kTerminalLaunchTitle, r3, kModuleXam, ordinal, a);
    case xam::XamLoaderGetLaunchDataSize:
      if (!r3) return X_ERROR_INVALID_PARAMETER;
      if (!Wr32(r3, 0)) return Invalid();
      return X_ERROR_NOT_FOUND;
    case xam::XamLoaderGetLaunchData:
      return X_ERROR_NOT_FOUND;
    case xam::XamEnableInactivityProcessing:
      return X_ERROR_SUCCESS;
    case xam::XamResetInactivity:
      return 0;
    case xam::XamAlloc: {
      const uint32_t block = PoolAlloc(r4);
      if (!block) return X_ERROR_NOT_FOUND;
      if (!Wr32(r5, block)) return Invalid();
      return X_ERROR_SUCCESS;
    }
    case xam::XamFree:
      PoolFree(r3);
      return X_ERROR_SUCCESS;

    // --- Users (Xenia default profile: signed-in local "User") -----------------
    case xam::XamUserGetSigninState:
      return r3 == 0 ? 1u : 0u;
    case xam::XamUserGetXUID: {
      if (!r5) return X_E_INVALIDARG;
      uint32_t result = X_E_NO_SUCH_USER;
      uint64_t xuid = 0;
      if (r3 >= 4) {
        result = X_E_INVALIDARG;
      } else if (r3 == 0 && (r4 & 7u)) {
        xuid = 0xB13EBABEBABEBABEull;
        result = X_E_SUCCESS;
      }
      if (!Wr64(r5, xuid)) return Invalid();
      return result;
    }
    case xam::XamUserGetSigninInfo: {
      if (!r5) return X_E_INVALIDARG;
      if (!ZeroGuest(r5, 40)) return Invalid();
      if (r3) return X_E_NO_SUCH_USER;
      static const char kName[] = "User";
      if (!Wr64(r5, 0xB13EBABEBABEBABEull) || !Wr32(r5 + 0x0Cu, 1) ||
          !Wr(r5 + 0x18u, kName, sizeof(kName))) {
        return Invalid();
      }
      return X_E_SUCCESS;
    }
    case xam::XamUserGetName: {
      if (r3 >= 4) return X_E_INVALIDARG;
      if (r3) return X_E_NO_SUCH_USER;
      static const char kName[] = "User";
      const uint32_t capacity = std::min<uint32_t>(r5, 16u);
      if (capacity) {
        const uint32_t copy = std::min<uint32_t>(capacity - 1u, 4u);
        if (!Wr(r4, kName, copy) || !Wr8(r4 + copy, 0)) return Invalid();
      }
      return X_E_SUCCESS;
    }
    case xam::XamUserCheckPrivilege: {
      if (r3 != 0xFFu) {
        if (r3 >= 4) return X_ERROR_INVALID_PARAMETER;
        if (r3) return X_ERROR_NO_SUCH_USER;
      }
      if (!Wr32(r5, 0)) return Invalid();
      return X_ERROR_SUCCESS;
    }

    // --- Input -----------------------------------------------------------------
    case xam::XamInputGetCapabilities:
    case xam::XamInputGetCapabilitiesEx: {
      // Ex has a leading "unk" argument.
      const uint32_t base = ordinal == xam::XamInputGetCapabilitiesEx ? 1u : 0u;
      const uint32_t user = a[base], flags = a[base + 1], caps = a[base + 2];
      if (!caps) return X_ERROR_BAD_ARGUMENTS;
      if ((flags & 0xFFu) && !(flags & 1u)) return X_ERROR_DEVICE_NOT_CONNECTED;
      const uint32_t index = InputUserIndex(user, flags);
      if (index >= 4 || !Input()[index].connected) return X_ERROR_DEVICE_NOT_CONNECTED;
      InputPad full;
      full.buttons = 0xF3FFu;
      full.left_trigger = full.right_trigger = 0xFF;
      full.thumb_lx = full.thumb_ly = full.thumb_rx = full.thumb_ry = int16_t(0xFFC0);
      if (!Wr8(caps + 0u, 1) || !Wr8(caps + 1u, 1) || !Wr16(caps + 2u, 0) ||
          !WriteGamepad(caps + 4u, full) || !Wr16(caps + 16u, 0xFF) ||
          !Wr16(caps + 18u, 0xFF)) {
        return Invalid();
      }
      return X_ERROR_SUCCESS;
    }
    case xam::XamInputGetState: {
      if ((r4 & 0xFFu) && !(r4 & 1u)) return X_ERROR_DEVICE_NOT_CONNECTED;
      const uint32_t index = InputUserIndex(r3, r4);
      if (index >= 4 || !Input()[index].connected) return X_ERROR_DEVICE_NOT_CONNECTED;
      if (r5) {
        const auto& pad = Input()[index];
        if (!Wr32(r5, pad.packet) || !WriteGamepad(r5 + 4u, pad)) return Invalid();
      }
      return X_ERROR_SUCCESS;
    }
    case xam::XamInputSetState: {
      if (!r5) return X_ERROR_BAD_ARGUMENTS;
      const uint32_t index = (r3 & 0xFFu) == 0xFFu ? 0u : r3;
      if (index >= 4 || !Input()[index].connected) return X_ERROR_DEVICE_NOT_CONNECTED;
      Rd16(r5, &Input()[index].vibration_left);
      Rd16(r5 + 2u, &Input()[index].vibration_right);
      return X_ERROR_SUCCESS;
    }

    default:
      g_handled = false;
      return 0;
  }
}

}  // namespace

uint32_t DispatchExtendedKernelService(uint32_t module, uint32_t ordinal,
                                       const uint32_t args[8],
                                       uint32_t* result) {
  g_status = kKernelServiceSuccess;
  g_handled = true;
  uint32_t value = 0;
  if (module == kModuleXboxkrnl) {
    value = DispatchXboxkrnl(ordinal, args);
  } else if (module == kModuleXam) {
    value = DispatchXam(ordinal, args);
  } else {
    g_handled = false;
  }
  if (!g_handled) return kKernelServiceIdle;
  *result = value;
  return g_status;
}

void ResetExtendedKernelServices() {
  g_exe = {};
  g_process_info_block = 0;
  g_caller_r13 = g_caller_lr = g_caller_r1 = 0;
  g_irql = 0;
  g_next_thread_id = 2;
  g_virtual_time_100ns = 0;
  g_timestamp_bundle = 0;
  g_uptime_origin_ms = 0;
  g_graphics_interrupt_callback = g_graphics_interrupt_user_data = 0;
  g_terminal = {};
  g_wait = {};
  g_timeout_spin = {};
  DebugLogEntries().clear();
  g_debug_log_total = 0;
  Input() = {};
  Input()[0].connected = true;
  PoolUsed().clear();
  PoolFreeList().clear();
  g_pool_top = kPoolBase;
  PhysicalByVirtual().clear();
  PhysicalRanges().clear();
  Objects().clear();
  ThreadPriority().clear();
  ThreadAffinity().clear();
  g_kernel_module_handles = {};
}

}  // namespace render360::xenia_web

// ---------------------------------------------------------------------------
// Browser ABI.

extern "C" {
namespace r360k = render360::xenia_web;

R360_WASM_EXPORT("r360_kernel_services_reset")
void r360_kernel_services_reset() { r360k::ResetExtendedKernelServices(); }

R360_WASM_EXPORT("r360_kernel_service_set_caller")
void r360_kernel_service_set_caller(uint32_t r13, uint32_t lr, uint32_t r1) {
  r360k::g_caller_r13 = r13;
  r360k::g_caller_lr = lr;
  r360k::g_caller_r1 = r1;
  r360k::RefreshTimeStampBundle();
}

R360_WASM_EXPORT("r360_kernel_set_timestamp_bundle")
void r360_kernel_set_timestamp_bundle(uint32_t address) {
  r360k::g_timestamp_bundle = address;
  r360k::g_uptime_origin_ms = 0;
  r360k::RefreshTimeStampBundle();
}

// Installs the executable module (X_LDR_DATA_TABLE_ENTRY / HMODULE) and the
// guest copy of the XEX header, as Xenia's UserModule does, plus the process
// info block pointed to by KTHREAD+0x84.
R360_WASM_EXPORT("r360_kernel_set_executable_module")
uint32_t r360_kernel_set_executable_module(uint32_t hmodule,
                                           uint32_t xex_header,
                                           uint32_t process_info_block) {
  uint32_t magic = 0;
  if (!xex_header || !r360k::Rd32(xex_header, &magic) || magic != 0x58455832u) {
    return 0;
  }
  r360k::g_exe.hmodule = hmodule;
  r360k::g_exe.xex_header = xex_header;
  r360k::g_process_info_block = process_info_block;
  return 1;
}

// Allocates the Xbox thread objects (KTHREAD/KPCR/TLS) for a native registry
// thread that the browser scheduler created directly.
R360_WASM_EXPORT("r360_kernel_prepare_thread_objects")
uint32_t r360_kernel_prepare_thread_objects(uint32_t native_handle,
                                            uint32_t start_address,
                                            uint32_t creation_flags) {
  return r360k::PrepareThreadObjects(native_handle, start_address,
                                     creation_flags, 0);
}

R360_WASM_EXPORT("r360_kernel_pool_alloc")
uint32_t r360_kernel_pool_alloc(uint32_t size, uint32_t alignment) {
  return r360k::PoolAlloc(size, alignment ? alignment : 16u);
}

R360_WASM_EXPORT("r360_kernel_terminal_kind")
uint32_t r360_kernel_terminal_kind() { return r360k::g_terminal.kind; }
R360_WASM_EXPORT("r360_kernel_terminal_code")
uint32_t r360_kernel_terminal_code() { return r360k::g_terminal.code; }
R360_WASM_EXPORT("r360_kernel_terminal_ordinal")
uint32_t r360_kernel_terminal_ordinal() { return r360k::g_terminal.ordinal; }
R360_WASM_EXPORT("r360_kernel_terminal_module")
uint32_t r360_kernel_terminal_module() { return r360k::g_terminal.module; }
R360_WASM_EXPORT("r360_kernel_terminal_lr")
uint32_t r360_kernel_terminal_lr() { return r360k::g_terminal.lr; }
R360_WASM_EXPORT("r360_kernel_terminal_arg")
uint32_t r360_kernel_terminal_arg(uint32_t index) {
  return index < r360k::g_terminal.args.size() ? r360k::g_terminal.args[index] : 0u;
}

R360_WASM_EXPORT("r360_kernel_wait_ordinal")
uint32_t r360_kernel_wait_ordinal() { return r360k::g_wait.ordinal; }
R360_WASM_EXPORT("r360_kernel_wait_module")
uint32_t r360_kernel_wait_module() { return r360k::g_wait.module; }
R360_WASM_EXPORT("r360_kernel_wait_object")
uint32_t r360_kernel_wait_object() { return r360k::g_wait.object; }
R360_WASM_EXPORT("r360_kernel_wait_handle")
uint32_t r360_kernel_wait_handle() { return r360k::g_wait.handle; }
R360_WASM_EXPORT("r360_kernel_wait_object_type")
uint32_t r360_kernel_wait_object_type() { return r360k::g_wait.object_type; }
R360_WASM_EXPORT("r360_kernel_wait_reason")
uint32_t r360_kernel_wait_reason() { return r360k::g_wait.reason; }

R360_WASM_EXPORT("r360_kernel_debug_log_total")
uint32_t r360_kernel_debug_log_total() { return r360k::g_debug_log_total; }
R360_WASM_EXPORT("r360_kernel_debug_log_count")
uint32_t r360_kernel_debug_log_count() {
  return uint32_t(r360k::DebugLogEntries().size());
}
// Copies debug log entry |index| into wasm memory at |out| (capacity bytes).
R360_WASM_EXPORT("r360_kernel_debug_log_read")
uint32_t r360_kernel_debug_log_read(uint32_t index, uint32_t out,
                                    uint32_t capacity) {
  if (index >= r360k::DebugLogEntries().size() || !out || !capacity) return 0;
  const std::string& text = r360k::DebugLogEntries()[index];
  const uint32_t n = std::min<uint32_t>(uint32_t(text.size()), capacity);
  std::memcpy(reinterpret_cast<void*>(uintptr_t(out)), text.data(), n);
  return n;
}

// Render360 controller -> XInput gamepad state for user_index.
R360_WASM_EXPORT("r360_input_set_gamepad")
uint32_t r360_input_set_gamepad(uint32_t user_index, uint32_t connected,
                                uint32_t buttons, uint32_t triggers,
                                uint32_t left_stick, uint32_t right_stick) {
  if (user_index >= 4) return 0;
  auto& pad = r360k::Input()[user_index];
  const uint16_t new_buttons = uint16_t(buttons);
  const uint8_t lt = uint8_t(triggers), rt = uint8_t(triggers >> 8);
  const int16_t lx = int16_t(left_stick), ly = int16_t(left_stick >> 16);
  const int16_t rx = int16_t(right_stick), ry = int16_t(right_stick >> 16);
  const bool changed = pad.buttons != new_buttons || pad.left_trigger != lt ||
                       pad.right_trigger != rt || pad.thumb_lx != lx ||
                       pad.thumb_ly != ly || pad.thumb_rx != rx ||
                       pad.thumb_ry != ry;
  pad.connected = connected != 0;
  pad.buttons = new_buttons;
  pad.left_trigger = lt;
  pad.right_trigger = rt;
  pad.thumb_lx = lx;
  pad.thumb_ly = ly;
  pad.thumb_rx = rx;
  pad.thumb_ry = ry;
  if (changed) ++pad.packet;
  return 1;
}

R360_WASM_EXPORT("r360_kernel_graphics_interrupt_callback")
uint32_t r360_kernel_graphics_interrupt_callback() {
  return r360k::g_graphics_interrupt_callback;
}
R360_WASM_EXPORT("r360_kernel_object_count")
uint32_t r360_kernel_object_count() {
  uint32_t count = 0;
  for (const auto& object : r360k::Objects()) count += object.used ? 1u : 0u;
  return count;
}
}  // extern "C"
