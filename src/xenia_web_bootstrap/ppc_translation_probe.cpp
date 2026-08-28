#include <cstdint>
#include <cstring>
#include <memory>

#include "probe_backend.h"
#include "xenia/cpu/ppc/ppc_frontend.h"
#include "xenia/cpu/processor.h"
#include "xenia/memory.h"

namespace render360::xenia_web {
namespace {
constexpr uint32_t kProbeGuestBase = 0x80000000u;
constexpr uint32_t kProbeMaxBytes = 64u * 1024u;
alignas(16) uint8_t g_input_buffer[kProbeMaxBytes] = {};

enum ProbeStatus : uint32_t {
  kProbeCold = 0,
  kProbeRuntimeReady = 1,
  kProbeCodeLoaded = 2,
  kProbeTranslated = 3,
  kProbeErrorMemory = 0xE001,
  kProbeErrorProcessor = 0xE002,
  kProbeErrorInput = 0xE003,
  kProbeErrorTranslate = 0xE004,
};

// The bootstrap probe is process-lifetime state. Deliberately avoid teardown of
// a partial emulator graph at wasm module shutdown; full runtime lifecycle and
// reclamation belongs to the later browser Memory/Kernel implementation.
xe::Memory* g_memory = nullptr;
xe::cpu::Processor* g_processor = nullptr;
uint32_t g_loaded_size = 0;
uint32_t g_status = kProbeCold;

bool EnsureRuntime() {
  if (g_processor) return true;

  auto* memory = new xe::Memory();
  if (!memory->Initialize()) {
    g_status = kProbeErrorMemory;
    return false;
  }

  auto* processor = new xe::cpu::Processor(memory, nullptr);
  auto backend = std::make_unique<ProbeBackend>();
  if (!processor->Setup(std::move(backend))) {
    g_status = kProbeErrorProcessor;
    return false;
  }

  g_memory = memory;
  g_processor = processor;
  g_status = kProbeRuntimeReady;
  return true;
}
}  // namespace
}  // namespace render360::xenia_web

extern "C" {

void r360_ppc_probe_reset() {
  render360::xenia_web::ResetProbeTelemetry();
  render360::xenia_web::g_loaded_size = 0;
  render360::xenia_web::g_status =
      render360::xenia_web::g_processor
          ? render360::xenia_web::kProbeRuntimeReady
          : render360::xenia_web::kProbeCold;
}

uint32_t r360_ppc_probe_input_buffer() {
  return static_cast<uint32_t>(
      reinterpret_cast<uintptr_t>(render360::xenia_web::g_input_buffer));
}

uint32_t r360_ppc_probe_input_capacity() {
  return render360::xenia_web::kProbeMaxBytes;
}

uint32_t r360_ppc_probe_load(const uint8_t* bytes, uint32_t length) {
  using namespace render360::xenia_web;
  if (!bytes || !length || length > kProbeMaxBytes || (length & 3u)) {
    g_status = kProbeErrorInput;
    return 0;
  }
  if (!EnsureRuntime()) return 0;

  uint8_t* guest = g_memory->TranslateVirtual<uint8_t*>(kProbeGuestBase);
  if (!guest) {
    g_status = kProbeErrorMemory;
    return 0;
  }
  std::memcpy(guest, bytes, length);
  g_loaded_size = length;
  g_status = kProbeCodeLoaded;
  return length;
}

uint32_t r360_ppc_probe_translate() {
  using namespace render360::xenia_web;
  if (!EnsureRuntime() || !g_loaded_size) {
    if (!g_loaded_size && g_status < 0xE000) g_status = kProbeErrorInput;
    return 0;
  }

  ResetProbeTelemetry();
  ProbeGuestFunction function(nullptr, kProbeGuestBase);
  function.set_end_address(kProbeGuestBase + g_loaded_size - 4u);

  if (!g_processor->frontend()->DefineFunction(&function, 0)) {
    g_status = kProbeErrorTranslate;
    return 0;
  }

  g_status = kProbeTranslated;
  return GetProbeTelemetry().hir_instructions;
}

uint32_t r360_ppc_probe_status() {
  return render360::xenia_web::g_status;
}

uint32_t r360_ppc_probe_guest_base() {
  return render360::xenia_web::kProbeGuestBase;
}

uint32_t r360_ppc_probe_loaded_size() {
  return render360::xenia_web::g_loaded_size;
}

}  // extern "C"
