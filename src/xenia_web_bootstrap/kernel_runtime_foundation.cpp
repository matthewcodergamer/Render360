#include <array>
#include <cstdint>

#include "sparse_guest_memory.h"

#if defined(__wasm__)
#define R360_WASM_EXPORT(name) __attribute__((used, export_name(name)))
#else
#define R360_WASM_EXPORT(name)
#endif

namespace render360::xenia_web {
namespace {

constexpr uint32_t kModuleXboxkrnl = 1;
constexpr uint32_t kModuleXam = 2;
constexpr uint32_t kStatusIdle = 0;
constexpr uint32_t kStatusSuccess = 1;
constexpr uint32_t kStatusUnsupported = 2;
constexpr uint32_t kStatusInvalid = 3;
constexpr uint32_t kTlsOutOfIndexes = 0xFFFFFFFFu;
constexpr uint32_t kMaxThreads = 32;
constexpr uint32_t kMaxTlsSlots = 64;
constexpr uint32_t kGuestTickFrequency = 50000000u;
constexpr uint32_t kGuestPageSize = 4096u;
// Browser guest stacks live in a dedicated 512 MiB sparse virtual arena below
// the normal 0x82000000 retail XEX image region. Each thread owns a 16 MiB
// slot, with the first page intentionally left unmapped as a downward-growing
// stack guard. Mapping is fail-closed: if a title already occupies a slot,
// thread creation fails rather than overwriting guest memory.
constexpr uint32_t kGuestStackArenaBase = 0x60000000u;
constexpr uint32_t kGuestStackSlotStride = 0x01000000u;
constexpr uint32_t kGuestStackGuardBytes = kGuestPageSize;
constexpr uint32_t kGuestStackDefaultBytes = 0x00040000u;  // 256 KiB.
constexpr uint32_t kGuestStackTopReserve = 0x100u;
constexpr uint32_t kBrowserMainThreadReservedSlot = 16u;
constexpr uint32_t kGuestStackMaxBytes =
    kGuestStackSlotStride - 2u * kGuestStackGuardBytes;

enum ThreadState : uint32_t {
  kThreadInvalid = 0,
  kThreadReady = 1,
  kThreadRunning = 2,
  kThreadSuspended = 3,
  kThreadTerminated = 4,
};

struct GuestThread {
  bool used = false;
  bool stack_mapped = false;
  uint16_t generation = 0;
  ThreadState state = kThreadInvalid;
  uint32_t entry = 0;
  uint32_t context = 0;
  uint32_t stack_size = 0;
  uint32_t stack_base = 0;
  uint32_t stack_top = 0;
  uint32_t flags = 0;
  uint32_t suspend_count = 0;
  uint32_t exit_code = 0;
  std::array<uint32_t, kMaxTlsSlots> tls{};
};

std::array<GuestThread, kMaxThreads> g_threads{};
std::array<bool, kMaxTlsSlots> g_tls_allocated{};
uint32_t g_current_thread = 0;
uint32_t g_scheduler_cursor = 0;
uint32_t g_runtime_status = kStatusIdle;
uint32_t g_service_status = kStatusIdle;
uint32_t g_service_calls = 0;
uint32_t g_last_module = 0;
uint32_t g_last_ordinal = 0;
uint32_t g_next_notify_handle = 0x37000001u;
uint32_t g_input_mask = 0;
uint32_t g_input_packet = 1;
int32_t g_input_lx = 0, g_input_ly = 0, g_input_rx = 0, g_input_ry = 0;

void StoreInputBE16(uint8_t* p, uint16_t v) { p[0]=uint8_t(v>>8); p[1]=uint8_t(v); }
void StoreInputBE32(uint8_t* p, uint32_t v) { p[0]=uint8_t(v>>24); p[1]=uint8_t(v>>16); p[2]=uint8_t(v>>8); p[3]=uint8_t(v); }
uint16_t BrowserInputButtons() {
  uint16_t b=0;
  if(g_input_mask&(1u<<0)) b|=0x1000u; if(g_input_mask&(1u<<1)) b|=0x2000u;
  if(g_input_mask&(1u<<2)) b|=0x4000u; if(g_input_mask&(1u<<3)) b|=0x8000u;
  if(g_input_mask&(1u<<6)) b|=0x0100u; if(g_input_mask&(1u<<7)) b|=0x0200u;
  if(g_input_mask&(1u<<8)) b|=0x0010u; if(g_input_mask&(1u<<9)) b|=0x0020u;
  return b;
}
bool WriteBrowserInputState(uint32_t address) {
  std::array<uint8_t,16> v{};
  StoreInputBE32(v.data(),g_input_packet); StoreInputBE16(v.data()+4,BrowserInputButtons());
  v[6]=(g_input_mask&(1u<<4))?0xFFu:0u; v[7]=(g_input_mask&(1u<<5))?0xFFu:0u;
  StoreInputBE16(v.data()+8,uint16_t(int16_t(g_input_lx))); StoreInputBE16(v.data()+10,uint16_t(int16_t(g_input_ly)));
  StoreInputBE16(v.data()+12,uint16_t(int16_t(g_input_rx))); StoreInputBE16(v.data()+14,uint16_t(int16_t(g_input_ry)));
  return WriteSparseGuestMemory(address,v.data(),v.size());
}

uint32_t MakeHandle(uint32_t index, uint16_t generation) {
  return 0x36000000u | (uint32_t(generation) << 8) | (index + 1u);
}

bool DecodeHandle(uint32_t handle, uint32_t* index_out) {
  if ((handle & 0xFF000000u) != 0x36000000u) return false;
  const uint32_t low = handle & 0xFFu;
  if (low == 0 || low > kMaxThreads) return false;
  const uint32_t index = low - 1u;
  const uint16_t generation = uint16_t((handle >> 8) & 0xFFFFu);
  const auto& thread = g_threads[index];
  if (!thread.used || thread.generation != generation) return false;
  if (index_out) *index_out = index;
  return true;
}

GuestThread* LookupThread(uint32_t handle, bool allow_terminated = false) {
  uint32_t index = 0;
  if (!DecodeHandle(handle, &index)) return nullptr;
  auto& thread = g_threads[index];
  if (!allow_terminated && thread.state == kThreadTerminated) return nullptr;
  return &thread;
}

uint32_t ThreadHandleByIndex(uint32_t index) {
  if (index >= kMaxThreads || !g_threads[index].used) return 0;
  return MakeHandle(index, g_threads[index].generation);
}

void ReleaseThreadStack(GuestThread& thread) {
  if (thread.stack_mapped && thread.stack_base && thread.stack_size) {
    const uint32_t pages = thread.stack_size / kGuestPageSize;
    // Sparse memory may already have been reset independently. An absent old
    // mapping is harmless here; a subsequent allocation/map clears that fault.
    UnmapSparseGuestMemory(thread.stack_base, pages);
  }
  thread.stack_mapped = false;
}

bool AllocateThreadStack(uint32_t thread_index, uint32_t stack_size,
                         uint32_t* stack_base_out,
                         uint32_t* stack_top_out) {
  if (thread_index >= kMaxThreads || !stack_size ||
      stack_size > kGuestStackMaxBytes ||
      (stack_size & (kGuestPageSize - 1u))) {
    return false;
  }
  const uint64_t slot64 = uint64_t(kGuestStackArenaBase) +
                          uint64_t(thread_index) * kGuestStackSlotStride;
  const uint64_t base64 = slot64 + kGuestStackGuardBytes;
  const uint64_t end64 = base64 + stack_size;
  const uint64_t upper_guard_end64 = end64 + kGuestStackGuardBytes;
  if (upper_guard_end64 > uint64_t(UINT32_MAX) + 1u ||
      upper_guard_end64 > slot64 + kGuestStackSlotStride) {
    return false;
  }
  const uint32_t stack_base = static_cast<uint32_t>(base64);
  const uint32_t page_count = stack_size / kGuestPageSize;
  const uint32_t backing = AllocateSparseGuestBacking(page_count);
  if (!backing ||
      !MapSparseGuestMemory(stack_base, page_count, backing, 0,
                            kGuestRead | kGuestWrite)) {
    return false;
  }
  uint32_t stack_top = static_cast<uint32_t>(end64) - kGuestStackTopReserve;
  stack_top &= ~0xFu;
  if (stack_top <= stack_base) {
    UnmapSparseGuestMemory(stack_base, page_count);
    return false;
  }
  if (stack_base_out) *stack_base_out = stack_base;
  if (stack_top_out) *stack_top_out = stack_top;
  return true;
}

void ResetRuntime() {
  for (auto& thread : g_threads) {
    ReleaseThreadStack(thread);
    const uint16_t next_generation = uint16_t(thread.generation + 1u);
    thread = {};
    thread.generation = next_generation ? next_generation : 1u;
  }
  g_tls_allocated.fill(false);
  g_current_thread = 0;
  g_scheduler_cursor = 0;
  g_input_mask = 0; g_input_packet = 1; g_input_lx = g_input_ly = g_input_rx = g_input_ry = 0;
  g_runtime_status = kStatusIdle;
}

uint32_t CreateThread(uint32_t entry, uint32_t context, uint32_t stack_size,
                      uint32_t flags) {
  if (!entry) {
    g_runtime_status = kStatusInvalid;
    return 0;
  }
  if (!stack_size) stack_size = kGuestStackDefaultBytes;
  const uint64_t aligned64 =
      (uint64_t(stack_size) + 0x3FFFu) & ~uint64_t(0x3FFFu);
  if (!aligned64 || aligned64 > kGuestStackMaxBytes) {
    g_runtime_status = kStatusInvalid;
    return 0;
  }
  stack_size = static_cast<uint32_t>(aligned64);
  for (uint32_t i = 0; i < kMaxThreads; ++i) {
    if (i == kBrowserMainThreadReservedSlot) continue;
    auto& thread = g_threads[i];
    if (thread.used && thread.state != kThreadTerminated) continue;
    ReleaseThreadStack(thread);
    uint32_t stack_base = 0;
    uint32_t stack_top = 0;
    if (!AllocateThreadStack(i, stack_size, &stack_base, &stack_top)) {
      g_runtime_status = kStatusInvalid;
      return 0;
    }
    uint16_t generation = uint16_t(thread.generation + 1u);
    if (!generation) generation = 1;
    thread = {};
    thread.used = true;
    thread.stack_mapped = true;
    thread.generation = generation;
    thread.state = kThreadReady;
    thread.entry = entry;
    thread.context = context;
    thread.stack_size = stack_size;
    thread.stack_base = stack_base;
    thread.stack_top = stack_top;
    thread.flags = flags;
    const uint32_t handle = MakeHandle(i, generation);
    if (!g_current_thread) {
      g_current_thread = handle;
      thread.state = kThreadRunning;
      g_scheduler_cursor = i;
    }
    g_runtime_status = kStatusSuccess;
    return handle;
  }
  g_runtime_status = kStatusInvalid;
  return 0;
}

bool SetCurrentThread(uint32_t handle) {
  uint32_t new_index = 0;
  if (!DecodeHandle(handle, &new_index)) {
    g_runtime_status = kStatusInvalid;
    return false;
  }
  auto& next = g_threads[new_index];
  if (next.state == kThreadTerminated || next.suspend_count ||
      !next.stack_mapped) {
    g_runtime_status = kStatusInvalid;
    return false;
  }
  uint32_t old_index = 0;
  if (DecodeHandle(g_current_thread, &old_index)) {
    auto& old = g_threads[old_index];
    if (old.state == kThreadRunning) old.state = kThreadReady;
  }
  next.state = kThreadRunning;
  g_current_thread = handle;
  g_scheduler_cursor = new_index;
  g_runtime_status = kStatusSuccess;
  return true;
}

uint32_t SuspendThread(uint32_t handle) {
  auto* thread = LookupThread(handle);
  if (!thread || thread->suspend_count == 0xFFFFFFFFu) {
    g_runtime_status = kStatusInvalid;
    return 0xFFFFFFFFu;
  }
  const uint32_t previous = thread->suspend_count++;
  thread->state = kThreadSuspended;
  if (handle == g_current_thread) g_current_thread = 0;
  g_runtime_status = kStatusSuccess;
  return previous;
}

uint32_t ResumeThread(uint32_t handle) {
  auto* thread = LookupThread(handle);
  if (!thread || !thread->suspend_count || !thread->stack_mapped) {
    g_runtime_status = kStatusInvalid;
    return 0xFFFFFFFFu;
  }
  const uint32_t previous = thread->suspend_count--;
  if (!thread->suspend_count) thread->state = kThreadReady;
  g_runtime_status = kStatusSuccess;
  return previous;
}

bool TerminateThread(uint32_t handle, uint32_t exit_code) {
  auto* thread = LookupThread(handle);
  if (!thread) {
    g_runtime_status = kStatusInvalid;
    return false;
  }
  thread->state = kThreadTerminated;
  thread->exit_code = exit_code;
  thread->suspend_count = 0;
  ReleaseThreadStack(*thread);
  if (handle == g_current_thread) g_current_thread = 0;
  g_runtime_status = kStatusSuccess;
  return true;
}

uint32_t NextRunnable() {
  for (uint32_t step = 1; step <= kMaxThreads; ++step) {
    const uint32_t index = (g_scheduler_cursor + step) % kMaxThreads;
    auto& thread = g_threads[index];
    if (!thread.used || thread.state == kThreadTerminated ||
        thread.suspend_count || !thread.stack_mapped) {
      continue;
    }
    const uint32_t handle = ThreadHandleByIndex(index);
    if (SetCurrentThread(handle)) return handle;
  }
  g_runtime_status = kStatusInvalid;
  return 0;
}

uint32_t TlsAlloc() {
  for (uint32_t i = 0; i < kMaxTlsSlots; ++i) {
    if (g_tls_allocated[i]) continue;
    g_tls_allocated[i] = true;
    for (auto& thread : g_threads) thread.tls[i] = 0;
    g_runtime_status = kStatusSuccess;
    return i;
  }
  g_runtime_status = kStatusInvalid;
  return kTlsOutOfIndexes;
}

bool TlsFree(uint32_t slot) {
  if (slot >= kMaxTlsSlots || !g_tls_allocated[slot]) {
    g_runtime_status = kStatusInvalid;
    return false;
  }
  g_tls_allocated[slot] = false;
  for (auto& thread : g_threads) thread.tls[slot] = 0;
  g_runtime_status = kStatusSuccess;
  return true;
}

bool TlsSet(uint32_t handle, uint32_t slot, uint32_t value) {
  auto* thread = LookupThread(handle);
  if (!thread || slot >= kMaxTlsSlots || !g_tls_allocated[slot]) {
    g_runtime_status = kStatusInvalid;
    return false;
  }
  thread->tls[slot] = value;
  g_runtime_status = kStatusSuccess;
  return true;
}

uint32_t TlsGet(uint32_t handle, uint32_t slot) {
  auto* thread = LookupThread(handle);
  if (!thread || slot >= kMaxTlsSlots || !g_tls_allocated[slot]) {
    g_runtime_status = kStatusInvalid;
    return 0;
  }
  g_runtime_status = kStatusSuccess;
  return thread->tls[slot];
}

uint32_t ServiceCall(uint32_t module, uint32_t ordinal,
                     uint32_t r3, uint32_t r4, uint32_t r5, uint32_t r6,
                     uint32_t, uint32_t, uint32_t, uint32_t) {
  ++g_service_calls;
  g_last_module = module;
  g_last_ordinal = ordinal;
  g_service_status = kStatusSuccess;

  if (module == kModuleXboxkrnl) {
    switch (ordinal) {
      case 0x0083:  // KeQueryPerformanceFrequency
        return kGuestTickFrequency;
      case 0x0132: {  // RtlLowerChar
        const uint32_t c = r3 & 0xFFu;
        return c >= 'A' && c <= 'Z' ? (c ^ 0x20u) : c;
      }
      case 0x014A: {  // RtlUpperChar
        const uint32_t c = r3 & 0xFFu;
        return c >= 'a' && c <= 'z' ? (c ^ 0x20u) : c;
      }
      case 0x0152: {  // KeTlsAlloc
        const uint32_t slot = TlsAlloc();
        if (g_runtime_status != kStatusSuccess) g_service_status = kStatusInvalid;
        return slot;
      }
      case 0x0153: {  // KeTlsFree
        const bool ok = TlsFree(r3);
        if (!ok) g_service_status = kStatusInvalid;
        return ok ? 1u : 0u;
      }
      case 0x0154: {  // KeTlsGetValue
        if (!g_current_thread) {
          g_service_status = kStatusInvalid;
          return 0;
        }
        const uint32_t value = TlsGet(g_current_thread, r3);
        if (g_runtime_status != kStatusSuccess) g_service_status = kStatusInvalid;
        return value;
      }
      case 0x0155: {  // KeTlsSetValue
        if (!g_current_thread) {
          g_service_status = kStatusInvalid;
          return 0;
        }
        const bool ok = TlsSet(g_current_thread, r3, r4);
        if (!ok) g_service_status = kStatusInvalid;
        return ok ? 1u : 0u;
      }
      default:
        g_service_status = kStatusUnsupported;
        return 0;
    }
  }

  if (module == kModuleXam) {
    switch (ordinal) {
      case 0x0190: {  // XamInputGetCapabilities
        if(!r5){g_service_status=kStatusInvalid;return 87u;}
        std::array<uint8_t,20> caps{}; caps[0]=1u; caps[1]=1u;
        if(!WriteSparseGuestMemory(r5,caps.data(),caps.size())){g_service_status=kStatusInvalid;return 87u;}
        return 0u;
      }
      case 0x0191: {  // XamInputGetState
        if(!r5) return 0u;
        if(!WriteBrowserInputState(r5)){g_service_status=kStatusInvalid;return 87u;}
        return 0u;
      }
      case 0x0192:  // XamInputSetState - vibration ignored for browser touch input.
        return 0u;
      case 0x028A: {  // XamNotifyCreateListener
        // Xenia returns a kernel object handle. The browser runtime does not
        // yet need queued dashboard notifications during title startup, but it
        // must return a stable non-zero listener handle so titles can poll it.
        const uint32_t handle = g_next_notify_handle++;
        if (!g_next_notify_handle) g_next_notify_handle = 0x37000001u;
        return handle;
      }
      case 0x028B: {  // XNotifyGetNext
        // Match Xenia's empty-queue behavior: zero optional param first, require
        // an id pointer for output, zero id, then report no dequeued event.
        // Guest pointers are Xbox virtual addresses, so use sparse guest memory
        // and preserve big-endian dword representation.
        const uint32_t zero = 0;
        if (r6 && !WriteSparseGuestMemory(r6, &zero, sizeof(zero))) {
          g_service_status = kStatusInvalid;
          return 0;
        }
        if (!r5) return 0;
        if (!WriteSparseGuestMemory(r5, &zero, sizeof(zero))) {
          g_service_status = kStatusInvalid;
          return 0;
        }
        return 0;
      }
      case 0x028C:  // XNotifyPositionUI - ignored by Xenia.
      case 0x028D:  // XNotifyDelayUI - ignored by Xenia.
        return 0;
      case 0x03CD:  // XGetLanguage - XLanguage::kEnglish in Xenia default path.
        return 1u;
      default:
        g_service_status = kStatusUnsupported;
        return 0;
    }
  }

  g_service_status = kStatusUnsupported;
  return 0;
}

}  // namespace
}  // namespace render360::xenia_web

