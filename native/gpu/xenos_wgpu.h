// Render360 native Xenos GPU backend: replays the command stream the core
// records (src/xenia_web_bootstrap/webgpu_backend.cpp) into wgpu-native
// (WebGPU on Metal), as render360-webgpu-backend.mjs does in the browser and
// as Xenia's VulkanCommandProcessor replays its DeferredCommandBuffer.
// The core's Xenia SPIR-V shaders go to wgpu directly (Naga inside wgpu).
#pragma once

#include <cstdint>
#include <memory>
#include <string>
#include <vector>

struct WGPUInstanceImpl;
struct WGPUSurfaceImpl;

namespace r360gpu {

struct Stats {
  uint64_t uploads = 0, uploaded_bytes = 0, dropped_uploads = 0, submits = 0, shaders = 0, shader_failures = 0,
           pipelines = 0, pipeline_failures = 0, draws = 0, skipped_draws = 0, render_passes = 0, swaps = 0,
           targets_created = 0, textures = 0, texture_loads = 0, texture_failures = 0, texture_load_failures = 0,
           load_shader_failures = 0, unbindable_textures = 0, dumps = 0, resolves = 0, resolve_failures = 0,
           clears = 0, presents = 0, errors = 0;
};

class Backend {
 public:
  // Creates a device. `metal_layer` (CAMetalLayer*) is optional: without it
  // the backend renders off-screen (headless runner) and frames can be read
  // back with ReadFront.
  static std::unique_ptr<Backend> Create(void* metal_layer, std::string* error);
  virtual ~Backend() = default;

  // Replays and clears the core's recorded commands (r360_gpu_stream_*).
  virtual void ReplayCore() = 0;
  // Replays stream words (a capture file).
  virtual void ReplayWords(const uint32_t* words, size_t count) = 0;
  // Draws the last swapped front buffer to the layer (aspect fit). Returns
  // false when there is no front buffer yet.
  virtual bool Present(uint32_t drawable_width, uint32_t drawable_height) = 0;
  // RGBA8 pixels of the last swapped front buffer (blocking readback).
  virtual bool ReadFront(std::vector<uint8_t>* rgba, uint32_t* width, uint32_t* height) = 0;
  // Bytes of the GPU shared memory (guest physical memory copy), blocking.
  virtual bool ReadShared(uint32_t offset, uint32_t length, std::vector<uint8_t>* out) = 0;
  virtual uint32_t swaps() const = 0;
  virtual const Stats& stats() const = 0;
  virtual std::string last_error() const = 0;
  virtual std::string adapter_name() const = 0;
};

// Puts the core into GPU record mode (and the software renderer off), as
// render360-webgpu-play.mjs createXenosWebGpuPlayPath does.
void EnableCoreRecording(bool on);

}  // namespace r360gpu
