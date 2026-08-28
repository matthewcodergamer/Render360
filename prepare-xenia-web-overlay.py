#!/usr/bin/env python3
"""Generate browser-only overlays for compiling upstream Xenia on wasm32.

The overlays preserve upstream Xbox/PPC behavior. They adapt only host ABI and
compiler-language seams needed by Emscripten. Generated files live under
build/ and are never committed as a forked copy of upstream Xenia.
"""
from pathlib import Path

ROOT = Path(__file__).resolve().parent
XENIA = ROOT / "upstream" / "xenia"
OVERLAY = ROOT / "build" / "xenia-web-overlay"

PPC_CONTEXT_SOURCE = XENIA / "src/xenia/cpu/ppc/ppc_context.h"
PPC_CONTEXT_DEST = OVERLAY / "xenia/cpu/ppc/ppc_context.h"
CVAR_SOURCE = XENIA / "src/xenia/base/cvar.cc"
CVAR_DEST = OVERLAY / "xenia/base/cvar.cc"

if not PPC_CONTEXT_SOURCE.exists():
    raise SystemExit("Run ./fetch-xenia.sh first; upstream PPCContext header is missing")
if not CVAR_SOURCE.exists():
    raise SystemExit("Run ./fetch-xenia.sh first; upstream cvar.cc is missing")

# PPCContext: wasm32 host pointers are 32-bit, making the upstream context 16
# bytes short of Xenia's existing 64-byte size invariant. Add tail-only padding
# after the final data member so every existing architectural/runtime offset is
# unchanged.
text = PPC_CONTEXT_SOURCE.read_text(errors="strict")
needle = "  // Value of last reserved load\n  uint64_t reserved_val;\n"
if needle not in text:
    raise SystemExit("Upstream PPCContext layout drifted: reserved_val anchor not found")
replacement = needle + (
    "\n#if defined(__EMSCRIPTEN__) || defined(XE_ARCH_WASM32)\n"
    "  // Render360 web ABI: compensate for 32-bit host pointers without\n"
    "  // moving any existing PPCContext field. Keep this as tail padding.\n"
    "  uint8_t render360_wasm32_tail_padding[16];\n"
    "#endif\n"
)
text = text.replace(needle, replacement, 1)
PPC_CONTEXT_DEST.parent.mkdir(parents=True, exist_ok=True)
PPC_CONTEXT_DEST.write_text(text)

# cvar.cc: this pinned Xenia revision predates C++20's char8_t type and uses u8
# literals directly with std::string. Emscripten's modern Clang correctly makes
# those literals char8_t, which is source-incompatible with that old utility.
# All u8 literals in this unit are ASCII TOML/escape syntax, so removing only
# the u8 prefix preserves the exact byte strings while leaving Xenia's cvar
# implementation and registry logic intact.
cvar_text = CVAR_SOURCE.read_text(errors="strict")
u8_count = cvar_text.count('u8"')
if u8_count == 0:
    raise SystemExit("Upstream cvar.cc UTF-8 literal pattern drifted: no u8 literals found")
cvar_text = cvar_text.replace('u8"', '"')
CVAR_DEST.parent.mkdir(parents=True, exist_ok=True)
CVAR_DEST.write_text(cvar_text)

print(f"Generated web PPCContext overlay: {PPC_CONTEXT_DEST}")
print("ABI rule: upstream field offsets unchanged; wasm32 tail padded by 16 bytes")
print(f"Generated web cvar source overlay: {CVAR_DEST}")
print(f"UTF-8 rule: normalized {u8_count} legacy u8 literals to identical narrow byte literals")
