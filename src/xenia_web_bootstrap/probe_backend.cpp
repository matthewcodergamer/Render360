#include "probe_backend.h"

#include <cstdio>
#include <cstring>
#include <memory>

#include "hir_correctness_executor.h"
#include "kernel_import_probe.h"
#include "sparse_guest_memory.h"
#include "xex_pe_guest_loader.h"
#include "wasm_backend_call_probe.h"
#include "wasm_backend_cfg_probe.h"
#include "wasm_backend_fpu_probe.h"
#include "wasm_backend_memory_probe.h"
#include "wasm_backend_probe.h"
#include "wasm_backend_vmx_probe.h"
#include "xenia/cpu/function.h"
#include "xenia/cpu/function_debug_info.h"
#include "xenia/cpu/hir/block.h"
#include "xenia/cpu/hir/hir_builder.h"
#include "xenia/cpu/hir/instr.h"
#include "xenia/cpu/hir/opcodes.h"
#include "xenia/cpu/ppc/ppc_frontend.h"
#include "xenia/cpu/ppc/ppc_scanner.h"
#include "xenia/cpu/processor.h"
#include "xenia/memory.h"

extern "C" uint32_t r360_ppc_probe_guest_base();
extern "C" uint32_t r360_ppc_probe_loaded_size();
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

bool IsInLoadedProbeWindow(uint32_t address) {
  const uint32_t base = r360_ppc_probe_guest_base();
  const uint64_t end = uint64_t(base) + r360_ppc_probe_loaded_size();
  return address >= base && uint64_t(address) < end;
}

uint32_t ReadBigEndian32(const uint8_t* p) {
  return (uint32_t(p[0]) << 24) | (uint32_t(p[1]) << 16) |
         (uint32_t(p[2]) << 8) | uint32_t(p[3]);
}

uint64_t ReadBigEndian64(const uint8_t* p) {
  return (uint64_t(ReadBigEndian32(p)) << 32) | ReadBigEndian32(p + 4);
}

bool MatchSharedEpilogReturnSignature(uint32_t address,
                                      uint32_t* first_gpr_out) {
  auto read_word = [](uint32_t code_address, uint32_t* out) {
    if (!out) return false;
    uint8_t raw[4] = {};
    if (!ReadSparseGuestMemory(code_address, raw, sizeof(raw))) return false;
    *out = ReadBigEndian32(raw);
    return true;
  };

  uint32_t first = 0;
  if (!read_word(address, &first)) return false;
  const uint32_t first_gpr = (first >> 21) & 31u;
  if (first_gpr < 14u || first_gpr > 31u) return false;

  for (uint32_t reg = first_gpr; reg <= 31u; ++reg) {
    const uint32_t code_address = address + (reg - first_gpr) * 4u;
    uint32_t word = 0;
    if (!read_word(code_address, &word)) return false;
    const uint32_t primary = word >> 26;
    const uint32_t rt = (word >> 21) & 31u;
    const uint32_t ra = (word >> 16) & 31u;
    const uint32_t xo = word & 3u;
    int32_t disp = static_cast<int32_t>(word & 0x0000FFFCu);
    if (disp & 0x00008000) disp |= static_cast<int32_t>(0xFFFF0000u);
    const int32_t expected_disp = -16 - int32_t(31u - reg) * 8;
    if (primary != 58u || rt != reg || ra != 1u || xo != 0u ||
        disp != expected_disp) {
      return false;
    }
  }

  const uint32_t tail = address + (32u - first_gpr) * 4u;
  constexpr uint32_t kExpectedTail[] = {
      0x8181FFF8u,  // lwz r12,-8(r1)
      0x7D8803A6u,  // mtlr r12
      0x4E800020u,  // blr
  };
  for (uint32_t i = 0; i < 3u; ++i) {
    uint32_t word = 0;
    if (!read_word(tail + i * 4u, &word) || word != kExpectedTail[i]) {
      return false;
    }
  }

  if (first_gpr_out) *first_gpr_out = first_gpr;
  return true;
}

