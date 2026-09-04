#include <cstdint>
#include <cstring>
#include <memory>
#include <string>

#include "hir_correctness_executor.h"
#include "ppc_translation_probe_runtime.h"
#include "probe_backend.h"
#include "sparse_guest_memory.h"
#include "wasm_backend_call_probe.h"
#include "xenia/cpu/module.h"
#include "xenia/cpu/ppc/ppc_frontend.h"
#include "xenia/cpu/ppc/ppc_scanner.h"
#include "xenia/cpu/processor.h"
#include "xenia/memory.h"

namespace render360::xenia_web {
namespace {
constexpr uint32_t kDefaultProbeGuestBase = 0x80000000u;
constexpr uint32_t kProbeMaxBytes = 64u * 1024u;
constexpr uint32_t kSparsePageBytes = 4096u;
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

// Scanned-entry translation used to collapse four different outcomes into a
// single zero return. Keep this diagnostic separate from ProbeStatus so the
// title handoff can retain its stable 0x82000005 ABI while browser reports say
// exactly which Xenia stage failed.
enum ProbeScanDiagnostic : uint32_t {
  kProbeScanIdle = 0,
  kProbeScanGuardRejected = 1,
  kProbeScanScannerFailed = 2,
  kProbeScanDefineFailed = 3,
  kProbeScanZeroHIR = 4,
  kProbeScanTranslated = 5,
};

xe::Memory* g_memory = nullptr;
xe::cpu::Processor* g_processor = nullptr;
ProbeModule* g_probe_module = nullptr;
uint32_t g_loaded_size = 0;
uint32_t g_status = kProbeCold;
uint32_t g_scan_diagnostic = kProbeScanIdle;
uint32_t g_scan_address = 0;
uint32_t g_scan_window_end = 0;
uint32_t g_scan_function_end = 0;
uint32_t g_scan_hir_instructions = 0;

void ResetScanDiagnostic() {
  g_scan_diagnostic = kProbeScanIdle;
  g_scan_address = 0;
  g_scan_window_end = 0;
  g_scan_function_end = 0;
  g_scan_hir_instructions = 0;
}

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

uint32_t PageSparseCodeWindow(uint32_t target_address) {
  if ((target_address & 3u) || !EnsureRuntime()) return 0;

  // Keep the target on the first 4 KiB page so the PPC scanner has as much
  // forward room as possible. Real XEX sections are already mapped into the
  // authoritative sparse 32-bit guest address space by the PE loader.
  const uint32_t window_base = target_address & ~(kSparsePageBytes - 1u);
  if (uint64_t(window_base) + kProbeMaxBytes > 0x100000000ull) return 0;

  // Fail closed on PE section permissions. A readable .data/.rdata page is not
  // guest code just because its bytes are addressable. Only the contiguous
  // readable+executable sparse span containing the target may enter the PPC
  // decoder window.
  const uint32_t executable_bytes =
      SparseGuestExecutableSpan(window_base, kProbeMaxBytes);
  if (!executable_bytes ||
      uint64_t(target_address) >= uint64_t(window_base) + executable_bytes) {
    return 0;
  }

  // A nested guest call may move the one physical wasm32 code backing window.
  // Emitted caller HIR no longer depends on its instruction bytes; title data
  // accesses use sparse-memory fallback, so the window can safely follow the
  // next real executable target without allocating a desktop-sized 4 GiB heap.
  g_active_guest_base = window_base;
  uint8_t* guest = g_memory->TranslateVirtual<uint8_t*>(window_base);
  if (!guest) return 0;
  std::memset(guest, 0, kProbeMaxBytes);

  uint32_t loaded = 0;
  for (uint32_t offset = 0; offset < executable_bytes;
       offset += kSparsePageBytes) {
    const uint32_t page_bytes =
        executable_bytes - offset < kSparsePageBytes
            ? executable_bytes - offset
            : kSparsePageBytes;
    if (!ReadSparseGuestMemory(window_base + offset, guest + offset,
                               page_bytes)) {
      return 0;
    }
    loaded += page_bytes;
  }
  if (!loaded || target_address >= window_base + loaded) return 0;

  // This is a host-window relocation, not a title code mutation, so don't bump
  // sparse executable content generations. We still evict generated functions
  // whose backing window may now point at different title bytes.
  InvalidateWasmBackendExecutableRange(window_base, loaded);
  g_loaded_size = loaded;
  g_status = kProbeCodeLoaded;
  return loaded;
}
}  // namespace

xe::Memory* ActiveProbeMemory() {
  if (!EnsureRuntime()) return nullptr;
  return g_memory;
}

}  // namespace render360::xenia_web

