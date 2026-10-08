#pragma once

#include <cstdint>

#include "xenia/gpu/ucode.h"
#include "xenia/gpu/xenos.h"

namespace render360::xenia_web {

// One PM4 DRAW_INDX / DRAW_INDX_2 handed to the software Xenos renderer.
struct XenosSoftDraw {
  const uint32_t* registers = nullptr;  // the command processor register file
  uint32_t register_count = 0;
  uint32_t draw_initiator = 0;          // VGT_DRAW_INITIATOR
  uint32_t index_base = 0;              // DMA index buffer (GPU address)
  uint32_t index_size = 0;              // DMA index buffer size in indices
  const uint32_t* vertex_shader = nullptr;
  uint32_t vertex_shader_dwords = 0;
  uint32_t vertex_shader_hash = 0;
  const uint32_t* pixel_shader = nullptr;
  uint32_t pixel_shader_dwords = 0;
  uint32_t pixel_shader_hash = 0;
};

// Software Xenos backend (CPU, like a Xenia GPU backend but without a host
// GPU): rasterizes RB_MODECONTROL color/depth draws into a modelled 10 MiB
// EDRAM with Xenia's ShaderInterpreter running the vertex and pixel shaders,
// and performs RB_MODECONTROL copy draws (resolves and clears) from EDRAM to
// guest memory using Xenia's draw_util::GetResolveInfo. Returns false when the
// draw uses something not implemented yet (counted, never faked).
bool RenderXenosDraw(const XenosSoftDraw& draw);

// Texture fetch for the Xenia ShaderInterpreter overlay: samples the texture
// described by `fetch` at `coords` (already selected from the source
// register). Returns false for unsupported formats/dimensions.
bool SampleXenosTexture(const xe::gpu::xenos::xe_gpu_texture_fetch_t& fetch,
                        const xe::gpu::ucode::TextureFetchInstruction& instr,
                        const float coords[3], float result[4]);

void ResetXenosSoftRenderer();

}  // namespace render360::xenia_web
