#include "probe_backend.h"

#include <cstdio>
#include <cstring>
#include <memory>

#include "hir_correctness_executor.h"
#include "wasm_backend_call_probe.h"
#include "wasm_backend_cfg_probe.h"
#include "wasm_backend_memory_probe.h"
#include "wasm_backend_probe.h"
#include "xenia/cpu/function_debug_info.h"
#include "xenia/cpu/hir/block.h"
#include "xenia/cpu/hir/hir_builder.h"
#include "xenia/cpu/hir/instr.h"
#include "xenia/cpu/ppc/ppc_frontend.h"
#include "xenia/cpu/ppc/ppc_scanner.h"
#include "xenia/cpu/processor.h"
#include "xenia/memory.h"

namespace render360::xenia_web {
namespace {
ProbeTelemetry g_probe_telemetry;
ProbeBackend* g_probe_backend = nullptr;
constexpr uint32_t kProbeGuestBase = 0x80000000u;
constexpr uint32_t kProbeGuestSize = 64u * 1024u;
constexpr uint32_t kProbeGuestEnd = 0x8000FFFCu;

bool TranslateNestedGuestAddress(uint32_t address, xe::cpu::Module* module) {
  if (!g_probe_backend || !g_probe_backend->processor()) {
    std::fprintf(stderr, "R360_CALL_RESOLVE rejected: backend/processor missing\n");
    return false;
  }
  auto* frontend = g_probe_backend->processor()->frontend();
  if (!frontend) {
    std::fprintf(stderr, "R360_CALL_RESOLVE rejected: frontend missing\n");
    return false;
  }
  std::fprintf(stderr, "R360_CALL_RESOLVE target=0x%08X\n", address);
  if (address < kProbeGuestBase || address > kProbeGuestEnd) {
    std::fprintf(stderr, "R360_CALL_RESOLVE rejected: target outside probe window\n");
    return false;
  }
  ProbeGuestFunction nested_function(module, address);
  xe::cpu::ppc::PPCScanner scanner(frontend);
  if (!scanner.Scan(&nested_function, nullptr)) {
    std::fprintf(stderr, "R360_CALL_RESOLVE scan failed target=0x%08X\n", address);
    return false;
  }
  std::fprintf(stderr, "R360_CALL_RESOLVE scanned target=0x%08X end=0x%08X\n",
               address, nested_function.end_address());
  const bool translated = frontend->DefineFunction(&nested_function, 0);
  std::fprintf(stderr, "R360_CALL_RESOLVE translated target=0x%08X result=%u\n",
               address, translated ? 1u : 0u);
  return translated;
}

bool ResolveNestedGuestCall(xe::cpu::Function* function) {
  if (!function) return false;
  return TranslateNestedGuestAddress(function->address(), function->module());
}
bool ResolveNestedGuestAddress(uint32_t address) {
  return TranslateNestedGuestAddress(address, nullptr);
}
}  // namespace

void ResetProbeTelemetry() { g_probe_telemetry = {}; }
const ProbeTelemetry& GetProbeTelemetry() { return g_probe_telemetry; }

ProbeGuestFunction::ProbeGuestFunction(xe::cpu::Module* module, uint32_t address)
    : xe::cpu::GuestFunction(module, address) {}
ProbeGuestFunction::~ProbeGuestFunction() = default;
bool ProbeGuestFunction::CallImpl(xe::cpu::ThreadState*, uint32_t) { return false; }

ProbeAssembler::ProbeAssembler(xe::cpu::backend::Backend* backend)
    : xe::cpu::backend::Assembler(backend) {}
ProbeAssembler::~ProbeAssembler() = default;

bool ProbeAssembler::Assemble(
    xe::cpu::GuestFunction* function, xe::cpu::hir::HIRBuilder* builder,
    uint32_t, std::unique_ptr<xe::cpu::FunctionDebugInfo> debug_info) {
  const bool nested_execution = IsHIRCorrectnessExecutionActive();
  uint32_t block_count = 0;
  uint32_t instruction_count = 0;
  for (auto* block = builder->first_block(); block; block = block->next) {
    const uint32_t block_index = block_count++;
    for (auto* instr = block->instr_head; instr; instr = instr->next) {
      ++instruction_count;
      std::fprintf(stderr, "R360_HIR%s block=%u ordinal=%u opcode=%s(%u)\n",
                   nested_execution ? "_NESTED" : "", block_index, instr->ordinal,
                   instr->opcode && instr->opcode->name ? instr->opcode->name : "<null>",
                   instr->opcode ? static_cast<unsigned>(instr->opcode->num) : 0u);
    }
  }

  ++g_probe_telemetry.assembled_functions;
  auto* memory = backend_ && backend_->processor() ? backend_->processor()->memory() : nullptr;

  // Unlike the single-function scalar/CFG/memory probes, the call workstream
  // must observe every Xenia-produced function. Nested callees are therefore
  // registered here too, after their own scanner/frontend/compiler pipeline has
  // finalized HIR. The generated caller never decodes PPC and never asks the
  // correctness executor to impersonate a callee.
  const bool call_registered = RegisterWasmBackendCallFunction(function, builder);
  std::fprintf(stderr,
               "R360_WASM_BACKEND_CALL%s address=0x%08X registered=%u status=%u functions=%u\n",
               nested_execution ? "_NESTED" : "",
               function ? function->address() : 0u, call_registered ? 1u : 0u,
               GetWasmBackendCallStatus(), GetWasmBackendCallFunctionCount());

  if (!nested_execution) {
    g_probe_telemetry.hir_blocks = block_count;
    g_probe_telemetry.hir_instructions = instruction_count;
    g_probe_telemetry.last_guest_address = function ? function->address() : 0;

    BuildWasmBackendProbe(builder);
    BuildWasmBackendCfgProbe(builder);
    uint8_t* guest_host_base = memory ? memory->TranslateVirtual<uint8_t*>(kProbeGuestBase) : nullptr;
    BuildWasmBackendMemoryProbe(builder, guest_host_base, kProbeGuestBase, kProbeGuestSize);

    std::fprintf(stderr, "R360_WASM_BACKEND status=%u module_bytes=%u lowered=%u\n",
                 GetWasmBackendProbeStatus(), GetWasmBackendProbeModuleSize(),
                 GetWasmBackendProbeLoweredInstructions());
    std::fprintf(stderr, "R360_WASM_BACKEND_CFG status=%u module_bytes=%u lowered=%u\n",
                 GetWasmBackendCfgProbeStatus(), GetWasmBackendCfgProbeModuleSize(),
                 GetWasmBackendCfgProbeLoweredInstructions());
    std::fprintf(stderr, "R360_WASM_BACKEND_MEMORY status=%u module_bytes=%u lowered=%u guest_host=0x%08X\n",
                 GetWasmBackendMemoryProbeStatus(), GetWasmBackendMemoryProbeModuleSize(),
                 GetWasmBackendMemoryProbeLoweredInstructions(),
                 static_cast<uint32_t>(reinterpret_cast<uintptr_t>(guest_host_base)));
  }

  const auto correctness = ExecuteHIRCorrectnessProbe(builder, memory);
  if (!nested_execution) {
    g_probe_telemetry.correctness_instructions = correctness.instructions_executed;
    g_probe_telemetry.correctness_r3 = correctness.r3;
    g_probe_telemetry.correctness_status = !correctness.supported ? 1u :
        (!correctness.reached_return_boundary ? 2u : 3u);
  }

  std::fprintf(stderr, "R360_EXEC%s status=%u instructions=%u r3=%llu return_boundary=%u\n",
               nested_execution ? "_NESTED" : "",
               correctness.supported ? (correctness.reached_return_boundary ? 3u : 2u) : 1u,
               correctness.instructions_executed,
               static_cast<unsigned long long>(correctness.r3),
               correctness.reached_return_boundary ? 1u : 0u);

  if (function && debug_info) function->set_debug_info(std::move(debug_info));
  if (nested_execution) return correctness.supported && correctness.reached_return_boundary;
  return true;
}

ProbeBackend::ProbeBackend() = default;
ProbeBackend::~ProbeBackend() = default;

bool ProbeBackend::Initialize(xe::cpu::Processor* processor) {
  if (!xe::cpu::backend::Backend::Initialize(processor)) return false;
  g_probe_backend = this;
  SetHIRCorrectnessCallResolver(&ResolveNestedGuestCall);
  SetHIRCorrectnessAddressResolver(&ResolveNestedGuestAddress);

  machine_info_.supports_extended_load_store = false;
  auto& gprs = machine_info_.register_sets[0];
  gprs.id = 0; std::strcpy(gprs.name, "gpr");
  gprs.types = xe::cpu::backend::MachineInfo::RegisterSet::INT_TYPES; gprs.count = 7;
  auto& vecs = machine_info_.register_sets[1];
  vecs.id = 1; std::strcpy(vecs.name, "vec");
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
uint64_t ProbeBackend::CalculateNextHostInstruction(xe::cpu::ThreadDebugInfo*, uint64_t) { return 0; }
}  // namespace render360::xenia_web

extern "C" {
uint32_t r360_ppc_probe_assembled_functions() { return render360::xenia_web::GetProbeTelemetry().assembled_functions; }
uint32_t r360_ppc_probe_hir_block_count() { return render360::xenia_web::GetProbeTelemetry().hir_blocks; }
uint32_t r360_ppc_probe_hir_instruction_count() { return render360::xenia_web::GetProbeTelemetry().hir_instructions; }
uint32_t r360_ppc_probe_last_guest_address() { return render360::xenia_web::GetProbeTelemetry().last_guest_address; }
uint32_t r360_ppc_probe_correctness_status() { return render360::xenia_web::GetProbeTelemetry().correctness_status; }
uint32_t r360_ppc_probe_correctness_instructions() { return render360::xenia_web::GetProbeTelemetry().correctness_instructions; }
uint64_t r360_ppc_probe_correctness_r3() { return render360::xenia_web::GetProbeTelemetry().correctness_r3; }
}
