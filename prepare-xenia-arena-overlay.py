#!/usr/bin/env python3
"""Generate the browser-only Xenia Arena allocation overlay.

Xenia requires every Arena chunk payload to be at least 16-byte aligned. The
pinned desktop implementation relies on malloc providing that alignment. That
assumption is not guaranteed by the standalone wasm32 libc configuration used
by the V33 translation probe, so the browser build uses Xenia's own aligned
allocation helpers while preserving Arena layout, chunk sizing and allocation
semantics.
"""
from pathlib import Path

ROOT = Path(__file__).resolve().parent
XENIA = ROOT / "upstream" / "xenia"
OVERLAY = ROOT / "build" / "xenia-web-overlay"
SOURCE = XENIA / "src/xenia/base/arena.cc"
DEST = OVERLAY / "xenia/base/arena.cc"

if not SOURCE.exists():
    raise SystemExit("Run ./fetch-xenia.sh first; upstream arena.cc is missing")

text = SOURCE.read_text(errors="strict")
include_anchor = '#include "xenia/base/math.h"\n'
if include_anchor not in text:
    raise SystemExit("Upstream arena.cc include anchor drifted")
text = text.replace(
    include_anchor,
    include_anchor + '#include "xenia/base/memory.h"\n',
    1,
)

alloc_anchor = '''Arena::Chunk::Chunk(size_t chunk_size)
    : next(nullptr), capacity(chunk_size), buffer(0), offset(0) {
  buffer = reinterpret_cast<uint8_t*>(malloc(capacity));
  assert_true((reinterpret_cast<size_t>(buffer) & size_t(15)) == 0,
              "16 byte alignment required");
}

Arena::Chunk::~Chunk() {
  if (buffer) {
    free(buffer);
  }
}
'''
replacement = '''Arena::Chunk::Chunk(size_t chunk_size)
    : next(nullptr), capacity(chunk_size), buffer(0), offset(0) {
#if defined(__EMSCRIPTEN__) || defined(XE_ARCH_WASM32)
  // Render360 browser host boundary: Xenia requires 16-byte Arena payload
  // alignment. Standalone wasm32 malloc is not relied on for that contract;
  // use Xenia's aligned allocator explicitly instead.
  buffer = reinterpret_cast<uint8_t*>(xe::memory::AlignedAlloc(capacity, 16));
#else
  buffer = reinterpret_cast<uint8_t*>(malloc(capacity));
#endif
  assert_true((reinterpret_cast<size_t>(buffer) & size_t(15)) == 0,
              "16 byte alignment required");
}

Arena::Chunk::~Chunk() {
  if (buffer) {
#if defined(__EMSCRIPTEN__) || defined(XE_ARCH_WASM32)
    xe::memory::AlignedFree(buffer);
#else
    free(buffer);
#endif
  }
}
'''
if alloc_anchor not in text:
    raise SystemExit("Upstream Arena chunk allocation block drifted")
text = text.replace(alloc_anchor, replacement, 1)

DEST.parent.mkdir(parents=True, exist_ok=True)
DEST.write_text(text)
print(f"Generated web Arena overlay: {DEST}")
print("Arena rule: preserve Xenia 16-byte chunk contract using explicit aligned allocation on wasm32")
