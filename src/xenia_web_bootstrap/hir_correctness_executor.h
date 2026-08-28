#ifndef RENDER360_XENIA_WEB_BOOTSTRAP_HIR_CORRECTNESS_EXECUTOR_H_
#define RENDER360_XENIA_WEB_BOOTSTRAP_HIR_CORRECTNESS_EXECUTOR_H_

#include <cstdint>

namespace xe {
class Memory;
namespace cpu::hir {
class HIRBuilder;
}
}  // namespace xe

namespace render360::xenia_web {

struct HIRCorrectnessResult {
  bool supported = false;
  bool reached_return_boundary = false;
  uint32_t instructions_executed = 0;
  uint64_t r3 = 0;
};

// CI/runtime correctness probes can seed architectural input state before the
// finalized Xenia HIR is executed. This is testing infrastructure only: it does
// not decode or emulate PowerPC outside Xenia.
void ResetHIRCorrectnessInitialState();
bool SetHIRCorrectnessInitialGPR(uint32_t index, uint64_t value);

// Executes finalized Xenia HIR against a real PPCContext and the same Xenia
// Memory instance owned by Processor. PowerPC has already been decoded by Xenia.
HIRCorrectnessResult ExecuteHIRCorrectnessProbe(xe::cpu::hir::HIRBuilder* builder,
                                                xe::Memory* memory);

}  // namespace render360::xenia_web

#endif  // RENDER360_XENIA_WEB_BOOTSTRAP_HIR_CORRECTNESS_EXECUTOR_H_
