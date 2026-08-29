#!/usr/bin/env python3
"""Relocate the bounded Xenia wasm32 translation-probe code window.

The base Xenia web overlay intentionally gives the real PPC scanner only a
64 KiB code window instead of pretending wasm32 can reserve Xenia's desktop
4.5 GiB address space. Early probes fixed that window at 0x80000000. Real XEX
bring-up needs the same bounded window to follow the decoder-derived title entry
address (for example 0x91000020) without expanding the backing allocation.

This pass runs after prepare-xenia-web-overlay.py and changes only the wasm32
probe host-address translation seam. Xbox/PPC semantics and the 64 KiB bound
remain unchanged.
"""
from pathlib import Path

ROOT = Path(__file__).resolve().parent
HEADER = ROOT / "build" / "xenia-web-overlay" / "xenia" / "memory.h"

if not HEADER.exists():
    raise SystemExit("Run prepare-xenia-web-overlay.py first; generated memory.h is missing")

text = HEADER.read_text(errors="strict")

namespace_anchor = "namespace xe {\n"
if namespace_anchor not in text:
    raise SystemExit("Generated Xenia memory.h namespace anchor drifted")

# ppc_translation_probe.cpp already exports this getter. It is deliberately a
# telemetry-only read: no Memory calls, allocation, or recursion occur here.
decl = 'extern "C" uint32_t r360_ppc_probe_guest_base();\n\n'
if decl not in text:
    text = text.replace(namespace_anchor, decl + namespace_anchor, 1)

fixed = "    constexpr uint32_t kRender360ProbeGuestBase = 0x80000000u;\n"
reloc = (
    "    const uint32_t kRender360ProbeGuestBase =\n"
    "        r360_ppc_probe_guest_base();\n"
)
if fixed not in text:
    if reloc not in text:
        raise SystemExit("Generated Xenia memory.h probe-base anchor drifted")
else:
    text = text.replace(fixed, reloc, 1)

HEADER.write_text(text)
print(f"Relocated bounded wasm32 PPC scanner window: {HEADER}")
print("Memory rule: 64 KiB backing remains fixed-size; guest base follows the active decoder-derived probe entry")
