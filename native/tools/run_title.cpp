// Native headless title runner (macOS): the native counterpart of
// tools/run-title.mjs, built by native/build-native.sh as build/native-<target>/run-title.
//
//   run-title <game.iso | package | default.xex | folder> [--json out.json]
//             [--max-minstr N] [--deterministic PS] [--budget N] [--license trial|full]
//             [--dialog-button N] [--progress] [--slice-ms N] [--disc FILE]...
//
// Interpreter only (no guest JIT natively). Game files are read in place.
#include <algorithm>
#include <memory>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <cstdlib>
#include <string>
#include <vector>

#include "render360_core.h"
#if defined(R360_WITH_WGPU)
#include <zlib.h>
#include "../gpu/xenos_wgpu.h"
#endif

namespace {
struct Progress {
  std::chrono::steady_clock::time_point started, last;
  bool enabled = false;
#if defined(R360_WITH_WGPU)
  r360gpu::Backend* gpu = nullptr;
  uint32_t replayed_swaps = 0;
#endif
};

#if defined(R360_WITH_WGPU)
// Minimal PNG writer (RGBA8) for --gpu.
bool WritePng(const char* file, const std::vector<uint8_t>& rgba, uint32_t w, uint32_t h) {
  std::vector<uint8_t> raw;
  raw.reserve(size_t(w * 4 + 1) * h);
  for (uint32_t y = 0; y < h; ++y) {
    raw.push_back(0);
    raw.insert(raw.end(), rgba.begin() + size_t(y) * w * 4, rgba.begin() + size_t(y + 1) * w * 4);
  }
  uLongf zlen = compressBound(uLong(raw.size()));
  std::vector<uint8_t> z(zlen);
  if (compress2(z.data(), &zlen, raw.data(), uLong(raw.size()), 6) != Z_OK) return false;
  z.resize(zlen);
  FILE* f = std::fopen(file, "wb");
  if (!f) return false;
  auto be = [](uint32_t v, uint8_t* o) { o[0] = v >> 24; o[1] = v >> 16; o[2] = v >> 8; o[3] = v; };
  auto chunk = [&](const char* type, const std::vector<uint8_t>& data) {
    uint8_t len[4], crcb[4];
    be(uint32_t(data.size()), len);
    std::fwrite(len, 1, 4, f);
    std::fwrite(type, 1, 4, f);
    std::fwrite(data.data(), 1, data.size(), f);
    uLong crc = crc32(0, reinterpret_cast<const Bytef*>(type), 4);
    crc = crc32(crc, data.data(), uInt(data.size()));
    be(uint32_t(crc), crcb);
    std::fwrite(crcb, 1, 4, f);
  };
  static const uint8_t sig[8] = {137, 80, 78, 71, 13, 10, 26, 10};
  std::fwrite(sig, 1, 8, f);
  std::vector<uint8_t> ihdr(13, 0);
  be(w, ihdr.data());
  be(h, ihdr.data() + 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  chunk("IHDR", ihdr);
  chunk("IDAT", z);
  chunk("IEND", {});
  std::fclose(f);
  return true;
}
#endif

uint32_t OnSlice(void* user) {
  auto* p = static_cast<Progress*>(user);
  const auto now = std::chrono::steady_clock::now();
#if defined(R360_WITH_WGPU)
  // As render360-webgpu-play.mjs: replay on every new guest frame, and at
  // least when the stream grows large.
  if (p->gpu && (r360_title_gpu_vd_swap_calls() != p->replayed_swaps || r360_gpu_stream_words() > 4u * 1024 * 1024)) {
    p->replayed_swaps = r360_title_gpu_vd_swap_calls();
    p->gpu->ReplayCore();
  }
#endif
  if (p->enabled && now - p->last >= std::chrono::seconds(5)) {
    p->last = now;
    const double wall = std::chrono::duration<double>(now - p->started).count();
    std::printf("progress %uM instr · %u kernel calls · %u frames · %u fibers · %u switches · %.1f MIPS · %.0fs\n",
                r360_hir_total_instructions_millions(), r360_kernel_import_calls(), r360_title_gpu_vd_swap_calls(),
                r360_fiber_count(), r360_fiber_switches(), r360_perf_counter(0) / wall / 1e6, wall);
    std::fflush(stdout);
  }
  return 0;
}
}  // namespace

int main(int argc, char** argv) {
  R360BootOptions options{};
  options.dialog_button = -1;
  const char* json = nullptr;
  const char* gpu_png = nullptr;
  const char* frame_png = nullptr;
  std::vector<const char*> discs;
  Progress progress;
  for (int i = 1; i < argc; ++i) {
    const std::string a = argv[i];
    auto next = [&]() -> const char* {
      if (i + 1 >= argc) {
        std::fprintf(stderr, "%s needs a value\n", a.c_str());
        std::exit(2);
      }
      return argv[++i];
    };
    if (a == "--json") json = next();
    else if (a == "--max-minstr") options.max_minstr = uint32_t(std::strtoul(next(), nullptr, 0));
    else if (a == "--deterministic") options.deterministic_ps = uint32_t(std::strtoul(next(), nullptr, 0));
    else if (a == "--budget") options.function_budget = uint32_t(std::strtoul(next(), nullptr, 0));
    else if (a == "--license") options.license_full = std::strcmp(next(), "full") == 0;
    else if (a == "--dialog-button") options.dialog_button = int32_t(std::strtol(next(), nullptr, 0));
    else if (a == "--slice-ms") options.slice_ms = uint32_t(std::strtoul(next(), nullptr, 0));
    else if (a == "--progress") progress.enabled = true;
    else if (a == "--disc") discs.push_back(next());
    else if (a == "--gpu") gpu_png = next();
    else if (a == "--frame") frame_png = next();
    else if (a == "--help" || a == "-h") {
      std::printf("usage: run-title <game.iso|package|default.xex|folder> [--json out.json] [--max-minstr N] "
                  "[--deterministic PS] [--budget N] [--license trial|full] [--dialog-button N] [--progress] "
                  "[--slice-ms N] [--disc FILE]...\n");
      return 0;
    } else if (!options.path) options.path = argv[i];
    else {
      std::fprintf(stderr, "unexpected argument %s\n", argv[i]);
      return 2;
    }
  }
  if (!options.path) {
    std::fprintf(stderr, "usage: run-title <game> [--json out.json] ... (--help)\n");
    return 2;
  }
  // Same rule as run-title.mjs: progress (and frame/press work) runs in 200 ms slices.
  if (progress.enabled && !options.slice_ms) options.slice_ms = 200;
#if defined(R360_WITH_WGPU)
  std::unique_ptr<r360gpu::Backend> gpu;
  if (gpu_png) {
    std::string error;
    gpu = r360gpu::Backend::Create(nullptr, &error);
    if (!gpu) {
      std::fprintf(stderr, "GPU backend: %s\n", error.c_str());
      return 1;
    }
    std::printf("GPU: wgpu-native on %s (Xenos command stream replay)\n", gpu->adapter_name().c_str());
    r360gpu::EnableCoreRecording(true);
    progress.gpu = gpu.get();
    if (!options.slice_ms) options.slice_ms = 200;
  }
#else
  if (gpu_png) {
    std::fprintf(stderr, "--gpu needs a build with wgpu-native (R360_WGPU_DIR)\n");
    return 2;
  }
#endif
  progress.started = progress.last = std::chrono::steady_clock::now();
  if (options.slice_ms) {
    options.on_slice = OnSlice;
    options.user = &progress;
  }
  options.discs = discs.data();
  options.disc_count = uint32_t(discs.size());
  std::printf("Render360 native title runner · JIT-capable process: %s (interpreter only)\n",
              r360_native_jit_available() ? "yes" : "no");

  R360BootResult result{};
  r360_native_boot(&options, &result);

  if (!result.ok) {
    std::printf("FAILED BEFORE EXECUTION: %s\n", result.error);
  } else {
    std::printf("entry 0x%08X · %u PPC instructions (native HIR) · %u kernel calls\n", result.entry,
                result.execution_instructions, result.kernel_calls);
    std::printf("stopped at: %s\n", result.runtime_boundary);
    if (result.kernel_boundary[0]) std::printf("  %s\n", result.kernel_boundary);
    const double wall = result.elapsed_ms / 1000.0;
    const double instr = r360_perf_counter(0), interp = r360_perf_counter(1);
    std::printf("  frames (VdSwap): %u at %ux%u · %.2f fps wall · %.1f MIPS · interpreted %.1f%% · %.1fs\n",
                r360_title_gpu_vd_swap_calls(), r360_title_gpu_last_vd_swap_width(),
                r360_title_gpu_last_vd_swap_height(), r360_title_gpu_vd_swap_calls() / wall,
                instr / wall / 1e6, instr ? 100.0 * interp / instr : 0.0, wall);
    std::printf("  guest threads: %u title-created, %u switches\n", r360_fiber_count() ? r360_fiber_count() - 1 : 0,
                r360_fiber_switches());
  }
#if defined(R360_WITH_WGPU)
  if (gpu) {
    gpu->ReplayCore();
    const auto& st = gpu->stats();
    std::printf("  GPU: %llu swaps, %llu draws (%llu skipped), %llu pipelines (%llu failed), %llu shaders (%llu failed), "
                "%llu textures, %llu texture loads (%llu failed), %llu resolves (%llu failed), %llu clears, %llu errors\n",
                (unsigned long long)st.swaps, (unsigned long long)st.draws, (unsigned long long)st.skipped_draws,
                (unsigned long long)st.pipelines, (unsigned long long)st.pipeline_failures,
                (unsigned long long)st.shaders, (unsigned long long)st.shader_failures,
                (unsigned long long)st.textures, (unsigned long long)st.texture_loads,
                (unsigned long long)st.texture_load_failures, (unsigned long long)st.resolves,
                (unsigned long long)st.resolve_failures, (unsigned long long)st.clears, (unsigned long long)st.errors);
    // Diagnostic: the guest frontbuffer bytes in CPU memory vs the GPU copy.
    if (getenv("R360_GPU_COMPARE")) {
      r360_xenos_frontbuffer_snapshot_capture();
      const uint32_t src = r360_xenos_frontbuffer_snapshot_source_address(), bytes = r360_xenos_frontbuffer_snapshot_source_bytes();
      std::vector<uint8_t> shared;
      uint32_t diff = 0, cpu_nonwhite = 0, gpu_nonwhite = 0;
      if (src && bytes && gpu->ReadShared(src & 0x1FFFFFFFu, bytes, &shared)) {
        for (uint32_t i = 0; i + 4 <= bytes; i += 4) {
          uint32_t cpu = 0;
          r360_sparse_guest_memory_read_u32_be(src + i, &cpu);
          uint32_t g = (uint32_t(shared[i]) << 24) | (uint32_t(shared[i + 1]) << 16) | (uint32_t(shared[i + 2]) << 8) | shared[i + 3];
          diff += cpu != g;
          cpu_nonwhite += (cpu & 0xFFFFFF00u) != 0xFFFFFF00u && (cpu & 0x00FFFFFFu) != 0x00FFFFFFu;
          gpu_nonwhite += (g & 0xFFFFFF00u) != 0xFFFFFF00u && (g & 0x00FFFFFFu) != 0x00FFFFFFu;
        }
      }
      std::printf("  compare frontbuffer 0x%08X +%u: %u words differ, non-white cpu %u gpu %u\n", src, bytes, diff, cpu_nonwhite, gpu_nonwhite);
    }
    std::printf("  core GPU recorder: draws %u skips noVS %u translation %u primitive %u indices %u vfetch %u · "
                "textures %u created %u loads %u load failures %u · resolves %u (%u failed)\n",
                r360_gpu_draw_stat(0), r360_gpu_draw_stat(1), r360_gpu_draw_stat(2), r360_gpu_draw_stat(3),
                r360_gpu_draw_stat(4), r360_gpu_draw_stat(5), r360_gpu_texture_stat(0), r360_gpu_texture_stat(1),
                r360_gpu_texture_stat(2), r360_gpu_texture_stat(3), r360_gpu_draw_stat(7), r360_gpu_draw_stat(8));
    std::vector<uint8_t> rgba;
    uint32_t w = 0, h = 0;
    if (gpu->ReadFront(&rgba, &w, &h) && WritePng(gpu_png, rgba, w, h)) std::printf("  GPU front buffer %ux%u -> %s\n", w, h, gpu_png);
    else std::printf("  GPU front buffer: none yet\n");
  }
#endif
#if defined(R360_WITH_WGPU)
  // --frame: the software path's last VdSwap frontbuffer (render360-title-frontbuffer.mjs).
  if (frame_png && !gpu_png) {
    if (r360_xenos_frontbuffer_snapshot_capture() == 1) {
      const uint32_t w = r360_xenos_frontbuffer_snapshot_width(), h = r360_xenos_frontbuffer_snapshot_height();
      const auto* px = reinterpret_cast<const uint8_t*>(r360_xenos_frontbuffer_snapshot_buffer());
      std::vector<uint8_t> rgba(px, px + size_t(w) * h * 4);
      if (WritePng(frame_png, rgba, w, h)) std::printf("  frame %ux%u -> %s\n", w, h, frame_png);
    } else {
      std::printf("  frame: no frontbuffer (status 0x%x)\n", r360_xenos_frontbuffer_snapshot_status());
    }
  }
#endif
  if (json) {
    std::vector<char> report(1 << 20);
    const size_t n = r360_native_report_json(&result, report.data(), report.size());
    FILE* f = std::fopen(json, "w");
    if (f) {
      std::fwrite(report.data(), 1, std::min(n, report.size() - 1), f);
      std::fclose(f);
      std::printf("report written to %s\n", json);
    }
  }
  std::fflush(stdout);
  // Guest threads of the run may still be parked; exit without unwinding them.
  std::_Exit(result.ok ? 0 : 1);
}
