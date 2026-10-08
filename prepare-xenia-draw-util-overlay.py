#!/usr/bin/env python3
"""Generate the Xenia draw_util overlay for the software Xenos backend.

GetResolveInfo reads the resolve rectangle (D3D9 always places it in vertex
fetch constant 0) through Memory::TranslatePhysical. Render360 keeps guest
physical memory in SparseGuestMemory, so that one read goes through the kernel's
physical-to-virtual map instead. Everything else is upstream.
"""
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SOURCE = ROOT / "upstream" / "xenia" / "src/xenia/gpu/draw_util.cc"
DEST = ROOT / "build" / "xenia-web-overlay" / "xenia/gpu/draw_util.cc"
if not SOURCE.exists():
    raise SystemExit("Run ./fetch-xenia.sh first; upstream draw_util.cc is missing")
text = SOURCE.read_text(errors="strict")
anchor = """  trace_writer.WriteMemoryRead(fetch.address * sizeof(uint32_t),
                               fetch.size * sizeof(uint32_t));
  const float* vertices_guest = reinterpret_cast<const float*>(
      memory.TranslatePhysical(fetch.address * sizeof(uint32_t)));
"""
replacement = """  // Render360: guest physical memory lives in SparseGuestMemory.
  float vertices_guest[6] = {};
  if (!render360::xenia_web::ReadSparseGuestMemory(
          r360_kernel_gpu_address_to_virtual(fetch.address * sizeof(uint32_t)),
          vertices_guest, sizeof(vertices_guest))) {
    XELOGE("Resolve vertex buffer is not mapped");
    return false;
  }
"""
if text.count(anchor) != 1:
    raise SystemExit("draw_util overlay: resolve vertex read anchor changed")
text = text.replace(anchor, replacement)
include_anchor = '#include "xenia/gpu/draw_util.h"\n'
if text.count(include_anchor) != 1:
    raise SystemExit("draw_util overlay: include anchor changed")
text = text.replace(include_anchor, include_anchor +
                    '#include "sparse_guest_memory.h"\n'
                    'extern "C" uint32_t r360_kernel_gpu_address_to_virtual(uint32_t address);\n')
DEST.parent.mkdir(parents=True, exist_ok=True)
DEST.write_text(text)
print(f"Generated draw_util overlay: {DEST}")
