#include <cstdint>

#include "wasm_backend_call_probe.h"

namespace render360::xenia_web {

// Standalone Xenos CI links the authoritative sparse guest-memory model but
// intentionally does not link the PPC translator/backend. Executable-page
// invalidation is therefore meaningless in this GPU-only binary. The full
// Render360 bootstrap links wasm_backend_call_probe.cpp instead, where this
// hook performs real translated-code invalidation.
void InvalidateWasmBackendExecutableRange(uint32_t, uint32_t) {}

}  // namespace render360::xenia_web
