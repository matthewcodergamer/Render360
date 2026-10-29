#pragma once

#include <cstdint>
#include <vector>

#include "xenia/gpu/ucode.h"
#include "xenia/gpu/xenos.h"
#include "xenos_soft_draw.h"

namespace render360::xenia_web {

// Texture fetch for the Xenia ShaderInterpreter overlay: samples the texture
// described by `fetch` at `coords` (already selected from the source
// register). Returns false for unsupported formats/dimensions.
bool SampleXenosTexture(const xe::gpu::xenos::xe_gpu_texture_fetch_t& fetch,
                        const xe::gpu::ucode::TextureFetchInstruction& instr,
                        const float coords[3], float result[4]);

// Runs the guest vertex shader of `draw` on the CPU (Xenia ShaderInterpreter):
// 68 floats per guest vertex (position, 16 interpolators). Used by the GPU
// backend for primitives the host cannot expand (rectangle lists).
bool ShadeXenosVertices(const XenosSoftDraw& draw, std::vector<float>& out, uint32_t* vertex_count);


}  // namespace render360::xenia_web
