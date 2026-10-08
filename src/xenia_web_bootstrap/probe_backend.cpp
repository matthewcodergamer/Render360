#include "probe_backend.h"

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <memory>
#include <new>
#include <unordered_map>
#include <vector>

#include "guest_fibers.h"
#include "hir_correctness_executor.h"
#include "kernel_import_probe.h"
#include "kernel_xboxkrnl_services.h"
#include "sparse_guest_memory.h"
#include "xex_pe_guest_loader.h"
#include "wasm_backend_call_probe.h"
#include "wasm_backend_cfg_probe.h"
#include "wasm_backend_fpu_probe.h"
#include "wasm_backend_memory_probe.h"
#include "wasm_backend_probe.h"
#include "wasm_backend_vmx_probe.h"
#include "xenia/cpu/function.h"
#include "xenia/cpu/function_debug_info.h"
#include "xenia/cpu/hir/block.h"
#include "xenia/cpu/hir/hir_builder.h"
#include "xenia/cpu/hir/instr.h"
#include "xenia/cpu/hir/opcodes.h"
#include "xenia/cpu/ppc/ppc_frontend.h"
#include "xenia/cpu/ppc/ppc_scanner.h"
#include "xenia/cpu/processor.h"
#include "xenia/memory.h"

extern "C" uint32_t r360_ppc_probe_guest_base();
extern "C" uint32_t r360_ppc_probe_loaded_size();
extern "C" uint32_t r360_ppc_probe_page_sparse_code(uint32_t target_address);

#if defined(__wasm__)
#define R360_WASM_EXPORT(name) __attribute__((used, export_name(name)))
#else
#define R360_WASM_EXPORT(name)
#endif

// ---------------------------------------------------------------------------
// Trap report. A wasm trap (abort, failed allocation, unreachable) unwinds the
// whole call into the core and the browser only sees "Unreachable code should
// not be executed". Keep enough state in linear memory for the page to say
// what the core was doing; memory and exports stay readable after a trap.
// ---------------------------------------------------------------------------
#if defined(__wasm__)
extern "C" char __stack_low;
extern "C" char __stack_high;
extern "C" uintptr_t emscripten_stack_get_current(void);
#endif

namespace render360::xenia_web {
namespace {
enum TrapPhase : uint32_t {
  kTrapPhaseIdle = 0,
  kTrapPhaseTranslate = 1,
  kTrapPhaseExecute = 2,
};
char g_trap_reason[384] = {};
uint32_t g_trap_phase = kTrapPhaseIdle;
uint32_t g_trap_address = 0;
R360_FIBER_LOCAL uint32_t g_trap_depth = 0;
uint32_t g_trap_stack_low_water = 0;
uint32_t g_trap_stack_exhausted = 0;

uint32_t CurrentStackPointer() {
#if defined(__wasm__)
  return static_cast<uint32_t>(emscripten_stack_get_current());
#else
  return 0;
#endif
}

uint32_t StackHeadroom() {
#if defined(__wasm__)
  const uint32_t sp = CurrentStackPointer();
  const uint32_t low = static_cast<uint32_t>(GuestFiberStackLow());
  if (!g_trap_stack_low_water || sp < g_trap_stack_low_water) g_trap_stack_low_water = sp;
  return sp > low ? sp - low : 0;
#else
  return UINT32_MAX;
#endif
}

void SetTrapReason(const char* reason) {
  std::snprintf(g_trap_reason, sizeof(g_trap_reason), "%s", reason ? reason : "");
}

void NoteTrapPhase(uint32_t phase, uint32_t address) {
  g_trap_phase = phase;
  g_trap_address = address;
}
}  // namespace
}  // namespace render360::xenia_web

extern "C" {
// Xenia's own assert() calls land here when NDEBUG is not defined (third-party
// code still uses <cassert>). Record the text before trapping.
void __assert_fail(const char* expr, const char* file, int line,
                                const char* func) {
  const char* base = file ? std::strrchr(file, '/') : nullptr;
  std::snprintf(render360::xenia_web::g_trap_reason,
                sizeof(render360::xenia_web::g_trap_reason),
                "assertion failed: %s (%s:%d %s)", expr ? expr : "?",
                base ? base + 1 : (file ? file : "?"), line, func ? func : "?");
  std::fprintf(stderr, "R360_ASSERT %s\n", render360::xenia_web::g_trap_reason);
  __builtin_trap();
}
}

// Allocation failure would otherwise abort() with no message. On phones this
// is the usual "out of memory" path once wasm memory can no longer grow.
void* operator new(std::size_t size) {
  void* p = std::malloc(size ? size : 1);
  if (!p) {
    std::snprintf(render360::xenia_web::g_trap_reason,
                  sizeof(render360::xenia_web::g_trap_reason),
                  "out of memory allocating %zu bytes", size);
    std::fprintf(stderr, "R360_OOM %s\n", render360::xenia_web::g_trap_reason);
    __builtin_trap();
  }
  return p;
}
void* operator new[](std::size_t size) { return ::operator new(size); }
void* operator new(std::size_t size, const std::nothrow_t&) noexcept {
  return std::malloc(size ? size : 1);
}
void* operator new[](std::size_t size, const std::nothrow_t&) noexcept {
  return std::malloc(size ? size : 1);
}
void operator delete(void* p) noexcept { std::free(p); }
void operator delete[](void* p) noexcept { std::free(p); }
void operator delete(void* p, std::size_t) noexcept { std::free(p); }
void operator delete[](void* p, std::size_t) noexcept { std::free(p); }

