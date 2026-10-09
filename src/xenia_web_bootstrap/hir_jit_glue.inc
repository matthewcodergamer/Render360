
// ---------------------------------------------------------------------------
// Render360 guest JIT glue (appended to the HIR executor by
// prepare-hir-jit-overlay.py). Generated code (hir_wasm_jit.cpp) calls these
// helpers for everything with side effects beyond its locals and the
// PPCContext, so guest calls, returns, memory, MMIO and atomics behave exactly
// as in ExecuteBuilder above.
// ---------------------------------------------------------------------------
namespace render360::xenia_web {
namespace {
xe::Memory* g_jit_memory = nullptr;
uint32_t g_jit_fault = 0;
// Operand/result exchange for r360_jit_h_exec: three 16-byte operand slots
// and the result slot.
alignas(16) uint8_t g_jit_scratch[64] = {};
uint32_t g_jit_fail_kind = 0, g_jit_fail_opcode = 0, g_jit_fail_address = 0;

// Blocker for a failed helper, preferring a nested callee's blocker as the
// executor does after a failed call.
void JitRecordFailure(uint32_t kind, uint32_t opcode, uint32_t source) {
  HIRCorrectnessResult nested;
  if (ConsumePendingNestedFailure(&nested)) {
    g_jit_fail_kind = nested.blocker_kind;
    g_jit_fail_opcode = nested.blocker_opcode;
    g_jit_fail_address = nested.blocker_address;
  } else {
    g_jit_fail_kind = kind;
    g_jit_fail_opcode = opcode;
    g_jit_fail_address = source;
  }
  g_jit_fault = 1;
}

uint64_t JitLoad(uint32_t address, uint32_t size, bool int32, uint32_t source) {
  if (int32 && size == 4) {
    uint32_t mmio_value = 0;
    if (ReadTitleGpuMmio(address, &mmio_value)) {
      return ByteSwapUnsigned(mmio_value, xe::cpu::hir::INT32_TYPE);
    }
  }
  uint64_t value = 0;
  if (ReadSparseGuestMemory(address, &value, size)) return value;
  uint8_t* host = nullptr;
  if (IsSyntheticProbeWindowRange(address, size) &&
      TranslateGuestRange(g_jit_memory, address, size, &host)) {
    std::memcpy(&value, host, size);
    return value;
  }
  std::fprintf(stderr,
               "R360_HIR_MEMORY_FAIL op=load address=0x%08X fault=%u fault_address=0x%08X size=%u jit=1\n",
               address, SparseGuestLastFaultCode(), SparseGuestLastFaultAddress(), size);
  g_current_source_address = source;
  JitRecordFailure(kHIRBlockerGuestMemory, xe::cpu::hir::OPCODE_LOAD, source);
  return 0;
}

void JitStore(uint32_t address, uint64_t value, uint32_t size, bool int32, uint32_t source) {
  if (int32 && size == 4) {
    const uint32_t logical = static_cast<uint32_t>(
        ByteSwapUnsigned(uint32_t(value), xe::cpu::hir::INT32_TYPE));
    if (WriteTitleGpuMmio(address, logical)) return;
  }
  if (WriteSparseGuestMemory(address, &value, size)) {
    if (g_debug_watch_address && g_debug_watch_address - address < size) {
      std::fprintf(stderr, "R360_WATCH cpu pc=0x%08X address=0x%08X size=%u value=0x%llX jit=1\n",
                   source, address, size, static_cast<unsigned long long>(value));
    }
    return;
  }
  uint8_t* host = nullptr;
  if (IsSyntheticProbeWindowRange(address, size) &&
      TranslateGuestRange(g_jit_memory, address, size, &host)) {
    std::memcpy(host, &value, size);
    return;
  }
  std::fprintf(stderr,
               "R360_HIR_MEMORY_FAIL op=store address=0x%08X fault=%u fault_address=0x%08X size=%u jit=1\n",
               address, SparseGuestLastFaultCode(), SparseGuestLastFaultAddress(), size);
  g_current_source_address = source;
  JitRecordFailure(kHIRBlockerGuestMemory, xe::cpu::hir::OPCODE_STORE, source);
}
}  // namespace

uint32_t JitInstructionCounterAddress() {
  return uint32_t(reinterpret_cast<uintptr_t>(&g_total_instructions));
}
uint32_t JitFaultAddress() { return uint32_t(reinterpret_cast<uintptr_t>(&g_jit_fault)); }
uint32_t JitScratchAddress() { return uint32_t(reinterpret_cast<uintptr_t>(g_jit_scratch)); }
uint32_t JitReturnAddressSlot() {
  return uint32_t(reinterpret_cast<uintptr_t>(&g_next_guest_return_address));
}
uint32_t JitReturnValidSlot() {
  static_assert(sizeof(g_next_guest_return_valid) == 1, "token is one byte");
  return uint32_t(reinterpret_cast<uintptr_t>(&g_next_guest_return_valid));
}
bool JitDecodeDirectCall(uint32_t source, uint32_t* target) {
  return DecodeDirectBranchFromSource(source, target);
}

// Diagnostics (r360_jit_profile): interpreted HIR instructions per function
// start and reason (0 interior entry, else JitLastDecision()).
bool g_jit_profile = false;
uint64_t g_jit_exec_histogram[256] = {};
std::unordered_map<uint64_t, uint64_t> g_jit_exec_variants;
struct JitProfileEntry { uint64_t instructions = 0; uint32_t runs = 0; };
std::unordered_map<uint64_t, JitProfileEntry> g_jit_profile_entries;
void JitProfileInterpreted(xe::cpu::hir::HIRBuilder* builder, uint32_t reason, uint32_t instructions) {
  if (!g_jit_profile || !builder) return;
  uint32_t start = 0;
  for (auto* b = builder->first_block(); b && !start; b = b->next) {
    for (auto* i = b->instr_head; i; i = i->next) {
      if (i->opcode && i->opcode->num == xe::cpu::hir::OPCODE_SOURCE_OFFSET) { start = uint32_t(i->src1.offset); break; }
    }
  }
  if (reason == 4) reason = 0x100u | JitRejectOpcode(builder);
  auto& e = g_jit_profile_entries[(uint64_t(reason) << 32) | start];
  e.instructions += instructions;
  ++e.runs;
}

// Runs `builder` as compiled code when it has some (ExecuteHIRCorrectnessProbe
// calls this in place of ExecuteBuilder for plain function entries).
bool JitTryExecute(xe::cpu::hir::HIRBuilder* builder, xe::Memory* memory,
                   xe::cpu::ppc::PPCContext& context, HIRCorrectnessResult* result) {
  const uint32_t function = JitTakeFunction(builder);
  if (!function) return false;
  g_jit_memory = memory;
  g_jit_fault = 0;
  g_jit_fail_kind = g_jit_fail_opcode = g_jit_fail_address = 0;
  const uint32_t status = reinterpret_cast<uint32_t (*)(uint32_t)>(uintptr_t(function))(
      uint32_t(reinterpret_cast<uintptr_t>(&context)));
  *result = HIRCorrectnessResult{};
  result->r3 = context.r[3];
  switch (status) {
    case kJitStatusReturned:
      result->supported = true;
      result->reached_return_boundary = true;
      break;
    case kJitStatusFellOff:
      result->supported = true;
      result->blocker_kind = kHIRBlockerNoReturnBoundary;
      result->blocker_address = g_current_source_address;
      break;
    default:
      result->supported = false;
      result->blocker_kind = g_jit_fail_kind ? g_jit_fail_kind : kHIRBlockerUnsupportedOpcode;
      result->blocker_opcode = g_jit_fail_opcode;
      result->blocker_address = g_jit_fail_address;
      break;
  }
  return true;
}

}  // namespace render360::xenia_web

