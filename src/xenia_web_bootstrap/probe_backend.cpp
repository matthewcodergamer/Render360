#include "probe_backend.h"

#include <cstdio>
#include <cstring>
#include <memory>

#include "hir_correctness_executor.h"
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
  // ProbeBackend still owns no native executable code. Phase 4 execution is
  // performed explicitly from finalized Xenia HIR by HIRCorrectnessExecutor.
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

  const auto correctness = ExecuteHIRCorrectnessProbe(builder);
  g_probe_telemetry.correctness_instructions = correctness.instructions_executed;
  g_probe_telemetry.correctness_r3 = correctness.r3;
  if (!correctness.supported) {
    g_probe_telemetry.correctness_status = 1;
  } else if (!correctness.reached_return_boundary) {
    g_probe_telemetry.correctness_status = 2;
  } else {
    g_probe_telemetry.correctness_status = 3;
  }
  std::fprintf(stderr,
               "R360_EXEC status=%u instructions=%u r3=%llu return_boundary=%u\n",
               g_probe_telemetry.correctness_status,
               g_probe_telemetry.correctness_instructions,
               static_cast<unsigned long long>(g_probe_telemetry.correctness_r3),
               correctness.reached_return_boundary ? 1u : 0u);

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

void ProbeBackend::CommitExecutableRange(uint32_t, uint32_t) {}

std::unique_ptr<xe::cpu::backend::Assembler> ProbeBackend::CreateAssembler() {
  return std::make_unique<ProbeAssembler>(this);
}

std::unique_ptr<xe::cpu::GuestFunction> ProbeBackend::CreateGuestFunction(
    xe::cpu::Module* module, uint32_t address) {
  return std::make_unique<ProbeGuestFunction>(module, address);
}

uint64_t ProbeBackend::CalculateNextHostInstruction(
    xe::cpu::ThreadDebugInfo*, uint64_t) {
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
uint32_t r360_ppc_probe_correctness_status() {
  return render360::xenia_web::GetProbeTelemetry().correctness_status;
}
uint32_t r360_ppc_probe_correctness_instructions() {
  return render360::xenia_web::GetProbeTelemetry().correctness_instructions;
}
uint64_t r360_ppc_probe_correctness_r3() {
  return render360::xenia_web::GetProbeTelemetry().correctness_r3;
}
}
