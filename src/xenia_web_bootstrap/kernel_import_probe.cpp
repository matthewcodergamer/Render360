#include "kernel_import_probe.h"

#include <array>
#include <cstdint>

#include "hir_correctness_executor.h"
#include "title_gpu_runtime.h"
#include "xenia/cpu/ppc/ppc_context.h"

extern "C" {
uint32_t r360_kernel_service_call(uint32_t module, uint32_t ordinal,
                                  uint32_t r3, uint32_t r4, uint32_t r5,
                                  uint32_t r6, uint32_t r7, uint32_t r8,
                                  uint32_t r9, uint32_t r10);
uint32_t r360_kernel_service_status();
}

namespace render360::xenia_web {
namespace {
struct KernelImportEntry {
  uint32_t thunk_address = 0;
  uint32_t module_id = 0;
  uint32_t ordinal = 0;
  uint32_t abi_target = 0;
  bool implemented = false;
  bool used = false;
};

// V74 diagnostic-only ABI trace. This records the live PPC arguments and the
// result/status produced by the existing bounded kernel-service bridge. It does
// not change dispatch decisions, return values, guest memory or PPC execution.
struct KernelServiceTraceEntry {
  uint32_t sequence = 0;
  uint32_t thunk_address = 0;
  uint32_t module_id = 0;
  uint32_t ordinal = 0;
  std::array<uint32_t, 8> args{};
  uint32_t result = 0;
  uint32_t service_status = 0;
  uint32_t handled = 0;
  bool used = false;
};

constexpr uint32_t kMaxKernelImports = 256;
constexpr uint32_t kMaxKernelServiceTrace = 32;
constexpr uint32_t kModuleXboxkrnl = 1;
constexpr uint32_t kModuleXam = 2;
constexpr uint32_t kServiceStatusSuccess = 1;
constexpr uint32_t kServiceStatusInvalid = 3;
std::array<KernelImportEntry, kMaxKernelImports> g_entries{};
std::array<KernelServiceTraceEntry, kMaxKernelServiceTrace> g_service_trace{};
uint32_t g_count = 0, g_calls = 0, g_last_thunk = 0, g_last_module = 0,
         g_last_ordinal = 0, g_last_status = 0, g_last_abi_target = 0,
         g_service_trace_count = 0;

KernelServiceTraceEntry* BeginKernelServiceTrace(
    const KernelImportEntry& entry, xe::cpu::ppc::PPCContext* context) {
  if (!context || g_service_trace_count >= kMaxKernelServiceTrace) return nullptr;
  auto& trace = g_service_trace[g_service_trace_count++];
  trace = {};
  trace.used = true;
  trace.sequence = g_calls;
  trace.thunk_address = entry.thunk_address;
  trace.module_id = entry.module_id;
  trace.ordinal = entry.ordinal;
  for (uint32_t i = 0; i < trace.args.size(); ++i) {
    trace.args[i] = static_cast<uint32_t>(context->r[3 + i]);
  }
  return &trace;
}

void FinishKernelServiceTrace(KernelServiceTraceEntry* trace, uint32_t result,
                              uint32_t service_status, bool handled) {
  if (!trace) return;
  trace->result = result;
  trace->service_status = service_status;
  trace->handled = handled ? 1u : 0u;
}

bool TryBuiltInKernelService(const KernelImportEntry& entry,
                             xe::cpu::ppc::PPCContext* context) {
  if (entry.module_id != kModuleXboxkrnl && entry.module_id != kModuleXam) {
    return false;
  }
  if (!context) {
    g_last_status = kServiceStatusInvalid;
    return false;
  }

  KernelServiceTraceEntry* trace = BeginKernelServiceTrace(entry, context);
  uint32_t title_gpu_result = 0;
  if (TryTitleGpuKernelService(
          entry.module_id, entry.ordinal,
          static_cast<uint32_t>(context->r[3]),
          static_cast<uint32_t>(context->r[4]),
          static_cast<uint32_t>(context->r[5]),
          static_cast<uint32_t>(context->r[6]),
          static_cast<uint32_t>(context->r[7]),
          static_cast<uint32_t>(context->r[8]),
          static_cast<uint32_t>(context->r[9]),
          static_cast<uint32_t>(context->r[10]), &title_gpu_result)) {
    context->r[3] = title_gpu_result;
    g_last_status = kServiceStatusSuccess;
    FinishKernelServiceTrace(trace, title_gpu_result, kServiceStatusSuccess,
                             true);
    return true;
  }

  const uint32_t result = r360_kernel_service_call(
      entry.module_id, entry.ordinal,
      static_cast<uint32_t>(context->r[3]),
      static_cast<uint32_t>(context->r[4]),
      static_cast<uint32_t>(context->r[5]),
      static_cast<uint32_t>(context->r[6]),
      static_cast<uint32_t>(context->r[7]),
      static_cast<uint32_t>(context->r[8]),
      static_cast<uint32_t>(context->r[9]),
      static_cast<uint32_t>(context->r[10]));
  const uint32_t service_status = r360_kernel_service_status();
  FinishKernelServiceTrace(trace, result, service_status,
                           service_status == kServiceStatusSuccess);
  if (service_status != kServiceStatusSuccess) {
    // Keep unsupported services as the exact title blocker. Invalid service
    // state (for example TLS without a current guest thread) is distinguished
    // as an ABI/runtime failure rather than silently becoming success.
    if (service_status == kServiceStatusInvalid)
      g_last_status = kServiceStatusInvalid;
    return false;
  }

  context->r[3] = result;
  g_last_status = kServiceStatusSuccess;
  return true;
}

const KernelImportEntry* FindKernelImport(uint32_t thunk_address) {
  for (const auto& entry : g_entries) {
    if (entry.used && entry.thunk_address == thunk_address) return &entry;
  }
  return nullptr;
}

void RecordKernelImportCall(const KernelImportEntry& entry) {
  ++g_calls;
  g_last_thunk = entry.thunk_address;
  g_last_module = entry.module_id;
  g_last_ordinal = entry.ordinal;
  g_last_abi_target = entry.abi_target;
}

const KernelServiceTraceEntry* KernelServiceTraceAt(uint32_t index) {
  if (index >= g_service_trace_count || index >= kMaxKernelServiceTrace ||
      !g_service_trace[index].used) {
    return nullptr;
  }
  return &g_service_trace[index];
}
}  // namespace

void ResetKernelImportProbe() {
  g_entries = {};
  g_service_trace = {};
  g_count = g_calls = g_last_thunk = g_last_module = g_last_ordinal =
      g_last_status = g_last_abi_target = g_service_trace_count = 0;
  ResetTitleGpuRuntime();
}
bool RegisterKernelImportThunk(uint32_t thunk_address, uint32_t module_id,
                               uint32_t ordinal, bool implemented,
                               uint32_t abi_target) {
  if (!thunk_address || !module_id || ordinal > 0xFFFFu) return false;
  for (auto& entry : g_entries) {
    if (entry.used && entry.thunk_address == thunk_address) {
      entry.module_id = module_id;
      entry.ordinal = ordinal;
      entry.implemented = implemented;
      entry.abi_target = abi_target;
      return true;
    }
  }
  for (auto& entry : g_entries) {
    if (!entry.used) {
      entry.used = true;
      entry.thunk_address = thunk_address;
      entry.module_id = module_id;
      entry.ordinal = ordinal;
      entry.implemented = implemented;
      entry.abi_target = abi_target;
      ++g_count;
      return true;
    }
  }
  return false;
}
bool ResolveKernelImportThunk(uint32_t thunk_address) {
  const auto* entry = FindKernelImport(thunk_address);
  if (!entry) return false;
  RecordKernelImportCall(*entry);
  if (!entry->implemented) {
    // Real title imports are registered from decoded XEX metadata. Before
    // declaring one unimplemented, let the bounded built-in xboxkrnl/XAM
    // service layer consume the live PPC r3..r10 ABI. Unsupported ordinals
    // still fail closed and remain the next genuine title blocker.
    g_last_status = 2;
    return TryBuiltInKernelService(*entry, GetHIRCorrectnessActiveContext());
  }
  // A zero ABI target preserves the locked control-flow-only bridge. A
  // non-zero target asks ProbeBackend to execute a bounded ABI critic through
  // the same active PPCContext as the translated caller. This lets CI prove
  // argument registers, guest-memory access, r3 return state and continuation
  // without introducing blanket-success kernel stubs.
  g_last_status = 1;
  return true;
}

bool DispatchKernelImportThunkFromContext(
    uint32_t thunk_address, xe::cpu::ppc::PPCContext* context) {
  const auto* entry = FindKernelImport(thunk_address);
  if (!entry || !context) {
    g_last_status = kServiceStatusInvalid;
    return false;
  }
  RecordKernelImportCall(*entry);

  // Generated-Wasm execution can directly use the native built-in service
  // layer because it passes the real live PPCContext pointer. Explicit
  // test-only/legacy implemented targets are not blanket-successed here: a
  // non-zero ABI target needs the ProbeBackend HIR execution path and therefore
  // remains fail-closed in the generated runtime until that target is compiled
  // as a normal guest function.
  if (entry->implemented) {
    g_last_status = entry->abi_target ? kServiceStatusInvalid : 2u;
    return false;
  }
  g_last_status = 2;
  return TryBuiltInKernelService(*entry, context);
}
uint32_t KernelImportProbeCount() { return g_count; }
uint32_t KernelImportProbeCalls() { return g_calls; }
uint32_t KernelImportProbeLastThunk() { return g_last_thunk; }
uint32_t KernelImportProbeLastModule() { return g_last_module; }
uint32_t KernelImportProbeLastOrdinal() { return g_last_ordinal; }
uint32_t KernelImportProbeLastStatus() { return g_last_status; }
uint32_t KernelImportProbeLastAbiTarget() { return g_last_abi_target; }
uint32_t KernelImportServiceTraceCount() { return g_service_trace_count; }
uint32_t KernelImportServiceTraceSequence(uint32_t index) {
  const auto* trace = KernelServiceTraceAt(index);
  return trace ? trace->sequence : 0u;
}
uint32_t KernelImportServiceTraceThunk(uint32_t index) {
  const auto* trace = KernelServiceTraceAt(index);
  return trace ? trace->thunk_address : 0u;
}
uint32_t KernelImportServiceTraceModule(uint32_t index) {
  const auto* trace = KernelServiceTraceAt(index);
  return trace ? trace->module_id : 0u;
}
uint32_t KernelImportServiceTraceOrdinal(uint32_t index) {
  const auto* trace = KernelServiceTraceAt(index);
  return trace ? trace->ordinal : 0u;
}
uint32_t KernelImportServiceTraceArg(uint32_t index, uint32_t arg_index) {
  const auto* trace = KernelServiceTraceAt(index);
  return trace && arg_index < trace->args.size() ? trace->args[arg_index] : 0u;
}
uint32_t KernelImportServiceTraceResult(uint32_t index) {
  const auto* trace = KernelServiceTraceAt(index);
  return trace ? trace->result : 0u;
}
uint32_t KernelImportServiceTraceStatus(uint32_t index) {
  const auto* trace = KernelServiceTraceAt(index);
  return trace ? trace->service_status : 0u;
}
uint32_t KernelImportServiceTraceHandled(uint32_t index) {
  const auto* trace = KernelServiceTraceAt(index);
  return trace ? trace->handled : 0u;
}
void MarkKernelImportProbeAbiFailure() { g_last_status = 3; }
}  // namespace render360::xenia_web

