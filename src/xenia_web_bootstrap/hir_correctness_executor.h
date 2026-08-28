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

struct HIRCorrectnessResult {
  bool supported = false;
  bool reached_return_boundary = false;
  uint32_t instructions_executed = 0;
  uint64_t r3 = 0;
};

using HIRCorrectnessCallResolver = bool (*)(xe::cpu::Function* function);

void ResetHIRCorrectnessInitialState();
bool SetHIRCorrectnessInitialGPR(uint32_t index, uint64_t value);

// ProbeBackend installs a resolver that asks the real Xenia PPCFrontend to
// define/translate a called guest Function. The nested assembler then executes
// that finalized HIR against the same active PPCContext as the caller.
void SetHIRCorrectnessCallResolver(HIRCorrectnessCallResolver resolver);
bool IsHIRCorrectnessExecutionActive();

HIRCorrectnessResult ExecuteHIRCorrectnessProbe(xe::cpu::hir::HIRBuilder* builder,
                                                xe::Memory* memory);

}  // namespace render360::xenia_web

#endif  // RENDER360_XENIA_WEB_BOOTSTRAP_HIR_CORRECTNESS_EXECUTOR_H_
