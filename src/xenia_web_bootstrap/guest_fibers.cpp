#include "guest_fibers.h"

#include <cstdlib>
#include <cstring>
#include <vector>

#include "hir_correctness_executor.h"
#include "kernel_xboxkrnl_services.h"

#if defined(__wasm__)
// Binaryen Asyncify (applied by link-xenia-ppc-bootstrap.sh) turns these
// "asyncify" imports into calls to its own state machine.
extern "C" void r360_asyncify_start_unwind(void* data)
    __attribute__((import_module("asyncify"), import_name("start_unwind")));
extern "C" void r360_asyncify_stop_rewind()
    __attribute__((import_module("asyncify"), import_name("stop_rewind")));
extern "C" uintptr_t emscripten_stack_get_current(void);
extern "C" char __stack_low;
// The R360_FIBER_LOCAL section bounds (wasm-ld start/stop symbols).
extern "C" char __start_r360_fiber[];
extern "C" char __stop_r360_fiber[];
#endif

extern "C" {
uint32_t r360_guest_thread_current();
uint32_t r360_guest_thread_set_current(uint32_t handle);
uint32_t r360_guest_thread_runnable_list(uint32_t* out, uint32_t capacity);
uint32_t r360_guest_thread_entry(uint32_t handle);
uint32_t r360_guest_thread_context(uint32_t handle);
uint32_t r360_guest_thread_stack_top(uint32_t handle);
uint32_t r360_guest_thread_pcr(uint32_t handle);
uint32_t r360_guest_thread_arg1(uint32_t handle);
uint32_t r360_ppc_probe_page_sparse_code(uint32_t target_address);
uint32_t r360_ppc_probe_translate_scanned_at(uint32_t address);
uint32_t r360_ppc_probe_correctness_status();
}

