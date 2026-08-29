#!/usr/bin/env python3
"""Make Xenia's SPIR-V shader translator translation-only for browser/WASM.

This deliberately preserves Xenia's shader translation logic. The browser seam:
- removes the VulkanDevice-backed feature constructor, which is unavailable in
  standalone browser/WASM;
- exposes Xbox shared memory as one *logical* 512 MiB storage binding in SPIR-V.

The second adaptation is required because Xenia's conservative 128 MiB Vulkan
range splits 512 MiB Xbox shared memory into four descriptor bindings represented
as an array of structs ending in runtime arrays. Vulkan permits that descriptor
shape, while WGSL/Naga correctly rejects an array whose element type is unsized.
Using one logical binding preserves Xenia's guest-address arithmetic and makes the
IR representable in WebGPU WGSL. The browser resource layer remains responsible
for paging/uploading only the guest ranges actually needed by a draw; this does
not allocate or promise a literal 512 MiB GPU buffer on iPhone.
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

old_range = "      max_storage_buffer_range(all ? UINT32_MAX : (128 * 1024 * 1024)),\n"
new_range = "      max_storage_buffer_range(all ? UINT32_MAX : (512 * 1024 * 1024)),\n"
if old_range not in source:
    raise SystemExit("SPIR-V translator conservative storage-range anchor drifted")
source = source.replace(old_range, new_range, 1)
SOURCE.write_text(source)

print("Prepared browser-safe Xenia SPIR-V translator: Vulkan device seam removed; one logical 512 MiB shared-memory binding selected for WGSL compatibility")
