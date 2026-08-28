#ifndef RENDER360_XENIA_WEB_BOOTSTRAP_PROBE_BACKEND_H_
#define RENDER360_XENIA_WEB_BOOTSTRAP_PROBE_BACKEND_H_

#include <cstddef>
#include <cstdint>
#include <memory>

#include "xenia/cpu/backend/assembler.h"
#include "xenia/cpu/backend/backend.h"
#include "xenia/cpu/function.h"

namespace render360::xenia_web {

struct ProbeTelemetry {
  uint32_t assembled_functions = 0;
  uint32_t hir_blocks = 0;
  uint32_t hir_instructions = 0;
  uint32_t last_guest_address = 0;
};

void ResetProbeTelemetry();
const ProbeTelemetry& GetProbeTelemetry();

// Translation-only GuestFunction. It intentionally owns no executable host
// code and refuses CallImpl. This object exists only so Xenia's real frontend,
// scanner, HIR builder and compiler can describe a guest function.
class ProbeGuestFunction final : public xe::cpu::GuestFunction {
 public:
  ProbeGuestFunction(xe::cpu::Module* module, uint32_t address);
  ~ProbeGuestFunction() override;

  uint8_t* machine_code() const override { return nullptr; }
  size_t machine_code_length() const override { return 0; }

 protected:
  bool CallImpl(xe::cpu::ThreadState* thread_state,
                uint32_t return_address) override;
};

// Final HIR sink for the translation probe. It never emits machine code. It
// counts the actual finalized Xenia HIR supplied by PPCTranslator and records
// the guest address for browser/CI telemetry.
class ProbeAssembler final : public xe::cpu::backend::Assembler {
 public:
  explicit ProbeAssembler(xe::cpu::backend::Backend* backend);
  ~ProbeAssembler() override;

  bool Assemble(xe::cpu::GuestFunction* function,
                xe::cpu::hir::HIRBuilder* builder,
                uint32_t debug_info_flags,
                std::unique_ptr<xe::cpu::FunctionDebugInfo> debug_info) override;
};

// Browser translation backend. This is not an execution backend or JIT. Its
// purpose is to satisfy Xenia's backend seam while the real frontend produces
// and optimizes HIR. A later correctness backend will execute HIR explicitly.
class ProbeBackend final : public xe::cpu::backend::Backend {
 public:
  ProbeBackend();
  ~ProbeBackend() override;

  bool Initialize(xe::cpu::Processor* processor) override;
  void CommitExecutableRange(uint32_t guest_low, uint32_t guest_high) override;
  std::unique_ptr<xe::cpu::backend::Assembler> CreateAssembler() override;
  std::unique_ptr<xe::cpu::GuestFunction> CreateGuestFunction(
      xe::cpu::Module* module, uint32_t address) override;
  uint64_t CalculateNextHostInstruction(
      xe::cpu::ThreadDebugInfo* thread_info, uint64_t current_pc) override;
};

}  // namespace render360::xenia_web

extern "C" {
uint32_t r360_ppc_probe_assembled_functions();
uint32_t r360_ppc_probe_hir_block_count();
uint32_t r360_ppc_probe_hir_instruction_count();
uint32_t r360_ppc_probe_last_guest_address();
}

#endif  // RENDER360_XENIA_WEB_BOOTSTRAP_PROBE_BACKEND_H_
