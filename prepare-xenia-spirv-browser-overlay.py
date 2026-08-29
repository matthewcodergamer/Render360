#!/usr/bin/env python3
"""Make Xenia's SPIR-V shader translator translation-only for browser/WASM.

This deliberately preserves Xenia's shader translation logic. The only removed
piece is the VulkanDevice-backed feature constructor, which is not needed by the
browser probe because Render360 constructs Features directly from conservative
WebGPU-portable defaults.
"""
from pathlib import Path

ROOT = Path(__file__).resolve().parent
XENIA = ROOT / "upstream/xenia"
HEADER = XENIA / "src/xenia/gpu/spirv_shader_translator.h"
SOURCE = XENIA / "src/xenia/gpu/spirv_shader_translator.cc"

if not HEADER.exists() or not SOURCE.exists():
    raise SystemExit("Run ./fetch-xenia.sh first; SPIR-V translator sources missing")

header = HEADER.read_text(errors="strict")
include = '#include "xenia/ui/vulkan/vulkan_device.h"\n'
if include not in header:
    raise SystemExit("SPIR-V translator Vulkan include anchor drifted")
header = header.replace(include, "", 1)
ctor = "    explicit Features(const ui::vulkan::VulkanDevice* vulkan_device);\n"
if ctor not in header:
    raise SystemExit("SPIR-V translator Vulkan feature constructor anchor drifted")
header = header.replace(ctor, "", 1)
HEADER.write_text(header)

source = SOURCE.read_text(errors="strict")
start_marker = "SpirvShaderTranslator::Features::Features(\n    const ui::vulkan::VulkanDevice* const vulkan_device)\n"
start = source.find(start_marker)
if start < 0:
    raise SystemExit("SPIR-V translator Vulkan constructor definition drifted")
end_marker = "uint64_t SpirvShaderTranslator::GetDefaultVertexShaderModification("
end = source.find(end_marker, start)
if end < 0:
    raise SystemExit("SPIR-V translator post-Vulkan constructor anchor drifted")
source = source[:start] + source[end:]
SOURCE.write_text(source)

print("Prepared browser-safe Xenia SPIR-V translator: Vulkan device seam removed; translator semantics preserved")
