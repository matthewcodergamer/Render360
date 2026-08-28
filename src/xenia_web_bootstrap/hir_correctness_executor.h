#ifndef RENDER360_XENIA_WEB_BOOTSTRAP_HIR_CORRECTNESS_EXECUTOR_H_
#define RENDER360_XENIA_WEB_BOOTSTRAP_HIR_CORRECTNESS_EXECUTOR_H_

#include <cstdint>

namespace xe::cpu::hir {
class HIRBuilder;
}

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

// Executes a deliberately small, verified subset of finalized Xenia HIR against
// a real PPCContext. This does not decode PowerPC. The input must already have
// passed through Xenia PPCFrontend/PPCTranslator/PPCHIRBuilder/compiler passes.
HIRCorrectnessResult ExecuteHIRCorrectnessProbe(xe::cpu::hir::HIRBuilder* builder);

}  // namespace render360::xenia_web

#endif  // RENDER360_XENIA_WEB_BOOTSTRAP_HIR_CORRECTNESS_EXECUTOR_H_
