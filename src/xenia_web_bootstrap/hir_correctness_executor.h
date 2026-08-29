#ifndef RENDER360_XENIA_WEB_BOOTSTRAP_HIR_CORRECTNESS_EXECUTOR_H_
#define RENDER360_XENIA_WEB_BOOTSTRAP_HIR_CORRECTNESS_EXECUTOR_H_

#include <cstdint>

namespace xe {
class Memory;
namespace cpu {
class Function;
namespace hir {
class HIRBuilder;
}
}  // namespace cpu
}  // namespace xe

namespace render360::xenia_web {

enum HIRCorrectnessBlockerKind : uint32_t {
  kHIRBlockerNone = 0,
  kHIRBlockerUnsupportedOpcode = 1,
  kHIRBlockerUnresolvedCall = 2,
  kHIRBlockerInstructionLimit = 3,
  kHIRBlockerNoReturnBoundary = 4,
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
// HLE/import bridges may update the currently executing PPCContext while an
// indirect guest call is being resolved. This is deliberately unavailable
// outside active correctness/runtime execution.
bool SetHIRCorrectnessActiveGPR(uint32_t index, uint64_t value);

// ProbeBackend installs resolvers that send direct symbols and runtime-resolved
// indirect targets back through the real Xenia PPCScanner/PPCFrontend. Nested
// finalized HIR then executes against the same active PPCContext as the caller.
void SetHIRCorrectnessCallResolver(HIRCorrectnessCallResolver resolver);
void SetHIRCorrectnessAddressResolver(HIRCorrectnessAddressResolver resolver);
bool IsHIRCorrectnessExecutionActive();

HIRCorrectnessResult ExecuteHIRCorrectnessProbe(xe::cpu::hir::HIRBuilder* builder,
                                                xe::Memory* memory);

}  // namespace render360::xenia_web

#endif  // RENDER360_XENIA_WEB_BOOTSTRAP_HIR_CORRECTNESS_EXECUTOR_H_
