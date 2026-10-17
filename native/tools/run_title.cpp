// Native headless title runner (macOS): the native counterpart of
// tools/run-title.mjs, built by native/build-native.sh as build/native-<target>/run-title.
//
//   run-title <game.iso | package | default.xex | folder> [--json out.json]
//             [--max-minstr N] [--deterministic PS] [--budget N] [--license trial|full]
//             [--dialog-button N] [--progress] [--slice-ms N] [--disc FILE]...
//
// Interpreter only (no guest JIT natively). Game files are read in place.
#include <algorithm>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

#include "render360_core.h"

namespace {
struct Progress {
  std::chrono::steady_clock::time_point started, last;
  bool enabled = false;
};

uint32_t OnSlice(void* user) {
  auto* p = static_cast<Progress*>(user);
  const auto now = std::chrono::steady_clock::now();
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