namespace rxj = render360::xenia_web;
extern "C" {
#define R360_JIT_HELPER(name) __attribute__((used, export_name("r360_jit_h_" #name)))

R360_JIT_HELPER(call) uint32_t r360_jit_h_call(uint32_t symbol, uint32_t flags, uint32_t source) {
  rxj::g_current_source_address = source;
  auto* function = reinterpret_cast<xe::cpu::Function*>(uintptr_t(symbol));
  if (rxj::ResolveFunctionCallWithNestedFailure(function, flags)) return 1;
  rxj::JitRecordFailure(rxj::kHIRBlockerUnresolvedCall, xe::cpu::hir::OPCODE_CALL, source);
  return 0;
}
// CALL without a symbol: the executor's decoded direct-branch fallback.
R360_JIT_HELPER(call_addr) uint32_t r360_jit_h_call_addr(uint32_t target, uint32_t flags, uint32_t source) {
  rxj::g_current_source_address = source;
  if (rxj::g_address_resolver && rxj::ResolveAddressCallWithNestedFailure(target, flags)) return 1;
  rxj::JitRecordFailure(rxj::kHIRBlockerUnresolvedCall, xe::cpu::hir::OPCODE_CALL, source);
  return 0;
}
R360_JIT_HELPER(call_indirect) uint32_t r360_jit_h_call_indirect(uint32_t target, uint32_t flags, uint32_t source) {
  rxj::g_current_source_address = source;
  bool reached_return = false, block_terminated = false;
  if (!rxj::ExecuteIndirect(uint64_t(target), flags, &reached_return, &block_terminated)) {
    rxj::JitRecordFailure(rxj::kHIRBlockerUnresolvedCall, xe::cpu::hir::OPCODE_CALL_INDIRECT, source);
    return 0;
  }
  return reached_return ? 2u : 1u;
}
R360_JIT_HELPER(call_extern) uint32_t r360_jit_h_call_extern(uint32_t symbol, uint32_t source) {
  auto* function = reinterpret_cast<xe::cpu::Function*>(uintptr_t(symbol));
  if (function && function->behavior() == xe::cpu::Function::Behavior::kBuiltin &&
      rxj::g_active_context) {
    auto* builtin = static_cast<xe::cpu::BuiltinFunction*>(function);
    if (builtin->handler()) {
      builtin->handler()(rxj::g_active_context, builtin->arg0(), builtin->arg1());
      return 1;
    }
  }
  rxj::JitRecordFailure(rxj::kHIRBlockerUnsupportedOpcode, xe::cpu::hir::OPCODE_CALL_EXTERN, source);
  return 0;
}
R360_JIT_HELPER(set_return) void r360_jit_h_set_return(uint64_t address) {
  rxj::g_next_guest_return_address = address;
  rxj::g_next_guest_return_valid = true;
}
R360_JIT_HELPER(ld8) uint32_t r360_jit_h_ld8(uint32_t a, uint32_t s) { return uint32_t(rxj::JitLoad(a, 1, false, s)); }
R360_JIT_HELPER(ld16) uint32_t r360_jit_h_ld16(uint32_t a, uint32_t s) { return uint32_t(rxj::JitLoad(a, 2, false, s)); }
R360_JIT_HELPER(ld32) uint32_t r360_jit_h_ld32(uint32_t a, uint32_t s, uint32_t i) { return uint32_t(rxj::JitLoad(a, 4, i != 0, s)); }
R360_JIT_HELPER(ld64) uint64_t r360_jit_h_ld64(uint32_t a, uint32_t s) { return rxj::JitLoad(a, 8, false, s); }
R360_JIT_HELPER(st8) void r360_jit_h_st8(uint32_t a, uint32_t v, uint32_t s) { rxj::JitStore(a, v & 0xFFu, 1, false, s); }
R360_JIT_HELPER(st16) void r360_jit_h_st16(uint32_t a, uint32_t v, uint32_t s) { rxj::JitStore(a, v & 0xFFFFu, 2, false, s); }
R360_JIT_HELPER(st32) void r360_jit_h_st32(uint32_t a, uint32_t v, uint32_t s, uint32_t i) { rxj::JitStore(a, v, 4, i != 0, s); }
R360_JIT_HELPER(st64) void r360_jit_h_st64(uint32_t a, uint64_t v, uint32_t s) { rxj::JitStore(a, v, 8, false, s); }
// Loops in generated code poll here: guest interrupts, preemption and host
// time slices (may unwind), and the --max-minstr budget.
R360_JIT_HELPER(poll) uint32_t r360_jit_h_poll() {
  rxj::DeliverGuestInterruptsNow();
  if (rxj::g_total_instruction_budget &&
      rxj::g_total_instructions > rxj::g_total_instruction_budget) {
    rxj::g_jit_fail_kind = rxj::kHIRBlockerInstructionLimit;
    rxj::g_jit_fail_opcode = 0;
    rxj::g_jit_fail_address = rxj::g_current_source_address;
    return 0;
  }
  return 1;
}
R360_JIT_HELPER(clock) uint64_t r360_jit_h_clock() {
  timespec ts{};
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return (uint64_t(ts.tv_sec) * 1000000000ull + uint64_t(ts.tv_nsec)) / 20u;
}
R360_JIT_HELPER(memset) void r360_jit_h_memset(uint32_t address, uint32_t byte, uint32_t length, uint32_t source) {
  if (length > 4096) {
    rxj::JitRecordFailure(rxj::kHIRBlockerUnsupportedOpcode, xe::cpu::hir::OPCODE_MEMSET, source);
    return;
  }
  if (!length) return;
  uint8_t fill[4096];
  std::memset(fill, int(byte & 0xFF), length);
  if (!rxj::WriteSparseGuestMemory(address, fill, length)) {
    rxj::JitRecordFailure(rxj::kHIRBlockerUnsupportedOpcode, xe::cpu::hir::OPCODE_MEMSET, source);
  }
}
R360_JIT_HELPER(atomic) uint64_t r360_jit_h_atomic(uint32_t address, uint32_t size, uint64_t desired,
                                                  uint64_t expected, uint32_t cas, uint32_t source) {
  const uint32_t opcode = cas ? xe::cpu::hir::OPCODE_ATOMIC_COMPARE_EXCHANGE
                              : xe::cpu::hir::OPCODE_ATOMIC_EXCHANGE;
  uint64_t current = 0;
  if (!rxj::ReadSparseGuestMemory(address, &current, size)) {
    rxj::JitRecordFailure(rxj::kHIRBlockerUnsupportedOpcode, opcode, source);
    return 0;
  }
  const uint64_t mask = size == 8 ? ~0ull : ((1ull << (size * 8u)) - 1u);
  const bool swap = !cas || current == (expected & mask);
  if (swap && !rxj::WriteSparseGuestMemory(address, &desired, size)) {
    rxj::JitRecordFailure(rxj::kHIRBlockerUnsupportedOpcode, opcode, source);
    return 0;
  }
  return cas ? (swap ? 1u : 0u) : current;
}
R360_JIT_HELPER(set_rounding) void r360_jit_h_set_rounding(uint32_t mode) {
  rxj::g_ppc_rounding_mode = mode & 7u;
}
// CONVERT float -> int exactly as the executor's vector path (Xenia x64:
// cvt(t)sd2si "integer indefinite" for NaN/out of range, I64 saturating to
// INT64_MAX for a non-negative source, I32 from F64 clamped by vminsd first).
// kind: bit 0 = 64-bit result, bit 1 = FLOAT64 source.
R360_JIT_HELPER(cvt_f2i) uint64_t r360_jit_h_cvt_f2i(double x, uint32_t round_mode, uint32_t kind, uint32_t) {
  const bool trunc = round_mode == xe::cpu::hir::ROUND_TO_ZERO;
  auto cvt = [&](double v, double lo, double hi, int64_t indefinite) -> int64_t {
    if (std::isnan(v)) return indefinite;
    const double r = trunc ? std::trunc(v) : rxj::RoundWithPpcMode(v);
    if (r < lo || r > hi) return indefinite;
    return int64_t(r);
  };
  if (kind & 1u) {
    int64_t r = cvt(x, -9223372036854775808.0, 9223372036854774784.0, INT64_MIN);
    if (r == INT64_MIN && !std::signbit(x)) r = INT64_MAX;
    return uint64_t(r);
  }
  if (kind & 2u) x = x < 2147483647.0 ? x : 2147483647.0;
  return uint64_t(uint32_t(int32_t(cvt(x, -2147483648.0, 2147483647.0, INT32_MIN))));
}
R360_JIT_HELPER(mulhi64) uint64_t r360_jit_h_mulhi64(uint64_t a, uint64_t b, uint32_t is_unsigned) {
  return is_unsigned ? uint64_t((unsigned __int128)a * (unsigned __int128)b >> 64)
                     : uint64_t(((__int128)int64_t(a) * (__int128)int64_t(b)) >> 64);
}
__attribute__((used, export_name("r360_jit_profile")))
uint32_t r360_jit_profile(uint32_t command) {
  if (command == 1) { rxj::g_jit_profile = true; rxj::g_jit_profile_entries.clear(); return 1; }
  {
    uint64_t total = 0;
    for (uint64_t c : rxj::g_jit_exec_histogram) total += c;
    std::fprintf(stderr, "R360_JITPROF exec-helper total=%llu\n", (unsigned long long)total);
    std::vector<std::pair<uint64_t, uint64_t>> variants(rxj::g_jit_exec_variants.begin(), rxj::g_jit_exec_variants.end());
    std::sort(variants.begin(), variants.end(), [](auto& a, auto& b) { return a.second > b.second; });
    for (size_t n = 0; n < variants.size() && n < 16; ++n) {
      const uint64_t k = variants[n].first;
      std::fprintf(stderr, "R360_JITPROF variant %-20s flags=0x%04X src1=%u src2=%u dest=%u count=%llu\n",
                   r360_hir_opcode_name(uint32_t(k >> 32)), uint32_t((k >> 12) & 0xFFFF), uint32_t((k >> 8) & 15),
                   uint32_t((k >> 4) & 15), uint32_t(k & 15), (unsigned long long)variants[n].second);
    }
    for (int round = 0; round < 20; ++round) {
      int best = -1;
      for (int op = 0; op < 256; ++op)
        if (rxj::g_jit_exec_histogram[op] && (best < 0 || rxj::g_jit_exec_histogram[op] > rxj::g_jit_exec_histogram[best])) best = op;
      if (best < 0) break;
      std::fprintf(stderr, "R360_JITPROF exec %-24s %llu\n", r360_hir_opcode_name(best), (unsigned long long)rxj::g_jit_exec_histogram[best]);
      rxj::g_jit_exec_histogram[best] = 0;
    }
  }
  std::vector<std::pair<uint64_t, rxj::JitProfileEntry>> rows(rxj::g_jit_profile_entries.begin(), rxj::g_jit_profile_entries.end());
  std::sort(rows.begin(), rows.end(), [](auto& a, auto& b) { return a.second.instructions > b.second.instructions; });
  uint64_t total = 0;
  for (auto& r : rows) total += r.second.instructions;
  std::fprintf(stderr, "R360_JITPROF interpreted=%llu functions=%u\n", (unsigned long long)total, unsigned(rows.size()));
  static const char* kReasons[] = {"interior", "uncached", "cold", "pending", "rejected", "off"};
  for (size_t n = 0; n < rows.size() && n < 25; ++n) {
    const uint32_t reason = uint32_t(rows[n].first >> 32);
    std::fprintf(stderr, "R360_JITPROF %08X %-9s %-24s %10llu instr %8u runs\n", uint32_t(rows[n].first),
                 reason < 6 ? kReasons[reason] : "rejected",
                 reason >= 0x100 ? r360_hir_opcode_name(reason & 0xFF) : "",
                 (unsigned long long)rows[n].second.instructions, rows[n].second.runs);
  }
  return 1;
}
// Runs one HIR instruction with the executor's semantics (JitExecuteSingle):
// operands come from the scratch slots, the result goes to slot 3.
R360_JIT_HELPER(exec) uint32_t r360_jit_h_exec(uint32_t instr_ptr, uint32_t source) {
  using namespace xe::cpu::hir;
  auto* instr = reinterpret_cast<Instr*>(uintptr_t(instr_ptr));
  static rxj::RuntimeValues values;
  if (rxj::g_jit_profile) {
    ++rxj::g_jit_exec_histogram[instr->opcode->num & 0xFF];
    const auto vt = [](const Value* v) { return v ? uint32_t(v->type) : 15u; };
    ++rxj::g_jit_exec_variants[(uint64_t(instr->opcode->num) << 32) | (uint64_t(instr->flags & 0xFFFF) << 12) |
                               (vt(instr->src1.value) << 8) | (vt(instr->src2.value) << 4) |
                               vt(instr->dest)];
  }
  const auto sig = instr->opcode->signature;
  const Value* operands[3] = {
      GET_OPCODE_SIG_TYPE_SRC1(sig) == OPCODE_SIG_TYPE_V ? instr->src1.value : nullptr,
      GET_OPCODE_SIG_TYPE_SRC2(sig) == OPCODE_SIG_TYPE_V ? instr->src2.value : nullptr,
      GET_OPCODE_SIG_TYPE_SRC3(sig) == OPCODE_SIG_TYPE_V ? instr->src3.value : nullptr};
  for (int n = 0; n < 3; ++n) {
    const Value* v = operands[n];
    if (!v || v->IsConstant()) continue;
    rxj::RuntimeValue rv;
    rv.type = v->type;
    rv.value = {};
    std::memcpy(&rv.value, rxj::g_jit_scratch + 16 * n, GetTypeSize(v->type));
    values[v] = rv;
  }
  rxj::g_current_source_address = source;
  if (!rxj::g_active_context ||
      !rxj::JitExecuteSingle(instr, values, rxj::g_jit_memory, *rxj::g_active_context)) {
    const uint32_t op = instr->opcode->num;
    const bool memory_op = op == OPCODE_LOAD || op == OPCODE_LOAD_OFFSET ||
                           op == OPCODE_STORE || op == OPCODE_STORE_OFFSET;
    rxj::JitRecordFailure(memory_op ? rxj::kHIRBlockerGuestMemory : rxj::kHIRBlockerUnsupportedOpcode, op, source);
    return 0;
  }
  if (instr->dest) {
    auto* slot = values.find(instr->dest);
    if (!slot) {
      rxj::JitRecordFailure(rxj::kHIRBlockerUnsupportedOpcode, instr->opcode->num, source);
      return 0;
    }
    std::memset(rxj::g_jit_scratch + 48, 0, 16);  // narrow results read as zero-extended
    std::memcpy(rxj::g_jit_scratch + 48, &slot->second.value, GetTypeSize(instr->dest->type));
  }
  return 1;
}
// 16-byte guest loads/stores for generated VMX code (lvx/stvx), through the
// scratch result slot; raw bytes as LoadGuestValue/StoreGuestValue move them.
R360_JIT_HELPER(ld128) void r360_jit_h_ld128(uint32_t address, uint32_t source) {
  uint8_t* out = rxj::g_jit_scratch + 48;
  if (rxj::ReadSparseGuestMemory(address, out, 16)) return;
  uint8_t* host = nullptr;
  if (rxj::IsSyntheticProbeWindowRange(address, 16) &&
      rxj::TranslateGuestRange(rxj::g_jit_memory, address, 16, &host)) {
    std::memcpy(out, host, 16);
    return;
  }
  std::fprintf(stderr, "R360_HIR_MEMORY_FAIL op=load address=0x%08X size=16 jit=1\n", address);
  rxj::g_current_source_address = source;
  rxj::JitRecordFailure(rxj::kHIRBlockerGuestMemory, xe::cpu::hir::OPCODE_LOAD, source);
}
R360_JIT_HELPER(st128) void r360_jit_h_st128(uint32_t address, uint32_t source) {
  const uint8_t* in = rxj::g_jit_scratch + 48;
  if (rxj::WriteSparseGuestMemory(address, in, 16)) return;
  uint8_t* host = nullptr;
  if (rxj::IsSyntheticProbeWindowRange(address, 16) &&
      rxj::TranslateGuestRange(rxj::g_jit_memory, address, 16, &host)) {
    std::memcpy(host, in, 16);
    return;
  }
  std::fprintf(stderr, "R360_HIR_MEMORY_FAIL op=store address=0x%08X size=16 jit=1\n", address);
  rxj::g_current_source_address = source;
  rxj::JitRecordFailure(rxj::kHIRBlockerGuestMemory, xe::cpu::hir::OPCODE_STORE, source);
}
R360_JIT_HELPER(fail) void r360_jit_h_fail(uint32_t kind, uint32_t opcode, uint32_t source) {
  rxj::JitRecordFailure(kind, opcode, source);
}
#undef R360_JIT_HELPER
}  // extern "C"
