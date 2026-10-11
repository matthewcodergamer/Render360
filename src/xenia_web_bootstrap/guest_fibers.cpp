#include "guest_fibers.h"

#include <cstdlib>
#include <ctime>
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
uint32_t r360_kernel_import_last_module();
uint32_t r360_kernel_import_last_ordinal();
}

namespace render360::xenia_web {
namespace {

// Xenia Processor::Execute's return sentinel: a guest thread's entry function
// returns to it.
constexpr uint64_t kThreadReturnSentinel = 0xBCBCBCBCull;
constexpr uint32_t kFiberCStackBytes = 2u * 1024u * 1024u;
constexpr uint32_t kFiberAsyncifyBytes = 4u * 1024u * 1024u;
constexpr uint32_t kMaxFibers = 32;
// Xenia runs every guest thread on its own host thread, so they all advance
// together. The fibers share one host thread: a guest thread that never
// blocks (a frame loop polling a loader thread's progress) is preempted at a
// guest call boundary after this many HIR instructions when another guest
// thread can run.
constexpr uint64_t kPreemptQuantum = 2000000ull;

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
  uint32_t resumes = 0;       // diagnostics: times scheduled
  uint32_t leave_kind = 0;    // diagnostics: 1 blocked, 2 yield, 3 preempt, 4 host
  uint32_t leave_call = 0;    // diagnostics: module<<16|ordinal of the last kernel call
  uint32_t leave_counts[5] = {};
  uint32_t leave_pc = 0;      // diagnostics: guest address when it left
  uint64_t instructions = 0;  // diagnostics: HIR instructions run
  uint64_t vruntime = 0;      // fair-share clock (instructions, clamped on wake)
  // Guest-clock deadline (GuestClockNanoseconds) of a timed wait or sleep;
  // 0 = none. A blocked fiber is runnable again once it passes.
  uint64_t wake_ns = 0;
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
uint64_t g_host_slice_deadline_ms = 0;  // 0 = no browser time slicing
bool g_host_yield = false;
uint32_t g_host_yields = 0;
uint64_t g_quantum_start = 0;
uint64_t g_run_start = 0;
uint32_t g_preemptions = 0;

uint64_t HostMillis() {
  struct timespec ts {};
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return uint64_t(ts.tv_sec) * 1000ull + uint64_t(ts.tv_nsec) / 1000000ull;
}

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
      return fiber.progress_mark != g_progress ||
             (fiber.wake_ns && GuestClockNanoseconds() >= fiber.wake_ns);
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

// Fair-share choice of the next fiber that can make progress: the one that
// has run the fewest instructions (ties in round-robin order after `from`).
// Xenia gives every guest thread its own host thread, so a thread that wakes
// from a wait runs at once instead of after every other runnable thread's
// quantum; least-run-first approximates that on one host thread. A fiber's
// count is raised to within one quantum of the leaving fiber's when it is
// picked, so a long sleeper does not monopolise the host afterwards.
bool PickTarget(uint32_t from, uint32_t* target, bool preempting = false) {
  SyncFibersWithThreads();
  const uint32_t n = uint32_t(g_fibers.size());
  // The running fiber's count includes its current run.
  const uint64_t from_count =
      from >= n ? 0
                : g_fibers[from].vruntime +
                      (from == g_current ? HIRTotalInstructions() - g_run_start : 0);
  bool found = false;
  uint32_t best = 0;
  for (uint32_t step = 1; step <= n; ++step) {
    const uint32_t index = (from + step) % n;
    if (index == from) continue;
    const Fiber& fiber = g_fibers[index];
    if (!Eligible(fiber)) continue;
    if (index != 0 && !ThreadRunnable(fiber.thread)) continue;
    if (!found || fiber.vruntime < g_fibers[best].vruntime) best = index;
    found = true;
  }
  if (!found) return false;
  // A preempted fiber keeps running while it is still the least-run one.
  if (preempting && g_fibers[best].vruntime >= from_count) return false;
  if (from < n) {
    const uint64_t floor = from_count > kPreemptQuantum ? from_count - kPreemptQuantum : 0;
    if (g_fibers[best].vruntime < floor) g_fibers[best].vruntime = floor;
  }
  *target = best;
  return true;
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
void SwitchTo(uint32_t target, FiberState leaving_state, uint32_t kind) {
#if defined(__wasm__)
  Fiber& current = g_fibers[g_current];
  current.leave_kind = kind;
  if (kind < 5) ++current.leave_counts[kind];
  current.leave_pc = HIRLastSourceAddress();
  current.leave_call = (r360_kernel_import_last_module() << 16) |
                       (r360_kernel_import_last_ordinal() & 0xFFFFu);
  current.instructions += HIRTotalInstructions() - g_run_start;
  current.vruntime += HIRTotalInstructions() - g_run_start;
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
  (void)kind;
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
  SwitchTo(target, blocked ? kFiberBlocked : kFiberReady, blocked ? 1u : 2u);
  return false;  // unwinding; the value is not observed
#else
  (void)blocked;
  return false;
#endif
}

bool GuestInterruptActive() { return g_in_interrupt; }

// Xenia blocks a sleeping or timed-waiting XThread on a host wait until its
// deadline; here the fiber blocks with a guest-clock deadline and another
// fiber runs. Returns true when resumed (the caller re-checks its condition),
// false when no other fiber can run now (the caller idles: GuestFiberIdle).
bool GuestFiberSleepUntil(uint64_t deadline_ns) {
#if defined(__wasm__)
  if (g_rewinding) {
    g_rewinding = false;
    r360_asyncify_stop_rewind();
    if (g_force_fail) {
      g_force_fail = false;
      return false;
    }
    if (g_current < g_fibers.size()) g_fibers[g_current].wake_ns = 0;
    return true;
  }
  if (!g_enabled || g_in_interrupt || g_current >= g_fibers.size()) return false;
  g_fibers[g_current].wake_ns = deadline_ns;
  uint32_t target = 0;
  if (!PickTarget(g_current, &target) || !EnsureFiberMemory(g_fibers[g_current], false) ||
      !EnsureFiberMemory(g_fibers[target], target != 0)) {
    g_fibers[g_current].wake_ns = 0;
    return false;
  }
  SwitchTo(target, kFiberBlocked, 1u);
  return false;  // unwinding; the value is not observed
#else
  (void)deadline_ns;
  return false;
#endif
}

// Nothing else can run before `deadline_ns`: the CPU idles. The guest clock
// moves on (deterministic clock: skipped ahead; host clock: waited out) in
// steps no longer than a vblank period, delivering the interrupts that fall
// in between (their handlers may wake a thread). Returns false if idling is
// not possible here.
bool GuestFiberIdle(uint64_t deadline_ns) {
  if (!g_enabled || g_in_interrupt) return false;
  const uint64_t now = GuestClockNanoseconds();
  if (now >= deadline_ns) return true;
  uint64_t until = deadline_ns;
  // Another sleeper may be due earlier.
  for (const auto& fiber : g_fibers) {
    if (fiber.state == kFiberBlocked && fiber.wake_ns && fiber.wake_ns < until) until = fiber.wake_ns;
  }
  constexpr uint64_t kMaxIdleStepNs = 4000000ull;  // 4 ms
  if (until > now + kMaxIdleStepNs) until = now + kMaxIdleStepNs;
  if (!GuestClockIdleUntil(until)) return false;
  DeliverGuestInterruptsNow();
  return true;
}

void GuestFiberHostYieldIfDue() {
#if defined(__wasm__)
  if (g_rewinding) {
    // Resumed after the page got its turn.
    g_rewinding = false;
    g_force_fail = false;
    r360_asyncify_stop_rewind();
    return;
  }
  if (g_enabled && !g_in_interrupt && g_fibers.size() > 1 &&
      g_current < g_fibers.size() &&
      HIRTotalInstructions() - g_quantum_start >= kPreemptQuantum) {
    g_quantum_start = HIRTotalInstructions();
    uint32_t target = 0;
    if (PickTarget(g_current, &target, true) &&
        EnsureFiberMemory(g_fibers[g_current], false) &&
        EnsureFiberMemory(g_fibers[target], target != 0)) {
      ++g_preemptions;
      SwitchTo(target, kFiberReady, 3u);
      return;
    }
  }
  if (!g_enabled || g_in_interrupt || !g_host_slice_deadline_ms ||
      g_current >= g_fibers.size() || HostMillis() < g_host_slice_deadline_ms) {
    return;
  }
  if (!EnsureFiberMemory(g_fibers[g_current], false)) return;
  g_host_yield = true;
  ++g_host_yields;
  SwitchTo(g_current, kFiberReady, 4u);
#endif
}

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
  rx::g_host_slice_deadline_ms = 0;
  rx::g_host_yield = false;
  rx::g_host_yields = 0;
  rx::g_quantum_start = rx::g_run_start = rx::HIRTotalInstructions();
  rx::g_preemptions = 0;
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
// Browser time slice: the running guest thread unwinds to the driver after
// `milliseconds` of host time (0 disables slicing).
uint32_t r360_fiber_set_host_slice(uint32_t milliseconds) {
  rx::g_host_slice_deadline_ms = milliseconds ? rx::HostMillis() + milliseconds : 0;
  return milliseconds;
}
// 1 when the last unwind was a host time-slice yield (consumed by this call).
uint32_t r360_fiber_take_host_yield() {
  const bool yielded = rx::g_host_yield;
  rx::g_host_yield = false;
  return yielded ? 1u : 0u;
}
uint32_t r360_fiber_host_yields() { return rx::g_host_yields; }
uint32_t r360_fiber_preemptions() { return rx::g_preemptions; }
// Guest JIT frames (hir_wasm_jit.cpp) save their locals in the current
// fiber's Asyncify buffer like Binaryen-instrumented functions: pushed on
// unwind (after their callees), popped on rewind (before them).
__attribute__((used, export_name("r360_jit_h_spill_alloc")))
uint32_t r360_jit_h_spill_alloc(uint32_t bytes) {
  if (rx::g_current >= rx::g_fibers.size() || !rx::g_fibers[rx::g_current].asyncify) abort();
  auto* header = reinterpret_cast<uint32_t*>(rx::g_fibers[rx::g_current].asyncify);
  const uint32_t at = header[0];
  if (uint64_t(at) + bytes > header[1]) abort();
  header[0] = at + bytes;
  return at;
}
__attribute__((used, export_name("r360_jit_h_spill_pop")))
uint32_t r360_jit_h_spill_pop(uint32_t bytes) {
  if (rx::g_current >= rx::g_fibers.size() || !rx::g_fibers[rx::g_current].asyncify) abort();
  auto* header = reinterpret_cast<uint32_t*>(rx::g_fibers[rx::g_current].asyncify);
  header[0] -= bytes;
  return header[0];
}
uint32_t r360_fiber_leave(uint32_t index, uint32_t field) {
  if (index >= rx::g_fibers.size()) return 0;
  if (field >= 2 && field < 7) return rx::g_fibers[index].leave_counts[field - 2];
  if (field == 7) return rx::g_fibers[index].leave_pc;
  return field ? rx::g_fibers[index].leave_call : rx::g_fibers[index].leave_kind;
}
uint32_t r360_fiber_resumes(uint32_t index) {
  return index < rx::g_fibers.size() ? rx::g_fibers[index].resumes : 0u;
}
// Millions of HIR instructions the fiber has run (excluding its current run).
uint32_t r360_fiber_instructions_millions(uint32_t index) {
  return index < rx::g_fibers.size() ? uint32_t(rx::g_fibers[index].instructions / 1000000ull) : 0u;
}
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
  // A host time-slice yield resumes the same fiber: its preemption quantum
  // keeps running (otherwise browser slices shorter than the quantum would
  // stop it from ever being preempted).
  const bool same_fiber = rx::g_current == rx::g_target;
  rx::g_current = rx::g_target;
  rx::Fiber& fiber = rx::g_fibers[rx::g_current];
  const bool fresh = fiber.state == rx::kFiberNew;
  rx::RestoreLocals(fiber);
  if (fiber.thread) r360_guest_thread_set_current(fiber.thread);
  rx::g_stack_low = fiber.c_stack ? reinterpret_cast<uintptr_t>(fiber.c_stack) : 0;
  fiber.state = rx::kFiberRunning;
  ++fiber.resumes;
  rx::g_run_start = rx::HIRTotalInstructions();
  if (!same_fiber) rx::g_quantum_start = rx::g_run_start;
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
