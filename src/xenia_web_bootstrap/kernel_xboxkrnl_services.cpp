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

#include <time.h>
#include <cstdint>
// The guest clock lives in the HIR executor (hir_correctness_executor.cpp);
// these fallbacks serve standalone kernel builds.
extern "C" __attribute__((weak)) uint64_t r360_guest_clock_ns() {
  struct timespec ts {};
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return uint64_t(ts.tv_sec) * 1000000000ull + uint64_t(ts.tv_nsec);
}
extern "C" __attribute__((weak)) uint32_t r360_guest_clock_deterministic() { return 0; }

#include <algorithm>
#include <array>
#include <cstdint>
#include <cstring>
#include <ctime>
#include <deque>
#include <map>
#include <set>
#include <string>
#include <vector>

#include "guest_fibers.h"
#include "kernel_export_ordinals.h"

// Weak defaults for builds that link the kernel services without the HIR
// fiber scheduler or the title GPU runtime (standalone kernel critics): no
// other guest thread, no interrupts, no GPU. The full core overrides them.
namespace render360::xenia_web {
__attribute__((weak)) bool GuestFiberYield(bool) { return false; }
__attribute__((weak)) void GuestFiberNoteProgress() {}
__attribute__((weak)) bool GuestFibersActive() { return false; }
__attribute__((weak)) bool GuestInterruptActive() { return false; }
__attribute__((weak)) void GuestFiberHostYieldIfDue() {}
__attribute__((weak)) bool RunGuestInterrupt(uint32_t, uint32_t, uint32_t, uint32_t, uint32_t) { return false; }
__attribute__((weak)) void TitleGpuPump() {}
__attribute__((weak)) uint32_t TitleGpuTakePendingInterrupts(uint32_t* mask) { if (mask) *mask = 0; return 0; }
}  // namespace render360::xenia_web
#include "kernel_ntstatus_table.h"
#include "sparse_guest_memory.h"
#include "title_gpu_runtime.h"

#if defined(__wasm__)
#include <wasi/api.h>
#endif

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
uint32_t r360_guest_thread_pcr(uint32_t handle);
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
constexpr uint32_t X_STATUS_NO_MORE_FILES = 0x80000006u;
constexpr uint32_t X_STATUS_INVALID_INFO_CLASS = 0xC0000003u;
constexpr uint32_t X_STATUS_INFO_LENGTH_MISMATCH = 0xC0000004u;
constexpr uint32_t X_STATUS_ACCESS_VIOLATION = 0xC0000005u;
constexpr uint32_t X_STATUS_NO_SUCH_FILE = 0xC000000Fu;
constexpr uint32_t X_STATUS_END_OF_FILE = 0xC0000011u;
constexpr uint32_t X_STATUS_ACCESS_DENIED = 0xC0000022u;
constexpr uint32_t X_STATUS_OBJECT_NAME_INVALID = 0xC0000033u;
constexpr uint32_t X_STATUS_OBJECT_NAME_COLLISION = 0xC0000035u;
constexpr uint32_t X_STATUS_FILE_IS_A_DIRECTORY = 0xC00000BAu;
constexpr uint32_t X_STATUS_NOT_A_DIRECTORY = 0xC0000103u;
constexpr uint32_t X_STATUS_OBJECT_PATH_NOT_FOUND = 0xC000003Au;

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
constexpr uint32_t X_ERROR_INSUFFICIENT_BUFFER = 0x0000007Au;
constexpr uint32_t X_ERROR_IO_INCOMPLETE = 0x000003E4u;
constexpr uint32_t X_ERROR_IO_PENDING = 0x000003E5u;
constexpr uint32_t X_ERROR_FILE_NOT_FOUND = 0x00000002u;
constexpr uint32_t X_ERROR_PATH_NOT_FOUND = 0x00000003u;
constexpr uint32_t X_ERROR_ACCESS_DENIED = 0x00000005u;
constexpr uint32_t X_ERROR_INVALID_HANDLE = 0x00000006u;
constexpr uint32_t X_ERROR_NO_MORE_FILES = 0x00000012u;
constexpr uint32_t X_ERROR_ALREADY_EXISTS = 0x000000B7u;
constexpr uint32_t X_ERROR_FUNCTION_FAILED = 0x0000065Bu;

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
// The guest thread whose stack and KPCR graphics interrupts run on (Xenia's
// "GPU VSync" host thread), kept suspended so the scheduler never runs it.
uint32_t g_interrupt_thread = 0;
uint64_t g_last_vblank_ms = 0;
uint32_t g_interrupt_poll = 0;
uint32_t g_vblank_interrupts = 0;
uint32_t g_cp_interrupts = 0;

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
// Last blocking wait of each guest thread suspended in a fiber yield, with
// the guest return address (diagnostics: r360_kernel_thread_wait).
struct ThreadWait {
  WaitInfo wait;
  uint32_t caller_lr = 0;
  uint32_t count = 0;
};
std::map<uint32_t, ThreadWait> g_thread_waits;
// Last bounded (timed) wait of each guest thread: a thread that polls with
// timeouts shows up as ready, not blocked (r360_kernel_thread_poll).
std::map<uint32_t, ThreadWait> g_thread_polls;

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
  uint64_t unix_100ns = 0;
  if (r360_guest_clock_deterministic()) {
    // A fixed wall-clock origin (2026-01-01) keeps replays identical.
    unix_100ns = 1767225600ull * 10000000ull + r360_guest_clock_ns() / 100ull;
  } else {
    struct timespec ts {};
    clock_gettime(CLOCK_REALTIME, &ts);
    unix_100ns = uint64_t(ts.tv_sec) * 10000000ull + uint64_t(ts.tv_nsec) / 100ull;
  }
  return kUnixEpochAsFileTime + unix_100ns + g_virtual_time_100ns;
}

