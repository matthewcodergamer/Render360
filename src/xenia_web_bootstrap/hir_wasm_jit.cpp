// Render360 guest JIT: finalized Xenia HIR -> WebAssembly (see hir_wasm_jit.h).
#include "hir_wasm_jit.h"

#include <cstdio>
#include <cstring>
#include <unordered_map>
#include <vector>

#include "xenia/cpu/function.h"
#include "xenia/cpu/hir/block.h"
#include "xenia/cpu/hir/hir_builder.h"
#include "xenia/cpu/hir/instr.h"
#include "xenia/cpu/hir/label.h"
#include "xenia/cpu/hir/opcodes.h"
#include "xenia/cpu/hir/value.h"

namespace render360::xenia_web {

// Addresses the generated code bakes in (hir_jit_glue.inc).
uint32_t JitInstructionCounterAddress();
uint32_t JitFaultAddress();
uint32_t JitScratchAddress();
// Fiber-local expected-return token (SET_RETURN_ADDRESS) the executor keeps.
uint32_t JitReturnAddressSlot();
uint32_t JitReturnValidSlot();
// Target of the direct b/bl at `source` (the executor's fallback for a CALL
// without a symbol), when it decodes.
bool JitDecodeDirectCall(uint32_t source, uint32_t* target);

namespace {

using xe::cpu::hir::Block;
using xe::cpu::hir::HIRBuilder;
using xe::cpu::hir::Instr;
using xe::cpu::hir::TypeName;
using xe::cpu::hir::Value;
namespace hir = xe::cpu::hir;

// --- Policy ------------------------------------------------------------------
// 0 off, 1 compile hot functions, 2 compile on first execution (tests).
uint32_t g_mode = 1;
uint32_t g_hot_threshold = 2;
// Host callback installed by render360-guest-jit.mjs: (bytes, length,
// request id) -> table index, or 0 when the module compiles asynchronously
// (the host then calls r360_jit_install).
using CompilerFn = uint32_t (*)(uint32_t, uint32_t, uint32_t);
uint32_t g_compiler = 0;
uint32_t g_next_request = 1;
std::unordered_map<uint32_t, JitSlot*> g_pending;
HIRBuilder* g_candidate_builder = nullptr;
uint32_t g_last_decision = 0;
JitSlot* g_candidate_slot = nullptr;
// Telemetry.
uint32_t g_compiled = 0, g_rejected = 0, g_compile_failures = 0;
uint64_t g_jit_calls = 0;
uint32_t g_last_reject_opcode = 0;
uint32_t g_reject_histogram[256] = {};
std::unordered_map<const HIRBuilder*, uint32_t> g_reject_by_builder;
size_t g_code_bytes = 0;

// --- Wasm encoding -----------------------------------------------------------
enum : uint8_t {
  kI32 = 0x7F, kI64 = 0x7E, kF32 = 0x7D, kF64 = 0x7C, kV128 = 0x7B, kVoid = 0x40,
};

struct Bytes {
  std::vector<uint8_t> b;
  void u8(uint8_t v) { b.push_back(v); }
  void u32(uint32_t v) {
    do {
      uint8_t byte = v & 0x7F;
      v >>= 7;
      if (v) byte |= 0x80;
      b.push_back(byte);
    } while (v);
  }
  void s64(int64_t v) {
    bool more = true;
    while (more) {
      uint8_t byte = v & 0x7F;
      v >>= 7;
      if ((v == 0 && !(byte & 0x40)) || (v == -1 && (byte & 0x40))) {
        more = false;
      } else {
        byte |= 0x80;
      }
      b.push_back(byte);
    }
  }
  void s32(int32_t v) { s64(v); }
  void raw(const void* p, size_t n) {
    const uint8_t* q = static_cast<const uint8_t*>(p);
    b.insert(b.end(), q, q + n);
  }
  void str(const char* s) {
    const size_t n = std::strlen(s);
    u32(uint32_t(n));
    raw(s, n);
  }
  void append(const Bytes& o) { b.insert(b.end(), o.b.begin(), o.b.end()); }
  void section(uint8_t id, const Bytes& body) {
    u8(id);
    u32(uint32_t(body.b.size()));
    append(body);
  }
};

// Helper imports (module "h"); render360-guest-jit.mjs binds each name to
// the core export r360_jit_h_<name> (state -> asyncify_get_state).
struct HelperDef {
  const char* name;
  std::vector<uint8_t> params;
  std::vector<uint8_t> results;
};
enum Helper : uint32_t {
  kHState, kHSpillAlloc, kHSpillPop, kHCall, kHCallIndirect, kHSetReturn,
  kHLd8, kHLd16, kHLd32, kHLd64, kHSt8, kHSt16, kHSt32, kHSt64, kHPoll,
  kHClock, kHMemset, kHAtomic, kHSetRounding, kHCallExtern, kHCvtF2I,
  kHMulHi64, kHFail, kHCallAddr, kHExec, kHLd128, kHSt128, kHelperCount,
};
const std::vector<HelperDef>& Helpers() {
  static const std::vector<HelperDef> defs = {
      {"state", {}, {kI32}},
      {"spill_alloc", {kI32}, {kI32}},
      {"spill_pop", {kI32}, {kI32}},
      {"call", {kI32, kI32, kI32}, {kI32}},
      {"call_indirect", {kI32, kI32, kI32}, {kI32}},
      {"set_return", {kI64}, {}},
      {"ld8", {kI32, kI32}, {kI32}},
      {"ld16", {kI32, kI32}, {kI32}},
      {"ld32", {kI32, kI32, kI32}, {kI32}},
      {"ld64", {kI32, kI32}, {kI64}},
      {"st8", {kI32, kI32, kI32}, {}},
      {"st16", {kI32, kI32, kI32}, {}},
      {"st32", {kI32, kI32, kI32, kI32}, {}},
      {"st64", {kI32, kI64, kI32}, {}},
      {"poll", {}, {kI32}},
      {"clock", {}, {kI64}},
      {"memset", {kI32, kI32, kI32, kI32}, {}},
      {"atomic", {kI32, kI32, kI64, kI64, kI32, kI32}, {kI64}},
      {"set_rounding", {kI32}, {}},
      {"call_extern", {kI32, kI32}, {kI32}},
      {"cvt_f2i", {kF64, kI32, kI32, kI32}, {kI64}},
      {"mulhi64", {kI64, kI64, kI32}, {kI64}},
      {"fail", {kI32, kI32, kI32}, {}},
      {"call_addr", {kI32, kI32, kI32}, {kI32}},
      {"exec", {kI32, kI32}, {kI32}},
      {"ld128", {kI32, kI32}, {}},
      {"st128", {kI32, kI32}, {}},
  };
  return defs;
}

// Opcodes.
enum : uint8_t {
  oUnreachable = 0x00, oBlock = 0x02, oLoop = 0x03, oIf = 0x04, oElse = 0x05,
  oEnd = 0x0B, oBr = 0x0C, oBrTable = 0x0E, oReturn = 0x0F, oCall = 0x10,
  oDrop = 0x1A, oSelect = 0x1B, oLocalGet = 0x20, oLocalSet = 0x21,
  oLocalTee = 0x22, oI32Load = 0x28, oI64Load = 0x29, oF32Load = 0x2A,
  oF64Load = 0x2B, oI32Load8U = 0x2D, oI32Load16U = 0x2F, oI32Store = 0x36,
  oI64Store = 0x37, oF32Store = 0x38, oF64Store = 0x39, oI32Store8 = 0x3A,
  oI32Store16 = 0x3B, oI32Const = 0x41, oI64Const = 0x42, oF32Const = 0x43,
  oF64Const = 0x44, oI32Eqz = 0x45, oI32Eq = 0x46, oI32Ne = 0x47,
  oI32LtS = 0x48, oI32LtU = 0x49, oI32GtS = 0x4A, oI32GtU = 0x4B,
  oI32LeS = 0x4C, oI32LeU = 0x4D, oI32GeS = 0x4E, oI32GeU = 0x4F,
  oI64Eqz = 0x50, oI64Eq = 0x51, oI64Ne = 0x52, oI64LtS = 0x53,
  oI64LtU = 0x54, oI64GtS = 0x55, oI64GtU = 0x56, oI64LeS = 0x57,
  oI64LeU = 0x58, oI64GeS = 0x59, oI64GeU = 0x5A, oF32Eq = 0x5B,
  oF32Ne = 0x5C, oF32Lt = 0x5D, oF32Gt = 0x5E, oF32Le = 0x5F, oF32Ge = 0x60,
  oF64Eq = 0x61, oF64Ne = 0x62, oF64Lt = 0x63, oF64Gt = 0x64, oF64Le = 0x65,
  oF64Ge = 0x66, oI32Clz = 0x67, oI32Add = 0x6A, oI32Sub = 0x6B,
  oI32Mul = 0x6C, oI32DivS = 0x6D, oI32DivU = 0x6E, oI32And = 0x71,
  oI32Or = 0x72, oI32Xor = 0x73, oI32Shl = 0x74, oI32ShrS = 0x75,
  oI32ShrU = 0x76, oI32Rotl = 0x77, oI32Rotr = 0x78, oI64Clz = 0x79,
  oI64Add = 0x7C, oI64Sub = 0x7D, oI64Mul = 0x7E, oI64DivS = 0x7F,
  oI64DivU = 0x80, oI64And = 0x83, oI64Or = 0x84, oI64Xor = 0x85,
  oI64Shl = 0x86, oI64ShrS = 0x87, oI64ShrU = 0x88, oI64Rotl = 0x89,
  oI64Rotr = 0x8A, oF32Abs = 0x8B, oF32Neg = 0x8C, oF32Ceil = 0x8D,
  oF32Floor = 0x8E, oF32Trunc = 0x8F, oF32Nearest = 0x90, oF32Add = 0x92,
  oF32Sub = 0x93, oF32Mul = 0x94, oF32Div = 0x95, oF64Abs = 0x99,
  oF64Neg = 0x9A, oF64Ceil = 0x9B, oF64Floor = 0x9C, oF64Trunc = 0x9D,
  oF64Nearest = 0x9E, oF64Add = 0xA0, oF64Sub = 0xA1, oF64Mul = 0xA2,
  oF64Div = 0xA3, oI32WrapI64 = 0xA7, oI64ExtendI32S = 0xAC,
  oI64ExtendI32U = 0xAD, oF32ConvertI32S = 0xB2, oF32ConvertI64S = 0xB4,
  oF32DemoteF64 = 0xB6, oF64ConvertI32S = 0xB7, oF64ConvertI64S = 0xB9,
  oF64PromoteF32 = 0xBB, oI32ReinterpretF32 = 0xBC,
  oI64ReinterpretF64 = 0xBD, oF32ReinterpretI32 = 0xBE,
  oF64ReinterpretI64 = 0xBF, oI32Extend8S = 0xC0, oI32Extend16S = 0xC1,
};

enum class Cls { kNone, kI32, kI64, kF32, kF64, kV128 };
constexpr uint32_t kClassCount = 6;

Cls ClassOf(TypeName t) {
  switch (t) {
    case hir::INT8_TYPE: case hir::INT16_TYPE: case hir::INT32_TYPE: return Cls::kI32;
    case hir::INT64_TYPE: return Cls::kI64;
    case hir::FLOAT32_TYPE: return Cls::kF32;
    case hir::FLOAT64_TYPE: return Cls::kF64;
    case hir::VEC128_TYPE: return Cls::kV128;
    default: return Cls::kNone;
  }
}
uint8_t WasmType(Cls c) {
  switch (c) {
    case Cls::kI32: return kI32;
    case Cls::kI64: return kI64;
    case Cls::kF32: return kF32;
    case Cls::kF64: return kF64;
    case Cls::kV128: return kV128;
    default: return 0;
  }
}
bool IsInt(TypeName t) { return t <= hir::INT64_TYPE; }
uint32_t Bits(TypeName t) {
  switch (t) {
    case hir::INT8_TYPE: return 8;
    case hir::INT16_TYPE: return 16;
    case hir::INT32_TYPE: return 32;
    case hir::INT64_TYPE: return 64;
    default: return 0;
  }
}

bool IsCallSite(uint32_t op) {
  return op == hir::OPCODE_CALL || op == hir::OPCODE_CALL_TRUE ||
         op == hir::OPCODE_CALL_INDIRECT || op == hir::OPCODE_CALL_INDIRECT_TRUE ||
         op == hir::OPCODE_CALL_EXTERN;
}

constexpr uint32_t kPollBudget = 20000;  // backward branches between polls
// Fixed locals after the context parameter (index 0).
constexpr uint32_t kLocPc = 1, kLocBudget = 2, kLocResume = 3, kLocPending = 4,
                   kLocSp = 5, kLocTmp = 6, kLocTmpB = 7, kLocTmp64 = 8,
                   kLocTmp64B = 9, kLocTmpF64 = 10, kLocTmpV = 11, kFixedLocals = 12;

class Emitter {
 public:
  explicit Emitter(HIRBuilder* builder) : builder_(builder) {}

