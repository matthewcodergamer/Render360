#!/usr/bin/env python3
"""Generate the browser-only ContextPromotionPass header overlay.

Pinned Xenia uses llvm::BitVector here only as a small mutable bit set for PPC
context byte offsets. Pulling the host LLVM Support library into a standalone
wasm32 link is wrong (the apt library is native x86_64), so the browser build
keeps Xenia's pass algorithm unchanged while replacing this private container
with an equivalent std::vector-backed bit set.
"""
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SOURCE = ROOT / "upstream/xenia/src/xenia/cpu/compiler/passes/context_promotion_pass.h"
DEST = ROOT / "build/xenia-web-overlay/xenia/cpu/compiler/passes/context_promotion_pass.h"

if not SOURCE.exists():
    raise SystemExit("Run ./fetch-xenia.sh first; context_promotion_pass.h is missing")

text = SOURCE.read_text(errors="strict")
start = text.find("#if XE_COMPILER_MSVC\n")
end_marker = "#endif  // XE_COMPILER_MSVC\n"
end = text.find(end_marker, start)
if start < 0 or end < 0:
    raise SystemExit("Upstream ContextPromotionPass header drifted: LLVM include block not found")
end += len(end_marker)

replacement = r'''// Browser portability boundary: this pass only needs resize/reset/test/set.
class Render360ContextBitVector {
 public:
  void resize(uint32_t size) { bits_.assign(size, 0); }
  void reset() { std::fill(bits_.begin(), bits_.end(), uint8_t{0}); }
  bool test(uint32_t index) const { return index < bits_.size() && bits_[index] != 0; }
  void set(uint32_t index) {
    if (index < bits_.size()) bits_[index] = 1;
  }

 private:
  std::vector<uint8_t> bits_;
};
'''
text = text[:start] + replacement + text[end:]
old = "  llvm::BitVector context_validity_;"
new = "  Render360ContextBitVector context_validity_;"
if old not in text:
    raise SystemExit("Upstream ContextPromotionPass header drifted: BitVector member not found")
text = text.replace(old, new, 1)

DEST.parent.mkdir(parents=True, exist_ok=True)
DEST.write_text(text)
print(f"Generated compiler portability overlay: {DEST}")
print("ContextPromotionPass algorithm unchanged; only private LLVM BitVector storage replaced for standalone wasm32")