uint64_t MonotonicMillis() { return r360_guest_clock_ns() / 1000000ull; }

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
std::map<uint32_t, uint32_t>& PhysicalVirtualBases() {  // physical base -> virtual base
  static std::map<uint32_t, uint32_t> bases;
  return bases;
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

// Xenia's three physical heaps (v A0000000 64 KiB pages, v C0000000 16 MiB
// pages, v E0000000 4 KiB pages at physical + 0x1000) are views of the same
// physical memory: a page allocated through one view is also reachable
// through the others (titles hand GPU buffers between views). Each physical
// page gets one backing, mapped at all three addresses.
bool EnsurePhysicalViews(uint32_t physical, uint32_t size) {
  auto view = [](uint32_t index, uint32_t page) -> uint64_t {
    if (index == 0) return 0xA0000000ull + page;
    if (index == 1) return 0xC0000000ull + page;
    return page >= 0x1000u ? 0xE0000000ull + page - 0x1000u : 0ull;
  };
  const uint32_t first = physical & ~(kPageSize - 1u);
  const uint64_t end = uint64_t(physical) + size;
  for (uint32_t page = first; uint64_t(page) < end;) {
    if (SparseGuestMemoryPageMapped(0xA0000000u + page)) {
      page += kPageSize;
      continue;
    }
    uint32_t run = 0;
    for (uint32_t cursor = page; uint64_t(cursor) < end &&
                                 !SparseGuestMemoryPageMapped(0xA0000000u + cursor);
         cursor += kPageSize) {
      ++run;
    }
    const uint32_t backing = AllocateSparseGuestBacking(run);
    if (!backing) return false;
    for (uint32_t index = 0; index < 3; ++index) {
      // The E0 view starts at physical 0x1000: map the part of the run it has.
      uint32_t skip = 0;
      while (skip < run && !view(index, page + skip * kPageSize)) ++skip;
      if (skip == run) continue;
      if (!MapSparseGuestMemory(uint32_t(view(index, page + skip * kPageSize)), run - skip,
                                backing, skip, kGuestRead | kGuestWrite)) {
        return false;
      }
    }
    page += run * kPageSize;
  }
  return true;
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
      if (!EnsurePhysicalViews(physical, adjusted_size) ||
          !ZeroGuest(virtual_address, adjusted_size)) {
        return 0;
      }
      PhysicalRanges()[physical] = adjusted_size;
      PhysicalVirtualBases()[physical] = virtual_address;
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
  kFile,
  kEnumerator,
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
  // File state (Xenia XFile).
  uint32_t vfs_entry = 0;  // 1-based index into the VFS table.
  std::string vfs_device;  // "" = game disc, else a content device path.
  uint64_t position = 0;
  uint32_t find_index = 0;
  std::string find_pattern;
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
  for (uint32_t attempt = 0;; ++attempt) {
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
  // A bounded wait gives the other guest threads one turn to signal first.
  if (timeout && attempt == 0 && GuestFibersActive()) {
    ThreadWait& poll = g_thread_polls[r360_guest_thread_current()];
    poll.wait.module = module;
    poll.wait.ordinal = ordinal;
    poll.wait.object = first_blocked;
    poll.wait.handle = first_handle;
    uint8_t type = 0xFF;
    Rd8(first_blocked, &type);
    poll.wait.object_type = type;
    poll.wait.reason = uint32_t(timeout & 0xFFFFFFFFu);
    poll.caller_lr = g_caller_lr;
    ++poll.count;
  }
  if (timeout && attempt == 0 && GuestFiberYield(false)) continue;
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
}

bool GuestObjectForHandle(uint32_t handle, uint32_t* guest) {
  KernelObject* object = ResolveHandle(handle);
  if (object && object->type == ObjectType::kFile && !object->guest) {
    // Files complete I/O synchronously, so they are always signalled. Give
    // the object a signalled notification-event header to wait on.
    object->guest = PoolAlloc(16);
    object->owns_guest = true;
    if (!object->guest || !InitDispatcher(object->guest, kDispNotificationEvent, 16, 1)) {
      return false;
    }
  }
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

// Audio render-driver clients (Xenia AudioSystem::RegisterClient). The
// browser audio pump reads callback/argument pairs to drive guest callbacks.
struct AudioClient {
  bool used = false;
  uint32_t callback = 0;
  uint32_t callback_arg = 0;
  uint32_t frames_submitted = 0;
  uint32_t last_samples = 0;
  // Xenia AudioSystem: the guest pointer to the callback argument passed to
  // the callback (wrapped_callback_arg), the client semaphore count (frames
  // the title may still render) and frames submitted but not yet played.
  uint32_t wrapped_arg = 0;
  uint32_t available = 0;
  uint32_t queued = 0;
};
constexpr uint32_t kMaxAudioClients = 8;
// Xenia AudioSystem::kMaximumQueuedFrames.
constexpr uint32_t kAudioMaxQueuedFrames = 64;
std::array<AudioClient, kMaxAudioClients> g_audio_clients{};
// The audio "driver" plays one 256-sample frame per 16/3 ms (48 kHz), like
// Xenia's SDL driver releasing the client semaphore per consumed frame.
uint64_t g_audio_origin_ms = 0;
uint64_t g_audio_frames_played = 0;
uint32_t g_audio_thread = 0;
uint32_t g_audio_callbacks = 0;
// XMA hardware contexts (Xenia XmaDecoder: 320 x 64-byte contexts in
// physical memory). Decoding is not implemented yet; allocation is.
constexpr uint32_t kXmaContextCount = 320;
constexpr uint32_t kXmaContextBytes = 64;
uint32_t g_xma_context_base = 0;
std::array<bool, kXmaContextCount> g_xma_context_used{};

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
// Virtual file system (Xenia VirtualFileSystem + DiscImageDevice).
//
// The browser loader registers the title's disc/package directory tree. File
// bytes come from one of two sources:
//   * a buffer the loader filled in wasm memory (small or prefetched files), or
//   * WASI fd_pread on a host descriptor the loader owns (the Node title runner
//     reads the real ISO synchronously; a worker-hosted browser runtime can
//     use FileReaderSync on the File/Blob).
// When neither can supply the bytes synchronously the read stops at a
// would-block "host I/O" boundary naming the file, offset and length.

constexpr uint32_t kFileAttributeReadOnly = 0x0001u;
constexpr uint32_t kFileAttributeDirectory = 0x0010u;
constexpr uint32_t kFileAttributeNormal = 0x0080u;
constexpr uint32_t kWaitReasonHostIo = 4u;

struct VfsEntry {
  std::string device;  // "" = game disc (\\device\\cdrom0), else a content device.
  std::string path;  // Lowercase, '\\'-separated, relative to the device root.
  std::string name;  // Original-case final component.
  uint64_t size = 0;
  uint32_t attributes = kFileAttributeNormal | kFileAttributeReadOnly;
  uint32_t host_fd = 0;
  uint64_t host_offset = 0;
  std::vector<uint8_t> data;
  bool has_data = false;
  uint64_t timestamp = 0;
};

std::vector<VfsEntry>& VfsEntries() {
  static std::vector<VfsEntry> entries;
  return entries;
}
std::map<std::string, uint32_t>& VfsIndex() {
  static std::map<std::string, uint32_t> index;
  return index;
}
// Symbolic links (ObCreateSymbolicLink / Xenia RegisterSymbolicLink).
std::map<std::string, std::string>& VfsSymlinks() {
  static std::map<std::string, std::string> links;
  return links;
}
const char kDiscDevice[] = "\\device\\cdrom0";

// Writable content devices (save data packages), keyed by lowercase device
// path such as "\\device\\content\\1". The game disc is device "".
struct VfsDevice {
  bool writable = true;
};
std::map<std::string, VfsDevice>& VfsDevices() {
  static std::map<std::string, VfsDevice> devices;
  return devices;
}
std::string VfsKey(const std::string& device, const std::string& relative) {
  return device.empty() ? relative : device + "|" + relative;
}
std::string DevicePath(const std::string& device) {
  return device.empty() ? std::string(kDiscDevice) : device;
}

struct HostIoRequest {
  uint32_t entry = 0;
  uint64_t offset = 0;
  uint32_t length = 0;
  uint32_t host_errno = 0;
};
HostIoRequest g_host_io;
uint32_t g_vfs_reads = 0;
uint64_t g_vfs_bytes_read = 0;
char g_vfs_path_buffer[1024];

std::string Lower(std::string text) {
  for (auto& c : text) c = char(c >= 'A' && c <= 'Z' ? c + 32 : c);
  return text;
}

// xe::utf8::canonicalize_guest_path: split on '\\' or '/', drop '.', pop '..'.
std::string CanonicalizeGuestPath(const std::string& path) {
  std::vector<std::string> parts;
  std::string current;
  const auto flush = [&]() {
    if (current.empty() || current == ".") {
    } else if (current == "..") {
      if (!parts.empty()) parts.pop_back();
    } else {
      parts.push_back(current);
    }
    current.clear();
  };
  for (char c : path) {
    if (c == '\\' || c == '/') {
      flush();
    } else {
      current.push_back(c);
    }
  }
  flush();
  std::string out;
  const bool rooted = !path.empty() && (path[0] == '\\' || path[0] == '/');
  for (size_t i = 0; i < parts.size(); ++i) {
    if (i || rooted) out.push_back('\\');
    out += parts[i];
  }
  return out;
}

void EnsureDefaultSymlinks() {
  auto& links = VfsSymlinks();
  if (!links.empty()) return;
  links["game:"] = kDiscDevice;
  links["d:"] = kDiscDevice;
}

// Resolves a guest path to a device ("" = disc) and a device-relative key
// ("" is the device root). Returns false when no device owns the path.
bool ResolveGuestPath(std::string path, std::string* device_out,
                      std::string* relative) {
  EnsureDefaultSymlinks();
  if (Lower(path.substr(0, 4)) == "\\??\\") path = path.substr(4);
  std::string normalized = Lower(CanonicalizeGuestPath(path));
  for (int depth = 0; depth < 8; ++depth) {
    bool resolved = false;
    for (const auto& [key, value] : VfsSymlinks()) {
      if (normalized.compare(0, key.size(), key) == 0) {
        normalized = Lower(CanonicalizeGuestPath(value + "\\" + normalized.substr(key.size())));
        resolved = true;
        break;
      }
    }
    if (!resolved) break;
  }
  const auto owns = [&](const std::string& device_path, std::string* rest) {
    if (normalized.compare(0, device_path.size(), device_path) != 0) return false;
    *rest = normalized.substr(device_path.size());
    if (!rest->empty() && (*rest)[0] != '\\') return false;
    if (!rest->empty()) *rest = rest->substr(1);
    return true;
  };
  std::string rest;
  if (owns(kDiscDevice, &rest)) {
    *device_out = "";
    *relative = rest;
    return true;
  }
  for (const auto& [device_path, info] : VfsDevices()) {
    if (owns(device_path, &rest)) {
      *device_out = device_path;
      *relative = rest;
      return true;
    }
  }
  return false;
}

uint32_t RegisterVfsEntryOn(const std::string& device, const std::string& raw_path,
                            uint64_t size, uint32_t attributes, uint32_t host_fd,
                            uint64_t host_offset) {
  std::string canonical = CanonicalizeGuestPath(raw_path);
  if (!canonical.empty() && canonical[0] == '\\') canonical = canonical.substr(1);
  const std::string key = Lower(canonical);
  auto& entries = VfsEntries();
  auto& index = VfsIndex();
  // Register parent directories first so directory queries can enumerate.
  const size_t slash = canonical.find_last_of('\\');
  if (slash != std::string::npos) {
    const std::string parent = canonical.substr(0, slash);
    if (!index.count(VfsKey(device, Lower(parent)))) {
      RegisterVfsEntryOn(device, parent, 0,
                         kFileAttributeDirectory |
                             (device.empty() ? kFileAttributeReadOnly : 0u),
                         0, 0);
    }
  }
  auto found = index.find(VfsKey(device, key));
  if (found != index.end()) {
    auto& entry = entries[found->second - 1];
    entry.size = size;
    entry.attributes = attributes;
    entry.host_fd = host_fd;
    entry.host_offset = host_offset;
    return found->second;
  }
  VfsEntry entry;
  entry.device = device;
  entry.path = key;
  entry.name = slash == std::string::npos ? canonical : canonical.substr(slash + 1);
  entry.size = size;
  entry.attributes = attributes;
  entry.host_fd = host_fd;
  entry.host_offset = host_offset;
  entry.timestamp = kUnixEpochAsFileTime;
  entries.push_back(std::move(entry));
  index[VfsKey(device, key)] = uint32_t(entries.size());
  return uint32_t(entries.size());
}

uint32_t RegisterVfsEntry(const std::string& raw_path, uint64_t size,
                          uint32_t attributes, uint32_t host_fd,
                          uint64_t host_offset) {
  return RegisterVfsEntryOn("", raw_path, size, attributes, host_fd, host_offset);
}

VfsEntry* VfsEntryAt(uint32_t one_based) {
  auto& entries = VfsEntries();
  return one_based && one_based <= entries.size() ? &entries[one_based - 1] : nullptr;
}

uint32_t LookupVfs(const std::string& device, const std::string& relative) {
  if (relative.empty()) return 0;  // Device root; callers special-case it.
  auto it = VfsIndex().find(VfsKey(device, relative));
  return it == VfsIndex().end() ? 0u : it->second;
}

// XFile::Read semantics: returns an NTSTATUS, fills *read. Sets
// g_status = would-block when the host cannot provide the bytes now.
uint32_t ReadVfs(VfsEntry& entry, uint32_t entry_index, uint64_t offset,
                 uint32_t guest_buffer, uint32_t length, uint32_t* read) {
  *read = 0;
  if (!length) return X_STATUS_SUCCESS;
  if (uint64_t(guest_buffer) + length > 0x100000000ull) return X_STATUS_ACCESS_VIOLATION;
  if (offset >= entry.size) return X_STATUS_END_OF_FILE;
  const uint32_t count = uint32_t(std::min<uint64_t>(length, entry.size - offset));
  if (entry.has_data) {
    if (!Wr(guest_buffer, entry.data.data() + offset, count)) return X_STATUS_ACCESS_VIOLATION;
    *read = count;
    ++g_vfs_reads;
    g_vfs_bytes_read += count;
    return X_STATUS_SUCCESS;
  }
#if defined(__wasm__)
  if (entry.host_fd) {
    std::vector<uint8_t> chunk(std::min<uint32_t>(count, 1u << 20));
    uint32_t done = 0;
    while (done < count) {
      const uint32_t want = std::min<uint32_t>(count - done, uint32_t(chunk.size()));
      __wasi_iovec_t iov{chunk.data(), want};
      __wasi_size_t got = 0;
      const __wasi_errno_t err = __wasi_fd_pread(
          entry.host_fd, &iov, 1, entry.host_offset + offset + done, &got);
      if (err != __WASI_ERRNO_SUCCESS || got == 0) {
        if (done) break;
        g_host_io = {entry_index, offset, count, uint32_t(err)};
        g_wait = {};
        g_wait.object = entry_index;
        g_wait.reason = kWaitReasonHostIo;
        g_status = kKernelServiceWouldBlock;
        return 0;
      }
      if (!Wr(guest_buffer + done, chunk.data(), got)) return X_STATUS_ACCESS_VIOLATION;
      done += got;
    }
    *read = done;
    ++g_vfs_reads;
    g_vfs_bytes_read += done;
    return X_STATUS_SUCCESS;
  }
#endif
  g_host_io = {entry_index, offset, count, 0};
  g_wait = {};
  g_wait.object = entry_index;
  g_wait.reason = kWaitReasonHostIo;
  g_status = kKernelServiceWouldBlock;
  return 0;
}

bool WriteIoStatus(uint32_t io_status_block, uint32_t status, uint32_t information) {
  if (!io_status_block) return true;
  return Wr32(io_status_block, status) && Wr32(io_status_block + 4u, information);
}

// Reads X_OBJECT_ATTRIBUTES and returns the full guest path, prefixing the
// path of a root-directory file handle when one is supplied.
bool ObjectAttributesPath(uint32_t attributes_ptr, std::string* path) {
  uint32_t root = 0, name_ptr = 0;
  if (!Rd32(attributes_ptr, &root) || !Rd32(attributes_ptr + 4u, &name_ptr)) return false;
  std::string name;
  if (name_ptr && !ReadAnsiString(name_ptr, &name)) return false;
  for (char c : name) {
    if (uint8_t(c) < 0x20 || uint8_t(c) >= 0x7F) return false;  // Xenia IsValidPath.
  }
  if (root && root != 0xFFFFFFFDu) {  // 0xFFFFFFFD = ObDosDevices.
    KernelObject* dir = ResolveHandle(root);
    if (!dir || dir->type != ObjectType::kFile) return false;
    const VfsEntry* base = VfsEntryAt(dir->vfs_entry);
    name = DevicePath(dir->vfs_device) + (base ? "\\" + base->path : std::string()) +
           "\\" + name;
  }
  *path = name;
  return true;
}

// Wildcard match used by NtQueryDirectoryFile (Xenia FindEngine semantics
// for '*' and '?', case-insensitive).
bool WildcardMatch(const std::string& pattern, const std::string& text) {
  size_t p = 0, t = 0, star = std::string::npos, mark = 0;
  while (t < text.size()) {
    if (p < pattern.size() && (pattern[p] == '?' || pattern[p] == text[t])) {
      ++p;
      ++t;
    } else if (p < pattern.size() && pattern[p] == '*') {
      star = p++;
      mark = t;
    } else if (star != std::string::npos) {
      p = star + 1;
      t = ++mark;
    } else {
      return false;
    }
  }
  while (p < pattern.size() && pattern[p] == '*') ++p;
  return p == pattern.size();
}

bool WriteNetworkOpenInfo(uint32_t out, const VfsEntry* entry, bool is_root) {
  const uint64_t size = entry ? entry->size : 0;
  const uint64_t time = entry ? entry->timestamp : kUnixEpochAsFileTime;
  const uint32_t attributes = is_root ? (kFileAttributeDirectory | kFileAttributeReadOnly)
                                      : entry->attributes;
  return Wr64(out + 0, time) && Wr64(out + 8, time) && Wr64(out + 16, time) &&
         Wr64(out + 24, time) && Wr64(out + 32, (size + 2047u) & ~uint64_t(2047u)) &&
         Wr64(out + 40, size) && Wr32(out + 48, attributes) && Wr32(out + 52, 0);
}

// ---------------------------------------------------------------------------
// xboxkrnl dispatch.

// ---------------------------------------------------------------------------
// Crypto primitives for Xenia xboxkrnl_crypt.cc (SHA-1, SHA-256, RC4). The
// guest-visible state structures keep Xenia's layouts.

uint32_t Rotl32(uint32_t v, uint32_t n) { return (v << n) | (v >> (32u - n)); }
uint32_t Rotr32(uint32_t v, uint32_t n) { return (v >> n) | (v << (32u - n)); }

struct Sha1 {
  uint32_t h[5] = {0x67452301u, 0xEFCDAB89u, 0x98BADCFEu, 0x10325476u,
                   0xC3D2E1F0u};
  uint64_t count = 0;  // bytes
  uint8_t block[64] = {};
  void Compress(const uint8_t* p) {
    uint32_t w[80];
    for (int i = 0; i < 16; ++i) {
      w[i] = (uint32_t(p[i * 4]) << 24) | (uint32_t(p[i * 4 + 1]) << 16) |
             (uint32_t(p[i * 4 + 2]) << 8) | p[i * 4 + 3];
    }
    for (int i = 16; i < 80; ++i) w[i] = Rotl32(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);
    uint32_t a = h[0], b = h[1], c = h[2], d = h[3], e = h[4];
    for (int i = 0; i < 80; ++i) {
      uint32_t f, k;
      if (i < 20) { f = (b & c) | (~b & d); k = 0x5A827999u; }
      else if (i < 40) { f = b ^ c ^ d; k = 0x6ED9EBA1u; }
      else if (i < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8F1BBCDCu; }
      else { f = b ^ c ^ d; k = 0xCA62C1D6u; }
      const uint32_t t = Rotl32(a, 5) + f + e + k + w[i];
      e = d; d = c; c = Rotl32(b, 30); b = a; a = t;
    }
    h[0] += a; h[1] += b; h[2] += c; h[3] += d; h[4] += e;
  }
  void Update(const uint8_t* data, size_t size) {
    for (size_t i = 0; i < size; ++i) {
      block[count % 64] = data[i];
      ++count;
      if (count % 64 == 0) Compress(block);
    }
  }
  void Final(uint8_t out[20]) {
    const uint64_t bits = count * 8u;
    const uint8_t pad = 0x80, zero = 0;
    Update(&pad, 1);
    while (count % 64 != 56) Update(&zero, 1);
    for (int i = 7; i >= 0; --i) {
      const uint8_t byte = uint8_t(bits >> (i * 8));
      Update(&byte, 1);
    }
    for (int i = 0; i < 5; ++i) {
      out[i * 4] = uint8_t(h[i] >> 24); out[i * 4 + 1] = uint8_t(h[i] >> 16);
      out[i * 4 + 2] = uint8_t(h[i] >> 8); out[i * 4 + 3] = uint8_t(h[i]);
    }
  }
};

struct Sha256 {
  uint32_t h[8] = {0x6a09e667u, 0xbb67ae85u, 0x3c6ef372u, 0xa54ff53au,
                   0x510e527fu, 0x9b05688cu, 0x1f83d9abu, 0x5be0cd19u};
  uint64_t count = 0;
  uint8_t block[64] = {};
  void Compress(const uint8_t* p) {
    static constexpr uint32_t k[64] = {
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
        0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
        0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
        0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
        0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
        0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
        0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
        0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
        0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
        0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
        0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2};
    uint32_t w[64];
    for (int i = 0; i < 16; ++i) {
      w[i] = (uint32_t(p[i * 4]) << 24) | (uint32_t(p[i * 4 + 1]) << 16) |
             (uint32_t(p[i * 4 + 2]) << 8) | p[i * 4 + 3];
    }
    for (int i = 16; i < 64; ++i) {
      const uint32_t s0 = Rotr32(w[i - 15], 7) ^ Rotr32(w[i - 15], 18) ^ (w[i - 15] >> 3);
      const uint32_t s1 = Rotr32(w[i - 2], 17) ^ Rotr32(w[i - 2], 19) ^ (w[i - 2] >> 10);
      w[i] = w[i - 16] + s0 + w[i - 7] + s1;
    }
    uint32_t a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5],
             g = h[6], hh = h[7];
    for (int i = 0; i < 64; ++i) {
      const uint32_t s1 = Rotr32(e, 6) ^ Rotr32(e, 11) ^ Rotr32(e, 25);
      const uint32_t ch = (e & f) ^ (~e & g);
      const uint32_t t1 = hh + s1 + ch + k[i] + w[i];
      const uint32_t s0 = Rotr32(a, 2) ^ Rotr32(a, 13) ^ Rotr32(a, 22);
      const uint32_t maj = (a & b) ^ (a & c) ^ (b & c);
      const uint32_t t2 = s0 + maj;
      hh = g; g = f; f = e; e = d + t1; d = c; c = b; b = a; a = t1 + t2;
    }
    h[0] += a; h[1] += b; h[2] += c; h[3] += d;
    h[4] += e; h[5] += f; h[6] += g; h[7] += hh;
  }
  void Update(const uint8_t* data, size_t size) {
    for (size_t i = 0; i < size; ++i) {
      block[count % 64] = data[i];
      ++count;
      if (count % 64 == 0) Compress(block);
    }
  }
  void Final(uint8_t out[32]) {
    const uint64_t bits = count * 8u;
    const uint8_t pad = 0x80, zero = 0;
    Update(&pad, 1);
    while (count % 64 != 56) Update(&zero, 1);
    for (int i = 7; i >= 0; --i) {
      const uint8_t byte = uint8_t(bits >> (i * 8));
      Update(&byte, 1);
    }
    for (int i = 0; i < 8; ++i) {
      out[i * 4] = uint8_t(h[i] >> 24); out[i * 4 + 1] = uint8_t(h[i] >> 16);
      out[i * 4 + 2] = uint8_t(h[i] >> 8); out[i * 4 + 3] = uint8_t(h[i]);
    }
  }
};

// Feeds guest bytes to |hash| in bounded chunks.
template <typename Hash>
bool HashGuest(Hash& hash, uint32_t address, uint32_t size) {
  uint8_t chunk[1024];
  while (size) {
    const uint32_t n = std::min<uint32_t>(size, sizeof(chunk));
    if (!Rd(address, chunk, n)) return false;
    hash.Update(chunk, n);
    address += n;
    size -= n;
  }
  return true;
}

// XECRYPT_SHA_STATE {be32 count; be32 state[5]; u8 buffer[64]} (0x58) and
// XECRYPT_SHA256_STATE {be32 count; be32 state[8]; u8 buffer[64]}.
template <typename Hash, int kWords>
bool LoadHashState(uint32_t state, Hash* hash) {
  uint32_t count = 0;
  if (!Rd32(state, &count)) return false;
  for (int i = 0; i < kWords; ++i) {
    if (!Rd32(state + 4u + uint32_t(i) * 4u, &hash->h[i])) return false;
  }
  hash->count = count;
  return Rd(state + 4u + kWords * 4u, hash->block, 64);
}
template <typename Hash, int kWords>
bool StoreHashState(uint32_t state, const Hash& hash) {
  if (!Wr32(state, uint32_t(hash.count))) return false;
  for (int i = 0; i < kWords; ++i) {
    if (!Wr32(state + 4u + uint32_t(i) * 4u, hash.h[i])) return false;
  }
  return Wr(state + 4u + kWords * 4u, hash.block, 64);
}

// XECRYPT_RC4_STATE {u8 S[256]; u8 i; u8 j}. Xenia always indexes the key
// modulo 16; real hardware uses the key length, which is identical for the
// 16-byte keys titles pass.
bool Rc4Key(uint32_t state, uint32_t key, uint32_t key_size) {
  if (!key_size) return false;
  uint8_t s[256];
  std::vector<uint8_t> k(key_size);
  if (!Rd(key, k.data(), key_size)) return false;
  for (uint32_t x = 0; x < 256; ++x) s[x] = uint8_t(x);
  uint32_t idx = 0;
  for (uint32_t x = 0; x < 256; ++x) {
    idx = (idx + s[x] + k[x % key_size]) & 0xFFu;
    std::swap(s[idx], s[x]);
  }
  const uint8_t ij[2] = {0, 0};
  return Wr(state, s, 256) && Wr(state + 256u, ij, 2);
}
bool Rc4Crypt(uint32_t state, uint32_t data, uint32_t size) {
  uint8_t s[256], ij[2];
  if (!Rd(state, s, 256) || !Rd(state + 256u, ij, 2)) return false;
  uint8_t i = ij[0], j = ij[1];
  uint8_t chunk[1024];
  for (uint32_t done = 0; done < size;) {
    const uint32_t n = std::min<uint32_t>(size - done, sizeof(chunk));
    if (!Rd(data + done, chunk, n)) return false;
    for (uint32_t b = 0; b < n; ++b) {
      i = uint8_t(i + 1);
      j = uint8_t(j + s[i]);
      std::swap(s[i], s[j]);
      chunk[b] ^= s[uint8_t(s[i] + s[j])];
    }
    if (!Wr(data + done, chunk, n)) return false;
    done += n;
  }
  ij[0] = i;
  ij[1] = j;
  return Wr(state, s, 256) && Wr(state + 256u, ij, 2);
}

// ---------------------------------------------------------------------------
// Xenia default user profile settings (xam/user_profile.cc). Title-specific
// binary settings start unset and keep what the title writes for this run.

struct ProfileSetting {
  uint32_t id;
  uint32_t value;  // INT32 / FLOAT bit pattern
  const char16_t* text;
};
constexpr ProfileSetting kDefaultProfileSettings[] = {
    {0x10040002u, 0, nullptr},           {0x10040003u, 3, nullptr},
    {0x10040004u, 0, nullptr},           {0x10040005u, 0, nullptr},
    {0x10040006u, 0xFA, nullptr},        {0x5004000Bu, 0, nullptr},
    {0x1004000Cu, 0, nullptr},           {0x1004000Du, 0, nullptr},
    {0x1004000Eu, 0x64, nullptr},        {0x402C0011u, 0, u""},
    {0x10040012u, 1, nullptr},           {0x10040013u, 0, nullptr},
    {0x10040015u, 0, nullptr},           {0x10040018u, 0, nullptr},
    {0x1004001Du, 0xFFFF0000u, nullptr}, {0x1004001Eu, 0xFF00FF00u, nullptr},
    {0x10040022u, 1, nullptr},           {0x10040023u, 0, nullptr},
    {0x10040024u, 0, nullptr},           {0x10040026u, 0, nullptr},
    {0x10040027u, 0, nullptr},           {0x10040028u, 0, nullptr},
    {0x10040029u, 0, nullptr},           {0x10040038u, 0, nullptr},
    {0x10040039u, 0, nullptr},           {0x4064000Fu, 0, u"gamercard_picture_key"},
};
constexpr uint32_t kTitleSpecificSettings[] = {0x63E83FFFu, 0x63E83FFEu,
                                               0x63E83FFDu};

std::map<uint32_t, std::vector<uint8_t>>& TitleProfileSettings() {
  static std::map<uint32_t, std::vector<uint8_t>> settings;
  return settings;
}

const ProfileSetting* FindDefaultProfileSetting(uint32_t id) {
  for (const auto& setting : kDefaultProfileSettings) {
    if (setting.id == id) return &setting;
  }
  return nullptr;
}
bool IsTitleSpecificSetting(uint32_t id) {
  for (uint32_t known : kTitleSpecificSettings) {
    if (known == id) return true;
  }
  return false;
}

std::vector<uint8_t>& LaunchData() {
  static std::vector<uint8_t> data;
  return data;
}
bool g_launch_data_present = false;

// Xenia KernelState::CompleteOverlappedImmediate for XAM_OVERLAPPED
// {result, length, context, event, completion_routine, completion_context,
// extended_error}. A completion routine would need a guest APC, which the
// browser kernel does not deliver yet, so that case fails closed.
bool CompleteOverlappedEx(uint32_t overlapped, uint32_t result,
                          uint32_t extended_error, uint32_t length) {
  uint32_t event = 0, routine = 0;
  if (!Rd32(overlapped + 12u, &event) || !Rd32(overlapped + 16u, &routine)) {
    return false;
  }
  if (routine) return false;
  if (!Wr32(overlapped + 0u, result) || !Wr32(overlapped + 24u, extended_error) ||
      !Wr32(overlapped + 4u, length) || !Wr32(overlapped + 8u, CurrentKThread())) {
    return false;
  }
  if (event) {
    KernelObject* object = ResolveHandle(event);
    if (!object || object->type != ObjectType::kEvent ||
        !Wr32(object->guest + 4u, 1u)) {
      return false;
    }
  }
  return true;
}
bool CompleteOverlappedImmediate(uint32_t overlapped, uint32_t result) {
  // Xenia: some games treat length as success, so failures report -1.
  return CompleteOverlappedEx(overlapped, result, result, result ? 0xFFFFFFFFu : 0u);
}
uint32_t HresultFromWin32(uint32_t code) {
  return code ? (code & 0xFFFFu) | 0x80070000u : 0u;
}
// Xenia CompleteOverlappedDeferredEx, run synchronously: result, the
// HRESULT form as extended error, and an operation-specific length.
uint32_t FinishXamOverlapped(uint32_t overlapped, uint32_t result, uint32_t length) {
  if (!overlapped) return result;
  if (!CompleteOverlappedEx(overlapped, result, HresultFromWin32(result), length)) {
    return Invalid();
  }
  return X_ERROR_IO_PENDING;
}

// Xenia's XamUserReadProfileSettingsEx for the signed-in local profile.
uint32_t ReadProfileSettings(uint32_t user_index, uint32_t xuid_count,
                             uint32_t xuids, uint32_t setting_count,
                             uint32_t setting_ids, uint32_t buffer_size_ptr,
                             uint32_t buffer, uint32_t overlapped) {
  auto finish = [&](uint32_t result) -> uint32_t {
    if (!overlapped) return result;
    if (!CompleteOverlappedImmediate(overlapped, result)) return Invalid();
    return X_ERROR_IO_PENDING;
  };
  if (xuid_count > 1) xuid_count = 1;
  if (setting_count < 1 || setting_count > 32 || !buffer_size_ptr) {
    return X_ERROR_INVALID_PARAMETER;
  }
  uint32_t buffer_size = 0;
  if (!Rd32(buffer_size_ptr, &buffer_size)) return Invalid();
  if (buffer_size && !buffer) return X_ERROR_INVALID_PARAMETER;
  std::vector<uint32_t> ids(setting_count);
  uint32_t header = 0, data = 0;
  for (uint32_t i = 0; i < setting_count; ++i) {
    if (!Rd32(setting_ids + i * 4u, &ids[i])) return Invalid();
    header += 40u;
    const uint32_t type = ids[i] >> 28, size = (ids[i] >> 16) & 0xFFFu;
    if (type == 4u || type == 6u) data += size;
  }
  if (xuids) {
    header *= xuid_count;
    data *= xuid_count;
  }
  header += 8u;
  const uint32_t needed = header + data;
  if (!buffer || buffer_size < needed) {
    if (!buffer_size && !Wr32(buffer_size_ptr, needed)) return Invalid();
    return X_ERROR_INSUFFICIENT_BUFFER;
  }
  if (!xuids && user_index) return finish(X_ERROR_NO_SUCH_USER);
  for (uint32_t id : ids) {
    if (!FindDefaultProfileSetting(id) && !IsTitleSpecificSetting(id)) {
      DebugLog("XamUserReadProfileSettings: unknown setting " +
               std::to_string(id));
      return finish(X_ERROR_INVALID_PARAMETER);
    }
  }
  if (!Wr32(buffer, setting_count) || !Wr32(buffer + 4u, buffer + 8u)) {
    return Invalid();
  }
  uint32_t stream = buffer + header;
  for (uint32_t n = 0; n < setting_count; ++n) {
    const uint32_t out = buffer + 8u + n * 40u, id = ids[n];
    if (!ZeroGuest(out, 40u)) return Invalid();
    const ProfileSetting* def = FindDefaultProfileSetting(id);
    auto& title = TitleProfileSettings();
    const auto stored = title.find(id);
    const bool is_set = def || stored != title.end();
    const uint32_t from = !is_set ? 0u : (IsTitleSpecificSetting(id) ? 2u : 1u);
    if (!Wr32(out, from) || !Wr32(out + 16u, id)) return Invalid();
    if (xuids) {
      if (!Wr64(out + 8u, 0xB13EBABEBABEBABEull)) return Invalid();
    } else if (!Wr32(out + 8u, user_index)) {
      return Invalid();
    }
    if (!is_set) continue;
    const uint32_t type = id >> 28;
    if (!Wr8(out + 24u, uint8_t(type))) return Invalid();
    if (def && def->text) {
      std::u16string text(def->text);
      if (text.empty()) continue;
      const uint32_t bytes = uint32_t(text.size() + 1u) * 2u;
      for (size_t i = 0; i <= text.size(); ++i) {
        if (!Wr16(stream + uint32_t(i) * 2u, i < text.size() ? text[i] : 0)) {
          return Invalid();
        }
      }
      if (!Wr32(out + 32u, bytes) || !Wr32(out + 36u, stream)) return Invalid();
      stream += bytes;
    } else if (def) {
      if (!Wr32(out + 32u, def->value)) return Invalid();
    } else {
      const auto& value = stored->second;
      if (!Wr32(out + 32u, uint32_t(value.size())) || !Wr32(out + 36u, stream) ||
          (!value.empty() && !Wr(stream, value.data(), uint32_t(value.size())))) {
        return Invalid();
      }
      stream += uint32_t(value.size());
    }
  }
  return finish(X_ERROR_SUCCESS);
}

// Kernel stacks (MmCreateKernelStack) come from the 0x70000000 stack heap
// like Xenia; the primary thread's stack owns the bottom of that heap.
constexpr uint32_t kKernelStackBase = 0x78000000u;
constexpr uint32_t kKernelStackEnd = 0x7F000000u;
std::map<uint32_t, uint32_t>& KernelStacks() {  // low address -> size
  static std::map<uint32_t, uint32_t> stacks;
  return stacks;
}
uint32_t CreateKernelStack(uint32_t stack_size) {
  const uint32_t size = RoundUp(stack_size, 0x1000u);
  const uint32_t alignment = (stack_size & 0xF000u) ? 0x1000u : 0x10000u;
  if (!size) return 0;
  uint32_t candidate = kKernelStackBase;
  for (const auto& [base, length] : KernelStacks()) {
    if (uint64_t(candidate) + size <= base) break;
    candidate = RoundUp(base + length, alignment);
  }
  if (uint64_t(candidate) + size > kKernelStackEnd) return 0;
  const uint32_t pages = size / 0x1000u;
  const uint32_t backing = AllocateSparseGuestBacking(pages);
  if (!backing ||
      !MapSparseGuestMemory(candidate, pages, backing, 0, kGuestRead | kGuestWrite)) {
    return 0;
  }
  KernelStacks()[candidate] = size;
  return candidate + stack_size;
}

// Title terminate notifications (ExRegisterTitleTerminateNotification): the
// routine + priority pairs a title registers, kept for the terminal report.
std::map<uint32_t, uint32_t>& TitleTerminateNotifications() {
  static std::map<uint32_t, uint32_t> routines;
  return routines;
}

// KeSetCurrentStackPointers moves the caller's r1; the import probe applies
// this after the service returns.
uint32_t g_pending_stack_pointer = 0;
bool g_pending_stack_pointer_valid = false;

// ---------------------------------------------------------------------------
// XMA contexts (Xenia xboxkrnl_audio_xma.cc / apu/xma_context.h). A context
// is 16 big-endian dwords whose bitfields are numbered from the LSB of each
// dword. There is no XMA decoder yet, so buffers the title marks valid are
// never consumed; XMABlockWhileInUse reports that as a named wait.

constexpr uint32_t kWaitReasonXmaDecoder = 5u;

struct XmaField {
  uint32_t dword, shift, bits;
};
constexpr XmaField kXmaInput0PacketCount{0, 0, 12}, kXmaLoopCount{0, 12, 8},
    kXmaInput0Valid{0, 20, 1}, kXmaInput1Valid{0, 21, 1},
    kXmaOutputBlockCount{0, 22, 5}, kXmaOutputWriteOffset{0, 27, 5},
    kXmaInput1PacketCount{1, 0, 12}, kXmaLoopSubframeEnd{1, 14, 3},
    kXmaLoopSubframeSkip{1, 17, 3}, kXmaSubframeDecodeCount{1, 20, 4},
    kXmaSampleRate{1, 27, 2}, kXmaIsStereo{1, 29, 1},
    kXmaOutputValid{1, 31, 1}, kXmaInputReadOffset{2, 0, 26},
    kXmaLoopStart{3, 0, 26}, kXmaLoopEnd{4, 0, 26},
    kXmaPacketMetadata{4, 26, 5}, kXmaInput0Ptr{5, 0, 32},
    kXmaInput1Ptr{6, 0, 32}, kXmaOutputPtr{7, 0, 32},
    kXmaOutputReadOffset{9, 0, 5};

bool XmaGet(uint32_t context, XmaField field, uint32_t* value) {
  uint32_t word = 0;
  if (!Rd32(context + field.dword * 4u, &word)) return false;
  *value = field.bits == 32 ? word : (word >> field.shift) & ((1u << field.bits) - 1u);
  return true;
}
bool XmaSet(uint32_t context, XmaField field, uint32_t value) {
  uint32_t word = 0;
  if (!Rd32(context + field.dword * 4u, &word)) return false;
  if (field.bits == 32) {
    word = value;
  } else {
    const uint32_t mask = ((1u << field.bits) - 1u) << field.shift;
    word = (word & ~mask) | ((value << field.shift) & mask);
  }
  return Wr32(context + field.dword * 4u, word);
}
// The address the title's MmGetPhysicalAddress view gives for a buffer.
uint32_t GuestPhysicalAddress(uint32_t address) {
  if (const auto* p = FindPhysical(address)) {
    return p->physical_address + (address - p->virtual_address);
  }
  return address;
}
std::set<uint32_t>& XmaEnabledContexts() {
  static std::set<uint32_t> contexts;
  return contexts;
}
// XmaDecoder::Setup allocates the context array once, in physical memory.
bool EnsureXmaContextArray() {
  if (!g_xma_context_base) {
    g_xma_context_base = AllocatePhysical(kXmaContextCount * kXmaContextBytes,
                                          0x20000004u, 0, 0x1FFFFFFFu, 256);
  }
  return g_xma_context_base != 0;
}
// XmaDecoder register file (xma_register_table.inc): 0x4000 dwords.
constexpr uint32_t kXmaRegisterCount = 0x4000u;
constexpr uint32_t kXmaContextArrayAddress = 0x0600u, kXmaCurrentContextIndex = 0x0606u,
                   kXmaNextContextIndex = 0x0607u, kXmaContext0Kick = 0x0650u,
                   kXmaContext0Lock = 0x0690u, kXmaContext0Clear = 0x06A0u;
std::vector<uint32_t>& XmaRegisters() {
  static std::vector<uint32_t> registers;
  if (registers.empty()) {
    registers.assign(kXmaRegisterCount, 0u);
    registers[kXmaNextContextIndex] = 1u;
  }
  return registers;
}

// ---------------------------------------------------------------------------
// XAM notification listeners (Xenia XNotifyListener + KernelState). A listener
// is a waitable object: its manual-reset event is set while notifications are
// queued. The first system listener receives Xenia's startup notifications.

struct NotifyListener {
  uint32_t mask = 0;  // low 32 bits of the 64-bit mask (indices 0..31)
  uint32_t max_version = 0;
  std::deque<std::pair<uint32_t, uint32_t>> queue;
};
std::map<uint32_t, NotifyListener>& NotifyListeners() {  // handle -> listener
  static std::map<uint32_t, NotifyListener> listeners;
  return listeners;
}
bool g_notified_startup = false;

void EnqueueNotification(uint32_t handle, NotifyListener& listener,
                         uint32_t id, uint32_t data) {
  const uint32_t mask_index = (id >> 25) & 0x3Fu, version = (id >> 16) & 0x1FFu;
  if (mask_index >= 32 || !(listener.mask & (1u << mask_index))) return;
  if (version > listener.max_version) return;
  listener.queue.emplace_back(id, data);
  if (KernelObject* object = ResolveHandle(handle)) Wr32(object->guest + 4u, 1u);
}

uint32_t CreateNotifyListener(uint32_t mask, uint32_t max_version) {
  if (max_version > 10) max_version = 10;
  const uint32_t event = PoolAlloc(16);
  if (!event || !InitDispatcher(event, kDispNotificationEvent, 16, 0)) return 0;
  const uint32_t handle = CreateObject(ObjectType::kNotifyListener, event, true, "");
  if (!handle) return 0;
  auto& listener = NotifyListeners()[handle];
  listener = {};
  listener.mask = mask;
  listener.max_version = max_version;
  if (!g_notified_startup && (mask & 1u)) {
    g_notified_startup = true;
    for (const auto& [id, data] : {std::pair<uint32_t, uint32_t>{0x09u, 1u},
                                   {0x09u, 0u}, {0x0Au, 1u}, {0x0Au, 1u},
                                   {0x12u, 0u}, {0x12u, 0u}, {0x13u, 0u},
                                   {0x13u, 0u}}) {
      EnqueueNotification(handle, listener, id, data);
    }
  }
  return handle;
}

// ---------------------------------------------------------------------------
// Content packages (Xenia ContentManager): save data and other title content
// on the dummy HDD (device 1). Each package is a writable in-memory VFS
// device, mounted at "<root>:" while a title has it open. Packages last for
// this kernel session.

struct ContentPackage {
  uint32_t content_type = 0;
  std::string file_name;
  std::array<uint8_t, 0x134> data{};  // XCONTENT_DATA as the title passed it
  std::string device;                 // "\\device\\content\\N"
  std::vector<uint8_t> thumbnail;
};
std::vector<ContentPackage>& ContentPackages() {
  static std::vector<ContentPackage> packages;
  return packages;
}
std::map<std::string, std::string>& OpenContentRoots() {  // "save" -> device
  static std::map<std::string, std::string> roots;
  return roots;
}
uint32_t g_next_content_device = 1;
uint32_t g_license_mask = 0;  // Xenia cvars::license_mask default (trial).

// XCONTENT_DATA {device_id, content_type, display_name[128] u16,
// file_name[42], pad[2]} (0x134).
bool ReadContentData(uint32_t address, uint32_t* content_type, std::string* file_name,
                     std::array<uint8_t, 0x134>* raw) {
  if (!Rd(address, raw->data(), 0x134) || !Rd32(address + 4u, content_type)) return false;
  file_name->clear();
  for (uint32_t i = 0; i < 42; ++i) {
    const char c = char((*raw)[0x108 + i]);
    if (!c) break;
    file_name->push_back(c);
  }
  return true;
}
ContentPackage* FindContent(uint32_t content_type, const std::string& file_name) {
  for (auto& package : ContentPackages()) {
    if (package.content_type == content_type && Lower(package.file_name) == Lower(file_name)) {
      return &package;
    }
  }
  return nullptr;
}
bool ContentIsOpen(const ContentPackage& package) {
  for (const auto& [root, device] : OpenContentRoots()) {
    if (device == package.device) return true;
  }
  return false;
}
void MountContent(const std::string& root, const ContentPackage& package) {
  OpenContentRoots()[root] = package.device;
  VfsSymlinks()[root + ":"] = package.device;
}
void DeleteContentFiles(const std::string& device) {
  auto& entries = VfsEntries();
  std::vector<VfsEntry> kept;
  kept.reserve(entries.size());
  for (auto& entry : entries) {
    if (entry.device != device) kept.push_back(std::move(entry));
  }
  entries = std::move(kept);
  auto& index = VfsIndex();
  index.clear();
  for (uint32_t i = 0; i < entries.size(); ++i) {
    index[VfsKey(entries[i].device, entries[i].path)] = i + 1u;
  }
}
// Xenia ContentManager::CreateContent / OpenContent / CloseContent /
// DeleteContent return codes.
uint32_t CreateContent(const std::string& root, uint32_t content_type,
                       const std::string& file_name,
                       const std::array<uint8_t, 0x134>& raw) {
  if (OpenContentRoots().count(root) || FindContent(content_type, file_name)) {
    return X_ERROR_ALREADY_EXISTS;
  }
  ContentPackage package;
  package.content_type = content_type;
  package.file_name = file_name;
  package.data = raw;
  package.device = "\\device\\content\\" + std::to_string(g_next_content_device++);
  VfsDevices()[package.device] = {};
  ContentPackages().push_back(package);
  MountContent(root, ContentPackages().back());
  return X_ERROR_SUCCESS;
}
uint32_t OpenContent(const std::string& root, uint32_t content_type,
                     const std::string& file_name) {
  if (OpenContentRoots().count(root)) return X_ERROR_ALREADY_EXISTS;
  ContentPackage* package = FindContent(content_type, file_name);
  if (!package) return X_ERROR_FILE_NOT_FOUND;
  MountContent(root, *package);
  return X_ERROR_SUCCESS;
}
uint32_t CloseContent(const std::string& root) {
  auto it = OpenContentRoots().find(root);
  if (it == OpenContentRoots().end()) return X_ERROR_FILE_NOT_FOUND;
  VfsSymlinks().erase(root + ":");
  OpenContentRoots().erase(it);
  return X_ERROR_SUCCESS;
}
uint32_t DeleteContent(uint32_t content_type, const std::string& file_name) {
  auto& packages = ContentPackages();
  for (auto it = packages.begin(); it != packages.end(); ++it) {
    if (it->content_type != content_type || Lower(it->file_name) != Lower(file_name)) continue;
    if (ContentIsOpen(*it)) return X_ERROR_ACCESS_DENIED;
    DeleteContentFiles(it->device);
    VfsDevices().erase(it->device);
    packages.erase(it);
    return X_ERROR_SUCCESS;
  }
  return X_ERROR_FILE_NOT_FOUND;
}

// XAM enumerators (Xenia XStaticEnumerator): fixed-size items handed out
// items_per_enumerate at a time by XamEnumerate.
struct XamEnumerator {
  uint32_t item_size = 0;
  uint32_t per_enumerate = 1;
  uint32_t current = 0;
  std::vector<uint8_t> items;
  uint32_t count() const { return item_size ? uint32_t(items.size() / item_size) : 0; }
};
std::map<uint32_t, XamEnumerator>& XamEnumerators() {
  static std::map<uint32_t, XamEnumerator> enumerators;
  return enumerators;
}
uint32_t CreateXamEnumerator(uint32_t item_size, uint32_t per_enumerate,
                             std::vector<uint8_t> items) {
  const uint32_t handle = CreateObject(ObjectType::kEnumerator, 0, false);
  if (!handle) return 0;
  XamEnumerator e;
  e.item_size = item_size;
  e.per_enumerate = per_enumerate ? per_enumerate : 1u;
  e.items = std::move(items);
  XamEnumerators()[handle] = std::move(e);
  return handle;
}

// Xenia's dummy devices: HDD (id 1, type 1, 20 GB / 3 GB free) and ODD
// (id 2, type 4, 7 GB / 0 free).
struct DummyDevice {
  uint32_t id, type;
  uint64_t total, free;
  const char16_t* name;
};
constexpr DummyDevice kDummyDevices[] = {
    {1, 1, 20ull << 30, 3ull << 30, u"Dummy HDD"},
    {2, 4, 7ull << 30, 0, u"Dummy ODD"},
};
const DummyDevice* FindDummyDevice(uint32_t id) {
  for (const auto& device : kDummyDevices) {
    if (device.id == id) return &device;
  }
  return nullptr;
}
bool WriteDeviceData(uint32_t out, const DummyDevice& device) {
  // X_CONTENT_DEVICE_DATA {id, type, total u64, free u64, name[28] u16} (0x50)
  if (!ZeroGuest(out, 0x50) || !Wr32(out, device.id) || !Wr32(out + 4u, device.type) ||
      !Wr64(out + 8u, device.total) || !Wr64(out + 16u, device.free)) {
    return false;
  }
  const std::u16string name(device.name);
  for (size_t i = 0; i < name.size() && i < 27; ++i) {
    if (!Wr16(out + 24u + uint32_t(i) * 2u, name[i])) return false;
  }
  return true;
}

// Xenia KernelState::BroadcastNotification: every listener gets it.
void BroadcastNotification(uint32_t id, uint32_t data) {
  for (auto& [handle, listener] : NotifyListeners()) {
    if (KernelObject* object = ResolveHandle(handle);
        object && object->type == ObjectType::kNotifyListener) {
      EnqueueNotification(handle, listener, id, data);
    }
  }
}

// ---------------------------------------------------------------------------
// Xenia AppManager (xam/app_manager.cc) and its in-process apps: XmpApp (0xFA,
// the music player), XgiApp (0xFB) and XLiveBaseApp (0xFC). XMsgInProcessCall,
// XMsgSystemProcessCall and XMsgStartIORequest(Ex) dispatch here synchronously,
// as Xenia does. No audio is decoded for title playlists; the player state,
// handles and notifications follow Xenia.
constexpr uint32_t X_E_FAIL = 0x80004005u;
constexpr uint32_t X_E_NOTFOUND = 0x80070490u;

std::u16string ReadGuestU16String(uint32_t address) {
  std::u16string text;
  for (uint32_t i = 0; address && i < 1024; ++i) {
    uint16_t c = 0;
    if (!Rd16(address + i * 2u, &c) || !c) break;
    text.push_back(char16_t(c));
  }
  return text;
}
bool WriteGuestU16String(uint32_t address, const std::u16string& text) {
  for (size_t i = 0; i < text.size(); ++i) {
    if (!Wr16(address + uint32_t(i) * 2u, uint16_t(text[i]))) return false;
  }
  return Wr16(address + uint32_t(text.size()) * 2u, 0);
}

struct XmpSong {
  uint32_t handle = 0;
  std::u16string file_path, name, artist, album, album_artist, genre;
  uint32_t track_number = 0, duration_ms = 0, format = 0;
};
struct XmpPlaylist {
  uint32_t handle = 0;
  std::u16string name;
  uint32_t flags = 0;
  std::vector<XmpSong> songs;
};
struct XmpState {
  uint32_t state = 0;            // kIdle
  uint32_t playback_client = 1;  // kTitle
  uint32_t playback_mode = 0, repeat_mode = 0, unknown_flags = 0;
  float volume = 1.0f;
  uint32_t active_playlist = 0;  // playlist handle, 0 = none
  uint32_t active_song_index = 0;
  uint32_t next_playlist_handle = 1, next_song_handle = 1;
  std::map<uint32_t, XmpPlaylist> playlists;
};
XmpState& Xmp() {
  static XmpState state;
  return state;
}

constexpr uint32_t kXmpMsgStateChanged = 0x0A000001u;
constexpr uint32_t kXmpMsgPlaybackBehaviorChanged = 0x0A000002u;
constexpr uint32_t kXmpMsgPlaybackControllerChanged = 0x0A000003u;

void XmpOnStateChanged() {
  BroadcastNotification(kXmpMsgStateChanged, Xmp().state);
}
XmpPlaylist* XmpActivePlaylist() {
  auto it = Xmp().playlists.find(Xmp().active_playlist);
  return it == Xmp().playlists.end() ? nullptr : &it->second;
}
uint32_t XmpStop() {
  Xmp().active_playlist = 0;
  Xmp().active_song_index = 0;
  Xmp().state = 0;
  XmpOnStateChanged();
  return X_E_SUCCESS;
}

uint32_t XmpDispatch(uint32_t message, uint32_t buffer, uint32_t /*length*/) {
  XmpState& x = Xmp();
  uint32_t w[9] = {};
  auto args = [&](uint32_t count) {
    for (uint32_t i = 0; i < count; ++i) {
      if (!Rd32(buffer + i * 4u, &w[i])) return false;
    }
    return true;
  };
  switch (message) {
    case 0x00070002: {  // XMPPlayTitlePlaylist(client, storage, song)
      if (!args(3)) return Invalid();
      uint32_t playlist_handle = 0;
      if (!Rd32(w[1], &playlist_handle)) return Invalid();
      if (!x.playlists.count(playlist_handle)) return X_E_NOTFOUND;
      if (x.playback_client == 0) return X_E_SUCCESS;  // kSystem
      x.active_playlist = playlist_handle;
      x.active_song_index = 0;
      x.state = 1;  // kPlaying
      XmpOnStateChanged();
      BroadcastNotification(kXmpMsgPlaybackBehaviorChanged, 1);
      return X_E_SUCCESS;
    }
    case 0x00070003:  // XMPContinue
      if (x.state == 2) x.state = 1;
      XmpOnStateChanged();
      return X_E_SUCCESS;
    case 0x00070004:  // XMPStop
      return XmpStop();
    case 0x00070005:  // XMPPause
      if (x.state == 1) x.state = 2;
      XmpOnStateChanged();
      return X_E_SUCCESS;
    case 0x00070006:    // XMPNext
    case 0x00070007: {  // XMPPrevious
      XmpPlaylist* playlist = XmpActivePlaylist();
      if (!playlist || playlist->songs.empty()) return X_E_NOTFOUND;
      x.state = 1;
      const uint32_t count = uint32_t(playlist->songs.size());
      x.active_song_index = message == 0x00070006
                                ? (x.active_song_index + 1) % count
                                : (x.active_song_index ? x.active_song_index - 1
                                                       : count - 1);
      XmpOnStateChanged();
      return X_E_SUCCESS;
    }
    case 0x00070008:  // XMPSetPlaybackBehavior
      if (!args(4)) return Invalid();
      x.playback_mode = w[1];
      x.repeat_mode = w[2];
      x.unknown_flags = w[3];
      BroadcastNotification(kXmpMsgPlaybackBehaviorChanged, 0);
      return X_E_SUCCESS;
    case 0x00070009:  // XMPGetStatus
      if (!args(2)) return Invalid();
      return Wr32(w[1], x.state) ? X_E_SUCCESS : Invalid();
    case 0x0007000B:  // XMPGetVolume
      if (!args(2)) return Invalid();
      return WrF32(w[1], x.volume) ? X_E_SUCCESS : Invalid();
    case 0x0007000C: {  // XMPSetVolume
      if (!args(2)) return Invalid();
      std::memcpy(&x.volume, &w[1], sizeof(float));
      return X_E_SUCCESS;
    }
    case 0x0007000D: {  // XMPCreateTitlePlaylist
      if (!args(9)) return Invalid();
      const uint32_t storage = w[1], songs = w[3], song_count = w[4],
                     name_ptr = w[5], flags = w[6], song_handles = w[7],
                     playlist_handle_ptr = w[8];
      if (!Wr32(playlist_handle_ptr, storage)) return Invalid();
      XmpPlaylist playlist;
      playlist.handle = ++x.next_playlist_handle;
      playlist.name = ReadGuestU16String(name_ptr);
      playlist.flags = flags;
      if (songs) {
        for (uint32_t i = 0; i < song_count && i < 4096; ++i) {
          const uint32_t base = songs + i * 36u;
          uint32_t f[9] = {};
          for (uint32_t k = 0; k < 9; ++k) {
            if (!Rd32(base + k * 4u, &f[k])) return Invalid();
          }
          XmpSong song;
          song.handle = ++x.next_song_handle;
          song.file_path = ReadGuestU16String(f[0]);
          song.name = ReadGuestU16String(f[1]);
          song.artist = ReadGuestU16String(f[2]);
          song.album = ReadGuestU16String(f[3]);
          song.album_artist = ReadGuestU16String(f[4]);
          song.genre = ReadGuestU16String(f[5]);
          song.track_number = f[6];
          song.duration_ms = f[7];
          song.format = f[8];
          if (song_handles && !Wr32(song_handles + i * 4u, song.handle)) {
            return Invalid();
          }
          playlist.songs.push_back(std::move(song));
        }
      }
      // Xenia stores the playlist handle over the storage pointer it wrote
      // above (out_playlist_handle is the storage block).
      if (storage && !Wr32(storage, playlist.handle)) return Invalid();
      x.playlists[playlist.handle] = std::move(playlist);
      return X_E_SUCCESS;
    }
    case 0x0007000E: {  // XMPGetCurrentSong
      if (!args(3)) return Invalid();
      XmpPlaylist* playlist = XmpActivePlaylist();
      if (!playlist || x.active_song_index >= playlist->songs.size()) {
        return X_E_FAIL;
      }
      const XmpSong& song = playlist->songs[x.active_song_index];
      const uint32_t info = w[2], meta = info + 4u + 572u;
      if (!Wr32(info, song.handle) || !WriteGuestU16String(meta, song.name) ||
          !WriteGuestU16String(meta + 40u, song.artist) ||
          !WriteGuestU16String(meta + 80u, song.album) ||
          !WriteGuestU16String(meta + 120u, song.album_artist) ||
          !WriteGuestU16String(meta + 160u, song.genre) ||
          !Wr32(meta + 200u, song.track_number) ||
          !Wr32(meta + 204u, song.duration_ms) ||
          !Wr32(meta + 208u, song.format)) {
        return Invalid();
      }
      return X_E_SUCCESS;
    }
    case 0x00070013: {  // XMPDeleteTitlePlaylist
      if (!args(2)) return Invalid();
      uint32_t playlist_handle = 0;
      if (!Rd32(w[1], &playlist_handle)) return Invalid();
      auto it = x.playlists.find(playlist_handle);
      if (it == x.playlists.end()) return X_E_NOTFOUND;
      if (x.active_playlist == playlist_handle) XmpStop();
      x.playlists.erase(it);
      return X_E_SUCCESS;
    }
    case 0x0007001A:  // XMPSetPlaybackController
      if (!args(3)) return Invalid();
      x.playback_client = w[2];
      BroadcastNotification(kXmpMsgPlaybackControllerChanged, w[2] ? 0u : 1u);
      return X_E_SUCCESS;
    case 0x0007001B:  // XMPGetPlaybackController
      if (!args(3)) return Invalid();
      return Wr32(w[1], 0) && Wr32(w[2], 0) ? X_E_SUCCESS : Invalid();
    case 0x00070029:  // XMPGetPlaybackBehavior
      if (!args(4)) return Invalid();
      if ((w[1] && !Wr32(w[1], x.playback_mode)) ||
          (w[2] && !Wr32(w[2], x.repeat_mode)) ||
          (w[3] && !Wr32(w[3], x.unknown_flags))) {
        return Invalid();
      }
      return X_E_SUCCESS;
    case 0x0007002E:  // size query for the XamAlloc passed to 0x0007000D
      if (!args(3)) return Invalid();
      return Wr32(w[2], 4u + w[1] * 128u) ? X_E_SUCCESS : Invalid();
    case 0x0007003D:  // XMPCaptureOutput: unimplemented in Xenia too.
    default:
      return X_E_FAIL;
  }
}

uint32_t XgiDispatch(uint32_t message, uint32_t buffer, uint32_t /*length*/) {
  switch (message) {
    case 0x000B0006:  // XGIUserSetContextEx
    case 0x000B0007:  // XGIUserSetPropertyEx
    case 0x000B0008:  // XGIUserWriteAchievements
    case 0x000B0010:  // XGISessionCreateImpl
    case 0x000B0011:  // XGISessionDelete
    case 0x000B0012:  // XGISessionJoinLocal
    case 0x000B0014:
    case 0x000B0015:
    case 0x000B0071:
      return X_E_SUCCESS;
    case 0x000B0041: {  // XGIUserGetContext
      uint32_t context = 0;
      if (!Rd32(buffer + 16u, &context)) return Invalid();
      if (context && !Wr32(context + 4u, 0)) return Invalid();
      return X_E_FAIL;
    }
    default:
      return X_E_FAIL;
  }
}

uint32_t XLiveBaseDispatch(uint32_t message, uint32_t buffer,
                           uint32_t /*length*/) {
  switch (message) {
    case 0x00058004:  // XLiveBaseGetLogonId
    case 0x00058006:  // XLiveBaseGetNatType (XONLINE_NAT_OPEN)
      return Wr32(buffer, 1) ? X_E_SUCCESS : Invalid();
    case 0x00058007:  // GetServiceInfo
      return 0x80151802u;  // ERROR_CONNECTION_INVALID
    case 0x00058046:
      return X_E_SUCCESS;
    case 0x00058020:  // CXLiveFriends::Enumerate
    case 0x00058023:  // XMessageGameInviteGetAcceptedInfo
    default:
      return X_E_FAIL;
  }
}

// AppManager::DispatchMessageSync / DispatchMessageAsync (both synchronous).
uint32_t DispatchAppMessage(uint32_t app, uint32_t message, uint32_t buffer,
                            uint32_t length) {
  switch (app) {
    case 0xFAu: return XmpDispatch(message, buffer, length);
    case 0xFBu: return XgiDispatch(message, buffer, length);
    case 0xFCu: return XLiveBaseDispatch(message, buffer, length);
    default: return X_E_NOTFOUND;
  }
}

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
    case kx::KiApcNormalRoutineNop:
      // Xenia: kStub returning 0 (unk1 is 0x13 in titles that call it).
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
      GuestFiberNoteProgress();
      GuestFiberYield(false);
      return X_STATUS_SUCCESS;
    }
    case kx::NtYieldExecution:
      GuestFiberNoteProgress();
      GuestFiberYield(false);
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
      if (r3 == kCurrentThreadPseudoHandle || r3 == kCurrentProcessPseudoHandle) {
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
    case kx::ObCreateSymbolicLink: {
      // (X_ANSI_STRING* link, X_ANSI_STRING* target)
      std::string link, target;
      if (!ReadAnsiString(r3, &link) || !ReadAnsiString(r4, &target)) return Invalid();
      EnsureDefaultSymlinks();
      VfsSymlinks()[Lower(CanonicalizeGuestPath(link))] = Lower(CanonicalizeGuestPath(target));
      return X_STATUS_SUCCESS;
    }
    case kx::ObDeleteSymbolicLink: {
      std::string link;
      if (!ReadAnsiString(r3, &link)) return Invalid();
      VfsSymlinks().erase(Lower(CanonicalizeGuestPath(link)));
      return X_STATUS_SUCCESS;
    }

    // --- File system (Xenia xboxkrnl_io.cc / xboxkrnl_io_info.cc) ------------
    case kx::NtCreateFile:
    case kx::NtOpenFile: {
      // NtCreateFile(handle_out, access, attrs, iosb, alloc_size_ptr,
      //              file_attributes, share_access, disposition, options)
      // NtOpenFile(handle_out, access, attrs, iosb, share_access, options)
      const bool open = ordinal == kx::NtOpenFile;
      const uint32_t handle_out = r3, attrs = r5, iosb = r6;
      const uint32_t disposition = open ? 1u : a[7];
      uint32_t options = open ? r8 : 0u;
      if (!open && !StackArg(8, &options)) options = 0;
      if (!attrs) return X_STATUS_INVALID_PARAMETER;
      std::string path;
      if (!ObjectAttributesPath(attrs, &path)) {
        WriteIoStatus(iosb, X_STATUS_OBJECT_NAME_INVALID, 0);
        return X_STATUS_OBJECT_NAME_INVALID;
      }
      std::string device, relative;
      uint32_t entry_index = 0;
      bool is_root = false, resolved = false;
      if (ResolveGuestPath(path, &device, &relative)) {
        resolved = true;
        is_root = relative.empty();
        entry_index = LookupVfs(device, relative);
      }
      const bool writable = resolved && !device.empty();
      const bool exists = is_root || entry_index;
      // FILE_SUPERSEDE 0, OPEN 1, CREATE 2, OPEN_IF 3, OVERWRITE 4, OVERWRITE_IF 5.
      // IO_STATUS information: superseded 0, opened 1, created 2,
      // overwritten 3, exists 4, does-not-exist 5 (Xenia X_FILE_*).
      uint32_t information = 1u;
      if (!exists) {
        if (disposition == 1u || disposition == 4u || !writable) {
          const uint32_t status = (disposition == 1u || disposition == 4u || !resolved)
                                      ? X_STATUS_NO_SUCH_FILE
                                      : X_STATUS_ACCESS_DENIED;  // Disc is read-only.
          WriteIoStatus(iosb, status, 5u);
          if (handle_out) Wr32(handle_out, 0xFFFFFFFFu);
          return status;
        }
        const size_t slash = relative.find_last_of('\\');
        if (slash != std::string::npos && !LookupVfs(device, relative.substr(0, slash))) {
          WriteIoStatus(iosb, X_STATUS_OBJECT_PATH_NOT_FOUND, 5u);
          if (handle_out) Wr32(handle_out, 0xFFFFFFFFu);
          return X_STATUS_OBJECT_PATH_NOT_FOUND;
        }
        // Keep the title's spelling for the new name (paths index lowercase).
        std::string display = CanonicalizeGuestPath(path);
        const size_t name_at = display.find_last_of('\\');
        const std::string leaf =
            name_at == std::string::npos ? display : display.substr(name_at + 1);
        const std::string create_path =
            (slash == std::string::npos ? std::string() : relative.substr(0, slash) + "\\") + leaf;
        const bool directory = (options & 0x1u) || (a[5] & kFileAttributeDirectory);
        entry_index = RegisterVfsEntryOn(device, create_path, 0,
                                         directory ? kFileAttributeDirectory
                                                   : kFileAttributeNormal,
                                         0, 0);
        if (VfsEntry* created = VfsEntryAt(entry_index)) {
          created->has_data = !directory;
          created->timestamp = QueryGuestSystemTime();
        }
        information = 2u;
      } else if (disposition == 2u) {
        WriteIoStatus(iosb, X_STATUS_OBJECT_NAME_COLLISION, 4u);
        if (handle_out) Wr32(handle_out, 0xFFFFFFFFu);
        return X_STATUS_OBJECT_NAME_COLLISION;
      } else if (!is_root && (disposition == 0u || disposition == 4u || disposition == 5u)) {
        VfsEntry* existing = VfsEntryAt(entry_index);
        if (!(existing->attributes & kFileAttributeDirectory)) {
          if (!writable) {
            WriteIoStatus(iosb, X_STATUS_ACCESS_DENIED, 0);
            if (handle_out) Wr32(handle_out, 0xFFFFFFFFu);
            return X_STATUS_ACCESS_DENIED;
          }
          existing->data.clear();
          existing->size = 0;
          existing->has_data = true;
          existing->timestamp = QueryGuestSystemTime();
          information = disposition == 0u ? 0u : 3u;
        }
      }
      const VfsEntry* entry = VfsEntryAt(entry_index);
      const bool is_directory = is_root || (entry->attributes & kFileAttributeDirectory);
      // FILE_DIRECTORY_FILE 0x1, FILE_NON_DIRECTORY_FILE 0x40.
      if (is_directory && (options & 0x40u)) {
        WriteIoStatus(iosb, X_STATUS_FILE_IS_A_DIRECTORY, 0);
        return X_STATUS_FILE_IS_A_DIRECTORY;
      }
      if (!is_directory && (options & 0x1u)) {
        WriteIoStatus(iosb, X_STATUS_NOT_A_DIRECTORY, 0);
        return X_STATUS_NOT_A_DIRECTORY;
      }
      const uint32_t handle = CreateObject(ObjectType::kFile, 0, false);
      if (!handle) return X_STATUS_NO_MEMORY;
      uint32_t slot = 0;
      SlotForHandle(handle, &slot);
      Objects()[slot].vfs_entry = entry_index;
      Objects()[slot].vfs_device = device;
      WriteIoStatus(iosb, X_STATUS_SUCCESS, information);
      if (handle_out && !Wr32(handle_out, handle)) return Invalid();
      return X_STATUS_SUCCESS;
    }
    case kx::NtReadFile: {
      // (file, event, apc_routine, apc_context, iosb, buffer, length, offset_ptr)
      const uint32_t event = r4, iosb = r7, buffer = r8, length = r9;
      const uint32_t offset_ptr = a[7];
      KernelObject* event_object = event ? ResolveHandle(event) : nullptr;
      KernelObject* file = ResolveHandle(r3);
      if ((event && !event_object) || !file || file->type != ObjectType::kFile) {
        WriteIoStatus(iosb, X_STATUS_INVALID_HANDLE, 0);
        return X_STATUS_INVALID_HANDLE;
      }
      VfsEntry* entry = VfsEntryAt(file->vfs_entry);
      if (!entry || (entry->attributes & kFileAttributeDirectory)) {
        WriteIoStatus(iosb, X_STATUS_INVALID_PARAMETER, 0);
        return X_STATUS_INVALID_PARAMETER;
      }
      uint64_t offset = file->position;
      if (offset_ptr) {
        uint64_t requested = 0;
        if (!Rd64(offset_ptr, &requested)) return Invalid();
        // FILE_USE_FILE_POINTER_POSITION is -2 (0xFFFFFFFFFFFFFFFE).
        if (requested < 0xFFFFFFFFFFFFFFFEull) offset = requested;
      }
      uint32_t bytes = 0;
      const uint32_t status = ReadVfs(*entry, file->vfs_entry, offset, buffer, length, &bytes);
      if (g_status != kKernelServiceSuccess) return status;
      if (status == X_STATUS_SUCCESS) file->position = offset + bytes;
      WriteIoStatus(iosb, status, bytes);
      if (event_object && event_object->type == ObjectType::kEvent) {
        Wr32(event_object->guest + 4u, 1);
      }
      if ((r5 & ~1u) && r6) DebugLog("NtReadFile APC completion not delivered");
      return status;
    }
    case kx::NtWriteFile: {
      // (file, event, apc_routine, apc_context, iosb, buffer, length, offset_ptr)
      const uint32_t event = r4, iosb = r7, buffer = r8, length = r9;
      KernelObject* event_object = event ? ResolveHandle(event) : nullptr;
      KernelObject* file = ResolveHandle(r3);
      if ((event && !event_object) || !file || file->type != ObjectType::kFile) {
        WriteIoStatus(iosb, X_STATUS_INVALID_HANDLE, 0);
        return X_STATUS_INVALID_HANDLE;
      }
      VfsEntry* entry = VfsEntryAt(file->vfs_entry);
      if (!entry || (entry->attributes & kFileAttributeDirectory)) {
        WriteIoStatus(iosb, X_STATUS_INVALID_PARAMETER, 0);
        return X_STATUS_INVALID_PARAMETER;
      }
      if (entry->device.empty() || !entry->has_data) {
        WriteIoStatus(iosb, X_STATUS_ACCESS_DENIED, 0);
        return X_STATUS_ACCESS_DENIED;  // Game disc media is read-only.
      }
      uint64_t offset = file->position;
      if (a[7]) {
        uint64_t requested = 0;
        if (!Rd64(a[7], &requested)) return Invalid();
        if (requested < 0xFFFFFFFFFFFFFFFEull) offset = requested;
      }
      if (offset + length > (64ull << 20)) {  // Bounded in-memory save device.
        WriteIoStatus(iosb, X_STATUS_NO_MEMORY, 0);
        return X_STATUS_NO_MEMORY;
      }
      if (offset + length > entry->data.size()) entry->data.resize(size_t(offset + length));
      if (length && !Rd(buffer, entry->data.data() + offset, length)) {
        WriteIoStatus(iosb, X_STATUS_ACCESS_VIOLATION, 0);
        return X_STATUS_ACCESS_VIOLATION;
      }
      entry->size = entry->data.size();
      entry->timestamp = QueryGuestSystemTime();
      file->position = offset + length;
      WriteIoStatus(iosb, X_STATUS_SUCCESS, length);
      if (event_object && event_object->type == ObjectType::kEvent) {
        Wr32(event_object->guest + 4u, 1);
      }
      return X_STATUS_SUCCESS;
    }
    case kx::NtQueryInformationFile: {
      // (file, iosb, info, length, class)
      uint32_t minimum = 0;
      switch (r7) {
        case 6: minimum = 8; break;    // Internal
        case 14: minimum = 8; break;   // Position
        case 34: minimum = 56; break;  // NetworkOpen
        case 16: case 17: case 26: case 32: minimum = 4; break;
        case 9: case 19: minimum = 8; break;
        case 4: minimum = 40; break;   // Basic
        case 5: minimum = 24; break;   // Standard
        default: return X_STATUS_INVALID_INFO_CLASS;
      }
      if (r6 < minimum) return X_STATUS_INFO_LENGTH_MISMATCH;
      KernelObject* file = ResolveHandle(r3);
      if (!file || file->type != ObjectType::kFile) return X_STATUS_INVALID_HANDLE;
      const VfsEntry* entry = VfsEntryAt(file->vfs_entry);
      if (!ZeroGuest(r5, r6)) return Invalid();
      uint32_t status = X_STATUS_SUCCESS, out_length = 0;
      switch (r7) {
        case 6: {  // FileInternalInformation: stable per-path index.
          uint64_t hash = 1469598103934665603ull;
          for (char c : entry ? entry->path : std::string()) hash = (hash ^ uint8_t(c)) * 1099511628211ull;
          Wr64(r5, hash);
          out_length = 8;
          break;
        }
        case 14:
          Wr64(r5, file->position);
          out_length = 8;
          break;
        case 34:
          WriteNetworkOpenInfo(r5, entry, !entry);
          out_length = 56;
          break;
        case 17:  // Alignment
          out_length = 4;
          break;
        case 4: {  // Basic: 4 times + attributes.
          const uint64_t time = entry ? entry->timestamp : kUnixEpochAsFileTime;
          for (uint32_t i = 0; i < 4; ++i) Wr64(r5 + i * 8u, time);
          Wr32(r5 + 32u, entry ? entry->attributes : kFileAttributeDirectory);
          out_length = 40;
          break;
        }
        case 5: {  // Standard: allocation, end of file, links, delete, dir.
          const uint64_t size = entry ? entry->size : 0;
          Wr64(r5, (size + 2047u) & ~uint64_t(2047u));
          Wr64(r5 + 8u, size);
          Wr32(r5 + 16u, 1);
          Wr8(r5 + 21u, (!entry || (entry->attributes & kFileAttributeDirectory)) ? 1 : 0);
          out_length = 24;
          break;
        }
        default:
          status = X_STATUS_INVALID_PARAMETER;
          break;
      }
      WriteIoStatus(r4, status, out_length);
      return status;
    }
    case kx::NtSetInformationFile: {
      // (file, iosb, info, length, class)
      KernelObject* file = ResolveHandle(r3);
      if (!file || file->type != ObjectType::kFile) return X_STATUS_INVALID_HANDLE;
      uint32_t status = X_STATUS_SUCCESS, out_length = 0;
      switch (r7) {
        case 14: {  // Position
          if (r6 < 8) return X_STATUS_INFO_LENGTH_MISMATCH;
          uint64_t position = 0;
          if (!Rd64(r5, &position)) return Invalid();
          file->position = position;
          out_length = 8;
          break;
        }
        case 13:  // Disposition (ignored by Xenia)
        case 16:  // Mode
        case 19:  // Allocation (ignored by Xenia)
        case 32:  // I/O priority
          break;
        case 20: {  // End of file: writable content devices only.
          VfsEntry* entry = VfsEntryAt(file->vfs_entry);
          if (!entry || entry->device.empty() || !entry->has_data) {
            status = X_STATUS_ACCESS_DENIED;
            break;
          }
          if (r6 < 8) return X_STATUS_INFO_LENGTH_MISMATCH;
          uint64_t end = 0;
          if (!Rd64(r5, &end)) return Invalid();
          if (end > (64ull << 20)) {
            status = X_STATUS_NO_MEMORY;
            break;
          }
          entry->data.resize(size_t(end));
          entry->size = end;
          out_length = 8;
          break;
        }
        default:
          return X_STATUS_INVALID_INFO_CLASS;
      }
      WriteIoStatus(r4, status, out_length);
      return status;
    }
    case kx::NtQueryFullAttributesFile: {
      // (attrs, X_FILE_NETWORK_OPEN_INFORMATION*)
      std::string path, device, relative;
      if (!ObjectAttributesPath(r3, &path)) return X_STATUS_OBJECT_NAME_INVALID;
      if (!ResolveGuestPath(path, &device, &relative)) return X_STATUS_NO_SUCH_FILE;
      const uint32_t index = LookupVfs(device, relative);
      if (!relative.empty() && !index) return X_STATUS_NO_SUCH_FILE;
      if (!WriteNetworkOpenInfo(r4, VfsEntryAt(index), relative.empty())) return Invalid();
      return X_STATUS_SUCCESS;
    }
    case kx::NtQueryVolumeInformationFile: {
      // (file, iosb, info, length, class): 1 Volume, 3 Size, 5 Attribute.
      KernelObject* file = ResolveHandle(r3);
      uint32_t minimum = r7 == 1 ? 24u : r7 == 3 ? 24u : r7 == 5 ? 16u : r7 == 4 ? 8u : 0u;
      if (!minimum) return X_STATUS_INVALID_INFO_CLASS;
      if (r6 < minimum) return X_STATUS_INFO_LENGTH_MISMATCH;
      if (!file || file->type != ObjectType::kFile) return X_STATUS_INVALID_HANDLE;
      if (!ZeroGuest(r5, r6)) return Invalid();
      uint32_t status = X_STATUS_SUCCESS, out_length = 0;
      if (r7 == 1) {
        out_length = 17;  // offsetof(X_FILE_FS_VOLUME_INFORMATION, label)
      } else if (r7 == 3) {
        uint64_t total = 0;
        for (const auto& entry : VfsEntries()) {
          if (entry.device == file->vfs_device) total += (entry.size + 2047u) & ~uint64_t(2047u);
        }
        Wr64(r5, total / 0x200u);
        Wr64(r5 + 8u, 0);
        Wr32(r5 + 16u, 1);
        Wr32(r5 + 20u, 0x200u);
        out_length = 24;
      } else if (r7 == 5) {
        const char* kName = file->vfs_device.empty() ? "GDFX" : "FATX";
        Wr32(r5, 0);
        Wr32(r5 + 4u, 255);
        Wr32(r5 + 8u, 4);
        if (r6 >= 12u + 4u) {
          Wr(r5 + 12u, kName, 4);
          out_length = 16;
        } else {
          status = X_STATUS_BUFFER_OVERFLOW;
          out_length = 12;
        }
      }
      WriteIoStatus(r4, status, out_length);
      return status;
    }
    case kx::NtQueryDirectoryFile: {
      // (file, event, apc, apc_ctx, iosb, info, length, name, restart)
      const uint32_t iosb = r7, info = r8, length = r9, name_ptr = a[7];
      uint32_t restart = 0;
      StackArg(8, &restart);
      if (length < 72u) return X_STATUS_INFO_LENGTH_MISMATCH;
      KernelObject* dir = ResolveHandle(r3);
      if (!dir || dir->type != ObjectType::kFile) {
        WriteIoStatus(iosb, X_STATUS_NO_SUCH_FILE, 0);
        return X_STATUS_NO_SUCH_FILE;
      }
      std::string pattern;
      if (name_ptr && !ReadAnsiString(name_ptr, &pattern)) return Invalid();
      pattern = Lower(pattern);
      if (!pattern.empty()) {
        dir->find_pattern = pattern;
        dir->find_index = 0;
      } else if (restart) {
        dir->find_index = 0;
      }
      const VfsEntry* base = VfsEntryAt(dir->vfs_entry);
      const std::string prefix = base ? base->path + "\\" : std::string();
      const std::string rule = dir->find_pattern.empty() ? "*" : dir->find_pattern;
      auto& entries = VfsEntries();
      uint32_t found = 0;
      for (uint32_t i = dir->find_index; i < entries.size(); ++i) {
        const auto& entry = entries[i];
        if (entry.device != dir->vfs_device) continue;
        if (entry.path.compare(0, prefix.size(), prefix) != 0) continue;
        if (entry.path.find('\\', prefix.size()) != std::string::npos) continue;
        if (entry.path.size() == prefix.size()) continue;
        if (!WildcardMatch(rule, Lower(entry.name))) continue;
        found = i + 1;
        break;
      }
      if (!found) {
        const uint32_t status = pattern.empty() ? X_STATUS_NO_MORE_FILES : X_STATUS_NO_SUCH_FILE;
        WriteIoStatus(iosb, status, 0);
        return status;
      }
      dir->find_index = found;
      const auto& entry = entries[found - 1];
      if (64u + entry.name.size() > length) {
        WriteIoStatus(iosb, X_STATUS_NO_SUCH_FILE, 0);
        return X_STATUS_NO_SUCH_FILE;
      }
      if (!Wr32(info + 0, 0) || !Wr32(info + 4, found) ||
          !Wr64(info + 8, entry.timestamp) || !Wr64(info + 16, entry.timestamp) ||
          !Wr64(info + 24, entry.timestamp) || !Wr64(info + 32, entry.timestamp) ||
          !Wr64(info + 40, entry.size) ||
          !Wr64(info + 48, (entry.size + 2047u) & ~uint64_t(2047u)) ||
          !Wr32(info + 56, entry.attributes) ||
          !Wr32(info + 60, uint32_t(entry.name.size())) ||
          !Wr(info + 64, entry.name.data(), uint32_t(entry.name.size()))) {
        return Invalid();
      }
      WriteIoStatus(iosb, X_STATUS_SUCCESS, length);
      return X_STATUS_SUCCESS;
    }
    case kx::NtFlushBuffersFile:
      WriteIoStatus(r4, X_STATUS_SUCCESS, 0);
      return X_STATUS_SUCCESS;
    case kx::FscGetCacheElementCount:
      return 0;
    case kx::FscSetCacheElementCount:
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
        PhysicalVirtualBases().erase(it->second.physical_address);
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

    // --- Audio (Xenia xboxkrnl_audio.cc) ---------------------------------------
    case kx::XAudioGetSpeakerConfig:
      if (!Wr32(r3, 0x00010001u)) return Invalid();
      return X_ERROR_SUCCESS;
    case kx::XAudioGetVoiceCategoryVolumeChangeMask:
      if (!Wr32(r4, 0)) return Invalid();
      return X_ERROR_SUCCESS;
    case kx::XAudioGetVoiceCategoryVolume:
      if (!WrF32(r4, 1.0f)) return Invalid();
      return X_ERROR_SUCCESS;
    case kx::XAudioEnableDucker:
      return X_ERROR_SUCCESS;
    case kx::XAudioRegisterRenderDriverClient: {
      uint32_t callback = 0, callback_arg = 0;
      if (!Rd32(r3, &callback) || !Rd32(r3 + 4u, &callback_arg)) return Invalid();
      for (uint32_t i = 0; i < kMaxAudioClients; ++i) {
        if (g_audio_clients[i].used) continue;
        // Xenia RegisterClient: the callback receives a pointer to a copy
        // of its argument; the client semaphore starts with
        // kMaximumQueuedFrames.
        const uint32_t wrapped = PoolAlloc(4);
        if (!wrapped || !Wr32(wrapped, callback_arg)) return X_STATUS_NO_MEMORY;
        g_audio_clients[i] = {true, callback, callback_arg, 0, 0, wrapped,
                              kAudioMaxQueuedFrames, 0};
        if (!Wr32(r4, 0x41550000u | i)) return Invalid();
        return X_ERROR_SUCCESS;
      }
      return X_STATUS_NO_MEMORY;
    }
    case kx::XAudioUnregisterRenderDriverClient:
      if ((r3 & 0xFFFF0000u) == 0x41550000u && (r3 & 0xFFFFu) < kMaxAudioClients) {
        g_audio_clients[r3 & 0xFFFFu] = {};
      }
      return X_ERROR_SUCCESS;
    case kx::XAudioSubmitRenderDriverFrame:
      if ((r3 & 0xFFFF0000u) != 0x41550000u || (r3 & 0xFFFFu) >= kMaxAudioClients) {
        return Invalid();
      }
      ++g_audio_clients[r3 & 0xFFFFu].frames_submitted;
      if (g_audio_clients[r3 & 0xFFFFu].queued < kAudioMaxQueuedFrames) {
        ++g_audio_clients[r3 & 0xFFFFu].queued;
      }
      g_audio_clients[r3 & 0xFFFFu].last_samples = r4;
      return X_ERROR_SUCCESS;
    case kx::XMACreateContext: {
      if (!EnsureXmaContextArray()) return X_STATUS_NO_MEMORY;
      for (uint32_t i = 0; i < kXmaContextCount; ++i) {
        if (g_xma_context_used[i]) continue;
        g_xma_context_used[i] = true;
        const uint32_t context = g_xma_context_base + i * kXmaContextBytes;
        if (!ZeroGuest(context, kXmaContextBytes) || !Wr32(r3, context)) return Invalid();
        return X_STATUS_SUCCESS;
      }
      if (!Wr32(r3, 0)) return Invalid();
      return X_STATUS_NO_MEMORY;
    }
    case kx::XMAReleaseContext:
      if (g_xma_context_base && r3 >= g_xma_context_base &&
          r3 < g_xma_context_base + kXmaContextCount * kXmaContextBytes) {
        g_xma_context_used[(r3 - g_xma_context_base) / kXmaContextBytes] = false;
      }
      XmaEnabledContexts().erase(r3);
      return 0;
    case kx::XMAInitializeContext: {
      // XMA_CONTEXT_INIT {in0, in0_packets, in1, in1_packets, in_read_offset,
      // out, out_blocks, work, subframe_decode_count, channels, sample_rate,
      // loop {start, end, count u8, subframe_end u8, subframe_skip u8}}
      uint32_t init[11] = {};
      for (uint32_t i = 0; i < 11; ++i) {
        if (!Rd32(r4 + i * 4u, &init[i])) return Invalid();
      }
      uint32_t loop_start = 0, loop_end = 0;
      uint8_t loop_count = 0, loop_subframe_end = 0, loop_subframe_skip = 0;
      if (!Rd32(r4 + 44u, &loop_start) || !Rd32(r4 + 48u, &loop_end) ||
          !Rd8(r4 + 52u, &loop_count) || !Rd8(r4 + 53u, &loop_subframe_end) ||
          !Rd8(r4 + 54u, &loop_subframe_skip) || !ZeroGuest(r3, kXmaContextBytes)) {
        return Invalid();
      }
      const bool ok =
          XmaSet(r3, kXmaInput0Ptr, init[0] ? GuestPhysicalAddress(init[0]) : 0) &&
          XmaSet(r3, kXmaInput0PacketCount, init[1]) &&
          XmaSet(r3, kXmaInput1Ptr, init[2] ? GuestPhysicalAddress(init[2]) : 0) &&
          XmaSet(r3, kXmaInput1PacketCount, init[3]) &&
          XmaSet(r3, kXmaInputReadOffset, init[4]) &&
          XmaSet(r3, kXmaOutputPtr, GuestPhysicalAddress(init[5])) &&
          XmaSet(r3, kXmaOutputBlockCount, init[6]) &&
          XmaSet(r3, kXmaSubframeDecodeCount, init[8]) &&
          XmaSet(r3, kXmaIsStereo, init[9] >= 1 ? 1u : 0u) &&
          XmaSet(r3, kXmaSampleRate, init[10]) &&
          XmaSet(r3, kXmaLoopStart, loop_start) && XmaSet(r3, kXmaLoopEnd, loop_end) &&
          XmaSet(r3, kXmaLoopCount, loop_count) &&
          XmaSet(r3, kXmaLoopSubframeEnd, loop_subframe_end) &&
          XmaSet(r3, kXmaLoopSubframeSkip, loop_subframe_skip);
      if (!ok) return Invalid();
      return 0;
    }
    case kx::XMASetLoopData: {
      // Takes an XMA_CONTEXT_DATA-shaped source (Xenia).
      uint32_t v[5] = {};
      if (!XmaGet(r4, kXmaLoopStart, &v[0]) || !XmaGet(r4, kXmaLoopEnd, &v[1]) ||
          !XmaGet(r4, kXmaLoopCount, &v[2]) || !XmaGet(r4, kXmaLoopSubframeEnd, &v[3]) ||
          !XmaGet(r4, kXmaLoopSubframeSkip, &v[4]) ||
          !XmaSet(r3, kXmaLoopStart, v[0]) || !XmaSet(r3, kXmaLoopEnd, v[1]) ||
          !XmaSet(r3, kXmaLoopCount, v[2]) || !XmaSet(r3, kXmaLoopSubframeEnd, v[3]) ||
          !XmaSet(r3, kXmaLoopSubframeSkip, v[4])) {
        return Invalid();
      }
      return 0;
    }
    case kx::XMAGetInputBufferReadOffset:
    case kx::XMAIsInputBuffer0Valid:
    case kx::XMAIsInputBuffer1Valid:
    case kx::XMAIsOutputBufferValid:
    case kx::XMAGetOutputBufferReadOffset:
    case kx::XMAGetOutputBufferWriteOffset:
    case kx::XMAGetPacketMetadata: {
      const XmaField field =
          ordinal == kx::XMAGetInputBufferReadOffset ? kXmaInputReadOffset
          : ordinal == kx::XMAIsInputBuffer0Valid    ? kXmaInput0Valid
          : ordinal == kx::XMAIsInputBuffer1Valid    ? kXmaInput1Valid
          : ordinal == kx::XMAIsOutputBufferValid    ? kXmaOutputValid
          : ordinal == kx::XMAGetOutputBufferReadOffset ? kXmaOutputReadOffset
          : ordinal == kx::XMAGetOutputBufferWriteOffset ? kXmaOutputWriteOffset
                                                         : kXmaPacketMetadata;
      uint32_t value = 0;
      if (!XmaGet(r3, field, &value)) return Invalid();
      return value;
    }
    case kx::XMASetInputBufferReadOffset:
      if (!XmaSet(r3, kXmaInputReadOffset, r4)) return Invalid();
      return 0;
    case kx::XMASetOutputBufferReadOffset:
      if (!XmaSet(r3, kXmaOutputReadOffset, r4)) return Invalid();
      return 0;
    case kx::XMASetInputBuffer0:
    case kx::XMASetInputBuffer1: {
      const bool zero = ordinal == kx::XMASetInputBuffer0;
      if (!XmaSet(r3, zero ? kXmaInput0Ptr : kXmaInput1Ptr, GuestPhysicalAddress(r4)) ||
          !XmaSet(r3, zero ? kXmaInput0PacketCount : kXmaInput1PacketCount, r5)) {
        return Invalid();
      }
      return 0;
    }
    case kx::XMASetInputBuffer0Valid:
    case kx::XMASetInputBuffer1Valid:
    case kx::XMASetOutputBufferValid: {
      const XmaField field = ordinal == kx::XMASetInputBuffer0Valid   ? kXmaInput0Valid
                             : ordinal == kx::XMASetInputBuffer1Valid ? kXmaInput1Valid
                                                                      : kXmaOutputValid;
      if (!XmaSet(r3, field, 1)) return Invalid();
      return 0;
    }
    case kx::XMAEnableContext:
      XmaEnabledContexts().insert(r3);
      return 0;
    case kx::XMADisableContext:
      XmaEnabledContexts().erase(r3);
      return X_E_SUCCESS;
    case kx::XMABlockWhileInUse: {
      uint32_t valid0 = 0, valid1 = 0;
      if (!XmaGet(r3, kXmaInput0Valid, &valid0) || !XmaGet(r3, kXmaInput1Valid, &valid1)) {
        return Invalid();
      }
      if (valid0 || valid1) {
        return WouldBlock(kModuleXboxkrnl, ordinal, r3, 0, kWaitReasonXmaDecoder);
      }
      return 0;
    }

    // --- Crypto (Xenia xboxkrnl_crypt.cc) --------------------------------------
    case kx::XeCryptBnQwBeSigVerify:
      return 1;  // Xenia reports every signature as valid.
    case kx::XeCryptBnDwLePkcs1Verify:
      return 1;  // Xenia stub: signatures verify.
    case kx::XeCryptRandom: {
      // Xenia fills with 0xFD so runs replay deterministically.
      uint8_t chunk[256];
      std::memset(chunk, 0xFD, sizeof(chunk));
      for (uint32_t done = 0; done < r4;) {
        const uint32_t n = std::min<uint32_t>(r4 - done, sizeof(chunk));
        if (!Wr(r3 + done, chunk, n)) return Invalid();
        done += n;
      }
      return 0;
    }
    case kx::XeCryptShaInit: {
      Sha1 sha;
      if (!ZeroGuest(r3, 0x58u) || !StoreHashState<Sha1, 5>(r3, sha)) return Invalid();
      return 0;
    }
    case kx::XeCryptShaUpdate: {
      Sha1 sha;
      if (!LoadHashState<Sha1, 5>(r3, &sha) || !HashGuest(sha, r4, r5) ||
          !StoreHashState<Sha1, 5>(r3, sha)) {
        return Invalid();
      }
      return 0;
    }
    case kx::XeCryptShaFinal: {
      Sha1 sha;
      uint8_t digest[20];
      if (!LoadHashState<Sha1, 5>(r3, &sha)) return Invalid();
      sha.Final(digest);
      if ((r5 && !Wr(r4, digest, std::min<uint32_t>(r5, 20u))) ||
          !StoreHashState<Sha1, 5>(r3, sha)) {
        return Invalid();
      }
      return 0;
    }
    case kx::XeCryptSha: {
      // (in1, size1, in2, size2, in3, size3, out, out_size)
      Sha1 sha;
      uint8_t digest[20];
      for (int i = 0; i < 3; ++i) {
        const uint32_t in = a[i * 2], size = a[i * 2 + 1];
        if (in && size && !HashGuest(sha, in, size)) return Invalid();
      }
      sha.Final(digest);
      if (a[7] && !Wr(a[6], digest, std::min<uint32_t>(a[7], 20u))) return Invalid();
      return 0;
    }
    case kx::XeCryptSha256Init: {
      Sha256 sha;
      if (!ZeroGuest(r3, 0x64u) || !StoreHashState<Sha256, 8>(r3, sha)) return Invalid();
      return 0;
    }
    case kx::XeCryptSha256Update: {
      Sha256 sha;
      if (!LoadHashState<Sha256, 8>(r3, &sha) || !HashGuest(sha, r4, r5) ||
          !StoreHashState<Sha256, 8>(r3, sha)) {
        return Invalid();
      }
      return 0;
    }
    case kx::XeCryptSha256Final: {
      Sha256 sha;
      uint8_t hash[32];
      if (!LoadHashState<Sha256, 8>(r3, &sha)) return Invalid();
      sha.Final(hash);
      // Xenia leaves the final hash in the state's buffer.
      if ((r5 && !Wr(r4, hash, std::min<uint32_t>(r5, 32u))) ||
          !Wr(r3 + 0x24u, hash, 32)) {
        return Invalid();
      }
      return 0;
    }
    case kx::XeCryptHmacSha: {
      // (key, key_size, in1, size1, in2, size2, in3, size3, out, out_size)
      uint32_t out = 0, out_size = 0;
      if (!StackArg(8, &out) || !StackArg(9, &out_size)) return Invalid();
      uint8_t key[64] = {}, ipad[64], opad[64];
      uint32_t key_size = r4;
      if (key_size > 64u) {
        Sha1 key_hash;
        uint8_t digest[20];
        if (!HashGuest(key_hash, r3, key_size)) return Invalid();
        key_hash.Final(digest);
        std::memcpy(key, digest, 20);
        key_size = 20;
      } else if (key_size && !Rd(r3, key, key_size)) {
        return Invalid();
      }
      for (int i = 0; i < 64; ++i) {
        ipad[i] = uint8_t(key[i] ^ 0x36);
        opad[i] = uint8_t(key[i] ^ 0x5C);
      }
      Sha1 inner;
      inner.Update(ipad, 64);
      for (int i = 0; i < 3; ++i) {
        const uint32_t in = a[2 + i * 2], size = a[3 + i * 2];
        if (size && !HashGuest(inner, in, size)) return Invalid();
      }
      uint8_t digest[20];
      inner.Final(digest);
      Sha1 outer;
      outer.Update(opad, 64);
      outer.Update(digest, 20);
      outer.Final(digest);
      if (out_size && !Wr(out, digest, std::min<uint32_t>(out_size, 20u))) return Invalid();
      return 0;
    }
    case kx::XeCryptRc4Key:
      if (!Rc4Key(r3, r4, r5)) return Invalid();
      return 0;
    case kx::XeCryptRc4Ecb:
      if (!Rc4Crypt(r3, r4, r5)) return Invalid();
      return 0;
    case kx::XeCryptRc4: {
      // (key, key_size, data, size) with a transient state in the pool.
      const uint32_t state = PoolAlloc(0x104u);
      if (!state) return X_STATUS_NO_MEMORY;
      const bool ok = Rc4Key(state, r3, r4) && Rc4Crypt(state, r5, r6);
      PoolFree(state);
      if (!ok) return Invalid();
      return 0;
    }

    // --- Modules / threads (Xenia xboxkrnl_modules.cc, xboxkrnl_threading.cc)
    case kx::ExRegisterTitleTerminateNotification: {
      // X_EX_TITLE_TERMINATE_REGISTRATION {notification_routine, priority, list}
      uint32_t routine = 0, priority = 0;
      if (!Rd32(r3, &routine) || !Rd32(r3 + 4u, &priority)) return Invalid();
      if (r4) TitleTerminateNotifications()[routine] = priority;
      else TitleTerminateNotifications().erase(routine);
      return 0;
    }
    case kx::KeSetCurrentStackPointers: {
      // (stack_ptr, thread, stack_alloc_base, stack_base, stack_limit)
      if (!r4 || !Wr32(r4 + 0xD0u, r5) || !Wr32(r4 + 0x5Cu, r6) ||
          !Wr32(r4 + 0x60u, r7)) {
        return Invalid();
      }
      if (g_caller_r13 &&
          (!Wr32(g_caller_r13 + 0x70u, r6) || !Wr32(g_caller_r13 + 0x74u, r7))) {
        return Invalid();
      }
      g_pending_stack_pointer = r3;
      g_pending_stack_pointer_valid = true;
      return 0;
    }
    case kx::RtlImageNtHeader: {
      // Little-endian PE headers: MZ at +0, e_lfanew at +0x3C, "PE\0\0".
      if (!r3) return 0;
      uint8_t mz[2] = {}, lfanew[4] = {}, pe[4] = {};
      if (!Rd(r3, mz, 2) || mz[0] != 'M' || mz[1] != 'Z' ||
          !Rd(r3 + 0x3Cu, lfanew, 4)) {
        return 0;
      }
      const uint32_t offset = uint32_t(lfanew[0]) | (uint32_t(lfanew[1]) << 8) |
                              (uint32_t(lfanew[2]) << 16) | (uint32_t(lfanew[3]) << 24);
      if (!Rd(r3 + offset, pe, 4) || pe[0] != 'P' || pe[1] != 'E' || pe[2] || pe[3]) {
        return 0;
      }
      return r3 + offset;
    }
    case kx::MmCreateKernelStack:
      return CreateKernelStack(r3);
    case kx::MmDeleteKernelStack: {
      // (stack_base, stack_end) where stack_end is the low address.
      auto& stacks = KernelStacks();
      const auto it = stacks.find(r4);
      if (it == stacks.end()) return X_STATUS_UNSUCCESSFUL;
      UnmapSparseGuestMemory(it->first, it->second / 0x1000u);
      stacks.erase(it);
      return X_STATUS_SUCCESS;
    }

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
    case xam::XamLoaderSetLaunchData: {
      auto& data = LaunchData();
      data.assign(r4, 0);
      if (r4 && !Rd(r3, data.data(), r4)) return Invalid();
      g_launch_data_present = r4 != 0;
      return 0;
    }
    case xam::XamLoaderGetLaunchDataSize:
      if (!r3) return X_ERROR_INVALID_PARAMETER;
      if (!g_launch_data_present) {
        if (!Wr32(r3, 0)) return Invalid();
        return X_ERROR_NOT_FOUND;
      }
      if (!Wr32(r3, uint32_t(LaunchData().size()))) return Invalid();
      return X_ERROR_SUCCESS;
    case xam::XamLoaderGetLaunchData: {
      if (!g_launch_data_present) return X_ERROR_NOT_FOUND;
      const uint32_t copy = std::min<uint32_t>(r4, uint32_t(LaunchData().size()));
      if (copy && !Wr(r3, LaunchData().data(), copy)) return Invalid();
      return X_ERROR_SUCCESS;
    }
    case xam::XamEnableInactivityProcessing:
      return X_ERROR_SUCCESS;
    case xam::XamResetInactivity:
      return 0;
    // --- App messages (Xenia xam_msg.cc -> AppManager) -------------------------
    case xam::XMsgInProcessCall:
    case xam::XMsgSystemProcessCall:
      return DispatchAppMessage(r3, r4, r5, a[3]);
    case xam::XMsgStartIORequest:
    case xam::XMsgStartIORequestEx: {
      // (app, message, overlapped, buffer, buffer_length[, unknown])
      uint32_t result = DispatchAppMessage(r3, r4, a[3], a[4]);
      if (result == X_E_NOTFOUND) result = X_E_INVALIDARG;
      if (r5) {
        if (!CompleteOverlappedImmediate(r5, result)) return Invalid();
        result = X_ERROR_IO_PENDING;
      }
      return result;
    }
    case xam::XMsgCancelIORequest:
      return 0;
    case xam::XMsgCompleteIORequest:
      // (overlapped, result, extended_error, length)
      if (!CompleteOverlappedEx(r3, r4, r5, a[3])) return Invalid();
      return X_ERROR_SUCCESS;
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

    // --- Content / save data (Xenia xam_content.cc, xam_content_device.cc) ---
    case xam::XamContentCreate:
    case xam::XamContentCreateEx:
    case xam::XamContentCreateInternal: {
      // Create(user, root, data, flags, disposition*, license*, overlapped)
      // CreateEx(user, root, data, flags, disposition*, license*, cache,
      //          content_size(qword), overlapped)
      // CreateInternal(root, data, flags, disposition*, license*, cache,
      //                content_size(qword), overlapped)
      const bool internal = ordinal == xam::XamContentCreateInternal;
      const uint32_t base = internal ? 0u : 1u;
      const uint32_t root_ptr = a[base], data_ptr = a[base + 1], flags = a[base + 2];
      const uint32_t disposition_ptr = a[base + 3], license_ptr = a[base + 4];
      uint32_t overlapped = 0;
      if (ordinal == xam::XamContentCreate) overlapped = a[6];
      else if (internal) overlapped = a[7];
      else StackArg(8, &overlapped);
      std::string root;
      if (!ReadCString(root_ptr, &root, 64)) return Invalid();
      root = Lower(root);
      uint32_t content_type = 0;
      std::string file_name;
      std::array<uint8_t, 0x134> raw{};
      if (!ReadContentData(data_ptr, &content_type, &file_name, &raw)) return Invalid();
      if (overlapped && disposition_ptr && !Wr32(disposition_ptr, 0)) return Invalid();
      uint32_t result = X_ERROR_INVALID_PARAMETER, disposition = 0;  // 1 create, 2 open
      const bool exists = FindContent(content_type, file_name) != nullptr;
      switch (flags & 0xFu) {
        case 1:  // CREATE_NEW
          if (exists) result = X_ERROR_ALREADY_EXISTS;
          else disposition = 1;
          break;
        case 2:  // CREATE_ALWAYS
          if (exists) DeleteContent(content_type, file_name);
          disposition = 1;
          break;
        case 3:  // OPEN_EXISTING
          if (!exists) result = X_ERROR_PATH_NOT_FOUND;
          else disposition = 2;
          break;
        case 4:  // OPEN_ALWAYS
          disposition = exists ? 2u : 1u;
          break;
        case 5:  // TRUNCATE_EXISTING
          if (!exists) {
            result = X_ERROR_PATH_NOT_FOUND;
          } else {
            DeleteContent(content_type, file_name);
            disposition = 1;
          }
          break;
        default:
          break;
      }
      if (disposition == 1) result = CreateContent(root, content_type, file_name, raw);
      else if (disposition == 2) result = OpenContent(root, content_type, file_name);
      if (disposition_ptr && !Wr32(disposition_ptr, disposition)) return Invalid();
      if (license_ptr && !result && !Wr32(license_ptr, 0)) return Invalid();
      return FinishXamOverlapped(overlapped, result, disposition);
    }
    case xam::XamContentClose:
      // (root, overlapped)
      {
        std::string root;
        if (!ReadCString(r3, &root, 64)) return Invalid();
        const uint32_t result = CloseContent(Lower(root));
        if (!r4) return result;
        if (!CompleteOverlappedImmediate(r4, result)) return Invalid();
        return X_ERROR_IO_PENDING;
      }
    case xam::XamContentFlush:
      if (!r4) return X_ERROR_SUCCESS;
      if (!CompleteOverlappedImmediate(r4, X_ERROR_SUCCESS)) return Invalid();
      return X_ERROR_IO_PENDING;
    case xam::XamContentDelete:
    case xam::XamContentDeleteInternal: {
      // Delete(user, data, overlapped) / DeleteInternal(data, overlapped)
      const bool internal = ordinal == xam::XamContentDeleteInternal;
      const uint32_t data_ptr = internal ? r3 : r4, overlapped = internal ? r4 : r5;
      uint32_t content_type = 0;
      std::string file_name;
      std::array<uint8_t, 0x134> raw{};
      if (!ReadContentData(data_ptr, &content_type, &file_name, &raw)) return Invalid();
      const uint32_t result = DeleteContent(content_type, file_name);
      if (!overlapped) return result;
      if (!CompleteOverlappedImmediate(overlapped, result)) return Invalid();
      return X_ERROR_IO_PENDING;
    }
    case xam::XamContentGetCreator: {
      // (user, data, is_creator*, creator_xuid*, overlapped)
      uint32_t content_type = 0;
      std::string file_name;
      std::array<uint8_t, 0x134> raw{};
      if (!ReadContentData(r4, &content_type, &file_name, &raw)) return Invalid();
      uint32_t result = X_ERROR_SUCCESS;
      if (FindContent(content_type, file_name)) {
        const bool save = content_type == 1u;  // kSavedGame: the user created it
        if (!Wr32(r5, save ? 1u : 0u) ||
            (a[3] && !Wr64(a[3], save ? 0xB13EBABEBABEBABEull : 0ull))) {
          return Invalid();
        }
      } else {
        result = X_ERROR_PATH_NOT_FOUND;
      }
      if (!a[4]) return result;
      if (!CompleteOverlappedImmediate(a[4], result)) return Invalid();
      return X_ERROR_IO_PENDING;
    }
    case xam::XamContentGetThumbnail: {
      // (user, data, buffer, buffer_size*, overlapped)
      uint32_t content_type = 0, capacity = 0;
      std::string file_name;
      std::array<uint8_t, 0x134> raw{};
      if (!ReadContentData(r4, &content_type, &file_name, &raw) || !Rd32(a[3], &capacity)) {
        return Invalid();
      }
      const ContentPackage* package = FindContent(content_type, file_name);
      uint32_t result = X_ERROR_FILE_NOT_FOUND;
      uint32_t size = 0;
      if (package && !package->thumbnail.empty()) {
        size = uint32_t(package->thumbnail.size());
        result = X_ERROR_SUCCESS;
        if (r5) {
          if (capacity < size) result = X_ERROR_INSUFFICIENT_BUFFER;
          else if (!Wr(r5, package->thumbnail.data(), size)) return Invalid();
        }
      }
      if (!Wr32(a[3], size)) return Invalid();
      if (!a[4]) return result;
      if (!CompleteOverlappedImmediate(a[4], result)) return Invalid();
      return X_ERROR_IO_PENDING;
    }
    case xam::XamContentSetThumbnail: {
      // (user, data, buffer, size, overlapped)
      uint32_t content_type = 0;
      std::string file_name;
      std::array<uint8_t, 0x134> raw{};
      if (!ReadContentData(r4, &content_type, &file_name, &raw)) return Invalid();
      ContentPackage* package = FindContent(content_type, file_name);
      uint32_t result = X_ERROR_FILE_NOT_FOUND;
      if (package) {
        package->thumbnail.assign(a[3], 0);
        if (a[3] && !Rd(r5, package->thumbnail.data(), a[3])) return Invalid();
        result = X_ERROR_SUCCESS;
      }
      if (!a[4]) return result;
      if (!CompleteOverlappedImmediate(a[4], result)) return Invalid();
      return X_ERROR_IO_PENDING;
    }
    case xam::XamContentGetLicenseMask:
      // (mask*, overlapped)
      if (!Wr32(r3, g_license_mask)) return Invalid();
      if (!r4) return X_ERROR_SUCCESS;
      if (!CompleteOverlappedImmediate(r4, X_ERROR_SUCCESS)) return Invalid();
      return X_ERROR_IO_PENDING;
    case xam::XamContentGetDeviceName: {
      // (device_id, name_buffer (u16), capacity)
      const DummyDevice* device = FindDummyDevice(r3);
      if (!device) return X_ERROR_DEVICE_NOT_CONNECTED;
      const std::u16string name(device->name);
      if (r5 < name.size() + 1) return X_ERROR_INSUFFICIENT_BUFFER;
      for (size_t i = 0; i <= name.size(); ++i) {
        if (!Wr16(r4 + uint32_t(i) * 2u, i < name.size() ? name[i] : 0)) return Invalid();
      }
      return X_ERROR_SUCCESS;
    }
    case xam::XamContentGetDeviceState: {
      // (device_id, overlapped)
      const bool present = FindDummyDevice(r3) != nullptr;
      if (!r4) return present ? X_ERROR_SUCCESS : X_ERROR_DEVICE_NOT_CONNECTED;
      const bool ok = present ? CompleteOverlappedImmediate(r4, X_ERROR_SUCCESS)
                              : CompleteOverlappedEx(r4, X_ERROR_FUNCTION_FAILED,
                                                     X_ERROR_DEVICE_NOT_CONNECTED, 0);
      if (!ok) return Invalid();
      return X_ERROR_IO_PENDING;
    }
    case xam::XamContentGetDeviceData: {
      const DummyDevice* device = FindDummyDevice(r3);
      if (!device) return X_ERROR_DEVICE_NOT_CONNECTED;
      if (!WriteDeviceData(r4, *device)) return Invalid();
      return X_ERROR_SUCCESS;
    }
    case xam::XamContentCreateDeviceEnumerator: {
      // (content_type, content_flags, max_count, buffer_size*, handle*)
      if (a[3] && !Wr32(a[3], 0x50u * r5)) return Invalid();
      std::vector<uint8_t> items;
      for (const auto& device : kDummyDevices) {
        uint8_t item[0x50] = {};
        auto put32 = [&](uint32_t at, uint32_t v) {
          item[at] = uint8_t(v >> 24); item[at + 1] = uint8_t(v >> 16);
          item[at + 2] = uint8_t(v >> 8); item[at + 3] = uint8_t(v);
        };
        put32(0, device.id);
        put32(4, device.type);
        put32(8, uint32_t(device.total >> 32)); put32(12, uint32_t(device.total));
        put32(16, uint32_t(device.free >> 32)); put32(20, uint32_t(device.free));
        const std::u16string name(device.name);
        for (size_t i = 0; i < name.size() && i < 27; ++i) {
          item[24 + i * 2] = uint8_t(name[i] >> 8);
          item[25 + i * 2] = uint8_t(name[i]);
        }
        items.insert(items.end(), item, item + 0x50);
      }
      const uint32_t handle = CreateXamEnumerator(0x50u, r5, std::move(items));
      if (!handle) return X_STATUS_NO_MEMORY;
      if (!Wr32(a[4], handle)) return Invalid();
      return X_ERROR_SUCCESS;
    }
    case xam::XamContentCreateEnumerator: {
      // (user, device_id, content_type, content_flags, items_per_enumerate,
      //  buffer_size*, handle*)
      const uint32_t device_id = r4, content_type = r5, per = a[4];
      const uint32_t size_ptr = a[5], handle_out = a[6];
      if ((device_id && !FindDummyDevice(device_id)) || !handle_out) {
        if (size_ptr) Wr32(size_ptr, 0);
        return X_E_INVALIDARG;
      }
      if (size_ptr && !Wr32(size_ptr, 0x134u * per)) return Invalid();
      std::vector<uint8_t> items;
      if (!device_id || device_id == 1u) {
        for (const auto& package : ContentPackages()) {
          if (package.content_type != content_type) continue;
          auto item = package.data;
          item[0] = 0; item[1] = 0; item[2] = 0; item[3] = 1;  // device_id = HDD
          items.insert(items.end(), item.begin(), item.end());
        }
      }
      const uint32_t handle = CreateXamEnumerator(0x134u, per, std::move(items));
      if (!handle) return X_STATUS_NO_MEMORY;
      if (!Wr32(handle_out, handle)) return Invalid();
      return X_ERROR_SUCCESS;
    }
    case xam::XamEnumerate: {
      // (handle, flags, buffer, buffer_length, items_returned*, overlapped)
      const uint32_t items_returned = a[4], overlapped = a[5];
      KernelObject* object = ResolveHandle(r3);
      auto it = XamEnumerators().find(r3);
      if (!object || object->type != ObjectType::kEnumerator || it == XamEnumerators().end()) {
        return X_ERROR_INVALID_HANDLE;
      }
      auto& e = it->second;
      uint32_t result = X_ERROR_SUCCESS, count = 0;
      if (!r5) {
        result = X_ERROR_INVALID_PARAMETER;
      } else {
        count = std::min(e.count() - e.current, e.per_enumerate);
        if (!count) {
          result = X_ERROR_NO_MORE_FILES;
        } else {
          if (!Wr(r5, e.items.data() + size_t(e.current) * e.item_size, count * e.item_size)) {
            return Invalid();
          }
          e.current += count;
        }
      }
      if (!overlapped) {
        if (items_returned && !Wr32(items_returned, result ? 0u : count)) return Invalid();
        return result;
      }
      return FinishXamOverlapped(overlapped, result, count);
    }

    // --- Headless UI (Xenia xam_ui.cc / xam_user.cc) ------------------------------
    case xam::XamShowSigninUI:
      // Xenia: XN_SYS_SIGNINCHANGED, then XN_SYS_UI off, to every listener.
      BroadcastNotification(0x0Au, 1);
      BroadcastNotification(0x09u, 0);
      return X_ERROR_SUCCESS;
    case xam::XamShowDeviceSelectorUI: {
      // (user, content_type, content_flags, total_requested(qword),
      //  device_id*, overlapped): the dummy HDD, bracketed by XN_SYS_UI.
      BroadcastNotification(0x09u, 1);
      if (!Wr32(a[4], 1u)) return Invalid();
      BroadcastNotification(0x09u, 0);
      return FinishXamOverlapped(a[5], X_ERROR_SUCCESS, 0);
    }

    // --- Notifications (Xenia xam_notify.cc) -----------------------------------
    case xam::XamNotifyCreateListener:
      return CreateNotifyListener(r3, r4);
    case xam::XamNotifyCreateListenerInternal:
      return CreateNotifyListener(r3, r5);
    case xam::XNotifyGetNext: {
      // (handle, match_id, id_ptr, param_ptr)
      if (a[3] && !Wr32(a[3], 0)) return Invalid();
      if (!r5) return 0;
      if (!Wr32(r5, 0)) return Invalid();
      KernelObject* listener_object = ResolveHandle(r3);
      auto it = NotifyListeners().find(r3);
      if (!listener_object || listener_object->type != ObjectType::kNotifyListener ||
          it == NotifyListeners().end()) {
        return 0;
      }
      auto& queue = it->second.queue;
      auto entry = queue.begin();
      if (r4) {
        while (entry != queue.end() && entry->first != r4) ++entry;
      }
      if (entry == queue.end()) return 0;
      const uint32_t id = entry->first, data = entry->second;
      queue.erase(entry);
      if (queue.empty()) {
        if (KernelObject* object = ResolveHandle(r3)) Wr32(object->guest + 4u, 0u);
      }
      if (!Wr32(r5, id) || (a[3] && !Wr32(a[3], data))) return Invalid();
      return 1;
    }

    // --- Profile / user (Xenia xam_user.cc) -------------------------------------
    case xam::XamUserReadProfileSettings: {
      // (title_id, user_index, xuid_count, xuids, setting_count, setting_ids,
      //  buffer_size_ptr, buffer, overlapped)
      uint32_t overlapped = 0;
      StackArg(8, &overlapped);
      return ReadProfileSettings(a[1], a[2], a[3], a[4], a[5], a[6], a[7],
                                 overlapped);
    }
    case xam::XamUserReadProfileSettingsEx: {
      // (..., buffer_size_ptr, unk, buffer, overlapped)
      uint32_t buffer = 0, overlapped = 0;
      if (!StackArg(8, &buffer)) return Invalid();
      StackArg(9, &overlapped);
      return ReadProfileSettings(a[1], a[2], a[3], a[4], a[5], a[6], buffer,
                                 overlapped);
    }
    case xam::XamUserWriteProfileSettings: {
      // (title_id, user_index, setting_count, settings, overlapped)
      const uint32_t user = a[1], count = a[2], settings = a[3], overlapped = a[4];
      if (!count || !settings) return X_ERROR_INVALID_PARAMETER;
      if (!user) {
        for (uint32_t n = 0; n < count; ++n) {
          const uint32_t setting = settings + n * 40u;
          uint32_t id = 0, size = 0, ptr = 0;
          uint8_t type = 0;
          if (!Rd32(setting + 16u, &id) || !Rd8(setting + 24u, &type)) return Invalid();
          // Xenia stores CONTENT/BINARY settings; other types are logged only.
          if (type != 0u && type != 6u) continue;
          if (!Rd32(setting + 32u, &size) || !Rd32(setting + 36u, &ptr)) return Invalid();
          std::vector<uint8_t> bytes(size, 0);
          if (ptr && size && !Rd(ptr, bytes.data(), size)) return Invalid();
          TitleProfileSettings()[id] = std::move(bytes);
        }
      }
      const uint32_t result = user ? X_ERROR_NO_SUCH_USER : X_ERROR_SUCCESS;
      if (!overlapped) return result;
      if (!CompleteOverlappedImmediate(overlapped, result)) return Invalid();
      return X_ERROR_IO_PENDING;
    }
    case xam::XamUserGetGamerTag: {
      // (user_index, buffer (UTF-16), buffer_len in characters)
      if (r3 >= 4) return X_E_INVALIDARG;
      if (r3) return X_E_NO_SUCH_USER;
      if (!r4 || r5 < 16) return X_E_INVALIDARG;
      static const char16_t kTag[] = u"User";
      for (uint32_t i = 0; i < 5; ++i) {
        if (!Wr16(r4 + i * 2u, kTag[i])) return Invalid();
      }
      return X_E_SUCCESS;
    }
    case xam::XamUserGetMembershipTier:
      if (r3 >= 4) return X_ERROR_INVALID_PARAMETER;
      if (r3) return X_ERROR_NO_SUCH_USER;
      return 6;  // Xenia: Gold.
    case xam::XamUserIsOnlineEnabled:
      return 1;
    case xam::XamUserContentRestrictionGetFlags:
      if (r3) return X_ERROR_NO_SUCH_USER;
      if (!Wr32(r4, 0)) return Invalid();
      return X_ERROR_SUCCESS;
    case xam::XamUserContentRestrictionGetRating:
      if (r3) return X_ERROR_NO_SUCH_USER;
      if (!Wr32(a[2], 0x3Fu) || !Wr32(a[3], 0)) return Invalid();
      return X_ERROR_SUCCESS;
    case xam::XamUserContentRestrictionCheckAccess:
      // (user, unk1..unk4, out_unk5, overlapped)
      if (!Wr32(a[5], 1)) return Invalid();
      if (a[6] && !CompleteOverlappedImmediate(a[6], X_ERROR_SUCCESS)) return Invalid();
      return X_ERROR_SUCCESS;
    case xam::XamGetOverlappedResult: {
      // (overlapped, length_ptr, wait): completions here are immediate.
      uint32_t result = 0, length = 0, event = 0;
      if (!Rd32(r3, &result) || !Rd32(r3 + 4u, &length) || !Rd32(r3 + 12u, &event)) {
        return Invalid();
      }
      if (result == X_ERROR_IO_PENDING) {
        if (!event) return X_ERROR_IO_INCOMPLETE;
        KernelObject* object = ResolveHandle(event);
        return WouldBlock(kModuleXam, ordinal, object ? object->guest : 0, event, 1);
      }
      if (!result && r4 && !Wr32(r4, length)) return Invalid();
      return result;
    }

    // --- Locale / info (Xenia xam_locale.cc, xam_info.cc, xam_video.cc) -------
    case xam::XamGetLocale:
    case xam::XamGetLocaleEx:
      // Xenia xeXamGetLocaleEx: user_country 103 (US) maps to locale 36 when
      // within the caller's limits; otherwise it falls back from the game
      // region, and region 0xFFFF also resolves to US (36).
      return 36u;
    case xam::XamFeatureEnabled:
      return 0;
    case xam::XGetVideoCapabilities:
      return 0;
    case xam::XamTaskShouldExit:
      return 0;
    case xam::XamIsUIActive:
      return 0;

    // --- Networking startup (Xenia xam_net.cc, offline) ----------------------
    case xam::NetDll_XNetStartup:
    case xam::NetDll_XNetCleanup:
    case xam::NetDll_WSACleanup:
      return 0;
    case xam::NetDll_WSAStartup: {
      // (caller, version, X_WSADATA*) - Xenia's non-Windows values.
      if (r5) {
        if (!Wr16(r5, uint16_t(r4)) || !Wr8(r5 + 4u, 0) || !Wr8(r5 + 0x105u, 0) ||
            !Wr16(r5 + 0x186u, 100) || !Wr16(r5 + 0x188u, 1024)) {
          return Invalid();
        }
      }
      return 0;
    }
    case xam::NetDll_WSAGetLastError:
      return 0;
    case xam::NetDll_XNetGetTitleXnAddr: {
      // XNADDR {ina, inaOnline, wPortOnline, abEnet[6], abOnline[20]}:
      // loopback, MAC 0xCC.., XNET_GET_XNADDR_STATIC (4).
      uint8_t enet[6];
      std::memset(enet, 0xCC, sizeof(enet));
      if (!Wr32(r4, 0x7F000001u) || !Wr32(r4 + 4u, 0) || !Wr16(r4 + 8u, 0) ||
          !Wr(r4 + 10u, enet, 6) || !ZeroGuest(r4 + 16u, 20)) {
        return Invalid();
      }
      return 4;
    }
    case xam::NetDll_XNetGetDebugXnAddr:
      if (!ZeroGuest(r4, 36)) return Invalid();
      return 1;  // XNET_GET_XNADDR_NONE
    case xam::NetDll_XNetGetEthernetLinkStatus:
      return 0;  // no link: titles stay offline
    case xam::NetDll_XNetRandom: {
      uint8_t chunk[256];
      std::memset(chunk, 0xBB, sizeof(chunk));
      for (uint32_t done = 0; done < r5;) {
        const uint32_t n = std::min<uint32_t>(r5 - done, sizeof(chunk));
        if (!Wr(r4 + done, chunk, n)) return Invalid();
        done += n;
      }
      return 0;
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
  // The caller's registers are per guest thread; another fiber may run (and
  // make kernel calls) while this one is suspended in a wait.
  const uint32_t caller_r13 = g_caller_r13, caller_lr = g_caller_lr,
                 caller_r1 = g_caller_r1;
  for (;;) {
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
    // A wait on an object another guest thread must signal (or a lock it
    // holds): run that thread, then retry this call. Blocked paths have no
    // side effects, so the retry sees the same arguments and fresh state.
    if (g_status == kKernelServiceWouldBlock && g_wait.reason >= 1 &&
        g_wait.reason <= 3 && GuestFibersActive()) {
      ThreadWait& record = g_thread_waits[r360_guest_thread_current()];
      record.wait = g_wait;
      record.caller_lr = caller_lr;
      ++record.count;
    }
    if (g_status == kKernelServiceWouldBlock && g_wait.reason >= 1 &&
        g_wait.reason <= 3 && GuestFiberYield(true)) {
      g_caller_r13 = caller_r13;
      g_caller_lr = caller_lr;
      g_caller_r1 = caller_r1;
      continue;
    }
    if (g_status == kKernelServiceSuccess) {
      GuestFiberNoteProgress();
      if (!g_thread_waits.empty()) g_thread_waits.erase(r360_guest_thread_current());
    }
    *result = value;
    return g_status;
  }
}

// Xenia AudioSystem::WorkerThreadMain: calls each registered render-driver
// client's callback while its semaphore has frames available, on the audio
// worker thread. The worker is a suspended guest thread whose stack and KPCR
// the callback runs on, nested like an interrupt (it cannot block).
void PumpAudioClients() {
  bool any = false;
  for (const auto& client : g_audio_clients) any |= client.used && client.callback;
  if (!any) return;
  const uint64_t now = MonotonicMillis();
  if (!g_audio_origin_ms) g_audio_origin_ms = now;
  const uint64_t played = (now - g_audio_origin_ms) * 3u / 16u;
  for (; g_audio_frames_played < played; ++g_audio_frames_played) {
    for (auto& client : g_audio_clients) {
      if (!client.used || !client.queued) continue;
      --client.queued;
      if (client.available < kAudioMaxQueuedFrames) ++client.available;
    }
  }
  if (!g_audio_thread) {
    uint32_t entry = 0;
    for (const auto& client : g_audio_clients) {
      if (client.used && client.callback) { entry = client.callback; break; }
    }
    const uint32_t native = r360_guest_thread_create(entry, 0, 0x10000u, 0);
    if (!native) return;
    if (!PrepareThreadObjects(native, entry, 0, 0)) {
      r360_guest_thread_terminate(native, 0);
      return;
    }
    r360_guest_thread_suspend(native);
    g_audio_thread = native;
  }
  const uint32_t stack_top = r360_guest_thread_stack_top(g_audio_thread);
  const uint32_t pcr = r360_guest_thread_pcr(g_audio_thread);
  const uint32_t caller_r13 = g_caller_r13, caller_lr = g_caller_lr,
                 caller_r1 = g_caller_r1;
  // A few callbacks per poll keep the initial 64-frame burst from stalling
  // the interrupted thread.
  for (uint32_t round = 0; round < 4u; ++round) {
    bool pumped = false;
    for (auto& client : g_audio_clients) {
      if (!client.used || !client.callback || !client.available) continue;
      --client.available;
      RunGuestInterrupt(client.callback, client.wrapped_arg, 0, stack_top, pcr);
      ++g_audio_callbacks;
      pumped = true;
    }
    if (!pumped) break;
  }
  g_caller_r13 = caller_r13;
  g_caller_lr = caller_lr;
  g_caller_r1 = caller_r1;
}

void MaybeDeliverGuestInterrupts() {
  if ((++g_interrupt_poll & 63u) != 0) return;
  DeliverGuestInterruptsNow();
}

// Port of XmaDecoder::ReadRegister / WriteRegister (apu/xma_decoder.cc): the
// title's XMA library programs the decoder through this MMIO window. Values
// are the logical (host-order) register values.
bool ReadXmaMmio(uint32_t address, uint32_t* value) {
  if ((address & 0xFFFF0000u) != 0x7FEA0000u || !value) return false;
  auto& r = XmaRegisters();
  const uint32_t index = (address & 0xFFFFu) / 4u;
  if (index == kXmaContextArrayAddress) {
    if (EnsureXmaContextArray()) r[index] = GuestPhysicalAddress(g_xma_context_base);
  } else if (index == kXmaCurrentContextIndex) {
    // A rotating index keeps titles from seeing a stuck context.
    r[kXmaCurrentContextIndex] = r[kXmaNextContextIndex];
    r[kXmaNextContextIndex] = (r[kXmaNextContextIndex] + 1u) % kXmaContextCount;
  }
  *value = r[index];
  return true;
}

bool WriteXmaMmio(uint32_t address, uint32_t value) {
  if ((address & 0xFFFF0000u) != 0x7FEA0000u) return false;
  auto& r = XmaRegisters();
  const uint32_t index = (address & 0xFFFFu) / 4u;
  r[index] = value;
  auto for_each_context = [&](uint32_t group_base, auto&& action) {
    if (!EnsureXmaContextArray()) return;
    const uint32_t first = (index - group_base) * 32u;
    for (uint32_t i = 0; value && i < 32u; ++i, value >>= 1) {
      if ((value & 1u) && first + i < kXmaContextCount) {
        action(g_xma_context_base + (first + i) * kXmaContextBytes);
      }
    }
  };
  if (index >= kXmaContext0Kick && index < kXmaContext0Kick + 10u) {
    for_each_context(kXmaContext0Kick, [](uint32_t c) { XmaEnabledContexts().insert(c); });
  } else if (index >= kXmaContext0Lock && index < kXmaContext0Lock + 10u) {
    for_each_context(kXmaContext0Lock, [](uint32_t c) { XmaEnabledContexts().erase(c); });
  } else if (index >= kXmaContext0Clear && index < kXmaContext0Clear + 10u) {
    for_each_context(kXmaContext0Clear, [](uint32_t c) {
      XmaSet(c, kXmaInput0Valid, 0);
      XmaSet(c, kXmaInput1Valid, 0);
      XmaSet(c, kXmaOutputValid, 0);
      XmaSet(c, kXmaOutputReadOffset, 0);
      XmaSet(c, kXmaOutputWriteOffset, 0);
    });
  }
  return true;
}

void DeliverGuestInterruptsNow() {
  if (!GuestFibersActive() || GuestInterruptActive()) return;
  GuestFiberHostYieldIfDue();
  PumpAudioClients();
  if (!g_graphics_interrupt_callback) return;
  TitleGpuPump();
  uint32_t cpu_mask = 0;
  const uint32_t cp_interrupts = TitleGpuTakePendingInterrupts(&cpu_mask);
  const uint64_t now = MonotonicMillis();
  const bool vblank = now - g_last_vblank_ms >= 16u;
  if (!vblank && !cp_interrupts) return;
  if (!g_interrupt_thread) {
    const uint32_t native =
        r360_guest_thread_create(g_graphics_interrupt_callback, 0, 0x10000u, 0);
    if (!native) return;
    if (!PrepareThreadObjects(native, g_graphics_interrupt_callback, 0, 0)) {
      r360_guest_thread_terminate(native, 0);
      return;
    }
    r360_guest_thread_suspend(native);
    g_interrupt_thread = native;
  }
  const uint32_t stack_top = r360_guest_thread_stack_top(g_interrupt_thread);
  const uint32_t pcr = r360_guest_thread_pcr(g_interrupt_thread);
  // Processor::ExecuteInterrupt: the KPCR TLS pointer is zero during
  // interrupts (titles check it).
  uint32_t tls = 0;
  Rd32(pcr, &tls);
  Wr32(pcr, 0);
  const uint32_t caller_r13 = g_caller_r13, caller_lr = g_caller_lr,
                 caller_r1 = g_caller_r1;
  for (uint32_t i = 0; i < cp_interrupts && i < 8u; ++i) {
    for (uint32_t cpu = 0; cpu < 6; ++cpu) {
      if (!(cpu_mask & (1u << cpu))) continue;
      // XThread::SetActiveCpu: KPCR current_cpu (+0x10C).
      Wr8(pcr + 0x10Cu, uint8_t(cpu));
      RunGuestInterrupt(g_graphics_interrupt_callback, 1u,
                        g_graphics_interrupt_user_data, stack_top, pcr);
      ++g_cp_interrupts;
    }
  }
  if (vblank) {
    g_last_vblank_ms = now;
    Wr8(pcr + 0x10Cu, 2u);  // GraphicsSystem::MarkVblank dispatches on CPU 2
    RunGuestInterrupt(g_graphics_interrupt_callback, 0u,
                      g_graphics_interrupt_user_data, stack_top, pcr);
    ++g_vblank_interrupts;
  }
  g_caller_r13 = caller_r13;
  g_caller_lr = caller_lr;
  g_caller_r1 = caller_r1;
  Wr32(pcr, tls);
}

bool FinishGuestThreadFiber(uint32_t native, bool returned, uint32_t exit_code) {
  if (g_terminal.kind == kTerminalThreadExit) {
    g_terminal = {};
    return true;  // ExTerminateThread already marked and terminated it
  }
  if (!returned) return false;
  MarkThreadExited(r360_guest_thread_kthread(native), exit_code);
  r360_guest_thread_terminate(native, exit_code);
  return true;
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
  g_interrupt_thread = 0;
  g_last_vblank_ms = 0;
  g_interrupt_poll = g_vblank_interrupts = g_cp_interrupts = 0;
  g_thread_waits.clear();
  g_thread_polls.clear();
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
  PhysicalVirtualBases().clear();
  Objects().clear();
  ThreadPriority().clear();
  ThreadAffinity().clear();
  g_kernel_module_handles = {};
  g_audio_clients = {};
  g_audio_origin_ms = g_audio_frames_played = 0;
  g_audio_thread = g_audio_callbacks = 0;
  TitleProfileSettings().clear();
  LaunchData().clear();
  g_launch_data_present = false;
  KernelStacks().clear();
  TitleTerminateNotifications().clear();
  g_pending_stack_pointer = 0;
  g_pending_stack_pointer_valid = false;
  g_xma_context_base = 0;
  g_xma_context_used = {};
  XmaEnabledContexts().clear();
  XmaRegisters().assign(kXmaRegisterCount, 0u);
  XmaRegisters()[kXmaNextContextIndex] = 1u;
  NotifyListeners().clear();
  Xmp() = XmpState();
  g_notified_startup = false;
  for (const auto& package : ContentPackages()) {
    DeleteContentFiles(package.device);
    VfsDevices().erase(package.device);
  }
  ContentPackages().clear();
  for (const auto& [root, device] : OpenContentRoots()) VfsSymlinks().erase(root + ":");
  OpenContentRoots().clear();
  g_next_content_device = 1;
  XamEnumerators().clear();
  // Title-created symbolic links belong to the run; the registered VFS
  // content (r360_vfs_*) survives so a title can be re-run deterministically.
  VfsSymlinks().clear();
  g_host_io = {};
  g_vfs_reads = 0;
  g_vfs_bytes_read = 0;
}

bool TakeKernelServiceStackPointer(uint32_t* value) {
  if (!g_pending_stack_pointer_valid) return false;
  g_pending_stack_pointer_valid = false;
  if (value) *value = g_pending_stack_pointer;
  return true;
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

// --- Virtual file system registration (browser loader / title runner) ------

R360_WASM_EXPORT("r360_vfs_reset")
void r360_vfs_reset() {
  r360k::VfsEntries().clear();
  r360k::VfsIndex().clear();
  r360k::VfsSymlinks().clear();
  r360k::g_host_io = {};
  r360k::g_vfs_reads = 0;
  r360k::g_vfs_bytes_read = 0;
}
// 1 KiB scratch buffer in wasm memory for passing a UTF-8 guest path.
R360_WASM_EXPORT("r360_vfs_path_buffer")
uint32_t r360_vfs_path_buffer() {
  return uint32_t(uintptr_t(r360k::g_vfs_path_buffer));
}
// Registers a file or directory relative to \Device\Cdrom0 (the game disc).
// Returns the 1-based entry id. host_fd/host_offset let WASI fd_pread supply
// the bytes; 0 means data must be attached with r360_vfs_data_buffer.
R360_WASM_EXPORT("r360_vfs_register")
uint32_t r360_vfs_register(uint32_t path_length, uint32_t size_lo,
                           uint32_t size_hi, uint32_t attributes,
                           uint32_t host_fd, uint32_t host_offset_lo,
                           uint32_t host_offset_hi) {
  if (!path_length || path_length >= sizeof(r360k::g_vfs_path_buffer)) return 0;
  const std::string path(r360k::g_vfs_path_buffer, path_length);
  const uint64_t size = (uint64_t(size_hi) << 32) | size_lo;
  const uint64_t host_offset = (uint64_t(host_offset_hi) << 32) | host_offset_lo;
  return r360k::RegisterVfsEntry(path, size, attributes ? attributes
                                                        : (r360k::kFileAttributeNormal |
                                                           r360k::kFileAttributeReadOnly),
                                 host_fd, host_offset);
}
// Allocates an in-memory buffer holding the whole file for entry |id| and
// returns its wasm address for the loader to fill (0 on failure).
R360_WASM_EXPORT("r360_vfs_data_buffer")
uint32_t r360_vfs_data_buffer(uint32_t id) {
  auto* entry = r360k::VfsEntryAt(id);
  if (!entry || entry->size > 0x7FFFFFFFull) return 0;
  entry->data.assign(size_t(entry->size), 0);
  entry->has_data = true;
  return entry->size ? uint32_t(uintptr_t(entry->data.data())) : 1u;
}
R360_WASM_EXPORT("r360_vfs_entry_count")
uint32_t r360_vfs_entry_count() { return uint32_t(r360k::VfsEntries().size()); }
R360_WASM_EXPORT("r360_vfs_host_io_entry")
uint32_t r360_vfs_host_io_entry() { return r360k::g_host_io.entry; }
R360_WASM_EXPORT("r360_vfs_host_io_offset")
uint32_t r360_vfs_host_io_offset() { return uint32_t(r360k::g_host_io.offset); }
R360_WASM_EXPORT("r360_vfs_host_io_length")
uint32_t r360_vfs_host_io_length() { return r360k::g_host_io.length; }
R360_WASM_EXPORT("r360_vfs_host_io_errno")
uint32_t r360_vfs_host_io_errno() { return r360k::g_host_io.host_errno; }
R360_WASM_EXPORT("r360_vfs_reads")
uint32_t r360_vfs_reads() { return r360k::g_vfs_reads; }
// Copies the device-relative path of entry |id| into the path buffer and
// returns its length, so diagnostics can name a pending host read.
R360_WASM_EXPORT("r360_vfs_entry_path")
uint32_t r360_vfs_entry_path(uint32_t id) {
  const auto* entry = r360k::VfsEntryAt(id);
  if (!entry) return 0;
  const size_t n = std::min(entry->path.size(), sizeof(r360k::g_vfs_path_buffer) - 1);
  std::memcpy(r360k::g_vfs_path_buffer, entry->path.data(), n);
  r360k::g_vfs_path_buffer[n] = 0;
  return uint32_t(n);
}

// XBLA license mask reported by XamContentGetLicenseMask (Xenia
// cvars::license_mask): 0 = trial (Xenia default), 1 = full version bit,
// 0xFFFFFFFF = every license. Survives kernel resets like a console setting.
R360_WASM_EXPORT("r360_xam_set_license_mask")
uint32_t r360_xam_set_license_mask(uint32_t mask) {
  r360k::g_license_mask = mask;
  return mask;
}
R360_WASM_EXPORT("r360_xam_license_mask")
uint32_t r360_xam_license_mask() { return r360k::g_license_mask; }
R360_WASM_EXPORT("r360_content_package_count")
uint32_t r360_content_package_count() {
  return uint32_t(r360k::ContentPackages().size());
}

R360_WASM_EXPORT("r360_audio_client_callback")
uint32_t r360_audio_client_callback(uint32_t index) {
  return index < r360k::kMaxAudioClients && r360k::g_audio_clients[index].used
             ? r360k::g_audio_clients[index].callback
             : 0u;
}
R360_WASM_EXPORT("r360_audio_client_callback_arg")
uint32_t r360_audio_client_callback_arg(uint32_t index) {
  return index < r360k::kMaxAudioClients ? r360k::g_audio_clients[index].callback_arg : 0u;
}
R360_WASM_EXPORT("r360_audio_client_frames")
uint32_t r360_audio_client_frames(uint32_t index) {
  return index < r360k::kMaxAudioClients ? r360k::g_audio_clients[index].frames_submitted : 0u;
}
R360_WASM_EXPORT("r360_audio_client_last_samples")
uint32_t r360_audio_client_last_samples(uint32_t index) {
  return index < r360k::kMaxAudioClients ? r360k::g_audio_clients[index].last_samples : 0u;
}

// Xenia Memory::TranslatePhysical for GPU-visible addresses: the command
// processor receives physical addresses (MmGetPhysicalAddress) for ring
// write-back, indirect buffers, constants, shaders and fences. Addresses in a
// CPU view (>= 0x20000000) are already guest virtual addresses.
R360_WASM_EXPORT("r360_kernel_gpu_address_to_virtual")
uint32_t r360_kernel_gpu_address_to_virtual(uint32_t address) {
  if (address >= 0x20000000u) return address;
  auto& ranges = r360k::PhysicalRanges();
  auto it = ranges.upper_bound(address);
  if (it == ranges.begin()) return address;
  --it;
  if (address - it->first >= it->second) return address;
  auto base = r360k::PhysicalVirtualBases().find(it->first);
  if (base == r360k::PhysicalVirtualBases().end()) return address;
  return base->second + (address - it->first);
}
R360_WASM_EXPORT("r360_kernel_vblank_interrupts")
uint32_t r360_kernel_vblank_interrupts() { return r360k::g_vblank_interrupts; }
// Field of the blocking wait a guest thread is suspended in (0 when it is
// not waiting): 0 module<<16|ordinal, 1 object, 2 handle, 3 object type,
// 4 reason, 5 guest return address, 6 blocked retries.
R360_WASM_EXPORT("r360_kernel_thread_wait")
uint32_t r360_kernel_thread_wait(uint32_t thread, uint32_t field) {
  const auto it = r360k::g_thread_waits.find(thread);
  if (it == r360k::g_thread_waits.end()) return 0;
  const auto& w = it->second;
  switch (field) {
    case 0: return (w.wait.module << 16) | (w.wait.ordinal & 0xFFFFu);
    case 1: return w.wait.object;
    case 2: return w.wait.handle;
    case 3: return w.wait.object_type;
    case 4: return w.wait.reason;
    case 5: return w.caller_lr;
    case 6: return w.count;
    default: return 0;
  }
}
// Same fields for the thread's last bounded wait (4 = low timeout word).
R360_WASM_EXPORT("r360_kernel_thread_poll")
uint32_t r360_kernel_thread_poll(uint32_t thread, uint32_t field) {
  const auto it = r360k::g_thread_polls.find(thread);
  if (it == r360k::g_thread_polls.end()) return 0;
  const auto& w = it->second;
  switch (field) {
    case 0: return (w.wait.module << 16) | (w.wait.ordinal & 0xFFFFu);
    case 1: return w.wait.object;
    case 2: return w.wait.handle;
    case 3: return w.wait.object_type;
    case 4: return w.wait.reason;
    case 5: return w.caller_lr;
    case 6: return w.count;
    default: return 0;
  }
}
R360_WASM_EXPORT("r360_kernel_audio_callbacks")
uint32_t r360_kernel_audio_callbacks() { return r360k::g_audio_callbacks; }
R360_WASM_EXPORT("r360_kernel_cp_interrupts")
uint32_t r360_kernel_cp_interrupts() { return r360k::g_cp_interrupts; }
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