  bool Compile(std::vector<uint8_t>* out);
  uint32_t reject_opcode() const { return reject_opcode_; }

 private:
  struct Segment {
    Block* block = nullptr;
    Instr* first = nullptr;
    Instr* end = nullptr;  // exclusive
    uint32_t count = 0;
  };

  bool Plan();
  void AllocateTemporaries();
  bool EmitSegment(uint32_t k);
  bool EmitInstr(Instr* instr, uint32_t k, uint32_t source);
  bool Reject(const Instr* instr) {
    reject_opcode_ = instr && instr->opcode ? instr->opcode->num : 0xFFFFu;
    return false;
  }

  // Code helpers.
  void Op(uint8_t o) { code_.u8(o); }
  void I32(int32_t v) { code_.u8(oI32Const); code_.s32(v); }
  void I64(int64_t v) { code_.u8(oI64Const); code_.s64(v); }
  void Get(uint32_t l) { code_.u8(oLocalGet); code_.u32(l); }
  void Set(uint32_t l) { code_.u8(oLocalSet); code_.u32(l); }
  void Tee(uint32_t l) { code_.u8(oLocalTee); code_.u32(l); }
  void Call(Helper h) { code_.u8(oCall); code_.u32(h); }
  void Mem(uint8_t o, uint32_t align, uint32_t offset) {
    code_.u8(o); code_.u32(align); code_.u32(offset);
  }
  void Simd(uint32_t sub) { code_.u8(0xFD); code_.u32(sub); }
  void V128Load(uint32_t offset) { Simd(0x00); code_.u32(0); code_.u32(offset); }
  void V128Store(uint32_t offset) { Simd(0x0B); code_.u32(0); code_.u32(offset); }
  // Stores the value on the stack (class c) at the address below it.
  void StoreClass(Cls c, uint32_t offset) {
    switch (c) {
      case Cls::kI32: Mem(oI32Store, 0, offset); break;
      case Cls::kI64: Mem(oI64Store, 0, offset); break;
      case Cls::kF32: Mem(oF32Store, 0, offset); break;
      case Cls::kF64: Mem(oF64Store, 0, offset); break;
      default: V128Store(offset); break;
    }
  }
  void LoadClass(Cls c, uint32_t offset) {
    switch (c) {
      case Cls::kI32: Mem(oI32Load, 0, offset); break;
      case Cls::kI64: Mem(oI64Load, 0, offset); break;
      case Cls::kF32: Mem(oF32Load, 0, offset); break;
      case Cls::kF64: Mem(oF64Load, 0, offset); break;
      default: V128Load(offset); break;
    }
  }
  bool EmitGeneric(Instr* instr, uint32_t source);
  bool EmitVector(Instr* instr, uint32_t source);
  void Shuffle(const uint8_t lanes[16]) { Simd(0x0D); code_.raw(lanes, 16); }
  void V128Const(const uint8_t bytes[16]) { Simd(0x0C); code_.raw(bytes, 16); }
  void ByteSwap32x4() {
    static const uint8_t kLanes[16] = {3, 2, 1, 0, 7, 6, 5, 4, 11, 10, 9, 8, 15, 14, 13, 12};
    Simd(0x0D); code_.raw(kLanes, 16);  // shuffle(v, v)
  }
  bool EmitNative(Instr* instr, uint32_t k, uint32_t source);
  void If(uint8_t type = kVoid) { code_.u8(oIf); code_.u8(type); ++extra_; }
  void Else() { code_.u8(oElse); }
  void End() { code_.u8(oEnd); --extra_; }
  void BrTo(uint32_t depth) { code_.u8(oBr); code_.u32(depth); }
  uint32_t DepthToLoop(uint32_t k) const { return (n_ - 1 - k) + extra_; }
  uint32_t DepthToSegment(uint32_t k, uint32_t j) const { return (j - k - 1) + extra_; }

  uint32_t LocalOf(const Value* v);
  bool Push(const Value* v);              // value in its wasm class
  bool PushAs(const Value* v, Cls want);  // integer value widened/narrowed
  void PushSigned32(const Value* v);      // i32-class value sign-extended
  void Mask(TypeName t) {
    if (t == hir::INT8_TYPE) { I32(0xFF); Op(oI32And); }
    if (t == hir::INT16_TYPE) { I32(0xFFFF); Op(oI32And); }
  }
  bool SetDest(const Instr* instr) {
    if (!instr->dest) return false;
    Set(LocalOf(instr->dest));
    return true;
  }
  void Jump(uint32_t k, uint32_t j);
  void UnwindCheck(uint32_t k);
  void FaultCheck();
  void ByteSwap(Cls c, TypeName t);

