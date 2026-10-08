#ifndef RENDER360_XENIA_WEB_BOOTSTRAP_HIR_CORRECTNESS_EXECUTOR_H_
#define RENDER360_XENIA_WEB_BOOTSTRAP_HIR_CORRECTNESS_EXECUTOR_H_

#include <cstdint>
#include <string>
#include <cstdio>

namespace render360::xenia_web {
// Verbose per-function / per-call text tracing, off by default. In the browser
// every stderr line is a synchronous WASI fd_write that lands in
// console.error, and real titles make millions of guest calls, so hot-path
// diagnostics only print when a developer turns this on
// (r360_trace_set_verbose). The structured stack/call history rings and the
// kernel trace ring record the same events regardless. One-shot blocker and
// fault lines are never gated.
extern bool g_r360_verbose_trace;
}  // namespace render360::xenia_web

#define R360_VERBOSE_TRACE(...)                                  \
  do {                                                           \
    if (::render360::xenia_web::g_r360_verbose_trace) {          \
      std::fprintf(stderr, __VA_ARGS__);                         \
    }                                                            \
  } while (0)

namespace xe {
class Memory;
namespace cpu {
class Function;
namespace hir {
class HIRBuilder;
}
namespace ppc {
typedef struct PPCContext_s PPCContext;
}
}  // namespace cpu
}  // namespace xe;

namespace render360::xenia_web {

enum HIRCorrectnessBlockerKind : uint32_t {
  kHIRBlockerNone = 0,
  kHIRBlockerUnsupportedOpcode = 1,
  kHIRBlockerUnresolvedCall = 2,
  kHIRBlockerInstructionLimit = 3,
  kHIRBlockerNoReturnBoundary = 4,
  kHIRBlockerGuestMemory = 5,
};

struct HIRCorrectnessResult {
  bool supported = false;
  bool reached_return_boundary = false;
  uint32_t instructions_executed = 0;
  uint64_t r3 = 0;
  uint32_t blocker_kind = kHIRBlockerNone;
  uint32_t blocker_opcode = 0;
  uint32_t blocker_address = 0;
};

using HIRCorrectnessCallResolver = bool (*)(xe::cpu::Function* function);
using HIRCorrectnessAddressResolver = bool (*)(uint32_t guest_address);

void ResetHIRCorrectnessInitialState();
bool SetHIRCorrectnessInitialGPR(uint32_t index, uint64_t value);
bool SetHIRCorrectnessInitialLR(uint64_t value);
uint64_t GetHIRCorrectnessInitialLR();
uint64_t GetHIRCorrectnessLastGPR(uint32_t index);

// ProbeBackend installs resolvers that send direct symbols and runtime-resolved
// indirect targets back through the real Xenia PPCScanner/PPCFrontend. Nested
// finalized HIR then executes against the same active PPCContext as the caller.
void SetHIRCorrectnessCallResolver(HIRCorrectnessCallResolver resolver);
void SetHIRCorrectnessAddressResolver(HIRCorrectnessAddressResolver resolver);
void SetHIRCorrectnessExecutionEntry(uint32_t guest_address);
uint32_t GetHIRCorrectnessCurrentCallFlags();
uint32_t ConsumeHIRCorrectnessInteriorEntryMissing();
void SetHIRCorrectnessContextProvenanceRecovery(bool enabled);
bool IsHIRCorrectnessExecutionActive();
void AbandonHIRCorrectnessExecution();
bool AddHIRCorrectnessInitialRegister(const char* name, const char* value);
int CompareHIRCorrectnessLastRegister(const char* name, const char* value,
                                      std::string* actual);

// The kernel/XAM import bridge uses this only while finalized HIR is actively
// executing. It lets a resolved HLE import consume the caller's real r3..r10
// arguments and place its ABI return value back in r3 without inventing a
// second PPC execution context.
xe::cpu::ppc::PPCContext* GetHIRCorrectnessActiveContext();

HIRCorrectnessResult ExecuteHIRCorrectnessProbe(xe::cpu::hir::HIRBuilder* builder,
                                                xe::Memory* memory);

}  // namespace render360::xenia_web

#endif  // RENDER360_XENIA_WEB_BOOTSTRAP_HIR_CORRECTNESS_EXECUTOR_H_
