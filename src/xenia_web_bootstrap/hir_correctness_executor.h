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

// Executes a deliberately small, verified subset of finalized Xenia HIR against
// a real PPCContext. This does not decode PowerPC. The input must already have
// passed through Xenia PPCFrontend/PPCTranslator/PPCHIRBuilder/compiler passes.
//
// Initial gate: the finalized HIR for `li r3, 1; blr`:
//   source_offset, store_context, source_offset, context_barrier,
//   load_context, call_indirect(CALL_POSSIBLE_RETURN).
HIRCorrectnessResult ExecuteHIRCorrectnessProbe(xe::cpu::hir::HIRBuilder* builder);

}  // namespace render360::xenia_web

#endif  // RENDER360_XENIA_WEB_BOOTSTRAP_HIR_CORRECTNESS_EXECUTOR_H_
