#!/usr/bin/env python3
"""Render360 V33: audit the upstream Xenia PPC/HIR surface we intend to port.

This is deliberately a contract/audit step, not fake PPC execution. Run after
fetch-xenia.sh. It records whether the real upstream files and key interfaces
needed for the wasm32 bootstrap still exist.
"""
from pathlib import Path
import sys

root = Path(__file__).resolve().parent
xenia = root / "upstream" / "xenia"

contracts = {
    "PPC frontend": (
        "src/xenia/cpu/ppc/ppc_frontend.cc",
        ["PPCFrontend::Initialize", "PPCFrontend::DefineFunction", "translator->Translate"],
    ),
    "PPC frontend API": (
        "src/xenia/cpu/ppc/ppc_frontend.h",
        ["class PPCFrontend", "PPCBuiltins", "DefineFunction"],
    ),
    "PPC translator": (
        "src/xenia/cpu/ppc/ppc_translator.cc",
        ["PPCTranslator", "Translate"],
    ),
    "PPC HIR builder": (
        "src/xenia/cpu/ppc/ppc_hir_builder.cc",
        ["PPCHIRBuilder"],
    ),
    "PPC context": (
        "src/xenia/cpu/ppc/ppc_context.h",
        ["PPCContext"],
    ),
    "HIR builder": (
        "src/xenia/cpu/hir/hir_builder.h",
        ["class HIRBuilder"],
    ),
    "HIR instructions": (
        "src/xenia/cpu/hir/instr.h",
        ["class Instr"],
    ),
    "compiler": (
        "src/xenia/cpu/compiler/compiler.cc",
        ["Compiler::"],
    ),
    "processor boundary": (
        "src/xenia/cpu/processor.h",
        ["class Processor", "DefineBuiltin"],
    ),
}

if not xenia.exists():
    raise SystemExit("Run ./fetch-xenia.sh first; upstream/xenia is missing")

failed = []
print("Render360 Xenia Web Bootstrap Audit")
print("===================================")
for label, (relative, tokens) in contracts.items():
    path = xenia / relative
    if not path.exists():
        failed.append(f"{label}: missing {relative}")
        print(f"[MISSING] {label:20} {relative}")
        continue
    text = path.read_text(errors="replace")
    missing_tokens = [token for token in tokens if token not in text]
    if missing_tokens:
        failed.append(f"{label}: missing tokens {', '.join(missing_tokens)}")
        print(f"[DRIFT]   {label:20} {relative}")
    else:
        print(f"[READY]   {label:20} {relative}")

print()
print("Host-specific code remains intentionally outside this bootstrap:")
print("  x64 backend / x64 code cache / D3D12 / Vulkan / native HID / native audio")
print("Browser targets to add after the portable CPU boundary is proven:")
print("  correctness backend -> WasmBackend -> WebGPU/WGSL -> WebAudio -> browser VFS")

if failed:
    print("\nBLOCKED: upstream contract drift detected")
    for item in failed:
        print(" -", item)
    sys.exit(1)

print("\nPASS: upstream PPC frontend + HIR/compiler bootstrap surface is present")
