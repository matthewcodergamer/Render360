// Native build: the HIR -> WebAssembly guest JIT (hir_wasm_jit.cpp) does not
// apply, and no arm64/x64 backend exists yet (Xenia only ships x64), so every
// guest function runs on the HIR interpreter. These definitions keep the
// translation cache's JIT hooks inert ("JIT off", JitLastDecision() == 5).
//
// r360_native_jit_available() reports whether this process could run a JIT
// at all: on iOS that needs the debugger-attached / JIT-enabled state that a
// sideloaded build gets from StikDebug. It maps a MAP_JIT page, writes a tiny
// "return 42" stub and calls it.
#include <cstdint>
#include <cstring>
#include <sys/mman.h>
#if defined(__APPLE__)
#include <TargetConditionals.h>
#include <libkern/OSCacheControl.h>
#include <pthread.h>
#endif

#include "hir_wasm_jit.h"

namespace render360::xenia_web {
bool JitEnabled() { return false; }
void JitSetCandidate(xe::cpu::hir::HIRBuilder*, JitSlot*) {}
uint32_t JitTakeFunction(xe::cpu::hir::HIRBuilder*) { return 0; }
uint32_t JitLastDecision() { return 5; }
uint32_t JitRejectOpcode(xe::cpu::hir::HIRBuilder*) { return 0; }
JitSlot* JitTakeOsrSlot(xe::cpu::hir::HIRBuilder*) { return nullptr; }
uint32_t JitOsrFunction(xe::cpu::hir::HIRBuilder*, JitSlot*, bool) { return 0; }
uint32_t JitSegmentOfBlock(xe::cpu::hir::HIRBuilder*, const xe::cpu::hir::Block*) { return 0; }
void JitReleaseSlot(JitSlot*) {}
}  // namespace render360::xenia_web

namespace {
// 0 not probed, 1 available, 2 unavailable.
uint32_t g_jit_probe = 0;

uint32_t ProbeExecutableMemory() {
#if defined(__aarch64__) || defined(__x86_64__)
  const size_t size = 16384;
#if defined(__APPLE__)
  void* page = mmap(nullptr, size, PROT_READ | PROT_WRITE | PROT_EXEC,
                    MAP_PRIVATE | MAP_ANONYMOUS | MAP_JIT, -1, 0);
#else
  void* page = mmap(nullptr, size, PROT_READ | PROT_WRITE | PROT_EXEC,
                    MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
#endif
  if (page == MAP_FAILED) return 2;
#if defined(__aarch64__)
  static const uint32_t kStub[] = {0x52800540u /* mov w0, #42 */, 0xD65F03C0u /* ret */};
#else
  static const uint8_t kStub[] = {0xB8, 42, 0, 0, 0 /* mov eax, 42 */, 0xC3 /* ret */};
#endif
#if defined(__APPLE__) && defined(__aarch64__) && TARGET_OS_OSX
  pthread_jit_write_protect_np(0);
#endif
  std::memcpy(page, kStub, sizeof(kStub));
#if defined(__APPLE__) && defined(__aarch64__) && TARGET_OS_OSX
  pthread_jit_write_protect_np(1);
  sys_icache_invalidate(page, sizeof(kStub));
#endif
  // Without the JIT entitlement / debugger state the kernel kills the
  // process on the call instead of failing the mmap on some iOS versions;
  // the app only probes when the user enables JIT mode, and records a
  // breadcrumb first so a crash here is attributed correctly.
  using Fn = int (*)();
  const int value = reinterpret_cast<Fn>(page)();
  munmap(page, size);
  return value == 42 ? 1 : 2;
#else
  return 2;
#endif
}
}  // namespace

extern "C" uint32_t r360_native_jit_available() {
  if (!g_jit_probe) g_jit_probe = ProbeExecutableMemory();
  return g_jit_probe == 1 ? 1u : 0u;
}