extern "C" {

void r360_ppc_probe_reset() {
  render360::xenia_web::ResetProbeTelemetry();
  render360::xenia_web::ResetHIRCorrectnessInitialState();
  render360::xenia_web::ResetWasmBackendCallProbe();
  render360::xenia_web::ResetScanDiagnostic();
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

// R360_XENIA_ENTRY_ABI_V51: Xenia Processor::Execute installs a sentinel LR
// before entering the guest function. The browser HIR executor must start with
// the same architectural state instead of an all-zero special-register set.
uint32_t r360_ppc_probe_set_initial_lr(uint64_t value) {
  return render360::xenia_web::SetHIRCorrectnessInitialLR(value) ? 1u : 0u;
}

uint64_t r360_ppc_probe_initial_lr() {
  return render360::xenia_web::GetHIRCorrectnessInitialLR();
}

uint32_t r360_ppc_probe_write_guest_u32_be(uint32_t address, uint32_t value) {
  using namespace render360::xenia_web;
  if (!EnsureRuntime()) return 0;
  if (IsProbeGuestRange(address, 4)) {
    auto* guest = g_memory->TranslateVirtual<uint8_t*>(address);
    if (guest) {
      guest[0] = static_cast<uint8_t>(value >> 24);
      guest[1] = static_cast<uint8_t>(value >> 16);
      guest[2] = static_cast<uint8_t>(value >> 8);
      guest[3] = static_cast<uint8_t>(value);
      WriteSparseGuestMemory(address, guest, 4);
      return 1;
    }
  }
  const uint8_t bytes[4] = {static_cast<uint8_t>(value >> 24),
                            static_cast<uint8_t>(value >> 16),
                            static_cast<uint8_t>(value >> 8),
                            static_cast<uint8_t>(value)};
  return WriteSparseGuestMemory(address, bytes, sizeof(bytes)) ? 1u : 0u;
}

uint32_t r360_ppc_probe_read_guest_u32_be(uint32_t address) {
  using namespace render360::xenia_web;
  if (!EnsureRuntime()) return 0;
  if (IsProbeGuestRange(address, 4)) {
    const auto* guest = g_memory->TranslateVirtual<const uint8_t*>(address);
    if (guest) {
      return (uint32_t(guest[0]) << 24) | (uint32_t(guest[1]) << 16) |
             (uint32_t(guest[2]) << 8) | uint32_t(guest[3]);
    }
  }
  uint8_t bytes[4] = {};
  if (!ReadSparseGuestMemory(address, bytes, sizeof(bytes))) return 0;
  return (uint32_t(bytes[0]) << 24) | (uint32_t(bytes[1]) << 16) |
         (uint32_t(bytes[2]) << 8) | uint32_t(bytes[3]);
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

uint32_t r360_ppc_probe_page_sparse_code(uint32_t target_address) {
  return render360::xenia_web::PageSparseCodeWindow(target_address);
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

  const uint32_t hir = GetProbeTelemetry().hir_instructions;
  if (!hir) {
    // A zero-HIR translation is not success. The old path marked the probe as
    // translated and then returned zero, leaving the caller and telemetry in
    // contradictory states.
    g_status = kProbeErrorTranslate;
    return 0;
  }
  g_status = kProbeTranslated;
  return hir;
}

uint32_t r360_ppc_probe_translate_scanned_at(uint32_t address) {
  using namespace render360::xenia_web;
  ResetScanDiagnostic();
  g_scan_address = address;
  g_scan_window_end =
      g_loaded_size >= 4u ? g_active_guest_base + g_loaded_size - 4u : 0u;

  if (!EnsureRuntime() || !g_loaded_size || !g_probe_module || (address & 3u) ||
      !IsProbeGuestRange(address, 4u)) {
    g_scan_diagnostic = kProbeScanGuardRejected;
    if (g_status < 0xE000) g_status = kProbeErrorInput;
    return 0;
  }

  ResetProbeTelemetry();
  ProbeGuestFunction function(g_probe_module, address);
  // Give upstream Xenia a hard upper bound equal to the RX bytes currently
  // paged into the movable wasm32 code window, then let PPCScanner discover the
  // actual function end (blr/bctr/control-flow) within that real title span.
  function.set_end_address(g_active_guest_base + g_loaded_size - 4u);
  xe::cpu::ppc::PPCScanner scanner(g_processor->frontend());
  if (!scanner.Scan(&function, nullptr)) {
    g_scan_diagnostic = kProbeScanScannerFailed;
    g_status = kProbeErrorTranslate;
    return 0;
  }
  // scanWindowEnd is only the input ceiling. Preserve the boundary the Xenia
  // scanner actually discovered so a one-instruction thunk/stub can be
  // distinguished from a normal function whose assembler emitted zero HIR.
  g_scan_function_end = function.end_address();
  if (!g_processor->frontend()->DefineFunction(&function, 0)) {
    g_scan_diagnostic = kProbeScanDefineFailed;
    g_status = kProbeErrorTranslate;
    return 0;
  }

  const uint32_t hir = GetProbeTelemetry().hir_instructions;
  g_scan_hir_instructions = hir;
  if (!hir) {
    g_scan_diagnostic = kProbeScanZeroHIR;
    g_status = kProbeErrorTranslate;
    return 0;
  }

  g_scan_diagnostic = kProbeScanTranslated;
  g_status = kProbeTranslated;
  return hir;
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
uint32_t r360_ppc_probe_scan_diagnostic() {
  return render360::xenia_web::g_scan_diagnostic;
}
uint32_t r360_ppc_probe_scan_address() {
  return render360::xenia_web::g_scan_address;
}
uint32_t r360_ppc_probe_scan_window_end() {
  return render360::xenia_web::g_scan_window_end;
}
uint32_t r360_ppc_probe_scan_function_end() {
  return render360::xenia_web::g_scan_function_end;
}
uint32_t r360_ppc_probe_scan_hir_instructions() {
  return render360::xenia_web::g_scan_hir_instructions;
}

}  // extern "C"