extern "C" {
void r360_kernel_import_reset() {
  render360::xenia_web::ResetKernelImportProbe();
}
uint32_t r360_kernel_import_register(uint32_t a, uint32_t m, uint32_t o,
                                     uint32_t i, uint32_t r) {
  return render360::xenia_web::RegisterKernelImportThunk(a, m, o, i != 0, r)
             ? 1u
             : 0u;
}
uint32_t r360_kernel_import_dispatch_context(uint32_t thunk_address,
                                             uint32_t context_ptr) {
  if (!context_ptr ||
      (context_ptr & (alignof(xe::cpu::ppc::PPCContext) - 1u)) != 0u) {
    return 0;
  }
  auto* context = reinterpret_cast<xe::cpu::ppc::PPCContext*>(
      static_cast<uintptr_t>(context_ptr));
  return render360::xenia_web::DispatchKernelImportThunkFromContext(
             thunk_address, context)
             ? 1u
             : 0u;
}
uint32_t r360_kernel_import_count() {
  return render360::xenia_web::KernelImportProbeCount();
}
uint32_t r360_kernel_import_calls() {
  return render360::xenia_web::KernelImportProbeCalls();
}
uint32_t r360_kernel_import_last_thunk() {
  return render360::xenia_web::KernelImportProbeLastThunk();
}
uint32_t r360_kernel_import_last_module() {
  return render360::xenia_web::KernelImportProbeLastModule();
}
uint32_t r360_kernel_import_last_ordinal() {
  return render360::xenia_web::KernelImportProbeLastOrdinal();
}
uint32_t r360_kernel_import_last_status() {
  return render360::xenia_web::KernelImportProbeLastStatus();
}
uint32_t r360_kernel_import_trace_count() {
  return render360::xenia_web::KernelImportServiceTraceCount();
}
uint32_t r360_kernel_import_trace_sequence(uint32_t index) {
  return render360::xenia_web::KernelImportServiceTraceSequence(index);
}
uint32_t r360_kernel_import_trace_thunk(uint32_t index) {
  return render360::xenia_web::KernelImportServiceTraceThunk(index);
}
uint32_t r360_kernel_import_trace_module(uint32_t index) {
  return render360::xenia_web::KernelImportServiceTraceModule(index);
}
uint32_t r360_kernel_import_trace_ordinal(uint32_t index) {
  return render360::xenia_web::KernelImportServiceTraceOrdinal(index);
}
uint32_t r360_kernel_import_trace_arg(uint32_t index, uint32_t arg_index) {
  return render360::xenia_web::KernelImportServiceTraceArg(index, arg_index);
}
uint32_t r360_kernel_import_trace_result(uint32_t index) {
  return render360::xenia_web::KernelImportServiceTraceResult(index);
}
uint32_t r360_kernel_import_trace_status(uint32_t index) {
  return render360::xenia_web::KernelImportServiceTraceStatus(index);
}
uint32_t r360_kernel_import_trace_handled(uint32_t index) {
  return render360::xenia_web::KernelImportServiceTraceHandled(index);
}
}