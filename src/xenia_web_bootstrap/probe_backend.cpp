#include "probe_backend.h"

#include <cstdio>
#include <cstring>
#include <memory>

#include "hir_correctness_executor.h"
#include "kernel_import_probe.h"
#include "wasm_backend_call_probe.h"
#include "wasm_backend_cfg_probe.h"
#include "wasm_backend_fpu_probe.h"
#include "wasm_backend_memory_probe.h"
#include "wasm_backend_probe.h"
#include "wasm_backend_vmx_probe.h"
#include "xenia/cpu/function_debug_info.h"
#include "xenia/cpu/hir/block.h"
#include "xenia/cpu/hir/hir_builder.h"
#include "xenia/cpu/hir/instr.h"
#include "xenia/cpu/ppc/ppc_frontend.h"
#include "xenia/cpu/ppc/ppc_scanner.h"
#include "xenia/cpu/processor.h"
#include "xenia/memory.h"

extern "C" uint32_t r360_ppc_probe_guest_base();
extern "C" uint32_t r360_ppc_probe_page_sparse_code(uint32_t target_address);

#if defined(__wasm__)
#define R360_WASM_EXPORT(name) __attribute__((used, export_name(name)))
#else
#define R360_WASM_EXPORT(name)
#endif

namespace render360::xenia_web {
namespace {
ProbeTelemetry g_probe_telemetry;
ProbeBackend* g_probe_backend = nullptr;
bool g_execute_correctness_on_assemble = true;
constexpr uint32_t kProbeGuestSize = 64u * 1024u;

bool IsInActiveProbeWindow(uint32_t address) {
  const uint32_t base = r360_ppc_probe_guest_base();
  const uint64_t end = uint64_t(base) + kProbeGuestSize;
  return address >= base && uint64_t(address) < end;
}

bool TranslateNestedGuestAddress(uint32_t address, xe::cpu::Module* module) {
  // Registered kernel/XAM import thunks are resolved before the bounded probe
  // memory check. Real XEX thunks may live outside the entry's 64 KiB staging
  // window, but a known HLE import is an external call boundary, not guest code
  // that should be scanned from the probe window.
  if (ResolveKernelImportThunk(address)) {
    const uint32_t abi_target = KernelImportProbeLastAbiTarget();
    std::fprintf(stderr, "R360_KERNEL_IMPORT resolved target=0x%08X module=%u ordinal=0x%X abi_target=0x%08X\n",
                 address, KernelImportProbeLastModule(), KernelImportProbeLastOrdinal(), abi_target);
    if (abi_target) {
      if (abi_target == address) {
        MarkKernelImportProbeAbiFailure();
        return false;
      }
      // The ABI critic is translated as nested PPC and therefore executes on
      // the same active PPCContext as the caller. It can consume r3..r10,
      // touch validated guest memory through the normal HIR load/store path,
      // write the return value into r3, return, and let the caller continue.
      const bool abi_ok = TranslateNestedGuestAddress(abi_target, module);
      if (!abi_ok) MarkKernelImportProbeAbiFailure();
      return abi_ok;
    }
    return true;
  }
  if (KernelImportProbeLastThunk() == address && KernelImportProbeLastStatus() == 2) {
    std::fprintf(stderr, "R360_KERNEL_IMPORT unresolved target=0x%08X module=%u ordinal=0x%X\n",
                 address, KernelImportProbeLastModule(), KernelImportProbeLastOrdinal());
    return false;
  }
  if (!g_probe_backend || !g_probe_backend->processor()) {
    std::fprintf(stderr, "R360_CALL_RESOLVE rejected: backend/processor missing\n"); return false;
  }
  auto* frontend = g_probe_backend->processor()->frontend();
  if (!frontend) { std::fprintf(stderr, "R360_CALL_RESOLVE rejected: frontend missing\n"); return false; }
  std::fprintf(stderr, "R360_CALL_RESOLVE target=0x%08X active_base=0x%08X\n",
               address, r360_ppc_probe_guest_base());
  if (!IsInActiveProbeWindow(address)) {
    const uint32_t paged = r360_ppc_probe_page_sparse_code(address);
    std::fprintf(stderr, "R360_CALL_RESOLVE sparse-page target=0x%08X bytes=%u new_base=0x%08X\n",
                 address, paged, r360_ppc_probe_guest_base());
    if (!paged || !IsInActiveProbeWindow(address)) {
      std::fprintf(stderr, "R360_CALL_RESOLVE rejected: target unavailable in sparse guest code\n");
      return false;
    }
  }
  ProbeGuestFunction nested_function(module, address);
  xe::cpu::ppc::PPCScanner scanner(frontend);
  if (!scanner.Scan(&nested_function, nullptr)) {
    std::fprintf(stderr, "R360_CALL_RESOLVE scan failed target=0x%08X\n", address); return false;
  }
  std::fprintf(stderr, "R360_CALL_RESOLVE scanned target=0x%08X end=0x%08X\n", address, nested_function.end_address());
  const bool translated = frontend->DefineFunction(&nested_function, 0);
  std::fprintf(stderr, "R360_CALL_RESOLVE translated target=0x%08X result=%u\n", address, translated ? 1u : 0u);
  return translated;
}
bool ResolveNestedGuestCall(xe::cpu::Function* function) { return function && TranslateNestedGuestAddress(function->address(), function->module()); }
bool ResolveNestedGuestAddress(uint32_t address) { return TranslateNestedGuestAddress(address, nullptr); }
}  // namespace

void ResetProbeTelemetry() { g_probe_telemetry = {}; }
const ProbeTelemetry& GetProbeTelemetry() { return g_probe_telemetry; }
void SetProbeExecuteCorrectnessOnAssemble(bool enabled) {
  g_execute_correctness_on_assemble = enabled;
}
bool GetProbeExecuteCorrectnessOnAssemble() {
  return g_execute_correctness_on_assemble;
}
ProbeGuestFunction::ProbeGuestFunction(xe::cpu::Module* module, uint32_t address) : xe::cpu::GuestFunction(module, address) {}
ProbeGuestFunction::~ProbeGuestFunction() = default;
bool ProbeGuestFunction::CallImpl(xe::cpu::ThreadState*, uint32_t) { return false; }
ProbeAssembler::ProbeAssembler(xe::cpu::backend::Backend* backend) : xe::cpu::backend::Assembler(backend) {}
ProbeAssembler::~ProbeAssembler() = default;

bool ProbeAssembler::Assemble(xe::cpu::GuestFunction* function, xe::cpu::hir::HIRBuilder* builder,
                              uint32_t, std::unique_ptr<xe::cpu::FunctionDebugInfo> debug_info) {
  const bool nested_execution = IsHIRCorrectnessExecutionActive();
  const bool execute_correctness =
      nested_execution || GetProbeExecuteCorrectnessOnAssemble();
  uint32_t block_count = 0, instruction_count = 0;
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
  const bool call_registered = RegisterWasmBackendCallFunction(function, builder);
  std::fprintf(stderr, "R360_WASM_BACKEND_CALL%s address=0x%08X registered=%u status=%u functions=%u\n",
               nested_execution ? "_NESTED" : "", function ? function->address() : 0u,
               call_registered ? 1u : 0u, GetWasmBackendCallStatus(), GetWasmBackendCallFunctionCount());

  if (!nested_execution) {
    g_probe_telemetry.hir_blocks = block_count;
    g_probe_telemetry.hir_instructions = instruction_count;
    g_probe_telemetry.last_guest_address = function ? function->address() : 0;
    BuildWasmBackendProbe(builder);
    BuildWasmBackendCfgProbe(builder);
    const uint32_t active_base = r360_ppc_probe_guest_base();
    uint8_t* guest_host_base = memory ? memory->TranslateVirtual<uint8_t*>(active_base) : nullptr;
    BuildWasmBackendMemoryProbe(builder, guest_host_base, active_base, kProbeGuestSize);
    BuildWasmBackendFpuProbe(builder, guest_host_base, active_base, kProbeGuestSize);
    BuildWasmBackendVmxProbe(builder, guest_host_base, active_base, kProbeGuestSize);

    std::fprintf(stderr, "R360_WASM_BACKEND status=%u module_bytes=%u lowered=%u\n", GetWasmBackendProbeStatus(), GetWasmBackendProbeModuleSize(), GetWasmBackendProbeLoweredInstructions());
    std::fprintf(stderr, "R360_WASM_BACKEND_CFG status=%u module_bytes=%u lowered=%u\n", GetWasmBackendCfgProbeStatus(), GetWasmBackendCfgProbeModuleSize(), GetWasmBackendCfgProbeLoweredInstructions());
    std::fprintf(stderr, "R360_WASM_BACKEND_MEMORY status=%u module_bytes=%u lowered=%u guest_host=0x%08X\n", GetWasmBackendMemoryProbeStatus(), GetWasmBackendMemoryProbeModuleSize(), GetWasmBackendMemoryProbeLoweredInstructions(), static_cast<uint32_t>(reinterpret_cast<uintptr_t>(guest_host_base)));
    std::fprintf(stderr, "R360_WASM_BACKEND_FPU status=%u module_bytes=%u lowered=%u\n", GetWasmBackendFpuProbeStatus(), GetWasmBackendFpuProbeModuleSize(), GetWasmBackendFpuProbeLoweredInstructions());
    std::fprintf(stderr, "R360_WASM_BACKEND_VMX status=%u module_bytes=%u lowered=%u vector_ops=%u native_simd=%u scalarized_lanes=%u\n",
                 GetWasmBackendVmxProbeStatus(), GetWasmBackendVmxProbeModuleSize(),
                 GetWasmBackendVmxProbeLoweredInstructions(), GetWasmBackendVmxProbeVectorOps(),
                 GetWasmBackendVmxProbeNativeSimdOps(), GetWasmBackendVmxProbeScalarizedLaneOps());
  }

  HIRCorrectnessResult correctness;
  if (execute_correctness) {
    correctness = ExecuteHIRCorrectnessProbe(builder, memory);
  } else {
    // Production browser translation must be side-effect-free. Register/lower
    // the generated function, but leave execution to the persistent scheduler.
    correctness.supported = true;
  }
  if (!nested_execution) {
    g_probe_telemetry.correctness_instructions = correctness.instructions_executed;
    g_probe_telemetry.correctness_r3 = correctness.r3;
    g_probe_telemetry.correctness_status =
        !execute_correctness ? 4u
                             : (!correctness.supported
                                    ? 1u
                                    : (!correctness.reached_return_boundary ? 2u
                                                                           : 3u));
    g_probe_telemetry.correctness_blocker_kind = correctness.blocker_kind;
    g_probe_telemetry.correctness_blocker_opcode = correctness.blocker_opcode;
    g_probe_telemetry.correctness_blocker_address = correctness.blocker_address;
  }
  std::fprintf(stderr, "R360_EXEC%s mode=%s status=%u instructions=%u r3=%llu return_boundary=%u\n",
               nested_execution ? "_NESTED" : "",
               execute_correctness ? "execute" : "translate-only",
               !execute_correctness ? 4u : (correctness.supported ? (correctness.reached_return_boundary ? 3u : 2u) : 1u),
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
  g_probe_backend = this; SetHIRCorrectnessCallResolver(&ResolveNestedGuestCall); SetHIRCorrectnessAddressResolver(&ResolveNestedGuestAddress);
  std::fprintf(stderr, "R360_CALL_RESOLVERS_READY call=1 address=1 stable=1\n");
  machine_info_.supports_extended_load_store = false;
  auto& gprs = machine_info_.register_sets[0]; gprs.id=0; std::strcpy(gprs.name,"gpr"); gprs.types=xe::cpu::backend::MachineInfo::RegisterSet::INT_TYPES; gprs.count=7;
  auto& vecs = machine_info_.register_sets[1]; vecs.id=1; std::strcpy(vecs.name,"vec"); vecs.types=xe::cpu::backend::MachineInfo::RegisterSet::FLOAT_TYPES|xe::cpu::backend::MachineInfo::RegisterSet::VEC_TYPES; vecs.count=12;
  return true;
}
void ProbeBackend::CommitExecutableRange(uint32_t,uint32_t) {}
std::unique_ptr<xe::cpu::backend::Assembler> ProbeBackend::CreateAssembler(){return std::make_unique<ProbeAssembler>(this);}
std::unique_ptr<xe::cpu::GuestFunction> ProbeBackend::CreateGuestFunction(xe::cpu::Module* module,uint32_t address){return std::make_unique<ProbeGuestFunction>(module,address);}
uint64_t ProbeBackend::CalculateNextHostInstruction(xe::cpu::ThreadDebugInfo*,uint64_t){return 0;}
}  // namespace render360::xenia_web

extern "C" {
uint32_t r360_ppc_probe_assembled_functions(){return render360::xenia_web::GetProbeTelemetry().assembled_functions;}
uint32_t r360_ppc_probe_hir_block_count(){return render360::xenia_web::GetProbeTelemetry().hir_blocks;}
uint32_t r360_ppc_probe_hir_instruction_count(){return render360::xenia_web::GetProbeTelemetry().hir_instructions;}
uint32_t r360_ppc_probe_last_guest_address(){return render360::xenia_web::GetProbeTelemetry().last_guest_address;}
uint32_t r360_ppc_probe_correctness_status(){return render360::xenia_web::GetProbeTelemetry().correctness_status;}
uint32_t r360_ppc_probe_correctness_instructions(){return render360::xenia_web::GetProbeTelemetry().correctness_instructions;}
uint64_t r360_ppc_probe_correctness_r3(){return render360::xenia_web::GetProbeTelemetry().correctness_r3;}
uint32_t r360_ppc_probe_correctness_blocker_kind(){return render360::xenia_web::GetProbeTelemetry().correctness_blocker_kind;}
uint32_t r360_ppc_probe_correctness_blocker_opcode(){return render360::xenia_web::GetProbeTelemetry().correctness_blocker_opcode;}
uint32_t r360_ppc_probe_correctness_blocker_address(){return render360::xenia_web::GetProbeTelemetry().correctness_blocker_address;}
R360_WASM_EXPORT("r360_ppc_probe_set_execute_on_translate")
uint32_t r360_ppc_probe_set_execute_on_translate(uint32_t enabled){
  render360::xenia_web::SetProbeExecuteCorrectnessOnAssemble(enabled != 0);
  return render360::xenia_web::GetProbeExecuteCorrectnessOnAssemble() ? 1u : 0u;
}
R360_WASM_EXPORT("r360_ppc_probe_execute_on_translate")
uint32_t r360_ppc_probe_execute_on_translate(){
  return render360::xenia_web::GetProbeExecuteCorrectnessOnAssemble() ? 1u : 0u;
}
}