namespace render360::xenia_web {
namespace {
// Each nested guest call keeps a full Xenia scan/translate/execute chain on the
// host stack. Stop with a named blocker well before the wasm stack runs into
// static data (overflow corrupts globals silently).
constexpr uint32_t kMinNestedStackHeadroom = 192u * 1024u;
ProbeTelemetry g_probe_telemetry;
ProbeBackend* g_probe_backend = nullptr;
bool g_execute_correctness_on_assemble = true;
constexpr uint32_t kProbeGuestSize = 64u * 1024u;

bool IsInLoadedProbeWindow(uint32_t address) {
  const uint32_t base = r360_ppc_probe_guest_base();
  const uint64_t end = uint64_t(base) + r360_ppc_probe_loaded_size();
  return address >= base && uint64_t(address) < end;
}

uint32_t ReadBigEndian32(const uint8_t* p) {
  return (uint32_t(p[0]) << 24) | (uint32_t(p[1]) << 16) |
         (uint32_t(p[2]) << 8) | uint32_t(p[3]);
}

uint64_t ReadBigEndian64(const uint8_t* p) {
  return (uint64_t(ReadBigEndian32(p)) << 32) | ReadBigEndian32(p + 4);
}

bool MatchSharedEpilogReturnSignature(uint32_t address,
                                      uint32_t* first_gpr_out) {
  auto read_word = [](uint32_t code_address, uint32_t* out) {
    if (!out) return false;
    uint8_t raw[4] = {};
    if (!ReadSparseGuestMemory(code_address, raw, sizeof(raw))) return false;
    *out = ReadBigEndian32(raw);
    return true;
  };

  uint32_t first = 0;
  if (!read_word(address, &first)) return false;
  const uint32_t first_gpr = (first >> 21) & 31u;
  if (first_gpr < 14u || first_gpr > 31u) return false;

  for (uint32_t reg = first_gpr; reg <= 31u; ++reg) {
    const uint32_t code_address = address + (reg - first_gpr) * 4u;
    uint32_t word = 0;
    if (!read_word(code_address, &word)) return false;
    const uint32_t primary = word >> 26;
    const uint32_t rt = (word >> 21) & 31u;
    const uint32_t ra = (word >> 16) & 31u;
    const uint32_t xo = word & 3u;
    int32_t disp = static_cast<int32_t>(word & 0x0000FFFCu);
    if (disp & 0x00008000) disp |= static_cast<int32_t>(0xFFFF0000u);
    const int32_t expected_disp = -16 - int32_t(31u - reg) * 8;
    if (primary != 58u || rt != reg || ra != 1u || xo != 0u ||
        disp != expected_disp) {
      return false;
    }
  }

  const uint32_t tail = address + (32u - first_gpr) * 4u;
  constexpr uint32_t kExpectedTail[] = {
      0x8181FFF8u,  // lwz r12,-8(r1)
      0x7D8803A6u,  // mtlr r12
      0x4E800020u,  // blr
  };
  for (uint32_t i = 0; i < 3u; ++i) {
    uint32_t word = 0;
    if (!read_word(tail + i * 4u, &word) || word != kExpectedTail[i]) {
      return false;
    }
  }

  if (first_gpr_out) *first_gpr_out = first_gpr;
  return true;
}

bool ExecuteSharedEpilogReturn(uint32_t address) {
  auto* context = GetHIRCorrectnessActiveContext();
  if (!context) {
    std::fprintf(stderr,
                 "R360_EPILOG_HELPER rejected target=0x%08X reason=no-context\n",
                 address);
    return false;
  }

  // Microsoft __restgprlr_N helpers are canonical Xenia kEpilogReturn
  // functions. The entry instruction identifies N as an `ld rN,disp(r1)`;
  // the helper then restores rN..r31, restores LR from -8(r1), and returns.
  // Execute those semantics against the live caller PPCContext instead of
  // constructing a standalone HIR builder for an interior helper entry.
  uint8_t first_raw[4] = {};
  if (!ReadSparseGuestMemory(address, first_raw, sizeof(first_raw))) {
    std::fprintf(stderr,
                 "R360_EPILOG_HELPER rejected target=0x%08X reason=code-unmapped fault=%u@0x%08X\n",
                 address, SparseGuestLastFaultCode(), SparseGuestLastFaultAddress());
    return false;
  }
  const uint32_t first = ReadBigEndian32(first_raw);
  const uint32_t primary = first >> 26;
  const uint32_t first_gpr = (first >> 21) & 31u;
  const uint32_t ra = (first >> 16) & 31u;
  int32_t first_disp = static_cast<int32_t>(first & 0x0000FFFCu);
  if (first_disp & 0x00008000) first_disp |= static_cast<int32_t>(0xFFFF0000u);
  const int32_t expected_disp = -16 - int32_t(31u - first_gpr) * 8;
  if (primary != 58u || ra != 1u || first_gpr < 14u || first_gpr > 31u ||
      first_disp != expected_disp) {
    std::fprintf(stderr,
                 "R360_EPILOG_HELPER rejected target=0x%08X insn=0x%08X rt=%u ra=%u disp=%d expected=%d\n",
                 address, first, first_gpr, ra, first_disp, expected_disp);
    return false;
  }

  const uint32_t r1 = static_cast<uint32_t>(context->r[1]);
  for (uint32_t reg = first_gpr; reg <= 31u; ++reg) {
    const int32_t disp = -16 - int32_t(31u - reg) * 8;
    const uint32_t ea = r1 + static_cast<uint32_t>(disp);
    uint8_t raw[8] = {};
    if (!ReadSparseGuestMemory(ea, raw, sizeof(raw))) {
      std::fprintf(stderr,
                   "R360_EPILOG_HELPER load-fail target=0x%08X r%u ea=0x%08X fault=%u@0x%08X\n",
                   address, reg, ea, SparseGuestLastFaultCode(),
                   SparseGuestLastFaultAddress());
      return false;
    }
    context->r[reg] = ReadBigEndian64(raw);
  }

  const uint32_t lr_ea = r1 - 8u;
  uint8_t lr_raw[4] = {};
  if (!ReadSparseGuestMemory(lr_ea, lr_raw, sizeof(lr_raw))) {
    std::fprintf(stderr,
                 "R360_EPILOG_HELPER lr-fail target=0x%08X ea=0x%08X fault=%u@0x%08X\n",
                 address, lr_ea, SparseGuestLastFaultCode(),
                 SparseGuestLastFaultAddress());
    return false;
  }
  context->lr = ReadBigEndian32(lr_raw);
  R360_VERBOSE_TRACE(
               "R360_EPILOG_HELPER executed target=0x%08X first_gpr=%u r1=0x%08X lr=0x%08X\n",
               address, first_gpr, r1, static_cast<uint32_t>(context->lr));
  return true;
}

// Translation cache. Xenia translates a guest function once and then calls
// its machine code; the HIR executor runs the finalized HIRBuilder, so a
// nested call keeps the builder its first translation produced (the
// PPCTranslator overlay hands it over) and later calls execute it directly.
// Entries are keyed by function start, owning .pdata end and fragment mode,
// dropped when the code pages are rewritten, pinned while executing (guest
// recursion, suspended fibers) and evicted least-recently-used beyond a byte
// budget.
struct CachedTranslation {
  std::unique_ptr<xe::cpu::hir::HIRBuilder> builder;
  uint32_t begin = 0;
  uint32_t end = 0;
  uint32_t generation_begin = 0;
  uint32_t generation_end = 0;
  uint64_t last_use = 0;
  size_t bytes = 0;
  uint32_t pins = 0;
};
std::unordered_map<uint64_t, CachedTranslation> g_translation_cache;
size_t g_translation_cache_bytes = 0;
size_t g_translation_cache_budget = size_t(192) * 1024 * 1024;
uint64_t g_translation_cache_clock = 0;
uint64_t g_translation_cache_hits = 0;
uint64_t g_translation_cache_misses = 0;
// The key the next retained builder belongs to; per guest thread because a
// translation can be suspended mid-execution by a fiber switch.
R360_FIBER_LOCAL bool g_retain_pending = false;
R360_FIBER_LOCAL uint64_t g_retain_key = 0;
R360_FIBER_LOCAL uint32_t g_retain_begin = 0;
R360_FIBER_LOCAL uint32_t g_retain_end = 0;

uint64_t TranslationKey(uint32_t begin, uint32_t end, bool fragment) {
  return (uint64_t(begin) << 32) | (uint64_t(end) & ~3ull) | (fragment ? 1u : 0u);
}

void EvictTranslations() {
  while (g_translation_cache_bytes > g_translation_cache_budget) {
    auto victim = g_translation_cache.end();
    for (auto it = g_translation_cache.begin(); it != g_translation_cache.end(); ++it) {
      if (it->second.pins) continue;
      if (victim == g_translation_cache.end() ||
          it->second.last_use < victim->second.last_use) {
        victim = it;
      }
    }
    if (victim == g_translation_cache.end()) return;
    g_translation_cache_bytes -= victim->second.bytes;
    g_translation_cache.erase(victim);
  }
}

CachedTranslation* LookupTranslation(uint64_t key) {
  auto it = g_translation_cache.find(key);
  if (it == g_translation_cache.end()) return nullptr;
  CachedTranslation& entry = it->second;
  if (entry.generation_begin != GetWasmBackendExecutableContentGeneration(entry.begin) ||
      entry.generation_end != GetWasmBackendExecutableContentGeneration(entry.end)) {
    if (entry.pins) return nullptr;  // rewritten while running: retranslate
    g_translation_cache_bytes -= entry.bytes;
    g_translation_cache.erase(it);
    return nullptr;
  }
  entry.last_use = ++g_translation_cache_clock;
  return &entry;
}

// Runs a cached translation as ProbeAssembler::Assemble runs a nested one.
bool ExecuteCachedTranslation(CachedTranslation& entry) {
  auto* memory = g_probe_backend && g_probe_backend->processor()
                     ? g_probe_backend->processor()->memory()
                     : nullptr;
  if (!memory) return false;
  ++g_translation_cache_hits;
  ++entry.pins;
  NoteTrapPhase(kTrapPhaseExecute, entry.begin);
  const HIRCorrectnessResult result =
      ExecuteHIRCorrectnessProbe(entry.builder.get(), memory);
  --entry.pins;
  return result.supported && result.reached_return_boundary;
}

// DefineFunction (translate + execute), or the cached translation of the same
// function. The interior entry and provenance mode are applied by the caller.
bool DefineOrRunCached(xe::cpu::ppc::PPCFrontend* frontend,
                       xe::cpu::GuestFunction* function, uint64_t key) {
  if (CachedTranslation* cached = LookupTranslation(key)) {
    return ExecuteCachedTranslation(*cached);
  }
  ++g_translation_cache_misses;
  const bool saved_pending = g_retain_pending;
  const uint64_t saved_key = g_retain_key;
  const uint32_t saved_begin = g_retain_begin, saved_end = g_retain_end;
  g_retain_pending = true;
  g_retain_key = key;
  g_retain_begin = function->address();
  g_retain_end = function->end_address();
  const bool ok = frontend->DefineFunction(function, 0);
  g_retain_pending = saved_pending;
  g_retain_key = saved_key;
  g_retain_begin = saved_begin;
  g_retain_end = saved_end;
  return ok;
}

bool TranslateNestedGuestAddressOnce(uint32_t address, xe::cpu::Module* module,
                                     uint32_t call_flags);

// Tail-call trampoline. Xenia's x64 backend runs a cross-function `b` (HIR
// CALL with CALL_TAIL) as a real tail jump; the HIR executor would otherwise
// run it as one more nested call. Titles loop through tail branches (state
// machines, jump tables), which then grew the host and guest frame depth by
// one per iteration until return matching broke. A tail call made from a
// function this resolver is running is deferred: that function completes
// (CALL_TAIL ends its frame), and the target runs here in its place at the
// same depth, iteratively.
R360_FIBER_LOCAL uint32_t g_tail_frames_active = 0;
R360_FIBER_LOCAL bool g_pending_tail_valid = false;
R360_FIBER_LOCAL uint32_t g_pending_tail_address = 0;
R360_FIBER_LOCAL uint32_t g_pending_tail_flags = 0;
R360_FIBER_LOCAL xe::cpu::Module* g_pending_tail_module = nullptr;

bool TranslateNestedGuestAddress(uint32_t address, xe::cpu::Module* module) {
  // Guest call boundaries are where pending graphics interrupts run.
  MaybeDeliverGuestInterrupts();
  const uint32_t flags = GetHIRCorrectnessCurrentCallFlags();
  if ((flags & xe::cpu::hir::CALL_TAIL) && g_tail_frames_active > 0 &&
      !g_pending_tail_valid) {
    g_pending_tail_valid = true;
    g_pending_tail_address = address;
    g_pending_tail_flags = flags;
    g_pending_tail_module = module;
    return true;
  }
  ++g_tail_frames_active;
  bool ok = TranslateNestedGuestAddressOnce(address, module, flags);
  while (ok && g_pending_tail_valid) {
    g_pending_tail_valid = false;
    ok = TranslateNestedGuestAddressOnce(g_pending_tail_address,
                                         g_pending_tail_module,
                                         g_pending_tail_flags);
  }
  --g_tail_frames_active;
  g_pending_tail_valid = false;
  return ok;
}

bool TranslateNestedGuestAddressOnce(uint32_t address, xe::cpu::Module* module,
                                     uint32_t call_flags) {
  // Registered kernel/XAM import thunks are resolved before the bounded probe
  // memory check. Real XEX thunks may live outside the entry's 64 KiB staging
  // window, but a known HLE import is an external call boundary, not guest code
  // that should be scanned from the probe window.
  if (ResolveKernelImportThunk(address)) {
    const uint32_t abi_target = KernelImportProbeLastAbiTarget();
    R360_VERBOSE_TRACE( "R360_KERNEL_IMPORT resolved target=0x%08X module=%u ordinal=0x%X abi_target=0x%08X\n",
                 address, KernelImportProbeLastModule(), KernelImportProbeLastOrdinal(), abi_target);
    if (abi_target) {
      if (abi_target == address) {
        MarkKernelImportProbeAbiFailure();
        return false;
      }
      // The ABI critic is translated as nested PPC and therefore executes on
      // the same active PPCContext as the caller. It can consume r3..r10,
      // touch validated guest memory through the normal HIR load/store path,
      // write the return value into r3, return, and let the caller continue.
      const bool abi_ok = TranslateNestedGuestAddressOnce(abi_target, module, 0u);
      if (!abi_ok) MarkKernelImportProbeAbiFailure();
      return abi_ok;
    }
    return true;
  }
  // Any non-success outcome at a registered import thunk (unsupported,
  // invalid ABI, terminal title exit, would-block wait) is a kernel boundary.
  // Never fall through and translate the loader's thunk bytes as guest code.
  if (KernelImportProbeLastThunk() == address && KernelImportProbeLastStatus() >= 2) {
    std::fprintf(stderr, "R360_KERNEL_IMPORT stopped target=0x%08X module=%u ordinal=0x%X status=%u\n",
                 address, KernelImportProbeLastModule(), KernelImportProbeLastOrdinal(),
                 KernelImportProbeLastStatus());
    return false;
  }
  if (!g_probe_backend || !g_probe_backend->processor()) {
    std::fprintf(stderr, "R360_CALL_RESOLVE rejected: backend/processor missing\n"); return false;
  }
  auto* frontend = g_probe_backend->processor()->frontend();
  if (!frontend) { std::fprintf(stderr, "R360_CALL_RESOLVE rejected: frontend missing\n"); return false; }
  const bool is_tail = (call_flags & xe::cpu::hir::CALL_TAIL) != 0;

  // Xenia explicitly registers the Microsoft shared __restgprlr_* entries as
  // kEpilogReturn functions. They are valid tail-call entry points in their own
  // right: the caller has already restored r1 before branching into the helper,
  // and the helper consumes that live caller frame. Do not remap one of these
  // entries back to an enclosing .pdata owner and then jump into the middle of
  // the owner's HIR. Doing that skips HIR value definitions emitted before the
  // SOURCE_OFFSET marker and turns a valid stack load into a fake
  // guest-memory-dependency with faultAddress == 0.
  auto* target_function = g_probe_backend->processor()->QueryFunction(address);
  const bool epilog_by_metadata =
      target_function &&
      target_function->behavior() == xe::cpu::Function::Behavior::kEpilogReturn;
  uint32_t signature_first_gpr = 0;
  const bool epilog_by_signature =
      is_tail && MatchSharedEpilogReturnSignature(address, &signature_first_gpr);
  const bool is_epilog_return = epilog_by_metadata || epilog_by_signature;

  if (is_tail && is_epilog_return) {
    const bool helper_ok = ExecuteSharedEpilogReturn(address);
    R360_VERBOSE_TRACE(
                 "R360_CALL_RESOLVE epilog-inline target=0x%08X flags=0x%X meta=%u signature=%u first_gpr=%u result=%u\n",
                 address, call_flags, epilog_by_metadata ? 1u : 0u,
                 epilog_by_signature ? 1u : 0u, signature_first_gpr,
                 helper_ok ? 1u : 0u);
    return helper_ok;
  }

  uint32_t fn_begin = address, fn_end = 0, prolog = 0;
  bool pdata = PreparedPeGuestFindRuntimeFunction(address, &fn_begin, &fn_end,
                                                  &prolog);
  if (pdata &&
      (fn_end <= fn_begin || uint64_t(fn_end) - fn_begin > kProbeGuestSize)) {
    pdata = false;
    fn_begin = address;
    fn_end = 0;
    prolog = 0;
  }

  // Ordinary tail fragments may inherit the owning .pdata function, but Xenia
  // shared epilog helpers are already canonical function entries. Keep those
  // exact, just like linked calls, while retaining the owner/interior route for
  // real compiler-generated tail fragments such as Braid's 0x8236EB74 path.
  const bool use_owner = is_tail && pdata && !is_epilog_return;
  if (!use_owner) {
    fn_begin = address;
    fn_end = 0;
    prolog = 0;
  }

  auto loaded = [&]() {
    return IsInLoadedProbeWindow(fn_begin) &&
           (!use_owner ||
            (fn_end >= fn_begin + 4 && IsInLoadedProbeWindow(fn_end - 4)));
  };
  R360_VERBOSE_TRACE(
               "R360_CALL_RESOLVE target=0x%08X function=0x%08X flags=0x%X "
               "tail=%u epilog=%u pdata=%u owner=%u prolog=%u\n",
               address, fn_begin, call_flags, is_tail ? 1u : 0u,
               is_epilog_return ? 1u : 0u, pdata ? 1u : 0u,
               use_owner ? 1u : 0u, prolog);

  if (!loaded()) {
    const uint32_t paged = r360_ppc_probe_page_sparse_code(fn_begin);
    if (!paged || !loaded()) {
      std::fprintf(stderr,
                   "R360_CALL_RESOLVE rejected: target/function unavailable "
                   "target=0x%08X function=0x%08X owner=%u\n",
                   address, fn_begin, use_owner ? 1u : 0u);
      return false;
    }
  }

  if (StackHeadroom() < kMinNestedStackHeadroom) {
    g_trap_stack_exhausted = address;
    std::fprintf(stderr,
                 "R360_CALL_RESOLVE rejected: host stack exhausted target=0x%08X "
                 "depth=%u\n", address, g_trap_depth);
    return false;
  }
  ProbeGuestFunction nested_function(module, fn_begin);
  const uint32_t loaded_base = r360_ppc_probe_guest_base();
  const uint32_t loaded_size = r360_ppc_probe_loaded_size();
  if (loaded_size < 4) return false;
  const uint32_t scan_end =
      use_owner ? fn_end - 4 : loaded_base + loaded_size - 4;
  nested_function.set_end_address(scan_end);

  xe::cpu::ppc::PPCScanner scanner(frontend);
  if (!scanner.Scan(&nested_function, nullptr)) {
    std::fprintf(stderr,
                 "R360_CALL_RESOLVE scan failed target=0x%08X function=0x%08X "
                 "owner=%u\n",
                 address, fn_begin, use_owner ? 1u : 0u);
    return false;
  }
  if (use_owner && nested_function.end_address() < address) {
    nested_function.set_end_address(scan_end);
  }

  const uint32_t interior_entry =
      use_owner && address != fn_begin ? address : 0u;
  if (interior_entry) {
    // Clear any stale marker before this one exact owner/interior attempt.
    (void)ConsumeHIRCorrectnessInteriorEntryMissing();
  }
  SetHIRCorrectnessExecutionEntry(interior_entry);
  NoteTrapPhase(kTrapPhaseTranslate, address);
  ++g_trap_depth;
  const bool translated = DefineOrRunCached(
      frontend, &nested_function,
      TranslationKey(fn_begin, use_owner ? fn_end : 0u, false));
  --g_trap_depth;
  SetHIRCorrectnessExecutionEntry(0u);
  const uint32_t missing_entry =
      interior_entry ? ConsumeHIRCorrectnessInteriorEntryMissing() : 0u;
  R360_VERBOSE_TRACE(
               "R360_CALL_RESOLVE translated target=0x%08X function=0x%08X "
               "end=0x%08X flags=0x%X owner=%u interior=0x%08X result=%u\n",
               address, fn_begin, nested_function.end_address(), call_flags,
               use_owner ? 1u : 0u, interior_entry, translated ? 1u : 0u);

  // A compiler tail target may be a valid PPC instruction without surviving as
  // an exact SOURCE_OFFSET in finalized owner HIR. Do not guess a nearby marker:
  // replaying earlier HIR can duplicate side effects and starting later can skip
  // the target instruction. Re-translate only this exact PPC target as a
  // synthetic fragment, while keeping the owning .pdata end as the hard scan
  // boundary and the existing live PPCContext as execution state.
  const bool exact_interior_marker_missing =
      !translated && is_tail && use_owner && interior_entry &&
      missing_entry == interior_entry;
  if (!exact_interior_marker_missing) return translated;

  R360_VERBOSE_TRACE(
               "R360_TAIL_INTERIOR target=0x%08X owner=0x%08X end=0x%08X marker=0\n",
               address, fn_begin, fn_end);

  ProbeGuestFunction fragment(module, address);
  fragment.set_end_address(scan_end);
  xe::cpu::ppc::PPCScanner fragment_scanner(frontend);
  const bool fragment_scanned = fragment_scanner.Scan(&fragment, nullptr);
  if (!fragment_scanned) {
    R360_VERBOSE_TRACE(
                 "R360_TAIL_FRAGMENT_FALLBACK target=0x%08X owner=0x%08X "
                 "end=0x%08X scan=0 define=0\n",
                 address, fn_begin, fn_end);
    return false;
  }

  // address is now the fragment's real beginning, so requesting an interior HIR
  // entry would recreate the bug this fallback is intended to avoid.
  SetHIRCorrectnessExecutionEntry(0u);
  SetHIRCorrectnessContextProvenanceRecovery(true);
  const bool fragment_translated =
      DefineOrRunCached(frontend, &fragment, TranslationKey(address, fn_end, true));
  SetHIRCorrectnessContextProvenanceRecovery(false);
  SetHIRCorrectnessExecutionEntry(0u);
  R360_VERBOSE_TRACE(
               "R360_TAIL_FRAGMENT_FALLBACK target=0x%08X owner=0x%08X "
               "end=0x%08X scan=1 define=%u\n",
               address, fn_begin, fn_end, fragment_translated ? 1u : 0u);
  if (fragment_translated) {
    auto* context = GetHIRCorrectnessActiveContext();
    R360_VERBOSE_TRACE(
                 "R360_TAIL_FRAGMENT_EXECUTED target=0x%08X r1=0x%08X\n",
                 address,
                 context ? static_cast<uint32_t>(context->r[1]) : 0u);
  }
  return fragment_translated;
}
bool ResolveNestedGuestCall(xe::cpu::Function* function) { return function && TranslateNestedGuestAddress(function->address(), function->module()); }
bool ResolveNestedGuestAddress(uint32_t address) { return TranslateNestedGuestAddress(address, nullptr); }
}  // namespace

void ResetProbeTelemetry() { g_probe_telemetry = {}; }
bool WantsTranslatedBuilder() { return g_retain_pending; }
void RetainTranslatedBuilder(std::unique_ptr<xe::cpu::hir::HIRBuilder> builder) {
  if (!g_retain_pending || !builder) return;
  g_retain_pending = false;
  auto it = g_translation_cache.find(g_retain_key);
  if (it != g_translation_cache.end()) {
    if (it->second.pins) return;  // a stale entry is still executing
    g_translation_cache_bytes -= it->second.bytes;
    g_translation_cache.erase(it);
  }
  CachedTranslation entry;
  entry.begin = g_retain_begin;
  entry.end = g_retain_end ? g_retain_end : g_retain_begin;
  entry.generation_begin = GetWasmBackendExecutableContentGeneration(entry.begin);
  entry.generation_end = GetWasmBackendExecutableContentGeneration(entry.end);
  // Arena use is private to Xenia; an HIR instruction plus its result value
  // and operand uses is about 192 bytes, plus the 64 KiB first arena chunk.
  size_t instructions = 0;
  for (auto* block = builder->first_block(); block; block = block->next) {
    for (auto* instr = block->instr_head; instr; instr = instr->next) ++instructions;
  }
  entry.bytes = instructions * 192 + 64 * 1024;
  entry.last_use = ++g_translation_cache_clock;
  entry.builder = std::move(builder);
  g_translation_cache_bytes += entry.bytes;
  g_translation_cache.emplace(g_retain_key, std::move(entry));
  EvictTranslations();
}
void ResetTranslationCache() {
  for (auto it = g_translation_cache.begin(); it != g_translation_cache.end();) {
    if (it->second.pins) { ++it; continue; }
    g_translation_cache_bytes -= it->second.bytes;
    it = g_translation_cache.erase(it);
  }
  g_translation_cache_hits = g_translation_cache_misses = 0;
  g_retain_pending = false;
}
// __restgprlr_N entries found by r360_ppc_probe_register_save_rest
// (XexModule::FindSaveRest). The PPC scanner overlay consults this so a
// function ends at `b __restgprlr_N` before that helper was ever resolved.
namespace {
std::vector<uint32_t> g_rest_gpr_lr_addresses;
}
void RegisterRestGprLrAddress(uint32_t address) {
  if (!IsRegisteredRestGprLr(address)) g_rest_gpr_lr_addresses.push_back(address);
}
bool IsRegisteredRestGprLr(uint32_t address) {
  for (const uint32_t a : g_rest_gpr_lr_addresses) {
    if (a == address) return true;
  }
  return false;
}

void ResetTailTrampoline() {
  g_tail_frames_active = 0;
  g_pending_tail_valid = false;
}
void ResetTrapReport() {
  g_trap_reason[0] = 0;
  g_trap_phase = kTrapPhaseIdle;
  g_trap_address = 0;
  g_trap_depth = 0;
  g_trap_stack_low_water = 0;
  g_trap_stack_exhausted = 0;
}
void NoteTopLevelTranslate(uint32_t address) {
  NoteTrapPhase(kTrapPhaseTranslate, address);
}
const ProbeTelemetry& GetProbeTelemetry() { return g_probe_telemetry; }
void SetProbeExecuteCorrectnessOnAssemble(bool enabled) {
  g_execute_correctness_on_assemble = enabled;
}
bool GetProbeExecuteCorrectnessOnAssemble() {
  return g_execute_correctness_on_assemble;
}
ProbeGuestFunction::ProbeGuestFunction(xe::cpu::Module* module, uint32_t address) : xe::cpu::GuestFunction(module, address) {}
ProbeGuestFunction::~ProbeGuestFunction() = default;
bool ProbeGuestFunction::CallImpl(xe::cpu::ThreadState*, uint32_t) { return false; }
ProbeAssembler::ProbeAssembler(xe::cpu::backend::Backend* backend) : xe::cpu::backend::Assembler(backend) {}
ProbeAssembler::~ProbeAssembler() = default;

bool ProbeAssembler::Assemble(xe::cpu::GuestFunction* function, xe::cpu::hir::HIRBuilder* builder,
                              uint32_t, std::unique_ptr<xe::cpu::FunctionDebugInfo> debug_info) {
  const bool nested_execution = IsHIRCorrectnessExecutionActive();
  const bool execute_correctness =
      nested_execution || GetProbeExecuteCorrectnessOnAssemble();
  uint32_t block_count = 0, instruction_count = 0;
  for (auto* block = builder->first_block(); block; block = block->next) {
    const uint32_t block_index = block_count++;
    for (auto* instr = block->instr_head; instr; instr = instr->next) {
      ++instruction_count;
      R360_VERBOSE_TRACE( "R360_HIR%s block=%u ordinal=%u opcode=%s(%u)\n",
                   nested_execution ? "_NESTED" : "", block_index, instr->ordinal,
                   instr->opcode && instr->opcode->name ? instr->opcode->name : "<null>",
                   instr->opcode ? static_cast<unsigned>(instr->opcode->num) : 0u);
    }
  }

  ++g_probe_telemetry.assembled_functions;
  auto* memory = backend_ && backend_->processor() ? backend_->processor()->memory() : nullptr;
  const bool call_registered = RegisterWasmBackendCallFunction(function, builder);
  R360_VERBOSE_TRACE( "R360_WASM_BACKEND_CALL%s address=0x%08X registered=%u status=%u functions=%u\n",
               nested_execution ? "_NESTED" : "", function ? function->address() : 0u,
               call_registered ? 1u : 0u, GetWasmBackendCallStatus(), GetWasmBackendCallFunctionCount());

  if (!nested_execution) {
    g_probe_telemetry.hir_blocks = block_count;
    g_probe_telemetry.hir_instructions = instruction_count;
    g_probe_telemetry.last_guest_address = function ? function->address() : 0;
    BuildWasmBackendProbe(builder);
    BuildWasmBackendCfgProbe(builder);
    const uint32_t active_base = r360_ppc_probe_guest_base();
    uint8_t* guest_host_base = memory ? memory->TranslateVirtual<uint8_t*>(active_base) : nullptr;
    BuildWasmBackendMemoryProbe(builder, guest_host_base, active_base, kProbeGuestSize);
    BuildWasmBackendFpuProbe(builder, guest_host_base, active_base, kProbeGuestSize);
    BuildWasmBackendVmxProbe(builder, guest_host_base, active_base, kProbeGuestSize);

    R360_VERBOSE_TRACE( "R360_WASM_BACKEND status=%u module_bytes=%u lowered=%u\n", GetWasmBackendProbeStatus(), GetWasmBackendProbeModuleSize(), GetWasmBackendProbeLoweredInstructions());
    R360_VERBOSE_TRACE( "R360_WASM_BACKEND_CFG status=%u module_bytes=%u lowered=%u\n", GetWasmBackendCfgProbeStatus(), GetWasmBackendCfgProbeModuleSize(), GetWasmBackendCfgProbeLoweredInstructions());
    R360_VERBOSE_TRACE( "R360_WASM_BACKEND_MEMORY status=%u module_bytes=%u lowered=%u guest_host=0x%08X\n", GetWasmBackendMemoryProbeStatus(), GetWasmBackendMemoryProbeModuleSize(), GetWasmBackendMemoryProbeLoweredInstructions(), static_cast<uint32_t>(reinterpret_cast<uintptr_t>(guest_host_base)));
    R360_VERBOSE_TRACE( "R360_WASM_BACKEND_FPU status=%u module_bytes=%u lowered=%u\n", GetWasmBackendFpuProbeStatus(), GetWasmBackendFpuProbeModuleSize(), GetWasmBackendFpuProbeLoweredInstructions());
    R360_VERBOSE_TRACE( "R360_WASM_BACKEND_VMX status=%u module_bytes=%u lowered=%u vector_ops=%u native_simd=%u scalarized_lanes=%u\n",
                 GetWasmBackendVmxProbeStatus(), GetWasmBackendVmxProbeModuleSize(),
                 GetWasmBackendVmxProbeLoweredInstructions(), GetWasmBackendVmxProbeVectorOps(),
                 GetWasmBackendVmxProbeNativeSimdOps(), GetWasmBackendVmxProbeScalarizedLaneOps());
  }

  HIRCorrectnessResult correctness;
  if (execute_correctness) {
    NoteTrapPhase(kTrapPhaseExecute, function ? function->address() : 0u);
    correctness = ExecuteHIRCorrectnessProbe(builder, memory);
  } else {
    // Production browser translation must be side-effect-free. Register/lower
    // the generated function, but leave execution to the persistent scheduler.
    correctness.supported = true;
  }
  if (!nested_execution) {
    g_probe_telemetry.correctness_instructions = correctness.instructions_executed;
    g_probe_telemetry.correctness_r3 = correctness.r3;
    g_probe_telemetry.correctness_status =
        !execute_correctness ? 4u
                             : (!correctness.supported
                                    ? 1u
                                    : (!correctness.reached_return_boundary ? 2u
                                                                           : 3u));
    g_probe_telemetry.correctness_blocker_kind = correctness.blocker_kind;
    g_probe_telemetry.correctness_blocker_opcode = correctness.blocker_opcode;
    g_probe_telemetry.correctness_blocker_address = correctness.blocker_address;
  }
  R360_VERBOSE_TRACE( "R360_EXEC%s mode=%s status=%u instructions=%u r3=%llu return_boundary=%u\n",
               nested_execution ? "_NESTED" : "",
               execute_correctness ? "execute" : "translate-only",
               !execute_correctness ? 4u : (correctness.supported ? (correctness.reached_return_boundary ? 3u : 2u) : 1u),
               correctness.instructions_executed,
               static_cast<unsigned long long>(correctness.r3),
               correctness.reached_return_boundary ? 1u : 0u);
  if (function && debug_info) function->set_debug_info(std::move(debug_info));
  if (nested_execution) return correctness.supported && correctness.reached_return_boundary;
  return true;
}

ProbeBackend::ProbeBackend() = default;
ProbeBackend::~ProbeBackend() = default;
bool ProbeBackend::Initialize(xe::cpu::Processor* processor) {
  if (!xe::cpu::backend::Backend::Initialize(processor)) return false;
  g_probe_backend = this; SetHIRCorrectnessCallResolver(&ResolveNestedGuestCall); SetHIRCorrectnessAddressResolver(&ResolveNestedGuestAddress);
  std::fprintf(stderr, "R360_CALL_RESOLVERS_READY call=1 address=1 stable=1\n");
  machine_info_.supports_extended_load_store = false;
  auto& gprs = machine_info_.register_sets[0]; gprs.id=0; std::strcpy(gprs.name,"gpr"); gprs.types=xe::cpu::backend::MachineInfo::RegisterSet::INT_TYPES; gprs.count=7;
  auto& vecs = machine_info_.register_sets[1]; vecs.id=1; std::strcpy(vecs.name,"vec"); vecs.types=xe::cpu::backend::MachineInfo::RegisterSet::FLOAT_TYPES|xe::cpu::backend::MachineInfo::RegisterSet::VEC_TYPES; vecs.count=12;
  return true;
}
void ProbeBackend::CommitExecutableRange(uint32_t,uint32_t) {}
std::unique_ptr<xe::cpu::backend::Assembler> ProbeBackend::CreateAssembler(){return std::make_unique<ProbeAssembler>(this);}
std::unique_ptr<xe::cpu::GuestFunction> ProbeBackend::CreateGuestFunction(xe::cpu::Module* module,uint32_t address){return std::make_unique<ProbeGuestFunction>(module,address);}
uint64_t ProbeBackend::CalculateNextHostInstruction(xe::cpu::ThreadDebugInfo*,uint64_t){return 0;}
}  // namespace render360::xenia_web