bool ExecuteSharedEpilogReturn(uint32_t address) {
  auto* context = GetHIRCorrectnessActiveContext();
  if (!context) {
    std::fprintf(stderr,
                 "R360_EPILOG_HELPER rejected target=0x%08X reason=no-context\n",
                 address);
    return false;
  }

  // Microsoft __restgprlr_N helpers are canonical Xenia kEpilogReturn
  // functions. The entry instruction identifies N as an `ld rN,disp(r1)`;
  // the helper then restores rN..r31, restores LR from -8(r1), and returns.
  // Execute those semantics against the live caller PPCContext instead of
  // constructing a standalone HIR builder for an interior helper entry.
  uint8_t first_raw[4] = {};
  if (!ReadSparseGuestMemory(address, first_raw, sizeof(first_raw))) {
    std::fprintf(stderr,
                 "R360_EPILOG_HELPER rejected target=0x%08X reason=code-unmapped fault=%u@0x%08X\n",
                 address, SparseGuestLastFaultCode(), SparseGuestLastFaultAddress());
    return false;
  }
  const uint32_t first = ReadBigEndian32(first_raw);
  const uint32_t primary = first >> 26;
  const uint32_t first_gpr = (first >> 21) & 31u;
  const uint32_t ra = (first >> 16) & 31u;
  int32_t first_disp = static_cast<int32_t>(first & 0x0000FFFCu);
  if (first_disp & 0x00008000) first_disp |= static_cast<int32_t>(0xFFFF0000u);
  const int32_t expected_disp = -16 - int32_t(31u - first_gpr) * 8;
  if (primary != 58u || ra != 1u || first_gpr < 14u || first_gpr > 31u ||
      first_disp != expected_disp) {
    std::fprintf(stderr,
                 "R360_EPILOG_HELPER rejected target=0x%08X insn=0x%08X rt=%u ra=%u disp=%d expected=%d\n",
                 address, first, first_gpr, ra, first_disp, expected_disp);
    return false;
  }

  const uint32_t r1 = static_cast<uint32_t>(context->r[1]);
  for (uint32_t reg = first_gpr; reg <= 31u; ++reg) {
    const int32_t disp = -16 - int32_t(31u - reg) * 8;
    const uint32_t ea = r1 + static_cast<uint32_t>(disp);
    uint8_t raw[8] = {};
    if (!ReadSparseGuestMemory(ea, raw, sizeof(raw))) {
      std::fprintf(stderr,
                   "R360_EPILOG_HELPER load-fail target=0x%08X r%u ea=0x%08X fault=%u@0x%08X\n",
                   address, reg, ea, SparseGuestLastFaultCode(),
                   SparseGuestLastFaultAddress());
      return false;
    }
    context->r[reg] = ReadBigEndian64(raw);
  }

  const uint32_t lr_ea = r1 - 8u;
  uint8_t lr_raw[4] = {};
  if (!ReadSparseGuestMemory(lr_ea, lr_raw, sizeof(lr_raw))) {
    std::fprintf(stderr,
                 "R360_EPILOG_HELPER lr-fail target=0x%08X ea=0x%08X fault=%u@0x%08X\n",
                 address, lr_ea, SparseGuestLastFaultCode(),
                 SparseGuestLastFaultAddress());
    return false;
  }
  context->lr = ReadBigEndian32(lr_raw);
  std::fprintf(stderr,
               "R360_EPILOG_HELPER executed target=0x%08X first_gpr=%u r1=0x%08X lr=0x%08X\n",
               address, first_gpr, r1, static_cast<uint32_t>(context->lr));
  return true;
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
  const uint32_t call_flags = GetHIRCorrectnessCurrentCallFlags();
  const bool is_tail = (call_flags & xe::cpu::hir::CALL_TAIL) != 0;

  // Xenia explicitly registers the Microsoft shared __restgprlr_* entries as
  // kEpilogReturn functions. They are valid tail-call entry points in their own
  // right: the caller has already restored r1 before branching into the helper,
  // and the helper consumes that live caller frame. Do not remap one of these
  // entries back to an enclosing .pdata owner and then jump into the middle of
  // the owner's HIR. Doing that skips HIR value definitions emitted before the
  // SOURCE_OFFSET marker and turns a valid stack load into a fake
  // guest-memory-dependency with faultAddress == 0.
  auto* target_function = g_probe_backend->processor()->QueryFunction(address);
  const bool epilog_by_metadata =
      target_function &&
      target_function->behavior() == xe::cpu::Function::Behavior::kEpilogReturn;
  uint32_t signature_first_gpr = 0;
  const bool epilog_by_signature =
      is_tail && MatchSharedEpilogReturnSignature(address, &signature_first_gpr);
  const bool is_epilog_return = epilog_by_metadata || epilog_by_signature;

  if (is_tail && is_epilog_return) {
    const bool helper_ok = ExecuteSharedEpilogReturn(address);
    std::fprintf(stderr,
                 "R360_CALL_RESOLVE epilog-inline target=0x%08X flags=0x%X meta=%u signature=%u first_gpr=%u result=%u\n",
                 address, call_flags, epilog_by_metadata ? 1u : 0u,
                 epilog_by_signature ? 1u : 0u, signature_first_gpr,
                 helper_ok ? 1u : 0u);
    return helper_ok;
  }

  uint32_t fn_begin = address, fn_end = 0, prolog = 0;
  bool pdata = PreparedPeGuestFindRuntimeFunction(address, &fn_begin, &fn_end,
                                                  &prolog);
  if (pdata &&
      (fn_end <= fn_begin || uint64_t(fn_end) - fn_begin > kProbeGuestSize)) {
    pdata = false;
    fn_begin = address;
    fn_end = 0;
    prolog = 0;
  }

  // Ordinary tail fragments may inherit the owning .pdata function, but Xenia
  // shared epilog helpers are already canonical function entries. Keep those
  // exact, just like linked calls, while retaining the owner/interior route for
  // real compiler-generated tail fragments such as Braid's 0x8236EB74 path.
  const bool use_owner = is_tail && pdata && !is_epilog_return;
  if (!use_owner) {
    fn_begin = address;
    fn_end = 0;
    prolog = 0;
  }

  auto loaded = [&]() {
    return IsInLoadedProbeWindow(fn_begin) &&
           (!use_owner ||
            (fn_end >= fn_begin + 4 && IsInLoadedProbeWindow(fn_end - 4)));
  };
  std::fprintf(stderr,
               "R360_CALL_RESOLVE target=0x%08X function=0x%08X flags=0x%X "
               "tail=%u epilog=%u pdata=%u owner=%u prolog=%u\n",
               address, fn_begin, call_flags, is_tail ? 1u : 0u,
               is_epilog_return ? 1u : 0u, pdata ? 1u : 0u,
               use_owner ? 1u : 0u, prolog);

  if (!loaded()) {
    const uint32_t paged = r360_ppc_probe_page_sparse_code(fn_begin);
    if (!paged || !loaded()) {
      std::fprintf(stderr,
                   "R360_CALL_RESOLVE rejected: target/function unavailable "
                   "target=0x%08X function=0x%08X owner=%u\n",
                   address, fn_begin, use_owner ? 1u : 0u);
      return false;
    }
  }

  ProbeGuestFunction nested_function(module, fn_begin);
  const uint32_t loaded_base = r360_ppc_probe_guest_base();
  const uint32_t loaded_size = r360_ppc_probe_loaded_size();
  if (loaded_size < 4) return false;
  const uint32_t scan_end =
      use_owner ? fn_end - 4 : loaded_base + loaded_size - 4;
  nested_function.set_end_address(scan_end);

  xe::cpu::ppc::PPCScanner scanner(frontend);
  if (!scanner.Scan(&nested_function, nullptr)) {
    std::fprintf(stderr,
                 "R360_CALL_RESOLVE scan failed target=0x%08X function=0x%08X "
                 "owner=%u\n",
                 address, fn_begin, use_owner ? 1u : 0u);
    return false;
  }
  if (use_owner && nested_function.end_address() < address) {
    nested_function.set_end_address(scan_end);
  }

  const uint32_t interior_entry =
      use_owner && address != fn_begin ? address : 0u;
  SetHIRCorrectnessExecutionEntry(interior_entry);
  const bool translated = frontend->DefineFunction(&nested_function, 0);
  SetHIRCorrectnessExecutionEntry(0u);
  std::fprintf(stderr,
               "R360_CALL_RESOLVE translated target=0x%08X function=0x%08X "
               "end=0x%08X flags=0x%X owner=%u interior=0x%08X result=%u\n",
               address, fn_begin, nested_function.end_address(), call_flags,
               use_owner ? 1u : 0u, interior_entry, translated ? 1u : 0u);
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
