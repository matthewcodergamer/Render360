#!/usr/bin/env python3
"""Generate a narrow wasm32 overlay for Xenia's host MMIO fault decoder.

Xbox MMIO range semantics remain upstream Xenia. wasm32 has no native AMD64 or
ARM64 faulting instruction stream/register context, so only the three native
host-instruction decode/register access compile-time #error branches are made
unsupported for the translation-only browser probe.
"""
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SOURCE = ROOT / "upstream/xenia/src/xenia/cpu/mmio_handler.cc"
DEST = ROOT / "build/xenia-web-overlay/xenia/cpu/mmio_handler.cc"

if not SOURCE.exists():
    raise SystemExit("Run ./fetch-xenia.sh first; upstream mmio_handler.cc is missing")

text = SOURCE.read_text(errors="strict")

replacements = [
    (
        "#else\n#error TryDecodeLoadStore not implemented for the target CPU architecture.\n  return false;\n#endif  // XE_ARCH\n",
        "#elif XE_ARCH_WASM32\n"
        "  // Browser translation probe never executes native host MMIO fault\n"
        "  // instructions. There is no wasm32 host instruction decoder here.\n"
        "  (void)p;\n"
        "  (void)decoded_out;\n"
        "  return false;\n"
        "#else\n"
        "#error TryDecodeLoadStore not implemented for the target CPU architecture.\n"
        "  return false;\n"
        "#endif  // XE_ARCH\n",
        "TryDecodeLoadStore",
    ),
    (
        "#else\n#error Register value writing not implemented for the target CPU architecture.\n#endif  // XE_ARCH\n",
        "#elif XE_ARCH_WASM32\n"
        "    // No native host register context exists for wasm32 MMIO faults.\n"
        "    return false;\n"
        "#else\n"
        "#error Register value writing not implemented for the target CPU architecture.\n"
        "#endif  // XE_ARCH\n",
        "register write",
    ),
    (
        "#else\n#error Register value reading not implemented for the target CPU architecture.\n#endif  // XE_ARCH\n",
        "#elif XE_ARCH_WASM32\n"
        "      // No native host register context exists for wasm32 MMIO faults.\n"
        "      return false;\n"
        "#else\n"
        "#error Register value reading not implemented for the target CPU architecture.\n"
        "#endif  // XE_ARCH\n",
        "register read",
    ),
]

for old, new, label in replacements:
    if old not in text:
        raise SystemExit(f"Upstream mmio_handler.cc drifted: {label} anchor not found")
    text = text.replace(old, new, 1)

DEST.parent.mkdir(parents=True, exist_ok=True)
DEST.write_text(text)
print(f"Generated web MMIO overlay: {DEST}")
print("MMIO rule: preserve Xenia range semantics; wasm32 native host fault decode/register access is unsupported in the translation-only probe")