  HIRBuilder* builder_;
  Bytes code_;
  std::vector<Segment> segments_;
  std::unordered_map<const Block*, uint32_t> block_segment_;
  std::unordered_map<const Value*, uint32_t> locals_;
  // Values defined and used only inside one segment share a small pool of
  // wasm locals (see AllocateTemporaries); the rest get their own local.
  std::unordered_map<const Value*, uint32_t> pooled_;
  std::unordered_map<const Instr*, std::pair<uint32_t, uint32_t>> position_;
  std::vector<uint8_t> local_types_;  // index -> wasm type (from kFixedLocals)
  uint32_t real_ = 0, n_ = 0, end_ = 0, poll_ = 0, spill_ = 0, restore_ = 0;
  uint32_t extra_ = 0;
  uint32_t reject_opcode_ = 0;
  uint32_t counter_ = 0, fault_ = 0, return_slot_ = 0, return_valid_ = 0, scratch_ = 0;
  // Executor: intra-function control flow drops a pending expected-return
  // token (DiscardPendingGuestReturnMetadata).
  void DiscardReturnToken() { I32(int32_t(return_valid_)); I32(0); Mem(oI32Store8, 0, 0); }
};

uint32_t Emitter::LocalOf(const Value* v) {
  auto pooled = pooled_.find(v);
  if (pooled != pooled_.end()) return pooled->second;
  auto it = locals_.find(v);
  if (it != locals_.end()) return it->second;
  const uint32_t index = kFixedLocals + uint32_t(local_types_.size());
  local_types_.push_back(WasmType(ClassOf(v->type)));
  locals_.emplace(v, index);
  return index;
}

bool Emitter::Push(const Value* v) {
  if (!v) return false;
  const Cls c = ClassOf(v->type);
  if (c == Cls::kNone) return false;
  if (v->IsConstant()) {
    switch (v->type) {
      case hir::INT8_TYPE: I32(int32_t(uint32_t(v->constant.u8))); break;
      case hir::INT16_TYPE: I32(int32_t(uint32_t(v->constant.u16))); break;
      case hir::INT32_TYPE: I32(int32_t(v->constant.u32)); break;
      case hir::INT64_TYPE: I64(int64_t(v->constant.u64)); break;
      case hir::FLOAT32_TYPE: code_.u8(oF32Const); code_.raw(&v->constant.f32, 4); break;
      case hir::FLOAT64_TYPE: code_.u8(oF64Const); code_.raw(&v->constant.f64, 8); break;
      case hir::VEC128_TYPE: Simd(0x0C); code_.raw(&v->constant.v128, 16); break;
      default: return false;
    }
    return true;
  }
  Get(LocalOf(v));
  return true;
}

// Integer value as an unsigned i32 or i64 (zero-extended / wrapped), the way
// the executor's GetUnsigned + SetUnsigned move values between widths.
bool Emitter::PushAs(const Value* v, Cls want) {
  if (!Push(v)) return false;
  const Cls have = ClassOf(v->type);
  if (have == want) return true;
  if (have == Cls::kI32 && want == Cls::kI64) { Op(oI64ExtendI32U); return true; }
  if (have == Cls::kI64 && want == Cls::kI32) { Op(oI32WrapI64); return true; }
  return false;
}

void Emitter::PushSigned32(const Value* v) {
  Push(v);
  if (v->type == hir::INT8_TYPE) Op(oI32Extend8S);
  if (v->type == hir::INT16_TYPE) Op(oI32Extend16S);
}

void Emitter::Jump(uint32_t k, uint32_t j) {
  if (j > k) {
    BrTo(DepthToSegment(k, j));
    return;
  }
  // Backward: through the dispatcher, polling every kPollBudget times.
  Get(kLocBudget); I32(1); Op(oI32Sub); Tee(kLocBudget);
  If();
  I32(int32_t(j)); Set(kLocPc);
  Else();
  I32(int32_t(kPollBudget)); Set(kLocBudget);
  I32(int32_t(j)); Set(kLocPending);
  I32(int32_t(poll_)); Set(kLocPc);
  End();
  BrTo(DepthToLoop(k));
}

// After a helper that may unwind: save locals and leave (SPILL segment).
void Emitter::UnwindCheck(uint32_t k) {
  Call(kHState); I32(1); Op(oI32Eq);
  If();
  I32(int32_t(k)); Set(kLocResume);
  I32(int32_t(spill_)); Set(kLocPc);
  BrTo(DepthToLoop(k));
  End();
}

void Emitter::FaultCheck() {
  I32(int32_t(fault_)); Mem(oI32Load, 2, 0);
  If();
  I32(int32_t(kJitStatusFailed)); Op(oReturn);
  End();
}

// Byte swap of the value on the stack (class c, integer type t for ints).
void Emitter::ByteSwap(Cls c, TypeName t) {
  if (c == Cls::kF32) Op(oI32ReinterpretF32);
  if (c == Cls::kF64) Op(oI64ReinterpretF64);
  if (c == Cls::kI32 || c == Cls::kF32) {
    const uint32_t bits = c == Cls::kF32 ? 32 : Bits(t);
    if (bits == 8) {
      // no-op
    } else if (bits == 16) {
      Tee(kLocTmp); I32(8); Op(oI32Shl); I32(0xFF00); Op(oI32And);
      Get(kLocTmp); I32(8); Op(oI32ShrU); I32(0xFF); Op(oI32And);
      Op(oI32Or);
    } else {
      Tee(kLocTmp); I32(int32_t(0xFF00FF00u)); Op(oI32And); I32(8); Op(oI32Rotl);
      Get(kLocTmp); I32(0x00FF00FF); Op(oI32And); I32(8); Op(oI32Rotr);
      Op(oI32Or);
    }
  } else {
    // 64-bit: swap each half, then exchange halves.
    Set(kLocTmp64);
    for (int half = 0; half < 2; ++half) {
      Get(kLocTmp64);
      if (half == 0) { I64(32); Op(oI64ShrU); }
      Op(oI32WrapI64);
      Tee(kLocTmp); I32(int32_t(0xFF00FF00u)); Op(oI32And); I32(8); Op(oI32Rotl);
      Get(kLocTmp); I32(0x00FF00FF); Op(oI32And); I32(8); Op(oI32Rotr);
      Op(oI32Or);
      Op(oI64ExtendI32U);
      if (half == 1) { I64(32); Op(oI64Shl); Op(oI64Or); }
    }
  }
  if (c == Cls::kF32) Op(oF32ReinterpretI32);
  if (c == Cls::kF64) Op(oF64ReinterpretI64);
}

bool Emitter::Plan() {
  for (Block* block = builder_->first_block(); block; block = block->next) {
    block_segment_[block] = uint32_t(segments_.size());
    Segment current;
    current.block = block;
    current.first = block->instr_head;
    for (Instr* instr = block->instr_head; instr; instr = instr->next) {
      if (!instr->opcode) return Reject(instr);
      if (IsCallSite(instr->opcode->num) && instr != current.first) {
        current.end = instr;
        segments_.push_back(current);
        current = Segment();
        current.block = block;
        current.first = instr;
      }
      ++current.count;
    }
    current.end = nullptr;
    segments_.push_back(current);
  }
  uint32_t position = 0;
  for (uint32_t k = 0; k < segments_.size(); ++k) {
    for (Instr* i = segments_[k].first; i && i != segments_[k].end; i = i->next) {
      position_[i] = {k, position++};
    }
  }
  real_ = uint32_t(segments_.size());
  end_ = real_;
  poll_ = real_ + 1;
  spill_ = real_ + 2;
  restore_ = real_ + 3;
  n_ = real_ + 4;
  return real_ > 0;
}

// Linear scan per segment: a value whose definition and every use lie in one
// segment (uses after the definition) takes a pooled local from the first
// instruction that defines it to its last use. Wasm engines build SSA over all
// locals at every merge of the dispatcher; one local per HIR value made that
// quadratic in large functions.
void Emitter::AllocateTemporaries() {
  using namespace xe::cpu::hir;
  std::vector<uint32_t> pool_free[kClassCount];
  std::vector<uint32_t> pool_all[kClassCount];
  auto class_index = [](Cls c) { return uint32_t(c); };
  for (uint32_t k = 0; k < real_; ++k) {
    for (uint32_t c = 0; c < kClassCount; ++c) pool_free[c] = pool_all[c];
    std::unordered_map<const Value*, uint32_t> last_use;
    for (Instr* i = segments_[k].first; i && i != segments_[k].end; i = i->next) {
      Value* d = i->dest;
      if (!d || d->def != i || d->IsConstant() || ClassOf(d->type) == Cls::kNone) continue;
      const uint32_t def_pos = position_[i].second;
      uint32_t last = def_pos;
      bool local = true;
      for (auto* use = d->use_head; use && local; use = use->next) {
        auto it = position_.find(use->instr);
        if (it == position_.end() || it->second.first != k || it->second.second <= def_pos) {
          local = false;
        } else if (it->second.second > last) {
          last = it->second.second;
        }
      }
      if (local) last_use[d] = last;
    }
    for (Instr* i = segments_[k].first; i && i != segments_[k].end; i = i->next) {
      const uint32_t pos = position_[i].second;
      const auto sig = i->opcode ? i->opcode->signature : 0;
      const Value* operands[3] = {
          GET_OPCODE_SIG_TYPE_SRC1(sig) == OPCODE_SIG_TYPE_V ? i->src1.value : nullptr,
          GET_OPCODE_SIG_TYPE_SRC2(sig) == OPCODE_SIG_TYPE_V ? i->src2.value : nullptr,
          GET_OPCODE_SIG_TYPE_SRC3(sig) == OPCODE_SIG_TYPE_V ? i->src3.value : nullptr};
      for (int n = 0; n < 3; ++n) {
        const Value* v = operands[n];
        if (!v) continue;
        bool repeated = false;
        for (int m = 0; m < n; ++m) repeated |= operands[m] == v;
        auto lu = last_use.find(v);
        auto pl = pooled_.find(v);
        if (repeated || lu == last_use.end() || pl == pooled_.end() || lu->second != pos) continue;
        pool_free[class_index(ClassOf(v->type))].push_back(pl->second);
      }
      Value* d = i->dest;
      auto lu = d ? last_use.find(d) : last_use.end();
      if (lu == last_use.end() || pooled_.count(d)) continue;
      const uint32_t c = class_index(ClassOf(d->type));
      uint32_t index;
      if (!pool_free[c].empty()) {
        index = pool_free[c].back();
        pool_free[c].pop_back();
      } else {
        index = kFixedLocals + uint32_t(local_types_.size());
        local_types_.push_back(WasmType(ClassOf(d->type)));
        pool_all[c].push_back(index);
      }
      pooled_[d] = index;
      if (lu->second == pos) pool_free[c].push_back(index);  // never read
    }
  }
}

bool IsControlFlow(uint32_t op) {
  using namespace xe::cpu::hir;
  switch (op) {
    case OPCODE_BRANCH: case OPCODE_BRANCH_TRUE: case OPCODE_BRANCH_FALSE:
    case OPCODE_CALL: case OPCODE_CALL_TRUE: case OPCODE_CALL_INDIRECT:
    case OPCODE_CALL_INDIRECT_TRUE: case OPCODE_CALL_EXTERN: case OPCODE_RETURN:
    case OPCODE_RETURN_TRUE: case OPCODE_SET_RETURN_ADDRESS: case OPCODE_SOURCE_OFFSET:
      return true;
    default:
      return false;
  }
}

// Native wasm SIMD lowering of the hot VMX HIR, matching the executor's
// vector semantics (hir_vector_semantics.h and the VMX overlay). vec128_t
// lanes map 1:1 onto wasm lanes (both little-endian element order).
bool Emitter::EmitVector(Instr* instr, uint32_t source) {
  using namespace xe::cpu::hir;
  const uint32_t op = instr->opcode->num;
  Value* d = instr->dest;
  Value* a = instr->src1.value;
  Value* b = instr->src2.value;
  Value* c3 = instr->src3.value;
  auto is_vec = [](const Value* v) { return v && v->type == VEC128_TYPE; };
  switch (op) {
    case OPCODE_BYTE_SWAP:
      if (!is_vec(d) || !is_vec(a)) return Reject(instr);
      Push(a); Push(a); ByteSwap32x4();
      return SetDest(instr);
    case OPCODE_LOAD: case OPCODE_LOAD_OFFSET: {
      if (!is_vec(d) || (instr->flags & ~LOAD_STORE_BYTE_SWAP)) return Reject(instr);
      if (!PushAs(a, Cls::kI32)) return Reject(instr);
      if (op == OPCODE_LOAD_OFFSET) { if (!PushAs(b, Cls::kI32)) return Reject(instr); Op(oI32Add); }
      I32(int32_t(source));
      Call(kHLd128);
      FaultCheck();
      I32(int32_t(scratch_)); V128Load(48);
      if (instr->flags & LOAD_STORE_BYTE_SWAP) { Set(kLocTmpV); Get(kLocTmpV); Get(kLocTmpV); ByteSwap32x4(); }
      return SetDest(instr);
    }
    case OPCODE_STORE: case OPCODE_STORE_OFFSET: {
      Value* value = op == OPCODE_STORE ? b : c3;
      if (!is_vec(value) || (instr->flags & ~LOAD_STORE_BYTE_SWAP)) return Reject(instr);
      I32(int32_t(scratch_));
      Push(value);
      if (instr->flags & LOAD_STORE_BYTE_SWAP) { Push(value); ByteSwap32x4(); }
      V128Store(48);
      if (!PushAs(a, Cls::kI32)) return Reject(instr);
      if (op == OPCODE_STORE_OFFSET) { if (!PushAs(b, Cls::kI32)) return Reject(instr); Op(oI32Add); }
      I32(int32_t(source));
      Call(kHSt128);
      FaultCheck();
      return true;
    }
    case OPCODE_PERMUTE: {
      if (a && a->type == INT32_TYPE && a->IsConstant() && is_vec(b) && is_vec(c3) && is_vec(d)) {
        // PERMUTE_I32 with a constant control: a word shuffle of b || c3.
        uint8_t lanes[16];
        for (int k = 0; k < 4; ++k) {
          const uint32_t sel = (a->constant.u32 >> (8 * k)) & 7;
          for (int byte = 0; byte < 4; ++byte) {
            lanes[k * 4 + byte] = uint8_t(((sel & 4) ? 16 : 0) + (sel & 3) * 4 + byte);
          }
        }
        Push(b); Push(c3); Shuffle(lanes);
        return SetDest(instr);
      }
      // vperm bytes: index (control & 0x1F) ^ 3 into a || b.
      if (instr->flags != INT8_TYPE || !is_vec(a) || !is_vec(b) || !is_vec(c3) || !is_vec(d)) {
        return Reject(instr);
      }
      Push(a); I32(0x1F); Simd(0x0F); Simd(0x4E);   // & 0x1F
      I32(0x03); Simd(0x0F); Simd(0x51);             // ^ 3
      Set(kLocTmpV);                                 // index
      Push(b); Get(kLocTmpV); Simd(0x0E);            // swizzle(a_src, idx)
      Push(c3); Get(kLocTmpV); I32(16); Simd(0x0F); Simd(0x71); Simd(0x0E);  // swizzle(b_src, idx - 16)
      Simd(0x50);                                    // or
      return SetDest(instr);
    }
    case OPCODE_LOAD_VECTOR_SHL: case OPCODE_LOAD_VECTOR_SHR: {
      if (!is_vec(d) || !a || !IsInt(a->type)) return Reject(instr);
      uint8_t lanes[16];
      for (int k = 0; k < 16; ++k) lanes[k] = uint8_t(k ^ 3);
      V128Const(lanes);
      if (op == OPCODE_LOAD_VECTOR_SHL) {
        PushAs(a, Cls::kI32); I32(0xF); Op(oI32And);
      } else {
        I32(16); PushAs(a, Cls::kI32); I32(0xF); Op(oI32And); Op(oI32Sub);
      }
      Simd(0x0F);   // i8x16.splat
      Simd(0x6E);   // i8x16.add
      return SetDest(instr);
    }
    case OPCODE_VECTOR_ADD: case OPCODE_VECTOR_SUB: {
      if (!is_vec(d) || !is_vec(a) || !is_vec(b)) return Reject(instr);
      const auto part = TypeName(instr->flags & 0xFF);
      const uint32_t arith = instr->flags >> 8;
      const bool sat = arith & ARITHMETIC_SATURATE, uns = arith & ARITHMETIC_UNSIGNED;
      const bool sub = op == OPCODE_VECTOR_SUB;
      uint32_t simd = 0;
      switch (part) {
        case INT8_TYPE: simd = !sat ? (sub ? 0x71 : 0x6E) : uns ? (sub ? 0x73 : 0x70) : (sub ? 0x72 : 0x6F); break;
        case INT16_TYPE: simd = !sat ? (sub ? 0x91 : 0x8E) : uns ? (sub ? 0x93 : 0x90) : (sub ? 0x92 : 0x8F); break;
        case INT32_TYPE:
          if (sat) {
            // No i32x4 saturating add in wasm: r = a +/- b, then replace
            // overflowed lanes. Signed: overflow mask from the sign bits,
            // saturate toward a's sign. Unsigned: compare with a / b.
            Push(a); Push(b); Simd(sub ? 0xB1 : 0xAE); Set(kLocTmpV);
            if (uns) {
              if (!sub) {  // r | (r < a)
                Get(kLocTmpV); Get(kLocTmpV); Push(a); Simd(0x3A); Simd(0x50);
              } else {     // r & ~(a < b)
                Get(kLocTmpV); Push(a); Push(b); Simd(0x3A); Simd(0x4F);
              }
              return SetDest(instr);
            }
            // sat = (a >> 31) ^ 0x7FFFFFFF; ovf = add: (a^r)&(b^r), sub: (a^b)&(a^r)
            Push(a); I32(31); Simd(0xAC); I32(0x7FFFFFFF); Simd(0x11); Simd(0x51);  // sat
            Get(kLocTmpV);                                                           // r
            if (!sub) {
              Push(a); Get(kLocTmpV); Simd(0x51); Push(b); Get(kLocTmpV); Simd(0x51); Simd(0x4E);
            } else {
              Push(a); Push(b); Simd(0x51); Push(a); Get(kLocTmpV); Simd(0x51); Simd(0x4E);
            }
            I32(31); Simd(0xAC);                                                     // mask
            Simd(0x52);                                                              // bitselect
            return SetDest(instr);
          }
          simd = sub ? 0xB1 : 0xAE;
          break;
        case FLOAT32_TYPE: simd = sub ? 0xE5 : 0xE4; break;
        default: return Reject(instr);
      }
      Push(a); Push(b); Simd(simd);
      return SetDest(instr);
    }
    case OPCODE_AND: case OPCODE_OR: case OPCODE_XOR: case OPCODE_AND_NOT:
      if (!is_vec(d) || !is_vec(a) || !is_vec(b)) return Reject(instr);
      Push(a); Push(b);
      Simd(op == OPCODE_AND ? 0x4E : op == OPCODE_OR ? 0x50 : op == OPCODE_XOR ? 0x51 : 0x4F);
      return SetDest(instr);
    case OPCODE_NOT:
      if (!is_vec(d) || !is_vec(a)) return Reject(instr);
      Push(a); Simd(0x4D);
      return SetDest(instr);
    case OPCODE_SELECT:
      // (src1 & src3) | (~src1 & src2)
      if (!is_vec(d) || !is_vec(a) || !is_vec(b) || !is_vec(c3)) return Reject(instr);
      Push(c3); Push(b); Push(a); Simd(0x52);
      return SetDest(instr);
    case OPCODE_SPLAT:
      if (!is_vec(d) || !a) return Reject(instr);
      Push(a);
      switch (a->type) {
        case INT8_TYPE: Simd(0x0F); break;
        case INT16_TYPE: Simd(0x10); break;
        case INT32_TYPE: Simd(0x11); break;
        case FLOAT32_TYPE: Simd(0x13); break;
        default: return Reject(instr);
      }
      return SetDest(instr);
    case OPCODE_EXTRACT: {
      if (is_vec(a) && d && b && !b->IsConstant() && IsInt(b->type) &&
          (d->type == INT8_TYPE || d->type == INT16_TYPE)) {
        // Dynamic index: gather the element into lane 0 with a swizzle.
        Push(a);
        if (d->type == INT8_TYPE) {
          PushAs(b, Cls::kI32); I32(3); Op(oI32Xor); I32(0xF); Op(oI32And);
          Simd(0x0F); Simd(0x0E);                       // swizzle(v, splat(idx))
          Simd(0x16); code_.u8(0);
        } else {
          uint8_t pair[16];
          for (int k = 0; k < 16; ++k) pair[k] = uint8_t(k & 1);
          PushAs(b, Cls::kI32); I32(1); Op(oI32Xor); I32(7); Op(oI32And); I32(1); Op(oI32Shl);
          Simd(0x0F); V128Const(pair); Simd(0x6E);       // splat(2*lane) + {0,1,...}
          Simd(0x0E);
          Simd(0x19); code_.u8(0);
        }
        return SetDest(instr);
      }
      if (!is_vec(a) || !d || !b || !b->IsConstant()) return Reject(instr);
      const uint32_t index = b->constant.u8;
      Push(a);
      switch (d->type) {
        case INT8_TYPE: Simd(0x16); code_.u8(uint8_t((index ^ 3) & 0xF)); break;
        case INT16_TYPE: Simd(0x19); code_.u8(uint8_t((index ^ 1) & 7)); break;
        case INT32_TYPE: Simd(0x1B); code_.u8(uint8_t(index & 3)); break;
        case FLOAT32_TYPE: Simd(0x1F); code_.u8(uint8_t(index & 3)); break;
        default: return Reject(instr);
      }
      return SetDest(instr);
    }
    case OPCODE_SWIZZLE: {
      if (!is_vec(d) || !is_vec(a) || (instr->flags != INT32_TYPE && instr->flags != FLOAT32_TYPE)) {
        return Reject(instr);
      }
      const uint32_t imm = uint32_t(instr->src2.offset) & 0xFF;
      uint8_t lanes[16];
      for (int i = 0; i < 4; ++i) {
        const uint32_t from = (imm >> (2 * i)) & 3;
        for (int byte = 0; byte < 4; ++byte) lanes[i * 4 + byte] = uint8_t(from * 4 + byte);
      }
      Push(a); Push(a); Shuffle(lanes);
      return SetDest(instr);
    }
    case OPCODE_VECTOR_SHL: case OPCODE_VECTOR_SHR: case OPCODE_VECTOR_SHA: {
      // Per-lane shift counts: lane by lane for 32-bit parts.
      if (!is_vec(d) || !is_vec(a) || !is_vec(b) || TypeName(instr->flags & 0xFF) != INT32_TYPE) {
        return Reject(instr);
      }
      const uint8_t shift = op == OPCODE_VECTOR_SHL ? oI32Shl : op == OPCODE_VECTOR_SHR ? oI32ShrU : oI32ShrS;
      Push(a);
      for (uint8_t lane = 0; lane < 4; ++lane) {
        Set(kLocTmpV);
        Get(kLocTmpV);
        Get(kLocTmpV); Simd(0x1B); code_.u8(lane);
        Push(b); Simd(0x1B); code_.u8(lane);
        I32(31); Op(oI32And);
        Op(shift);
        Simd(0x1C); code_.u8(lane);
      }
      return SetDest(instr);
    }
    case OPCODE_VECTOR_MAX: case OPCODE_VECTOR_MIN: {
      if (!is_vec(d) || !is_vec(a) || !is_vec(b)) return Reject(instr);
      const auto part = TypeName(instr->flags >> 8);
      const bool uns = instr->flags & ARITHMETIC_UNSIGNED, mx = op == OPCODE_VECTOR_MAX;
      uint32_t simd = 0;
      switch (part) {
        case INT8_TYPE: simd = mx ? (uns ? 0x79 : 0x78) : (uns ? 0x77 : 0x76); break;
        case INT16_TYPE: simd = mx ? (uns ? 0x99 : 0x98) : (uns ? 0x97 : 0x96); break;
        case INT32_TYPE: simd = mx ? (uns ? 0xB9 : 0xB8) : (uns ? 0xB7 : 0xB6); break;
        default: return Reject(instr);
      }
      Push(a); Push(b); Simd(simd);
      return SetDest(instr);
    }
    case OPCODE_VECTOR_AVERAGE: {
      // (a + b + 1) >> 1 per lane = (a >> 1) + (b >> 1) + ((a | b) & 1).
      if (!is_vec(d) || !is_vec(a) || !is_vec(b) || TypeName(instr->flags & 0xFF) != INT32_TYPE) {
        return Reject(instr);
      }
      const bool uns = (instr->flags >> 8) & ARITHMETIC_UNSIGNED;
      const uint32_t shr = uns ? 0xAD : 0xAC;
      Push(a); I32(1); Simd(shr);
      Push(b); I32(1); Simd(shr);
      Simd(0xAE);
      Push(a); Push(b); Simd(0x50); I32(1); Simd(0x11); Simd(0x4E);
      Simd(0xAE);
      return SetDest(instr);
    }
    case OPCODE_DID_SATURATE:
      // x64: "TODO: implement saturation check" -> always 0 (executor too).
      if (!d || !IsInt(d->type)) return Reject(instr);
      if (ClassOf(d->type) == Cls::kI64) I64(0); else I32(0);
      return SetDest(instr);
    default:
      return Reject(instr);
  }
}

// One instruction through the executor's own dispatch (r360_jit_h_exec).
bool Emitter::EmitGeneric(Instr* instr, uint32_t source) {
  using namespace xe::cpu::hir;
  const auto& sig = instr->opcode->signature;
  const Value* operands[3] = {
      GET_OPCODE_SIG_TYPE_SRC1(sig) == OPCODE_SIG_TYPE_V ? instr->src1.value : nullptr,
      GET_OPCODE_SIG_TYPE_SRC2(sig) == OPCODE_SIG_TYPE_V ? instr->src2.value : nullptr,
      GET_OPCODE_SIG_TYPE_SRC3(sig) == OPCODE_SIG_TYPE_V ? instr->src3.value : nullptr};
  for (int n = 0; n < 3; ++n) {
    const Value* v = operands[n];
    if (!v || v->IsConstant()) continue;
    const Cls c = ClassOf(v->type);
    if (c == Cls::kNone) return Reject(instr);
    I32(int32_t(scratch_));
    Push(v);
    StoreClass(c, uint32_t(16 * n));
  }
  if (instr->dest && ClassOf(instr->dest->type) == Cls::kNone) return Reject(instr);
  I32(int32_t(reinterpret_cast<uintptr_t>(instr)));
  I32(int32_t(source));
  Call(kHExec);
  Op(oI32Eqz);
  If(); I32(int32_t(kJitStatusFailed)); Op(oReturn); End();
  if (instr->dest) {
    I32(int32_t(scratch_));
    LoadClass(ClassOf(instr->dest->type), 48);
    Set(LocalOf(instr->dest));
  }
  return true;
}

bool Emitter::EmitInstr(Instr* instr, uint32_t k, uint32_t source) {
  const size_t mark = code_.b.size();
  const uint32_t extra = extra_;
  if (EmitNative(instr, k, source)) return true;
  if (reject_opcode_ == 0xFD || IsControlFlow(instr->opcode->num)) return false;
  code_.b.resize(mark);
  extra_ = extra;
  reject_opcode_ = 0;
  return EmitGeneric(instr, source);
}

bool Emitter::EmitNative(Instr* instr, uint32_t k, uint32_t source) {
  using namespace xe::cpu::hir;
  const uint32_t op = instr->opcode->num;
  Value* d = instr->dest;
  Value* a = instr->src1.value;
  Value* b = instr->src2.value;
  Value* c3 = instr->src3.value;
  auto any_vec = [&]() {
    const auto& sig = instr->opcode->signature;
    auto is_vec = [](const Value* v) { return v && v->type == VEC128_TYPE; };
    if (d && d->type == VEC128_TYPE) return true;
    if (GET_OPCODE_SIG_TYPE_SRC1(sig) == OPCODE_SIG_TYPE_V && is_vec(a)) return true;
    if (GET_OPCODE_SIG_TYPE_SRC2(sig) == OPCODE_SIG_TYPE_V && is_vec(b)) return true;
    if (GET_OPCODE_SIG_TYPE_SRC3(sig) == OPCODE_SIG_TYPE_V && is_vec(c3)) return true;
    return false;
  };
  const bool vector_copy = op == OPCODE_ASSIGN || op == OPCODE_LOAD_LOCAL ||
                           op == OPCODE_STORE_LOCAL || op == OPCODE_LOAD_CONTEXT ||
                           op == OPCODE_STORE_CONTEXT;
  // An operand with no defining instruction (other than an HIR local slot)
  // would read as undefined; the executor fails or recovers it from context
  // (fragment provenance recovery). Leave such functions on the executor.
  {
    const auto& sig = instr->opcode->signature;
    const Value* srcs[3] = {
        GET_OPCODE_SIG_TYPE_SRC1(sig) == OPCODE_SIG_TYPE_V ? a : nullptr,
        GET_OPCODE_SIG_TYPE_SRC2(sig) == OPCODE_SIG_TYPE_V ? b : nullptr,
        GET_OPCODE_SIG_TYPE_SRC3(sig) == OPCODE_SIG_TYPE_V ? c3 : nullptr};
    const bool slot_op = op == OPCODE_LOAD_LOCAL || op == OPCODE_STORE_LOCAL;
    for (int n = 0; n < 3; ++n) {
      const Value* v = srcs[n];
      if (!v || v->IsConstant() || (slot_op && n == 0)) continue;
      if (!v->def || !position_.count(v->def)) {
        reject_opcode_ = 0xFD;
        return false;
      }
    }
  }
  if (any_vec() && !vector_copy) return EmitVector(instr, source);  // else generic

  switch (op) {
    case OPCODE_SOURCE_OFFSET: case OPCODE_CONTEXT_BARRIER:
    case OPCODE_MEMORY_BARRIER: case OPCODE_COMMENT: case OPCODE_NOP:
    case OPCODE_DEBUG_BREAK:
      return true;
    case OPCODE_DEBUG_BREAK_TRUE: case OPCODE_TRAP: case OPCODE_TRAP_TRUE:
      return true;  // Xenia logs/ignores these (executor prints the trap).
    case OPCODE_CACHE_CONTROL:
      switch (static_cast<CacheControlType>(instr->flags)) {
        case CACHE_CONTROL_TYPE_DATA_TOUCH:
        case CACHE_CONTROL_TYPE_DATA_TOUCH_FOR_STORE:
        case CACHE_CONTROL_TYPE_DATA_STORE:
        case CACHE_CONTROL_TYPE_DATA_STORE_AND_FLUSH:
          return true;
        default:
          return Reject(instr);
      }

    case OPCODE_LOAD_CONTEXT: {
      if (!d) return Reject(instr);
      const uint32_t offset = uint32_t(instr->src1.offset);
      Get(0);
      switch (d->type) {
        case INT8_TYPE: Mem(oI32Load8U, 0, offset); break;
        case INT16_TYPE: Mem(oI32Load16U, 0, offset); break;
        case INT32_TYPE: Mem(oI32Load, 0, offset); break;
        case INT64_TYPE: Mem(oI64Load, 0, offset); break;
        case FLOAT32_TYPE: Mem(oF32Load, 0, offset); break;
        case FLOAT64_TYPE: Mem(oF64Load, 0, offset); break;
        case VEC128_TYPE: V128Load(offset); break;
        default: return Reject(instr);
      }
      return SetDest(instr);
    }
    case OPCODE_STORE_CONTEXT: {
      if (!b) return Reject(instr);
      const uint32_t offset = uint32_t(instr->src1.offset);
      Get(0);
      if (!Push(b)) return Reject(instr);
      switch (b->type) {
        case INT8_TYPE: Mem(oI32Store8, 0, offset); break;
        case INT16_TYPE: Mem(oI32Store16, 0, offset); break;
        case INT32_TYPE: Mem(oI32Store, 0, offset); break;
        case INT64_TYPE: Mem(oI64Store, 0, offset); break;
        case FLOAT32_TYPE: Mem(oF32Store, 0, offset); break;
        case FLOAT64_TYPE: Mem(oF64Store, 0, offset); break;
        case VEC128_TYPE: V128Store(offset); break;
        default: return Reject(instr);
      }
      return true;
    }
    case OPCODE_LOAD_LOCAL: case OPCODE_STORE_LOCAL: {
      Value* slot = a;
      const Value* src = op == OPCODE_LOAD_LOCAL ? slot : b;
      Value* target = op == OPCODE_LOAD_LOCAL ? d : slot;
      if (!slot || !src || !target || ClassOf(src->type) != ClassOf(target->type) ||
          ClassOf(src->type) == Cls::kNone) {
        return Reject(instr);
      }
      Push(src);
      Set(LocalOf(target));
      return true;
    }

    case OPCODE_LOAD: case OPCODE_LOAD_OFFSET: {
      if (!d || (instr->flags & ~LOAD_STORE_BYTE_SWAP)) return Reject(instr);
      const Cls c = ClassOf(d->type);
      if (c == Cls::kNone || !PushAs(a, Cls::kI32)) return Reject(instr);
      if (op == OPCODE_LOAD_OFFSET) {
        if (!PushAs(b, Cls::kI32)) return Reject(instr);
        Op(oI32Add);
      }
      I32(int32_t(source));
      switch (d->type) {
        case INT8_TYPE: Call(kHLd8); break;
        case INT16_TYPE: Call(kHLd16); break;
        case INT32_TYPE: I32(1); Call(kHLd32); break;
        case FLOAT32_TYPE: I32(0); Call(kHLd32); Op(oF32ReinterpretI32); break;
        case INT64_TYPE: Call(kHLd64); break;
        case FLOAT64_TYPE: Call(kHLd64); Op(oF64ReinterpretI64); break;
        default: return Reject(instr);
      }
      if (instr->flags & LOAD_STORE_BYTE_SWAP) ByteSwap(c, d->type);
      SetDest(instr);
      FaultCheck();
      return true;
    }
    case OPCODE_STORE: case OPCODE_STORE_OFFSET: {
      Value* value = op == OPCODE_STORE ? b : c3;
      if (!value || (instr->flags & ~LOAD_STORE_BYTE_SWAP)) return Reject(instr);
      const Cls c = ClassOf(value->type);
      if (c == Cls::kNone || !PushAs(a, Cls::kI32)) return Reject(instr);
      if (op == OPCODE_STORE_OFFSET) {
        if (!PushAs(b, Cls::kI32)) return Reject(instr);
        Op(oI32Add);
      }
      Push(value);
      if (instr->flags & LOAD_STORE_BYTE_SWAP) ByteSwap(c, value->type);
      if (c == Cls::kF32) Op(oI32ReinterpretF32);
      if (c == Cls::kF64) Op(oI64ReinterpretF64);
      I32(int32_t(source));
      switch (value->type) {
        case INT8_TYPE: Call(kHSt8); break;
        case INT16_TYPE: Call(kHSt16); break;
        case INT32_TYPE: I32(1); Call(kHSt32); break;
        case FLOAT32_TYPE: I32(0); Call(kHSt32); break;
        case INT64_TYPE: case FLOAT64_TYPE: Call(kHSt64); break;
        default: return Reject(instr);
      }
      FaultCheck();
      return true;
    }
    case OPCODE_MEMSET:
      if (!PushAs(a, Cls::kI32) || !PushAs(b, Cls::kI32) || !PushAs(c3, Cls::kI32)) {
        return Reject(instr);
      }
      I32(int32_t(source));
      Call(kHMemset);
      FaultCheck();
      return true;
    case OPCODE_ATOMIC_EXCHANGE: case OPCODE_ATOMIC_COMPARE_EXCHANGE: {
      const bool cas = op == OPCODE_ATOMIC_COMPARE_EXCHANGE;
      Value* store = cas ? c3 : b;
      if (!store || !IsInt(store->type) || (cas && (!b || !IsInt(b->type)))) {
        return Reject(instr);
      }
      if (!PushAs(a, Cls::kI32)) return Reject(instr);
      I32(int32_t(Bits(store->type) / 8));
      PushAs(store, Cls::kI64);
      if (cas) PushAs(b, Cls::kI64); else I64(0);
      I32(cas ? 1 : 0);
      I32(int32_t(source));
      Call(kHAtomic);
      if (d) {
        if (ClassOf(d->type) == Cls::kI32) Op(oI32WrapI64);
        else if (ClassOf(d->type) != Cls::kI64) return Reject(instr);
        SetDest(instr);
      } else {
        Op(oDrop);
      }
      FaultCheck();
      return true;
    }
    case OPCODE_LOAD_CLOCK:
      if (!d || d->type != INT64_TYPE) return Reject(instr);
      Call(kHClock);
      return SetDest(instr);
    case OPCODE_SET_ROUNDING_MODE:
      if (!PushAs(a, Cls::kI32)) return Reject(instr);
      Call(kHSetRounding);
      return true;
    case OPCODE_SET_RETURN_ADDRESS:
      I32(int32_t(return_slot_));
      if (!PushAs(a, Cls::kI64)) return Reject(instr);
      Mem(oI64Store, 3, 0);
      I32(int32_t(return_valid_)); I32(1); Mem(oI32Store8, 0, 0);
      return true;

    case OPCODE_ASSIGN: case OPCODE_ZERO_EXTEND: case OPCODE_TRUNCATE: {
      if (!d || !a) return Reject(instr);
      const Cls dc = ClassOf(d->type), sc = ClassOf(a->type);
      if (dc == Cls::kNone || sc == Cls::kNone) return Reject(instr);
      if (!IsInt(d->type) || !IsInt(a->type)) {
        if (op != OPCODE_ASSIGN || d->type != a->type) return Reject(instr);
        Push(a);
        return SetDest(instr);
      }
      PushAs(a, dc);
      if (dc == Cls::kI32) Mask(d->type);
      return SetDest(instr);
    }
    case OPCODE_SIGN_EXTEND: {
      if (!d || !a || !IsInt(d->type) || !IsInt(a->type)) return Reject(instr);
      const Cls dc = ClassOf(d->type);
      if (a->type == INT64_TYPE) {
        Push(a);
        if (dc == Cls::kI32) Op(oI32WrapI64);
      } else {
        PushSigned32(a);
        if (dc == Cls::kI64) Op(oI64ExtendI32S);
      }
      if (dc == Cls::kI32) Mask(d->type);
      return SetDest(instr);
    }
    case OPCODE_CAST: {
      if (!d || !a) return Reject(instr);
      const Cls dc = ClassOf(d->type), sc = ClassOf(a->type);
      if (Bits(d->type) && Bits(a->type) && Bits(d->type) != Bits(a->type)) return Reject(instr);
      Push(a);
      if (dc == sc) {
      } else if (sc == Cls::kF32 && d->type == INT32_TYPE) Op(oI32ReinterpretF32);
      else if (sc == Cls::kF64 && d->type == INT64_TYPE) Op(oI64ReinterpretF64);
      else if (a->type == INT32_TYPE && dc == Cls::kF32) Op(oF32ReinterpretI32);
      else if (a->type == INT64_TYPE && dc == Cls::kF64) Op(oF64ReinterpretI64);
      else return Reject(instr);
      return SetDest(instr);
    }
    case OPCODE_CONVERT: {
      if (!d || !a) return Reject(instr);
      const Cls dc = ClassOf(d->type), sc = ClassOf(a->type);
      if ((sc == Cls::kF32 || sc == Cls::kF64) && (dc == Cls::kF32 || dc == Cls::kF64)) {
        Push(a);
        if (sc == Cls::kF32 && dc == Cls::kF64) Op(oF64PromoteF32);
        if (sc == Cls::kF64 && dc == Cls::kF32) Op(oF32DemoteF64);
        return SetDest(instr);
      }
      if (IsInt(a->type) && (dc == Cls::kF32 || dc == Cls::kF64)) {
        if (a->type == INT64_TYPE) {
          Push(a);
          Op(dc == Cls::kF32 ? oF32ConvertI64S : oF64ConvertI64S);
        } else {
          PushSigned32(a);
          Op(dc == Cls::kF32 ? oF32ConvertI32S : oF64ConvertI32S);
        }
        return SetDest(instr);
      }
      if ((sc == Cls::kF32 || sc == Cls::kF64) &&
          (d->type == INT32_TYPE || d->type == INT64_TYPE)) {
        Push(a);
        if (sc == Cls::kF32) Op(oF64PromoteF32);
        I32(int32_t(instr->flags));
        I32((d->type == INT64_TYPE ? 1 : 0) | (sc == Cls::kF64 ? 2 : 0));
        I32(int32_t(source));
        Call(kHCvtF2I);
        if (d->type == INT32_TYPE) Op(oI32WrapI64);
        return SetDest(instr);
      }
      return Reject(instr);
    }
    case OPCODE_ROUND: {
      if (!d || !a || d->type != a->type) return Reject(instr);
      const bool f32 = d->type == FLOAT32_TYPE;
      if (!f32 && d->type != FLOAT64_TYPE) return Reject(instr);
      Push(a);
      switch (instr->flags) {
        case ROUND_TO_ZERO: Op(f32 ? oF32Trunc : oF64Trunc); break;
        case ROUND_TO_NEAREST: case ROUND_DYNAMIC: Op(f32 ? oF32Nearest : oF64Nearest); break;
        case ROUND_TO_MINUS_INFINITY: Op(f32 ? oF32Floor : oF64Floor); break;
        case ROUND_TO_POSITIVE_INFINITY: Op(f32 ? oF32Ceil : oF64Ceil); break;
        default: break;  // executor: value unchanged
      }
      return SetDest(instr);
    }
    case OPCODE_IS_NAN: {
      if (!d || !a || !IsInt(d->type)) return Reject(instr);
      const Cls sc = ClassOf(a->type);
      if (sc != Cls::kF32 && sc != Cls::kF64) return Reject(instr);
      Push(a); Push(a);
      Op(sc == Cls::kF32 ? oF32Ne : oF64Ne);
      if (ClassOf(d->type) == Cls::kI64) Op(oI64ExtendI32U);
      return SetDest(instr);
    }
    case OPCODE_NEG: case OPCODE_ABS: case OPCODE_NOT: case OPCODE_BYTE_SWAP:
    case OPCODE_IS_TRUE: case OPCODE_IS_FALSE: case OPCODE_CNTLZ: {
      if (!d || !a) return Reject(instr);
      const Cls dc = ClassOf(d->type), sc = ClassOf(a->type);
      if (dc == Cls::kF32 || dc == Cls::kF64) {
        if (d->type != a->type) return Reject(instr);
        Push(a);
        if (op == OPCODE_NEG) Op(dc == Cls::kF32 ? oF32Neg : oF64Neg);
        else if (op == OPCODE_ABS) Op(dc == Cls::kF32 ? oF32Abs : oF64Abs);
        else if (op == OPCODE_BYTE_SWAP) ByteSwap(dc, d->type);
        else return Reject(instr);
        return SetDest(instr);
      }
      if (!IsInt(d->type) || !IsInt(a->type)) return Reject(instr);
      switch (op) {
        case OPCODE_NEG:
          if (dc == Cls::kI32) { I32(0); PushAs(a, dc); Op(oI32Sub); Mask(d->type); }
          else { I64(0); PushAs(a, dc); Op(oI64Sub); }
          break;
        case OPCODE_NOT:
          PushAs(a, dc);
          if (dc == Cls::kI32) { I32(-1); Op(oI32Xor); Mask(d->type); }
          else { I64(-1); Op(oI64Xor); }
          break;
        case OPCODE_BYTE_SWAP:
          if (d->type != a->type) return Reject(instr);
          Push(a);
          ByteSwap(dc, d->type);
          break;
        case OPCODE_IS_TRUE: case OPCODE_IS_FALSE:
          Push(a);
          Op(sc == Cls::kI64 ? oI64Eqz : oI32Eqz);
          if (op == OPCODE_IS_TRUE) Op(oI32Eqz);
          if (dc == Cls::kI64) Op(oI64ExtendI32U);
          break;
        case OPCODE_CNTLZ:
          if (d->type != INT8_TYPE) return Reject(instr);
          Push(a);
          if (sc == Cls::kI64) {
            Op(oI64Clz); Op(oI32WrapI64);
          } else {
            Op(oI32Clz);
            if (Bits(a->type) < 32) { I32(int32_t(32 - Bits(a->type))); Op(oI32Sub); }
          }
          break;
        default:
          return Reject(instr);
      }
      return SetDest(instr);
    }

    case OPCODE_SELECT: {
      if (!d || !a || !b || !c3) return Reject(instr);
      if (ClassOf(d->type) == Cls::kNone || ClassOf(b->type) != ClassOf(d->type) ||
          ClassOf(c3->type) != ClassOf(d->type) || !IsInt(a->type)) {
        return Reject(instr);
      }
      Push(b); Push(c3);
      Push(a);
      if (ClassOf(a->type) == Cls::kI64) { I64(0); Op(oI64Ne); }
      Op(oSelect);
      return SetDest(instr);
    }

    case OPCODE_ADD: case OPCODE_SUB: case OPCODE_MUL: case OPCODE_DIV:
    case OPCODE_AND: case OPCODE_AND_NOT: case OPCODE_OR: case OPCODE_XOR:
    case OPCODE_SHL: case OPCODE_SHR: case OPCODE_SHA: case OPCODE_ROTATE_LEFT:
    case OPCODE_MIN: case OPCODE_MAX: case OPCODE_MUL_HI: case OPCODE_ADD_CARRY:
    case OPCODE_COMPARE_EQ: case OPCODE_COMPARE_NE: case OPCODE_COMPARE_SLT:
    case OPCODE_COMPARE_SLE: case OPCODE_COMPARE_SGT: case OPCODE_COMPARE_SGE:
    case OPCODE_COMPARE_ULT: case OPCODE_COMPARE_ULE: case OPCODE_COMPARE_UGT:
    case OPCODE_COMPARE_UGE: {
      if (!d || !a || !b) return Reject(instr);
      const Cls dc = ClassOf(d->type), lc = ClassOf(a->type);
      const bool compare = op >= OPCODE_COMPARE_EQ && op <= OPCODE_COMPARE_UGE;
      // Floating point.
      if (lc == Cls::kF32 || lc == Cls::kF64) {
        const bool f32 = lc == Cls::kF32;
        if (a->type != b->type) return Reject(instr);
        if (compare) {
          if (!IsInt(d->type)) return Reject(instr);
          Push(a); Push(b);
          switch (op) {
            case OPCODE_COMPARE_EQ: Op(f32 ? oF32Eq : oF64Eq); break;
            case OPCODE_COMPARE_NE: Op(f32 ? oF32Ne : oF64Ne); break;
            case OPCODE_COMPARE_SLT: Op(f32 ? oF32Lt : oF64Lt); break;
            case OPCODE_COMPARE_SLE: Op(f32 ? oF32Le : oF64Le); break;
            case OPCODE_COMPARE_SGT: Op(f32 ? oF32Gt : oF64Gt); break;
            case OPCODE_COMPARE_SGE: Op(f32 ? oF32Ge : oF64Ge); break;
            default: return Reject(instr);
          }
          if (dc == Cls::kI64) Op(oI64ExtendI32U);
          return SetDest(instr);
        }
        if (d->type != a->type) return Reject(instr);
        switch (op) {
          case OPCODE_ADD: Push(a); Push(b); Op(f32 ? oF32Add : oF64Add); break;
          case OPCODE_SUB: Push(a); Push(b); Op(f32 ? oF32Sub : oF64Sub); break;
          case OPCODE_MUL: Push(a); Push(b); Op(f32 ? oF32Mul : oF64Mul); break;
          case OPCODE_DIV: Push(a); Push(b); Op(f32 ? oF32Div : oF64Div); break;
          case OPCODE_MIN: case OPCODE_MAX:
            // x < y ? x : y (MIN), x > y ? x : y (MAX), as the executor.
            Push(a); Push(b); Push(a); Push(b);
            Op(op == OPCODE_MIN ? (f32 ? oF32Lt : oF64Lt) : (f32 ? oF32Gt : oF64Gt));
            Op(oSelect);
            break;
          default:
            return Reject(instr);
        }
        return SetDest(instr);
      }
      if (!IsInt(d->type) || !IsInt(a->type) || !IsInt(b->type)) return Reject(instr);
      if (compare) {
        // Operands at their own width; the result is 0/1.
        const Cls cc = (a->type == INT64_TYPE || b->type == INT64_TYPE) ? Cls::kI64 : Cls::kI32;
        const bool is_signed = op >= OPCODE_COMPARE_SLT && op <= OPCODE_COMPARE_SGE;
        if (is_signed && a->type != b->type) return Reject(instr);
        if (cc == Cls::kI64) {
          PushAs(a, cc); PushAs(b, cc);
        } else if (is_signed) {
          PushSigned32(a); PushSigned32(b);
        } else {
          Push(a); Push(b);
        }
        const bool w = cc == Cls::kI64;
        switch (op) {
          case OPCODE_COMPARE_EQ: Op(w ? oI64Eq : oI32Eq); break;
          case OPCODE_COMPARE_NE: Op(w ? oI64Ne : oI32Ne); break;
          case OPCODE_COMPARE_SLT: Op(w ? oI64LtS : oI32LtS); break;
          case OPCODE_COMPARE_SLE: Op(w ? oI64LeS : oI32LeS); break;
          case OPCODE_COMPARE_SGT: Op(w ? oI64GtS : oI32GtS); break;
          case OPCODE_COMPARE_SGE: Op(w ? oI64GeS : oI32GeS); break;
          case OPCODE_COMPARE_ULT: Op(w ? oI64LtU : oI32LtU); break;
          case OPCODE_COMPARE_ULE: Op(w ? oI64LeU : oI32LeU); break;
          case OPCODE_COMPARE_UGT: Op(w ? oI64GtU : oI32GtU); break;
          case OPCODE_COMPARE_UGE: Op(w ? oI64GeU : oI32GeU); break;
          default: return Reject(instr);
        }
        if (dc == Cls::kI64) Op(oI64ExtendI32U);
        return SetDest(instr);
      }
      const bool w = dc == Cls::kI64;
      const uint32_t width = Bits(d->type);
      switch (op) {
        case OPCODE_ADD: case OPCODE_SUB: case OPCODE_MUL: case OPCODE_AND:
        case OPCODE_OR: case OPCODE_XOR:
          PushAs(a, dc); PushAs(b, dc);
          switch (op) {
            case OPCODE_ADD: Op(w ? oI64Add : oI32Add); break;
            case OPCODE_SUB: Op(w ? oI64Sub : oI32Sub); break;
            case OPCODE_MUL: Op(w ? oI64Mul : oI32Mul); break;
            case OPCODE_AND: Op(w ? oI64And : oI32And); break;
            case OPCODE_OR: Op(w ? oI64Or : oI32Or); break;
            default: Op(w ? oI64Xor : oI32Xor); break;
          }
          break;
        case OPCODE_AND_NOT:
          PushAs(a, dc); PushAs(b, dc);
          if (w) { I64(-1); Op(oI64Xor); Op(oI64And); }
          else { I32(-1); Op(oI32Xor); Op(oI32And); }
          break;
        case OPCODE_ADD_CARRY:
          if (!c3 || !IsInt(c3->type)) return Reject(instr);
          PushAs(a, dc); PushAs(b, dc);
          Op(w ? oI64Add : oI32Add);
          PushAs(c3, dc);
          if (w) { I64(1); Op(oI64And); Op(oI64Add); }
          else { I32(1); Op(oI32And); Op(oI32Add); }
          break;
        case OPCODE_SHL: case OPCODE_SHR: case OPCODE_SHA: {
          // shift = rhs & (width - 1).
          if (op == OPCODE_SHA && dc == Cls::kI32) PushSigned32(a);
          else PushAs(a, dc);
          PushAs(b, dc);
          if (w) { I64(int64_t(width - 1)); Op(oI64And); }
          else { I32(int32_t(width - 1)); Op(oI32And); }
          if (op == OPCODE_SHL) Op(w ? oI64Shl : oI32Shl);
          else if (op == OPCODE_SHR) Op(w ? oI64ShrU : oI32ShrU);
          else Op(w ? oI64ShrS : oI32ShrS);
          break;
        }
        case OPCODE_ROTATE_LEFT:
          if (d->type != a->type) return Reject(instr);
          if (width == 32 || width == 64) {
            Push(a); PushAs(b, dc);
            Op(w ? oI64Rotl : oI32Rotl);
          } else {
            // ((v << s) | (v >> (width - s))) & mask, s = rhs & (width - 1).
            PushAs(b, Cls::kI32); I32(int32_t(width - 1)); Op(oI32And); Set(kLocTmp);
            Push(a); Get(kLocTmp); Op(oI32Shl);
            Push(a); I32(int32_t(width)); Get(kLocTmp); Op(oI32Sub); Op(oI32ShrU);
            Op(oI32Or);
          }
          break;
        case OPCODE_MIN: case OPCODE_MAX:
          // MIN: rhs < lhs (signed) ? rhs : lhs; MAX: rhs > lhs ? rhs : lhs.
          if (a->type != b->type) return Reject(instr);
          Push(b); Push(a);
          if (w) { Push(b); Push(a); } else { PushSigned32(b); PushSigned32(a); }
          Op(op == OPCODE_MIN ? (w ? oI64LtS : oI32LtS) : (w ? oI64GtS : oI32GtS));
          Op(oSelect);
          break;
        case OPCODE_MUL_HI: {
          const bool is_unsigned = (instr->flags & ARITHMETIC_UNSIGNED) != 0;
          if (a->type != d->type || b->type != d->type) return Reject(instr);
          if (w) {
            Push(a); Push(b); I32(is_unsigned ? 1 : 0); Call(kHMulHi64);
          } else {
            if (is_unsigned) { PushAs(a, Cls::kI64); PushAs(b, Cls::kI64); }
            else { PushSigned32(a); Op(oI64ExtendI32S); PushSigned32(b); Op(oI64ExtendI32S); }
            Op(oI64Mul);
            I64(int64_t(width));
            Op(is_unsigned ? oI64ShrU : oI64ShrS);
            Op(oI32WrapI64);
          }
          break;
        }
        case OPCODE_DIV: {
          // 0 for a zero divisor; signed x / -1 = 0 - x (no trap).
          const bool is_unsigned = (instr->flags & ARITHMETIC_UNSIGNED) != 0;
          if (a->type != d->type || b->type != d->type) return Reject(instr);
          const uint32_t ta = w ? kLocTmp64 : kLocTmp, tb = w ? kLocTmp64B : kLocTmpB;
          if (is_unsigned || w) { Push(a); } else { PushSigned32(a); }
          Set(ta);
          if (is_unsigned || w) { Push(b); } else { PushSigned32(b); }
          Set(tb);
          const uint8_t rt = w ? kI64 : kI32;
          Get(tb); Op(w ? oI64Eqz : oI32Eqz);
          If(rt);
          if (w) I64(0); else I32(0);
          Else();
          if (is_unsigned) {
            Get(ta); Get(tb); Op(w ? oI64DivU : oI32DivU);
          } else {
            Get(tb); if (w) I64(-1); else I32(-1); Op(w ? oI64Eq : oI32Eq);
            If(rt);
            if (w) I64(0); else I32(0);
            Get(ta); Op(w ? oI64Sub : oI32Sub);
            Else();
            Get(ta); Get(tb); Op(w ? oI64DivS : oI32DivS);
            End();
          }
          End();
          break;
        }
        default:
          return Reject(instr);
      }
      if (!w) Mask(d->type);
      return SetDest(instr);
    }

    case OPCODE_BRANCH: {
      if (!instr->src1.label || !instr->src1.label->block) return Reject(instr);
      DiscardReturnToken();
      Jump(k, block_segment_[instr->src1.label->block]);
      return true;
    }
    case OPCODE_BRANCH_TRUE: case OPCODE_BRANCH_FALSE: {
      if (!instr->src2.label || !instr->src2.label->block || !a || !IsInt(a->type)) {
        return Reject(instr);
      }
      DiscardReturnToken();  // taken or not
      Push(a);
      if (ClassOf(a->type) == Cls::kI64) { I64(0); Op(oI64Ne); }
      if (op == OPCODE_BRANCH_FALSE) Op(oI32Eqz);
      If();
      Jump(k, block_segment_[instr->src2.label->block]);
      End();
      return true;
    }
    case OPCODE_RETURN:
      DiscardReturnToken();
      I32(int32_t(kJitStatusReturned));
      Op(oReturn);
      return true;
    case OPCODE_RETURN_TRUE:
      if (!a || !IsInt(a->type)) return Reject(instr);
      Push(a);
      if (ClassOf(a->type) == Cls::kI64) { I64(0); Op(oI64Ne); }
      If();
      DiscardReturnToken();
      I32(int32_t(kJitStatusReturned));
      Op(oReturn);
      End();
      return true;

    case OPCODE_CALL: case OPCODE_CALL_TRUE: {
      const bool conditional = op == OPCODE_CALL_TRUE;
      auto* symbol = conditional ? instr->src2.symbol : instr->src1.symbol;
      uint32_t direct_target = 0;
      // Without a symbol the executor decodes the b/bl at the source address.
      if (!symbol && (!source || !JitDecodeDirectCall(source, &direct_target))) {
        return Reject(instr);
      }
      if (conditional) {
        if (!a || !IsInt(a->type)) return Reject(instr);
        Push(a);
        if (ClassOf(a->type) == Cls::kI64) { I64(0); Op(oI64Ne); }
        If();
      }
      if (symbol) {
        I32(int32_t(reinterpret_cast<uintptr_t>(symbol)));
        I32(int32_t(instr->flags));
        I32(int32_t(source));
        Call(kHCall);
      } else {
        I32(int32_t(direct_target));
        I32(int32_t(instr->flags));
        I32(int32_t(source));
        Call(kHCallAddr);
      }
      Set(kLocTmp);
      UnwindCheck(k);
      Get(kLocTmp); Op(oI32Eqz);
      If(); I32(int32_t(kJitStatusFailed)); Op(oReturn); End();
      if (instr->flags & CALL_TAIL) { I32(int32_t(kJitStatusReturned)); Op(oReturn); }
      if (conditional) {
        Else();
        DiscardReturnToken();  // conditional call not taken
        End();
      }
      return true;
    }
    case OPCODE_CALL_INDIRECT: case OPCODE_CALL_INDIRECT_TRUE: {
      const bool conditional = op == OPCODE_CALL_INDIRECT_TRUE;
      Value* target = conditional ? b : a;
      if (!target || !IsInt(target->type)) return Reject(instr);
      if (conditional) {
        if (!a || !IsInt(a->type)) return Reject(instr);
        Push(a);
        if (ClassOf(a->type) == Cls::kI64) { I64(0); Op(oI64Ne); }
        If();
      }
      PushAs(target, Cls::kI32);
      I32(int32_t(instr->flags));
      I32(int32_t(source));
      Call(kHCallIndirect);
      Set(kLocTmp);
      UnwindCheck(k);
      // 0 failed, 1 continue, 2 reached a return.
      Get(kLocTmp); Op(oI32Eqz);
      If(); I32(int32_t(kJitStatusFailed)); Op(oReturn); End();
      Get(kLocTmp); I32(2); Op(oI32Eq);
      If(); I32(int32_t(kJitStatusReturned)); Op(oReturn); End();
      if (conditional) {
        Else();
        DiscardReturnToken();  // conditional indirect call not taken
        End();
      }
      return true;
    }
    case OPCODE_CALL_EXTERN: {
      if (!instr->src1.symbol) return Reject(instr);
      I32(int32_t(reinterpret_cast<uintptr_t>(instr->src1.symbol)));
      I32(int32_t(source));
      Call(kHCallExtern);
      Set(kLocTmp);
      UnwindCheck(k);
      Get(kLocTmp); Op(oI32Eqz);
      If(); I32(int32_t(kJitStatusFailed)); Op(oReturn); End();
      return true;
    }
    default:
      return Reject(instr);
  }
}

bool Emitter::EmitSegment(uint32_t k) {
  if (k < real_) {
    const Segment& s = segments_[k];
    if (s.count) {
      // Total instruction counter (--max-minstr, preemption accounting).
      I32(int32_t(counter_));
      I32(int32_t(counter_)); Mem(oI64Load, 3, 0);
      I64(int64_t(s.count)); Op(oI64Add);
      Mem(oI64Store, 3, 0);
    }
    uint32_t source = 0;
    for (Instr* i = s.block->instr_head; i && i != s.first; i = i->next) {
      if (i->opcode && i->opcode->num == hir::OPCODE_SOURCE_OFFSET) source = uint32_t(i->src1.offset);
    }
    for (Instr* instr = s.first; instr && instr != s.end; instr = instr->next) {
      if (instr->opcode->num == hir::OPCODE_SOURCE_OFFSET) source = uint32_t(instr->src1.offset);
      if (!EmitInstr(instr, k, source)) return false;
    }
    return true;  // falls through to segment k + 1
  }
  if (k == end_) {
    I32(int32_t(kJitStatusFellOff));
    Op(oReturn);
    return true;
  }
  if (k == poll_) {
    Call(kHPoll);
    Set(kLocTmp);
    UnwindCheck(k);
    Get(kLocTmp); Op(oI32Eqz);
    If(); I32(int32_t(kJitStatusFailed)); Op(oReturn); End();
    Get(kLocPending); Set(kLocPc);
    BrTo(DepthToLoop(k));
    return true;
  }
  const uint32_t total = kFixedLocals + uint32_t(local_types_.size());
  const uint32_t bytes = total * 16u;
  auto type_of = [&](uint32_t i) -> uint8_t {
    if (i == 0 || i < kLocTmp64) return kI32;
    if (i < kLocTmpF64) return kI64;
    if (i == kLocTmpF64) return kF64;
    if (i == kLocTmpV) return kV128;
    return local_types_[i - kFixedLocals];
  };
  if (k == spill_) {
    I32(int32_t(bytes)); Call(kHSpillAlloc); Set(kLocSp);
    for (uint32_t i = 0; i < total; ++i) {
      Get(kLocSp); Get(i);
      switch (type_of(i)) {
        case kI32: Mem(oI32Store, 2, i * 16u); break;
        case kI64: Mem(oI64Store, 3, i * 16u); break;
        case kF32: Mem(oF32Store, 2, i * 16u); break;
        case kV128: V128Store(i * 16u); break;
        default: Mem(oF64Store, 3, i * 16u); break;
      }
    }
    I32(int32_t(kJitStatusUnwinding));
    Op(oReturn);
    return true;
  }
  // RESTORE (Asyncify rewind).
  I32(int32_t(bytes)); Call(kHSpillPop); Set(kLocSp);
  for (uint32_t i = 0; i < total; ++i) {
    if (i == kLocSp) continue;
    Get(kLocSp);
    switch (type_of(i)) {
      case kI32: Mem(oI32Load, 2, i * 16u); break;
      case kI64: Mem(oI64Load, 3, i * 16u); break;
      case kF32: Mem(oF32Load, 2, i * 16u); break;
      case kV128: V128Load(i * 16u); break;
      default: Mem(oF64Load, 3, i * 16u); break;
    }
    Set(i);
  }
  Get(kLocResume); Set(kLocPc);
  BrTo(DepthToLoop(k));
  return true;
}

bool Emitter::Compile(std::vector<uint8_t>* out) {
  counter_ = JitInstructionCounterAddress();
  fault_ = JitFaultAddress();
  return_slot_ = JitReturnAddressSlot();
  scratch_ = JitScratchAddress();
  return_valid_ = JitReturnValidSlot();
  if (!Plan()) return false;
  AllocateTemporaries();

  // Function body (after the local declarations, which depend on it).
  // Entry: rewinding -> RESTORE, else segment 0.
  Call(kHState); I32(2); Op(oI32Eq);
  If(kI32); I32(int32_t(restore_)); Else(); I32(0); End();
  Set(kLocPc);
  I32(int32_t(kPollBudget)); Set(kLocBudget);
  code_.u8(oLoop); code_.u8(kVoid);
  for (uint32_t i = 0; i < n_; ++i) { code_.u8(oBlock); code_.u8(kVoid); }
  Get(kLocPc);
  code_.u8(oBrTable);
  code_.u32(n_);
  for (uint32_t i = 0; i < n_; ++i) code_.u32(i);
  code_.u32(end_);
  for (uint32_t k = 0; k < n_; ++k) {
    code_.u8(oEnd);  // closes block k: segment k starts here
    extra_ = 0;
    if (!EmitSegment(k)) return false;
  }
  // Guard against pathological SSA cost in the host engine's optimizing tier.
  if (uint64_t(n_) * (kFixedLocals + local_types_.size()) > 3000000ull) {
    reject_opcode_ = 0xFE;
    return false;
  }
  code_.u8(oEnd);  // loop
  Op(oUnreachable);
  code_.u8(oEnd);  // function

  // Module.
  Bytes module;
  const uint8_t magic[8] = {0x00, 0x61, 0x73, 0x6D, 0x01, 0x00, 0x00, 0x00};
  module.raw(magic, 8);
  const auto& helpers = Helpers();
  // Types: one per helper, then the generated function (i32) -> i32.
  Bytes types;
  types.u32(uint32_t(helpers.size()) + 1);
  for (const auto& h : helpers) {
    types.u8(0x60);
    types.u32(uint32_t(h.params.size()));
    for (uint8_t p : h.params) types.u8(p);
    types.u32(uint32_t(h.results.size()));
    for (uint8_t r : h.results) types.u8(r);
  }
  types.u8(0x60); types.u32(1); types.u8(kI32); types.u32(1); types.u8(kI32);
  module.section(1, types);
  Bytes imports;
  imports.u32(uint32_t(helpers.size()) + 1);
  imports.str("e"); imports.str("memory"); imports.u8(0x02); imports.u8(0x00); imports.u32(0);
  for (uint32_t i = 0; i < helpers.size(); ++i) {
    imports.str("h"); imports.str(helpers[i].name); imports.u8(0x00); imports.u32(i);
  }
  module.section(2, imports);
  Bytes functions;
  functions.u32(1);
  functions.u32(uint32_t(helpers.size()));
  module.section(3, functions);
  Bytes exports;
  exports.u32(1);
  exports.str("f"); exports.u8(0x00); exports.u32(uint32_t(helpers.size()));
  module.section(7, exports);
  // Code: locals as runs of equal types.
  Bytes body;
  std::vector<std::pair<uint32_t, uint8_t>> runs;
  auto add_local = [&](uint8_t t) {
    if (!runs.empty() && runs.back().second == t) ++runs.back().first;
    else runs.push_back({1, t});
  };
  for (uint32_t i = 1; i < kLocTmp64; ++i) add_local(kI32);
  add_local(kI64); add_local(kI64); add_local(kF64); add_local(kV128);
  for (uint8_t t : local_types_) add_local(t);
  body.u32(uint32_t(runs.size()));
  for (const auto& r : runs) { body.u32(r.first); body.u8(r.second); }
  body.append(code_);
  Bytes code_section;
  code_section.u32(1);
  code_section.u32(uint32_t(body.b.size()));
  code_section.append(body);
  module.section(10, code_section);
  *out = std::move(module.b);
  return true;
}

uint32_t RequestCompile(HIRBuilder* builder, JitSlot* slot) {
  Emitter emitter(builder);
  std::vector<uint8_t> bytes;
  if (!emitter.Compile(&bytes)) {
    slot->state = 2;
    ++g_rejected;
    g_last_reject_opcode = emitter.reject_opcode();
    ++g_reject_histogram[g_last_reject_opcode & 0xFF];
    g_reject_by_builder[builder] = g_last_reject_opcode;
    return 0;
  }
  const uint32_t request = g_next_request++;
  slot->state = 1;
  slot->request = request;
  g_pending[request] = slot;
  g_code_bytes += bytes.size();
  const uint32_t index = reinterpret_cast<CompilerFn>(uintptr_t(g_compiler))(
      uint32_t(uintptr_t(bytes.data())), uint32_t(bytes.size()), request);
  if (index) {
    g_pending.erase(request);
    slot->request = 0;
    slot->function = index;
    slot->state = 0;
    ++g_compiled;
  }
  return index;
}

}  // namespace

void JitSetCandidate(HIRBuilder* builder, JitSlot* slot) {
  g_candidate_builder = builder;
  g_candidate_slot = slot;
}

uint32_t JitTakeFunction(HIRBuilder* builder) {
  JitSlot* slot = g_candidate_builder == builder ? g_candidate_slot : nullptr;
  g_candidate_builder = nullptr;
  g_candidate_slot = nullptr;
  g_last_decision = 5;
  if (!g_mode || !g_compiler) return 0;
  g_last_decision = 1;
  if (!slot) {
    if (g_mode < 2) return 0;
    // Test mode: also compile uncached executions, each time afresh.
    static JitSlot scratch;
    scratch = JitSlot{};
    slot = &scratch;
  }
  if (slot->function) {
    ++g_jit_calls;
    return slot->function;
  }
  if (slot->state) {  // pending or not compilable
    g_last_decision = slot->state == 1 ? 3 : 4;
    return 0;
  }
  g_last_decision = 2;
  if (++slot->runs < (g_mode >= 2 ? 1u : g_hot_threshold)) return 0;
  const uint32_t index = RequestCompile(builder, slot);
  if (!index) g_last_decision = slot->state == 1 ? 3 : 4;
  if (index) ++g_jit_calls;
  return index;
}

uint32_t JitLastDecision() { return g_last_decision; }
uint32_t JitRejectOpcode(HIRBuilder* builder) {
  auto it = g_reject_by_builder.find(builder);
  return it == g_reject_by_builder.end() ? 0xFFu : it->second;
}

void JitReleaseSlot(JitSlot* slot) {
  if (slot && slot->request) g_pending.erase(slot->request);
}

}  // namespace render360::xenia_web

