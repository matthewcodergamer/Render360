#!/usr/bin/env python3
"""Generate browser-only header overlays for compiling upstream Xenia on wasm32.

The overlay preserves upstream Xbox/PPC semantics. It only adapts host ABI details
that differ because WebAssembly uses 32-bit pointers. Generated files live under
build/ and are never treated as upstream source replacements.
"""
from pathlib import Path
import shutil
import sys

ROOT = Path(__file__).resolve().parent
XENIA = ROOT / "upstream" / "xenia"
OVERLAY = ROOT / "build" / "xenia-web-overlay"

SOURCE = XENIA / "src/xenia/cpu/ppc/ppc_context.h"
DEST = OVERLAY / "xenia/cpu/ppc/ppc_context.h"

if not SOURCE.exists():
    raise SystemExit("Run ./fetch-xenia.sh first; upstream PPCContext header is missing")

text = SOURCE.read_text(errors="strict")
needle = "  // Value of last reserved load\n  uint64_t reserved_val;\n"
if needle not in text:
    raise SystemExit("Upstream PPCContext layout drifted: reserved_val anchor not found")

# On wasm32, Xenia's packed PPCContext is 16 bytes short of the existing
# 64-byte padding invariant because host pointers are 32-bit rather than
# 64-bit. Add tail-only padding after the final data member. This leaves every
# existing architectural/runtime field offset unchanged while restoring the
# invariant expected by Xenia's context allocation code.
replacement = needle + (
    "\n#if defined(__EMSCRIPTEN__) || defined(XE_ARCH_WASM32)\n"
    "  // Render360 web ABI: compensate for 32-bit host pointers without\n"
    "  // moving any existing PPCContext field. Keep this as tail padding.\n"
    "  uint8_t render360_wasm32_tail_padding[16];\n"
    "#endif\n"
)
text = text.replace(needle, replacement, 1)

DEST.parent.mkdir(parents=True, exist_ok=True)
DEST.write_text(text)

print(f"Generated web PPCContext overlay: {DEST}")
print("ABI rule: upstream field offsets unchanged; wasm32 tail padded by 16 bytes")