namespace render360::xenia_web {
namespace {

// Xenia Processor::Execute's return sentinel: a guest thread's entry function
// returns to it.
constexpr uint64_t kThreadReturnSentinel = 0xBCBCBCBCull;
constexpr uint32_t kFiberCStackBytes = 2u * 1024u * 1024u;
constexpr uint32_t kFiberAsyncifyBytes = 4u * 1024u * 1024u;
constexpr uint32_t kMaxFibers = 32;

enum FiberState : uint32_t {
  kFiberNew = 0,      // created by the title, never run
  kFiberRunning = 1,
  kFiberReady = 2,    // yielded voluntarily
  kFiberBlocked = 3,  // yielded from a failed wait
  kFiberDone = 4,
};

struct Fiber {
  uint32_t thread = 0;  // native guest thread handle
  FiberState state = kFiberNew;
  uint64_t progress_mark = 0;
  std::vector<uint8_t> locals;
  uint8_t* c_stack = nullptr;    // null for the title's primary thread
  uint8_t* asyncify = nullptr;   // {current, end} header followed by data
  uintptr_t sp = 0;
};

std::vector<Fiber> g_fibers;  // [0] = the title's primary thread
std::vector<uint8_t> g_pristine_locals;
uint32_t g_current = 0;
uint32_t g_target = 0;
bool g_enabled = false;
bool g_switch_pending = false;
bool g_rewinding = false;
bool g_force_fail = false;
uint64_t g_progress = 0;
uint32_t g_switches = 0;
uintptr_t g_stack_low = 0;
bool g_in_interrupt = false;

size_t LocalsSize() {
#if defined(__wasm__)
  return size_t(__stop_r360_fiber - __start_r360_fiber);
#else
  return 0;
#endif
}
void SaveLocals(Fiber& fiber) {
#if defined(__wasm__)
  fiber.locals.assign(__start_r360_fiber, __stop_r360_fiber);
#endif
}
void RestoreLocals(const Fiber& fiber) {
#if defined(__wasm__)
  const auto& image = fiber.locals.empty() ? g_pristine_locals : fiber.locals;
  if (image.size() == LocalsSize()) {
    std::memcpy(__start_r360_fiber, image.data(), image.size());
  }
#endif
}

void ReleaseFibers() {
  for (auto& fiber : g_fibers) {
    std::free(fiber.c_stack);
    std::free(fiber.asyncify);
  }
  g_fibers.clear();
}

bool Eligible(const Fiber& fiber) {
  switch (fiber.state) {
    case kFiberNew:
    case kFiberReady:
      return true;
    case kFiberBlocked:
      return fiber.progress_mark != g_progress;
    default:
      return false;
  }
}

// Adds fibers for guest threads the title created since the last switch and
// retires fibers whose thread was terminated or suspended meanwhile.
void SyncFibersWithThreads() {
  uint32_t handles[kMaxFibers] = {};
  const uint32_t count = r360_guest_thread_runnable_list(handles, kMaxFibers);
  for (size_t i = 1; i < g_fibers.size(); ++i) {
    bool runnable = false;
    for (uint32_t k = 0; k < count; ++k) runnable |= handles[k] == g_fibers[i].thread;
    if (!runnable && g_fibers[i].state != kFiberRunning) {
      // A suspended thread keeps its fiber; a terminated one is done.
      if (g_fibers[i].state == kFiberNew || g_fibers[i].state == kFiberDone) {
        g_fibers[i].state = kFiberDone;
      }
    }
  }
  for (uint32_t k = 0; k < count && g_fibers.size() < kMaxFibers; ++k) {
    bool known = false;
    for (const auto& fiber : g_fibers) known |= fiber.thread == handles[k];
    if (known) continue;
    Fiber fiber;
    fiber.thread = handles[k];
    g_fibers.push_back(std::move(fiber));
  }
}

bool ThreadRunnable(uint32_t handle) {
  uint32_t handles[kMaxFibers] = {};
  const uint32_t count = r360_guest_thread_runnable_list(handles, kMaxFibers);
  for (uint32_t k = 0; k < count; ++k) {
    if (handles[k] == handle) return true;
  }
  return false;
}

// Round-robin choice of the next fiber after `from` that can make progress.
bool PickTarget(uint32_t from, uint32_t* target) {
  SyncFibersWithThreads();
  const uint32_t n = uint32_t(g_fibers.size());
  for (uint32_t step = 1; step <= n; ++step) {
    const uint32_t index = (from + step) % n;
    if (index == from) continue;
    const Fiber& fiber = g_fibers[index];
    if (!Eligible(fiber)) continue;
    if (index != 0 && !ThreadRunnable(fiber.thread)) continue;
    *target = index;
    return true;
  }
  return false;
}

bool EnsureFiberMemory(Fiber& fiber, bool needs_stack) {
  if (!fiber.asyncify) {
    fiber.asyncify = static_cast<uint8_t*>(std::malloc(kFiberAsyncifyBytes));
    if (!fiber.asyncify) return false;
  }
  if (needs_stack && !fiber.c_stack) {
    fiber.c_stack = static_cast<uint8_t*>(std::malloc(kFiberCStackBytes));
    if (!fiber.c_stack) return false;
  }
  return true;
}

void ArmAsyncifyBuffer(Fiber& fiber) {
  auto* header = reinterpret_cast<uint32_t*>(fiber.asyncify);
  header[0] = static_cast<uint32_t>(reinterpret_cast<uintptr_t>(fiber.asyncify + 8));
  header[1] = static_cast<uint32_t>(reinterpret_cast<uintptr_t>(fiber.asyncify + kFiberAsyncifyBytes));
}

// Leaves the current fiber for `target`: snapshot its state and unwind the
// wasm stack back to the JS driver, which then starts or rewinds the target.
void SwitchTo(uint32_t target, FiberState leaving_state) {
#if defined(__wasm__)
  Fiber& current = g_fibers[g_current];
  current.state = leaving_state;
  current.progress_mark = g_progress;
  SaveLocals(current);
  current.sp = emscripten_stack_get_current();
  ArmAsyncifyBuffer(current);
  g_target = target;
  g_switch_pending = true;
  ++g_switches;
  r360_asyncify_start_unwind(current.asyncify);
#else
  (void)target;
  (void)leaving_state;
#endif
}

}  // namespace

bool GuestFibersActive() { return g_enabled; }

void GuestFiberNoteProgress() { ++g_progress; }

uintptr_t GuestFiberStackLow() {
#if defined(__wasm__)
  return g_stack_low ? g_stack_low : reinterpret_cast<uintptr_t>(&__stack_low);
#else
  return 0;
#endif
}

bool GuestFiberYield(bool blocked) {
#if defined(__wasm__)
  if (g_rewinding) {
    // Resumed: the driver restored this fiber's state and rewound into here.
    g_rewinding = false;
    r360_asyncify_stop_rewind();
    if (g_force_fail) {
      g_force_fail = false;
      return false;
    }
    return true;
  }
  if (!g_enabled || g_in_interrupt || g_current >= g_fibers.size()) return false;
  uint32_t target = 0;
  if (!PickTarget(g_current, &target)) return false;
  Fiber& next = g_fibers[target];
  if (!EnsureFiberMemory(g_fibers[g_current], false) ||
      !EnsureFiberMemory(next, target != 0)) {
    return false;
  }
  SwitchTo(target, blocked ? kFiberBlocked : kFiberReady);
  return false;  // unwinding; the value is not observed
#else
  (void)blocked;
  return false;
#endif
}

bool GuestInterruptActive() { return g_in_interrupt; }

bool RunGuestInterrupt(uint32_t address, uint32_t r3, uint32_t r4,
                       uint32_t stack_top, uint32_t pcr) {
#if defined(__wasm__)
  if (!g_enabled || g_in_interrupt || g_pristine_locals.size() != LocalsSize() ||
      !address || !stack_top) {
    return false;
  }
  g_in_interrupt = true;
  std::vector<uint8_t> interrupted(__start_r360_fiber, __stop_r360_fiber);
  std::memcpy(__start_r360_fiber, g_pristine_locals.data(), g_pristine_locals.size());
  ResetHIRCorrectnessInitialState();
  ClearHIRCorrectnessInitialRegisterStrings();
  SetHIRCorrectnessInitialGPR(1, stack_top);
  SetHIRCorrectnessInitialGPR(3, r3);
  SetHIRCorrectnessInitialGPR(4, r4);
  SetHIRCorrectnessInitialGPR(13, pcr);
  SetHIRCorrectnessInitialLR(kThreadReturnSentinel);
  bool ok = false;
  if (r360_ppc_probe_page_sparse_code(address)) {
    ok = r360_ppc_probe_translate_scanned_at(address) != 0 &&
         r360_ppc_probe_correctness_status() == 3u;
  }
  std::memcpy(__start_r360_fiber, interrupted.data(), interrupted.size());
  g_in_interrupt = false;
  return ok;
#else
  (void)address; (void)r3; (void)r4; (void)stack_top; (void)pcr;
  return false;
#endif
}

}  // namespace render360::xenia_web