extern "C" {

void r360_kernel_runtime_reset() {
  render360::xenia_web::ResetRuntime();
}

uint32_t r360_guest_thread_create(uint32_t entry, uint32_t context,
                                  uint32_t stack_size, uint32_t flags) {
  return render360::xenia_web::CreateThread(entry, context, stack_size, flags);
}
uint32_t r360_guest_thread_current() {
  return render360::xenia_web::g_current_thread;
}
uint32_t r360_guest_thread_set_current(uint32_t handle) {
  return render360::xenia_web::SetCurrentThread(handle) ? 1u : 0u;
}
uint32_t r360_guest_thread_suspend(uint32_t handle) {
  return render360::xenia_web::SuspendThread(handle);
}
uint32_t r360_guest_thread_resume(uint32_t handle) {
  return render360::xenia_web::ResumeThread(handle);
}
uint32_t r360_guest_thread_terminate(uint32_t handle, uint32_t exit_code) {
  return render360::xenia_web::TerminateThread(handle, exit_code) ? 1u : 0u;
}
uint32_t r360_guest_thread_next_runnable() {
  return render360::xenia_web::NextRunnable();
}
uint32_t r360_guest_thread_state(uint32_t handle) {
  auto* thread = render360::xenia_web::LookupThread(handle, true);
  return thread ? uint32_t(thread->state) : 0u;
}
uint32_t r360_guest_thread_exit_code(uint32_t handle) {
  auto* thread = render360::xenia_web::LookupThread(handle, true);
  return thread ? thread->exit_code : 0u;
}
R360_WASM_EXPORT("r360_guest_thread_entry")
uint32_t r360_guest_thread_entry(uint32_t handle) {
  auto* thread = render360::xenia_web::LookupThread(handle, true);
  return thread ? thread->entry : 0u;
}
R360_WASM_EXPORT("r360_guest_thread_context")
uint32_t r360_guest_thread_context(uint32_t handle) {
  auto* thread = render360::xenia_web::LookupThread(handle, true);
  return thread ? thread->context : 0u;
}
R360_WASM_EXPORT("r360_guest_thread_flags")
uint32_t r360_guest_thread_flags(uint32_t handle) {
  auto* thread = render360::xenia_web::LookupThread(handle, true);
  return thread ? thread->flags : 0u;
}
uint32_t r360_guest_thread_stack_size(uint32_t handle) {
  auto* thread = render360::xenia_web::LookupThread(handle, true);
  return thread ? thread->stack_size : 0u;
}
R360_WASM_EXPORT("r360_guest_thread_stack_base")
uint32_t r360_guest_thread_stack_base(uint32_t handle) {
  auto* thread = render360::xenia_web::LookupThread(handle, true);
  return thread ? thread->stack_base : 0u;
}
R360_WASM_EXPORT("r360_guest_thread_stack_top")
uint32_t r360_guest_thread_stack_top(uint32_t handle) {
  auto* thread = render360::xenia_web::LookupThread(handle, true);
  return thread ? thread->stack_top : 0u;
}
R360_WASM_EXPORT("r360_guest_thread_stack_mapped")
uint32_t r360_guest_thread_stack_mapped(uint32_t handle) {
  auto* thread = render360::xenia_web::LookupThread(handle, true);
  return thread && thread->stack_mapped ? 1u : 0u;
}
uint32_t r360_guest_runtime_status() {
  return render360::xenia_web::g_runtime_status;
}

uint32_t r360_guest_tls_alloc() { return render360::xenia_web::TlsAlloc(); }
uint32_t r360_guest_tls_free(uint32_t slot) {
  return render360::xenia_web::TlsFree(slot) ? 1u : 0u;
}
uint32_t r360_guest_tls_set(uint32_t handle, uint32_t slot, uint32_t value) {
  return render360::xenia_web::TlsSet(handle, slot, value) ? 1u : 0u;
}
uint32_t r360_guest_tls_get(uint32_t handle, uint32_t slot) {
  return render360::xenia_web::TlsGet(handle, slot);
}

R360_WASM_EXPORT("r360_kernel_input_set_mask")
void r360_kernel_input_set_mask(uint32_t mask) {
  if(render360::xenia_web::g_input_mask!=mask){render360::xenia_web::g_input_mask=mask;++render360::xenia_web::g_input_packet;if(!render360::xenia_web::g_input_packet)render360::xenia_web::g_input_packet=1;}
}
R360_WASM_EXPORT("r360_kernel_input_set_analog")
void r360_kernel_input_set_analog(int32_t lx,int32_t ly,int32_t rx,int32_t ry) {
  auto c=[](int32_t v){return v<-32768?-32768:(v>32767?32767:v);}; lx=c(lx);ly=c(ly);rx=c(rx);ry=c(ry);
  if(render360::xenia_web::g_input_lx!=lx||render360::xenia_web::g_input_ly!=ly||render360::xenia_web::g_input_rx!=rx||render360::xenia_web::g_input_ry!=ry){render360::xenia_web::g_input_lx=lx;render360::xenia_web::g_input_ly=ly;render360::xenia_web::g_input_rx=rx;render360::xenia_web::g_input_ry=ry;++render360::xenia_web::g_input_packet;if(!render360::xenia_web::g_input_packet)render360::xenia_web::g_input_packet=1;}
}
R360_WASM_EXPORT("r360_kernel_input_mask")
uint32_t r360_kernel_input_mask(){return render360::xenia_web::g_input_mask;}

void r360_kernel_service_reset() {
  render360::xenia_web::g_service_status = render360::xenia_web::kStatusIdle;
  render360::xenia_web::g_service_calls = 0;
  render360::xenia_web::g_last_module = 0;
  render360::xenia_web::g_last_ordinal = 0;
}
uint32_t r360_kernel_service_call(uint32_t module, uint32_t ordinal,
                                  uint32_t r3, uint32_t r4, uint32_t r5,
                                  uint32_t r6, uint32_t r7, uint32_t r8,
                                  uint32_t r9, uint32_t r10) {
  return render360::xenia_web::ServiceCall(module, ordinal, r3, r4, r5, r6,
                                           r7, r8, r9, r10);
}
uint32_t r360_kernel_service_status() {
  return render360::xenia_web::g_service_status;
}
uint32_t r360_kernel_service_calls() {
  return render360::xenia_web::g_service_calls;
}
uint32_t r360_kernel_service_last_module() {
  return render360::xenia_web::g_last_module;
}
uint32_t r360_kernel_service_last_ordinal() {
  return render360::xenia_web::g_last_ordinal;
}

}  // extern "C"