extern "C" {
uint32_t r360_ppc_probe_assembled_functions(){return render360::xenia_web::GetProbeTelemetry().assembled_functions;}
uint32_t r360_ppc_probe_hir_block_count(){return render360::xenia_web::GetProbeTelemetry().hir_blocks;}
uint32_t r360_ppc_probe_hir_instruction_count(){return render360::xenia_web::GetProbeTelemetry().hir_instructions;}
uint32_t r360_ppc_probe_last_guest_address(){return render360::xenia_web::GetProbeTelemetry().last_guest_address;}
uint32_t r360_ppc_probe_correctness_status(){return render360::xenia_web::GetProbeTelemetry().correctness_status;}
uint32_t r360_ppc_probe_correctness_instructions(){return render360::xenia_web::GetProbeTelemetry().correctness_instructions;}
uint64_t r360_ppc_probe_correctness_r3(){return render360::xenia_web::GetProbeTelemetry().correctness_r3;}
uint32_t r360_ppc_probe_correctness_blocker_kind(){return render360::xenia_web::GetProbeTelemetry().correctness_blocker_kind;}
uint32_t r360_ppc_probe_correctness_blocker_opcode(){return render360::xenia_web::GetProbeTelemetry().correctness_blocker_opcode;}
uint32_t r360_ppc_probe_correctness_blocker_address(){return render360::xenia_web::GetProbeTelemetry().correctness_blocker_address;}
R360_WASM_EXPORT("r360_ppc_probe_set_execute_on_translate")
uint32_t r360_ppc_probe_set_execute_on_translate(uint32_t enabled){
  render360::xenia_web::SetProbeExecuteCorrectnessOnAssemble(enabled != 0);
  return render360::xenia_web::GetProbeExecuteCorrectnessOnAssemble() ? 1u : 0u;
}
R360_WASM_EXPORT("r360_ppc_probe_execute_on_translate")
uint32_t r360_ppc_probe_execute_on_translate(){
  return render360::xenia_web::GetProbeExecuteCorrectnessOnAssemble() ? 1u : 0u;
}
}
extern "C" {
#if defined(__wasm__)
// WASI reactor entry. Runs every global constructor once, as a native Xenia
// process start would: Xenia's cvar registration and dynamically initialized
// tables (e.g. ppc_emit_altivec.cc __vsldoi_table, which vsldoi permutes
// through) are zero otherwise. Node's WASI.initialize() and the browser host
// (render360-browser-wasi.mjs) call _initialize before any other export.
void __wasm_call_ctors(void);
R360_WASM_EXPORT("_initialize")
void render360_wasi_initialize() {
  static bool initialized = false;
  if (initialized) return;
  initialized = true;
  __wasm_call_ctors();
}
#endif

R360_WASM_EXPORT("r360_trap_reason")
uint32_t r360_trap_reason() {
  return static_cast<uint32_t>(reinterpret_cast<uintptr_t>(render360::xenia_web::g_trap_reason));
}
R360_WASM_EXPORT("r360_trap_reason_length")
uint32_t r360_trap_reason_length() {
  return static_cast<uint32_t>(std::strlen(render360::xenia_web::g_trap_reason));
}
R360_WASM_EXPORT("r360_trap_phase")
uint32_t r360_trap_phase() { return render360::xenia_web::g_trap_phase; }
R360_WASM_EXPORT("r360_trap_address")
uint32_t r360_trap_address() { return render360::xenia_web::g_trap_address; }
R360_WASM_EXPORT("r360_trap_depth")
uint32_t r360_trap_depth() { return render360::xenia_web::g_trap_depth; }
R360_WASM_EXPORT("r360_trap_stack_headroom")
uint32_t r360_trap_stack_headroom() {
#if defined(__wasm__)
  const uint32_t low = static_cast<uint32_t>(reinterpret_cast<uintptr_t>(&__stack_low));
  const uint32_t water = render360::xenia_web::g_trap_stack_low_water;
  return water > low ? water - low : 0;
#else
  return 0;
#endif
}
R360_WASM_EXPORT("r360_trap_stack_exhausted")
uint32_t r360_trap_stack_exhausted() { return render360::xenia_web::g_trap_stack_exhausted; }
R360_WASM_EXPORT("r360_trap_reset")
void r360_trap_reset() { render360::xenia_web::ResetTrapReport(); }
}

extern "C" {
// Translation cache statistics and budget (megabytes; 0 keeps the default).
uint32_t r360_hir_cache_hits() { return uint32_t(render360::xenia_web::g_translation_cache_hits); }
uint32_t r360_hir_cache_misses() { return uint32_t(render360::xenia_web::g_translation_cache_misses); }
uint32_t r360_hir_cache_entries() { return uint32_t(render360::xenia_web::g_translation_cache.size()); }
uint32_t r360_hir_cache_kilobytes() { return uint32_t(render360::xenia_web::g_translation_cache_bytes / 1024); }
uint32_t r360_hir_cache_set_budget_mb(uint32_t megabytes) {
  if (megabytes) render360::xenia_web::g_translation_cache_budget = size_t(megabytes) * 1024 * 1024;
  render360::xenia_web::EvictTranslations();
  return uint32_t(render360::xenia_web::g_translation_cache_budget / (1024 * 1024));
}
}
