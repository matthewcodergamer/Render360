#include <cstdint>
#include <cstring>
#include <memory>
#include <string>

#include "hir_correctness_executor.h"
#include "probe_backend.h"
#include "wasm_backend_call_probe.h"
#include "xenia/cpu/module.h"
#include "xenia/cpu/ppc/ppc_frontend.h"
#include "xenia/cpu/processor.h"
#include "xenia/memory.h"

namespace render360::xenia_web {
namespace {
constexpr uint32_t kDefaultProbeGuestBase = 0x80000000u;
constexpr uint32_t kProbeMaxBytes = 64u * 1024u;
alignas(16) uint8_t g_input_buffer[kProbeMaxBytes] = {};
uint32_t g_active_guest_base = kDefaultProbeGuestBase;

class ProbeModule final : public xe::cpu::Module {
 public:
  explicit ProbeModule(xe::cpu::Processor* processor)
      : xe::cpu::Module(processor) {}

  const std::string& name() const override {
    static const std::string kName = "Render360ProbeModule";
    return kName;
  }
  bool is_executable() const override { return true; }
  bool ContainsAddress(uint32_t address) override {
    return address >= g_active_guest_base &&
           uint64_t(address) < uint64_t(g_active_guest_base) + kProbeMaxBytes;
  }

 protected:
  std::unique_ptr<xe::cpu::Function> CreateFunction(uint32_t address) override {
    return std::make_unique<ProbeGuestFunction>(this, address);
  }
};

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

xe::Memory* g_memory = nullptr;
xe::cpu::Processor* g_processor = nullptr;
ProbeModule* g_probe_module = nullptr;
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
  auto probe_module = std::make_unique<ProbeModule>(processor);
  g_probe_module = probe_module.get();
  if (!processor->AddModule(std::move(probe_module))) {
    g_probe_module = nullptr;
    g_status = kProbeErrorProcessor;
    return false;
  }

  g_memory = memory;
  g_processor = processor;
  g_status = kProbeRuntimeReady;
  return true;
}

bool IsProbeGuestRange(uint32_t address, uint32_t size) {
  if (!size || address < g_active_guest_base) return false;
  uint64_t end = uint64_t(address) + size;
  return end <= uint64_t(g_active_guest_base) + kProbeMaxBytes &&
         end <= 0x100000000ull;
}

uint32_t LoadAt(uint32_t address, const uint8_t* bytes, uint32_t length) {
  if (!bytes || !length || length > kProbeMaxBytes || (length & 3u) ||
      (address & 3u) || uint64_t(address) + length > 0x100000000ull) {
    g_status = kProbeErrorInput;
    return 0;
  }

  // Publish the decoder-derived guest base before Memory / Processor setup.
  // The wasm32 Xenia overlay deliberately owns only one bounded 64 KiB backing
  // window; its guest-visible address follows this value rather than reserving
  // a fake desktop-size Xbox address space.
  g_active_guest_base = address;
  if (!EnsureRuntime()) return 0;
  if (!IsProbeGuestRange(address, length)) {
    g_status = kProbeErrorInput;
    return 0;
  }

  uint8_t* guest = g_memory->TranslateVirtual<uint8_t*>(address);
  if (!guest) {
    g_status = kProbeErrorMemory;
    return 0;
  }
  // Loading executable bytes is a code mutation. Version the affected pages
  // and evict generated guest functions before the new bytes become visible.
  InvalidateWasmBackendExecutableRange(address, length);
  std::memcpy(guest, bytes, length);
  g_loaded_size = length;
  g_status = kProbeCodeLoaded;
  return length;
}
}  // namespace
}  // namespace render360::xenia_web

extern "C" {

void r360_ppc_probe_reset() {
  render360::xenia_web::ResetProbeTelemetry();
  render360::xenia_web::ResetHIRCorrectnessInitialState();
  render360::xenia_web::ResetWasmBackendCallProbe();
  render360::xenia_web::g_active_guest_base =
      render360::xenia_web::kDefaultProbeGuestBase;
  render360::xenia_web::g_loaded_size = 0;
  render360::xenia_web::g_status =
      render360::xenia_web::g_processor
          ? render360::xenia_web::kProbeRuntimeReady
          : render360::xenia_web::kProbeCold;
}

uint32_t r360_ppc_probe_set_initial_gpr(uint32_t index, uint64_t value) {
  return render360::xenia_web::SetHIRCorrectnessInitialGPR(index, value) ? 1u : 0u;
}

uint32_t r360_ppc_probe_write_guest_u32_be(uint32_t address, uint32_t value) {
  using namespace render360::xenia_web;
  if (!EnsureRuntime() || !IsProbeGuestRange(address, 4)) return 0;
  auto* guest = g_memory->TranslateVirtual<uint8_t*>(address);
  if (!guest) return 0;
  guest[0] = static_cast<uint8_t>(value >> 24);
  guest[1] = static_cast<uint8_t>(value >> 16);
  guest[2] = static_cast<uint8_t>(value >> 8);
  guest[3] = static_cast<uint8_t>(value);
  return 1;
}

uint32_t r360_ppc_probe_read_guest_u32_be(uint32_t address) {
  using namespace render360::xenia_web;
  if (!EnsureRuntime() || !IsProbeGuestRange(address, 4)) return 0;
  const auto* guest = g_memory->TranslateVirtual<const uint8_t*>(address);
  if (!guest) return 0;
  return (uint32_t(guest[0]) << 24) | (uint32_t(guest[1]) << 16) |
         (uint32_t(guest[2]) << 8) | uint32_t(guest[3]);
}

uint32_t r360_ppc_probe_input_buffer() {
  return static_cast<uint32_t>(
      reinterpret_cast<uintptr_t>(render360::xenia_web::g_input_buffer));
}

uint32_t r360_ppc_probe_input_capacity() {
  return render360::xenia_web::kProbeMaxBytes;
}

uint32_t r360_ppc_probe_load_at(uint32_t address, const uint8_t* bytes,
                                uint32_t length) {
  return render360::xenia_web::LoadAt(address, bytes, length);
}

uint32_t r360_ppc_probe_load(const uint8_t* bytes, uint32_t length) {
  return render360::xenia_web::LoadAt(
      render360::xenia_web::kDefaultProbeGuestBase, bytes, length);
}

uint32_t r360_ppc_probe_translate() {
  using namespace render360::xenia_web;
  if (!EnsureRuntime() || !g_loaded_size || !g_probe_module) {
    if (!g_loaded_size && g_status < 0xE000) g_status = kProbeErrorInput;
    return 0;
  }

  ResetProbeTelemetry();
  ProbeGuestFunction function(g_probe_module, g_active_guest_base);
  function.set_end_address(g_active_guest_base + g_loaded_size - 4u);
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
  return render360::xenia_web::g_active_guest_base;
}
uint32_t r360_ppc_probe_loaded_size() {
  return render360::xenia_web::g_loaded_size;
}

}  // extern "C"
