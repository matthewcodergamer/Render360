#!/usr/bin/env python3
"""Generate the browser-only Xenia Arena allocation overlay.

Xenia requires every Arena chunk payload to be at least 16-byte aligned. The
pinned desktop implementation relies on malloc providing that alignment. That
assumption is not guaranteed by the standalone wasm32 libc configuration used
by the V33 translation probe, so the browser build explicitly requests the
required alignment while preserving Arena layout, chunk sizing and allocation
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
  // Render360 browser host boundary: keep Xenia's exact 16-byte Arena payload
  // contract while allocating the full arbitrary-sized chunk. The standalone
  // wasm32 libc build does not guarantee that plain malloc is 16-byte aligned.
  void* aligned_buffer = nullptr;
  if (posix_memalign(&aligned_buffer, 16, capacity) != 0) {
    aligned_buffer = nullptr;
  }
  buffer = reinterpret_cast<uint8_t*>(aligned_buffer);
#else
  buffer = reinterpret_cast<uint8_t*>(malloc(capacity));
#endif
  assert_not_null(buffer);
  assert_true((reinterpret_cast<size_t>(buffer) & size_t(15)) == 0,
              "16 byte alignment required");
}

Arena::Chunk::~Chunk() {
  if (buffer) {
    free(buffer);
  }
}
'''
if alloc_anchor not in text:
    raise SystemExit("Upstream Arena chunk allocation block drifted")
text = text.replace(alloc_anchor, replacement, 1)

# Render360 keeps finalized HIR builders for re-execution (probe_backend.cpp
# translation cache), so an arena's first chunk is its minimum footprint.
# Use 64 KiB chunks instead of Xenia's 4 MiB and give an allocation larger
# than a chunk its own chunk (upstream asserts "need to support larger
# chunks", which NDEBUG compiles out).
ctor_anchor = """Arena::Arena(size_t chunk_size)
    : chunk_size_(chunk_size), head_chunk_(nullptr), active_chunk_(nullptr) {}"""
ctor_new = """Arena::Arena(size_t chunk_size)
    : chunk_size_(chunk_size < 64 * 1024 ? chunk_size : 64 * 1024),
      head_chunk_(nullptr),
      active_chunk_(nullptr) {}"""
grow_anchor = """      Chunk* next = active_chunk_->next;
      if (!next) {
        assert_true(size + get_padding() < chunk_size_,
                    "need to support larger chunks");
        next = new Chunk(chunk_size_);
        active_chunk_->next = next;
      }"""
grow_new = """      Chunk* next = active_chunk_->next;
      const size_t needed = size + 16 + 4_KiB;
      if (!next || next->capacity < needed) {
        Chunk* fresh = new Chunk(needed > chunk_size_ ? needed : chunk_size_);
        fresh->next = next;
        active_chunk_->next = fresh;
        next = fresh;
      }"""
head_anchor = """    head_chunk_ = active_chunk_ = new Chunk(chunk_size_);"""
head_new = """    const size_t needed = size + 16 + 4_KiB;
    head_chunk_ = active_chunk_ =
        new Chunk(needed > chunk_size_ ? needed : chunk_size_);"""
for a, b, name in ((ctor_anchor, ctor_new, "constructor"), (grow_anchor, grow_new, "chunk growth"), (head_anchor, head_new, "first chunk")):
    if text.count(a) != 1:
        raise SystemExit(f"Upstream Arena {name} drifted")
    text = text.replace(a, b, 1)

DEST.parent.mkdir(parents=True, exist_ok=True)
DEST.write_text(text)
print(f"Generated web Arena overlay: {DEST}")
print("Arena rule: preserve Xenia 16-byte chunk contract with arbitrary-size posix_memalign on wasm32")
