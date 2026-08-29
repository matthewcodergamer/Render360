#ifndef RENDER360_XENIA_WEB_BOOTSTRAP_PPC_TRANSLATION_PROBE_RUNTIME_H_
#define RENDER360_XENIA_WEB_BOOTSTRAP_PPC_TRANSLATION_PROBE_RUNTIME_H_

namespace xe {
class Memory;
}

namespace render360::xenia_web {

// Returns the same bounded Xenia Memory instance used by the PPC frontend.
// Browser title bytes outside its movable 64 KiB code window remain owned by
// SparseGuestMemory; GPU interpreter overlays redirect physical vertex reads to
// that authoritative sparse address space.
xe::Memory* ActiveProbeMemory();

}  // namespace render360::xenia_web

#endif