namespace rx = render360::xenia_web;

extern "C" {
__attribute__((used, export_name("r360_jit_set_compiler")))
uint32_t r360_jit_set_compiler(uint32_t table_index) {
  rx::g_compiler = table_index;
  return 1;
}
__attribute__((used, export_name("r360_jit_set_mode")))
uint32_t r360_jit_set_mode(uint32_t mode, uint32_t hot_threshold) {
  rx::g_mode = mode;
  if (hot_threshold) rx::g_hot_threshold = hot_threshold;
  return rx::g_mode;
}
// Asynchronous compile finished: `table_index` holds the function for request
// `request` (0 = the host could not compile it).
__attribute__((used, export_name("r360_jit_install")))
uint32_t r360_jit_install(uint32_t request, uint32_t table_index) {
  auto it = rx::g_pending.find(request);
  if (it == rx::g_pending.end()) return 0;
  rx::JitSlot* slot = it->second;
  rx::g_pending.erase(it);
  slot->request = 0;
  if (table_index) {
    slot->function = table_index;
    slot->state = 0;
    ++rx::g_compiled;
  } else {
    slot->state = 2;
    ++rx::g_compile_failures;
  }
  return 1;
}
__attribute__((used, export_name("r360_jit_stat")))
uint32_t r360_jit_stat(uint32_t which) {
  switch (which) {
    case 0: return rx::g_compiled;
    case 1: return rx::g_rejected;
    case 2: return rx::g_compile_failures;
    case 3: return uint32_t(rx::g_jit_calls / 1000u);
    case 4: return rx::g_last_reject_opcode;
    case 5: return uint32_t(rx::g_code_bytes / 1024u);
    case 6: return uint32_t(rx::g_pending.size());
    default: return 0;
  }
}
__attribute__((used, export_name("r360_jit_reject_count")))
uint32_t r360_jit_reject_count(uint32_t opcode) {
  return rx::g_reject_histogram[opcode & 0xFF];
}
}
