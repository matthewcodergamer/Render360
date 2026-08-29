#include "kernel_import_probe.h"

#include <array>

namespace render360::xenia_web {
namespace {
struct KernelImportEntry {
  uint32_t thunk_address = 0;
  uint32_t module_id = 0;
  uint32_t ordinal = 0;
  uint32_t r3_result = 0;
  bool implemented = false;
  bool used = false;
};
constexpr uint32_t kMaxKernelImports = 256;
std::array<KernelImportEntry, kMaxKernelImports> g_entries{};
uint32_t g_count = 0, g_calls = 0, g_last_thunk = 0, g_last_module = 0,
         g_last_ordinal = 0, g_last_status = 0;
}  // namespace

void ResetKernelImportProbe() {
  g_entries = {}; g_count = g_calls = g_last_thunk = g_last_module =
      g_last_ordinal = g_last_status = 0;
}
bool RegisterKernelImportThunk(uint32_t thunk_address, uint32_t module_id,
                               uint32_t ordinal, bool implemented,
                               uint32_t r3_result) {
  if (!thunk_address || !module_id || ordinal > 0xFFFFu) return false;
  for (auto& entry : g_entries) {
    if (entry.used && entry.thunk_address == thunk_address) {
      entry.module_id = module_id; entry.ordinal = ordinal;
      entry.implemented = implemented; entry.r3_result = r3_result; return true;
    }
  }
  for (auto& entry : g_entries) {
    if (!entry.used) {
      entry.used = true; entry.thunk_address = thunk_address;
      entry.module_id = module_id; entry.ordinal = ordinal;
      entry.implemented = implemented; entry.r3_result = r3_result;
      ++g_count; return true;
    }
  }
  return false;
}
bool ResolveKernelImportThunk(uint32_t thunk_address) {
  for (const auto& entry : g_entries) {
    if (!entry.used || entry.thunk_address != thunk_address) continue;
    ++g_calls; g_last_thunk = entry.thunk_address; g_last_module = entry.module_id;
    g_last_ordinal = entry.ordinal;
    if (!entry.implemented) { g_last_status = 2; return false; }
    // The first HLE bridge contract is control-flow dispatch. Return-value ABI
    // mutation is deliberately a separate contract so the locked Run-351 HIR
    // executor remains byte-for-byte unchanged.
    g_last_status = 1; return true;
  }
  return false;
}
uint32_t KernelImportProbeCount() { return g_count; }
uint32_t KernelImportProbeCalls() { return g_calls; }
uint32_t KernelImportProbeLastThunk() { return g_last_thunk; }
uint32_t KernelImportProbeLastModule() { return g_last_module; }
uint32_t KernelImportProbeLastOrdinal() { return g_last_ordinal; }
uint32_t KernelImportProbeLastStatus() { return g_last_status; }
}  // namespace render360::xenia_web

extern "C" {
void r360_kernel_import_reset(){render360::xenia_web::ResetKernelImportProbe();}
uint32_t r360_kernel_import_register(uint32_t a,uint32_t m,uint32_t o,uint32_t i,uint32_t r){return render360::xenia_web::RegisterKernelImportThunk(a,m,o,i!=0,r)?1u:0u;}
uint32_t r360_kernel_import_count(){return render360::xenia_web::KernelImportProbeCount();}
uint32_t r360_kernel_import_calls(){return render360::xenia_web::KernelImportProbeCalls();}
uint32_t r360_kernel_import_last_thunk(){return render360::xenia_web::KernelImportProbeLastThunk();}
uint32_t r360_kernel_import_last_module(){return render360::xenia_web::KernelImportProbeLastModule();}
uint32_t r360_kernel_import_last_ordinal(){return render360::xenia_web::KernelImportProbeLastOrdinal();}
uint32_t r360_kernel_import_last_status(){return render360::xenia_web::KernelImportProbeLastStatus();}
}
