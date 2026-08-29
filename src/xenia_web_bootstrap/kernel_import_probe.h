#ifndef RENDER360_XENIA_WEB_BOOTSTRAP_KERNEL_IMPORT_PROBE_H_
#define RENDER360_XENIA_WEB_BOOTSTRAP_KERNEL_IMPORT_PROBE_H_

#include <cstdint>

namespace render360::xenia_web {

void ResetKernelImportProbe();
bool RegisterKernelImportThunk(uint32_t thunk_address, uint32_t module_id,
                               uint32_t ordinal, bool implemented,
                               uint32_t r3_result);
bool ResolveKernelImportThunk(uint32_t thunk_address);
uint32_t KernelImportProbeCount();
uint32_t KernelImportProbeCalls();
uint32_t KernelImportProbeLastThunk();
uint32_t KernelImportProbeLastModule();
uint32_t KernelImportProbeLastOrdinal();
uint32_t KernelImportProbeLastStatus();

}  // namespace render360::xenia_web

extern "C" {
void r360_kernel_import_reset();
uint32_t r360_kernel_import_register(uint32_t thunk_address,
                                    uint32_t module_id,
                                    uint32_t ordinal,
                                    uint32_t implemented,
                                    uint32_t r3_result);
uint32_t r360_kernel_import_count();
uint32_t r360_kernel_import_calls();
uint32_t r360_kernel_import_last_thunk();
uint32_t r360_kernel_import_last_module();
uint32_t r360_kernel_import_last_ordinal();
uint32_t r360_kernel_import_last_status();
}

#endif
