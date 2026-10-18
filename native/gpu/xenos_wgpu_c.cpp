// C entry points for the Swift app (ios/Render360) around r360gpu::Backend.
#include <memory>
#include <string>

#include "xenos_wgpu.h"

namespace {
std::unique_ptr<r360gpu::Backend> g_backend;
std::string g_error;
}  // namespace

extern "C" {
// Creates the GPU backend on a CAMetalLayer and puts the core into GPU
// record mode. Returns 1 on success; on failure the software path stays on.
int r360_gpu_backend_start(void* metal_layer) {
  g_backend = r360gpu::Backend::Create(metal_layer, &g_error);
  if (!g_backend) return 0;
  r360gpu::EnableCoreRecording(true);
  return 1;
}
// Replays the recorded commands; presents the newest front buffer when
// `present` is set. Call on the running guest thread (host slice).
int r360_gpu_backend_frame(int present, unsigned width, unsigned height) {
  if (!g_backend) return 0;
  g_backend->ReplayCore();
  return present ? (g_backend->Present(width, height) ? 1 : 0) : 1;
}
const char* r360_gpu_backend_error(void) { return g_error.c_str(); }
unsigned r360_gpu_backend_errors(void) { return g_backend ? unsigned(g_backend->stats().errors) : 0u; }
}
