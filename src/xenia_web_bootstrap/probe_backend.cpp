#include "probe_backend.h"

#include <cstdio>
#include <cstring>
#include <memory>

#include "xenia/cpu/function_debug_info.h"
#include "xenia/cpu/hir/block.h"
#include "xenia/cpu/hir/hir_builder.h"
#include "xenia/cpu/hir/instr.h"

namespace render360::xenia_web {
namespace {
ProbeTelemetry g_probe_telemetry;
}  // namespace

void ResetProbeTelemetry() { g_probe_telemetry = {}; }
const ProbeTelemetry& GetProbeTelemetry() { return g_probe_telemetry; }

ProbeGuestFunction::ProbeGuestFunction(xe::cpu::Module* module,
                                       uint32_t address)
    : xe::cpu::GuestFunction(module, address) {}
ProbeGuestFunction::~ProbeGuestFunction() = default;

bool ProbeGuestFunction::CallImpl(xe::cpu::ThreadState*, uint32_t) {
  // Translation-only function. Returning false is intentional: Render360 must
  // never report this probe backend as an execution backend.
  return false;
}

ProbeAssembler::ProbeAssembler(xe::cpu::backend::Backend* backend)
    : xe::cpu::backend::Assembler(backend) {}
ProbeAssembler::~ProbeAssembler() = default;

bool ProbeAssembler::Assemble(
    xe::cpu::GuestFunction* function, xe::cpu::hir::HIRBuilder* builder,
    uint32_t, std::unique_ptr<xe::cpu::FunctionDebugInfo> debug_info) {
  uint32_t block_count = 0;
  uint32_t instruction_count = 0;
  for (auto* block = builder->first_block(); block; block = block->next) {
    const uint32_t block_index = block_count++;
    for (auto* instr = block->instr_head; instr; instr = instr->next) {
      ++instruction_count;
      // Phase 4 observability: report the finalized HIR that Xenia itself has
      // already translated and optimized. The correctness executor will be
      // implemented against this HIR stream; this is not a second PPC decoder.
      std::fprintf(stderr, "R360_HIR block=%u ordinal=%u opcode=%s(%u)\n",
                   block_index, instr->ordinal,
                   instr->opcode && instr->opcode->name ? instr->opcode->name
                                                        : "<null>",
                   instr->opcode
                       ? static_cast<unsigned>(instr->opcode->num)
                       : 0u);
    }
  }

  ++g_probe_telemetry.assembled_functions;
  g_probe_telemetry.hir_blocks = block_count;
  g_probe_telemetry.hir_instructions = instruction_count;
  g_probe_telemetry.last_guest_address = function ? function->address() : 0;

  if (function && debug_info) {
    function->set_debug_info(std::move(debug_info));
  }
  return true;
}

ProbeBackend::ProbeBackend() = default;
ProbeBackend::~ProbeBackend() = default;

bool ProbeBackend::Initialize(xe::cpu::Processor* processor) {
  if (!xe::cpu::backend::Backend::Initialize(processor)) {
    return false;
  }

  // The Xenia compiler's RegisterAllocationPass requires the backend to
  // describe the host register sets it is translating for. Keep the probe
  // target aligned with Xenia's mature x64 allocator shape (7 allocatable GPRs
  // and 12 shared floating/vector registers) without importing the x64 emitter
  // or claiming that these registers are executable wasm32 machine registers.
  // They are only the allocation contract consumed while finalizing Xenia HIR.
  machine_info_.supports_extended_load_store = false;

  auto& gprs = machine_info_.register_sets[0];
  gprs.id = 0;
  std::strcpy(gprs.name, "gpr");
  gprs.types = xe::cpu::backend::MachineInfo::RegisterSet::INT_TYPES;
  gprs.count = 7;

  auto& vecs = machine_info_.register_sets[1];
  vecs.id = 1;
  std::strcpy(vecs.name, "vec");
  vecs.types = xe::cpu::backend::MachineInfo::RegisterSet::FLOAT_TYPES |
               xe::cpu::backend::MachineInfo::RegisterSet::VEC_TYPES;
  vecs.count = 12;

  return true;
}

void ProbeBackend::CommitExecutableRange(uint32_t, uint32_t) {
  // No native executable memory exists in this translation-only backend.
}

std::unique_ptr<xe::cpu::backend::Assembler> ProbeBackend::CreateAssembler() {
  return std::make_unique<ProbeAssembler>(this);
}

std::unique_ptr<xe::cpu::GuestFunction> ProbeBackend::CreateGuestFunction(
    xe::cpu::Module* module, uint32_t address) {
  return std::make_unique<ProbeGuestFunction>(module, address);
}

uint64_t ProbeBackend::CalculateNextHostInstruction(
    xe::cpu::ThreadDebugInfo*, uint64_t) {
  // There is no host machine-code stream to step in this backend.
  return 0;
}

}  // namespace render360::xenia_web

extern "C" {
uint32_t r360_ppc_probe_assembled_functions() {
  return render360::xenia_web::GetProbeTelemetry().assembled_functions;
}
uint32_t r360_ppc_probe_hir_block_count() {
  return render360::xenia_web::GetProbeTelemetry().hir_blocks;
}
uint32_t r360_ppc_probe_hir_instruction_count() {
  return render360::xenia_web::GetProbeTelemetry().hir_instructions;
}
uint32_t r360_ppc_probe_last_guest_address() {
  return render360::xenia_web::GetProbeTelemetry().last_guest_address;
}
}