namespace rx = render360::xenia_web;

extern "C" {

// enable=1 starts fiber scheduling for a title run (the caller is about to
// enter the primary thread); enable=0 ends it and frees fiber memory.
uint32_t r360_fiber_reset(uint32_t enable) {
  rx::ReleaseFibers();
  rx::g_current = 0;
  rx::g_target = 0;
  rx::g_switch_pending = false;
  rx::g_rewinding = false;
  rx::g_force_fail = false;
  rx::g_progress = 0;
  rx::g_switches = 0;
  rx::g_stack_low = 0;
  rx::g_enabled = enable != 0;
  if (!rx::g_enabled) return 0;
#if defined(__wasm__)
  rx::g_pristine_locals.assign(__start_r360_fiber, __stop_r360_fiber);
#endif
  rx::Fiber primary;
  primary.thread = r360_guest_thread_current();
  primary.state = rx::kFiberRunning;
  rx::g_fibers.push_back(std::move(primary));
  return uint32_t(rx::LocalsSize());
}

uint32_t r360_fiber_current() { return rx::g_current; }
uint32_t r360_fiber_count() { return uint32_t(rx::g_fibers.size()); }
uint32_t r360_fiber_switches() { return rx::g_switches; }
uint32_t r360_fiber_switch_pending() { return rx::g_switch_pending ? 1u : 0u; }
uint32_t r360_fiber_thread(uint32_t index) {
  return index < rx::g_fibers.size() ? rx::g_fibers[index].thread : 0u;
}
uint32_t r360_fiber_state(uint32_t index) {
  return index < rx::g_fibers.size() ? uint32_t(rx::g_fibers[index].state) : 0xFFFFFFFFu;
}

// Applies the pending switch after the driver stopped the unwind. Returns 1
// when the target starts fresh (call r360_fiber_entry), 2 when it must be
// rewound (asyncify_start_rewind(r360_fiber_asyncify_data()) and re-enter its
// root), 0 when nothing is pending.
uint32_t r360_fiber_prepare() {
  if (!rx::g_switch_pending || rx::g_target >= rx::g_fibers.size()) return 0;
  rx::g_switch_pending = false;
  rx::g_current = rx::g_target;
  rx::Fiber& fiber = rx::g_fibers[rx::g_current];
  const bool fresh = fiber.state == rx::kFiberNew;
  rx::RestoreLocals(fiber);
  if (fiber.thread) r360_guest_thread_set_current(fiber.thread);
  rx::g_stack_low = fiber.c_stack ? reinterpret_cast<uintptr_t>(fiber.c_stack) : 0;
  fiber.state = rx::kFiberRunning;
  rx::g_rewinding = !fresh;
  return fresh ? 1u : 2u;
}

// Stack pointer the driver installs (_emscripten_stack_restore) before it
// enters the current fiber.
uint32_t r360_fiber_stack_pointer() {
  if (rx::g_current >= rx::g_fibers.size()) return 0;
  const rx::Fiber& fiber = rx::g_fibers[rx::g_current];
  if (!rx::g_rewinding && fiber.c_stack) {
    return uint32_t(reinterpret_cast<uintptr_t>(fiber.c_stack) + rx::kFiberCStackBytes) & ~15u;
  }
  return uint32_t(fiber.sp);
}

uint32_t r360_fiber_asyncify_data() {
  if (rx::g_current >= rx::g_fibers.size()) return 0;
  return uint32_t(reinterpret_cast<uintptr_t>(rx::g_fibers[rx::g_current].asyncify));
}

// Root of a title-created guest thread: runs its entry function through the
// same scanned-translation path as the title entry. When the thread finishes
// the next fiber is queued; a thread that stopped on a blocker ends the run.
uint32_t r360_fiber_entry() {
  if (rx::g_current == 0 || rx::g_current >= rx::g_fibers.size()) return 0;
  const uint32_t handle = rx::g_fibers[rx::g_current].thread;
  const uint32_t entry = r360_guest_thread_entry(handle);
  rx::ResetHIRCorrectnessInitialState();
  rx::ClearHIRCorrectnessInitialRegisterStrings();
  rx::SetHIRCorrectnessInitialGPR(1, r360_guest_thread_stack_top(handle));
  rx::SetHIRCorrectnessInitialGPR(3, r360_guest_thread_context(handle));
  rx::SetHIRCorrectnessInitialGPR(4, r360_guest_thread_arg1(handle));
  rx::SetHIRCorrectnessInitialGPR(13, r360_guest_thread_pcr(handle));
  rx::SetHIRCorrectnessInitialLR(rx::kThreadReturnSentinel);
  uint32_t hir = 0;
  if (r360_ppc_probe_page_sparse_code(entry)) {
    hir = r360_ppc_probe_translate_scanned_at(entry);
  }
  rx::Fiber& fiber = rx::g_fibers[rx::g_current];
  // Status 3: the entry returned to the sentinel (the thread exited).
  const bool returned = hir && r360_ppc_probe_correctness_status() == 3u;
  const bool exited = rx::FinishGuestThreadFiber(
      handle, returned, uint32_t(rx::GetHIRCorrectnessLastGPR(3)));
  if (!exited) return hir ? hir : 1u;  // stopped on a blocker: end the run
  fiber.state = rx::kFiberDone;
  rx::GuestFiberNoteProgress();
  uint32_t target = 0;
  if (!rx::PickTarget(rx::g_current, &target)) {
    // Nothing else can run: resume the primary thread so its pending wait
    // reports the deadlock through the normal would-block path.
    target = 0;
    rx::g_force_fail = rx::g_fibers[0].state == rx::kFiberBlocked ||
                       rx::g_fibers[0].state == rx::kFiberReady;
    if (!rx::g_force_fail) return hir ? hir : 1u;
  }
  rx::g_target = target;
  rx::g_switch_pending = true;
  ++rx::g_switches;
  return hir ? hir : 1u;
}

}  // extern "C"
