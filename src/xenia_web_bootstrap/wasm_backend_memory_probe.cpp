#include "wasm_backend_memory_probe.h"

#include <cstddef>
#include <cstdint>
#include <cstring>
#include <unordered_map>
#include <unordered_set>
#include <vector>

#include "xenia/cpu/hir/block.h"
#include "xenia/cpu/hir/hir_builder.h"
#include "xenia/cpu/hir/instr.h"
#include "xenia/cpu/hir/opcodes.h"
#include "xenia/cpu/hir/value.h"
#include "xenia/cpu/ppc/ppc_context.h"

namespace render360::xenia_web {
namespace {
using xe::cpu::hir::HIRBuilder;
using xe::cpu::hir::Instr;
using xe::cpu::hir::TypeName;
using xe::cpu::hir::Value;
using xe::cpu::ppc::PPCContext;

struct LocalInfo { uint32_t index; TypeName type; };
using ValueLocals = std::unordered_map<const Value*, LocalInfo>;

uint32_t g_status = 0;
uint32_t g_lowered = 0;
std::vector<uint8_t> g_module;
alignas(64) uint8_t g_context[sizeof(PPCContext)] = {};
uint32_t g_guest_host_base = 0;
uint32_t g_guest_base = 0;
uint32_t g_guest_size = 0;

bool IsInt(TypeName t) {
  return t == xe::cpu::hir::INT8_TYPE || t == xe::cpu::hir::INT16_TYPE ||
         t == xe::cpu::hir::INT32_TYPE || t == xe::cpu::hir::INT64_TYPE;
}
bool IsI64(TypeName t) { return t == xe::cpu::hir::INT64_TYPE; }

void U32(std::vector<uint8_t>& o, uint32_t v) {
  do { uint8_t b = uint8_t(v & 0x7F); v >>= 7; if (v) b |= 0x80; o.push_back(b); } while (v);
}
void I32(std::vector<uint8_t>& o, int32_t v) {
  bool more = true;
  while (more) { uint8_t b = uint8_t(v & 0x7F); bool s = (b & 0x40) != 0; v >>= 7;
    more = !((v == 0 && !s) || (v == -1 && s)); if (more) b |= 0x80; o.push_back(b); }
}
void I64(std::vector<uint8_t>& o, int64_t v) {
  bool more = true;
  while (more) { uint8_t b = uint8_t(v & 0x7F); bool s = (b & 0x40) != 0; v >>= 7;
    more = !((v == 0 && !s) || (v == -1 && s)); if (more) b |= 0x80; o.push_back(b); }
}
void Name(std::vector<uint8_t>& o, const char* s) {
  uint32_t n = uint32_t(std::strlen(s)); U32(o, n); o.insert(o.end(), s, s + n);
}
void Section(std::vector<uint8_t>& m, uint8_t id, const std::vector<uint8_t>& p) {
  m.push_back(id); U32(m, uint32_t(p.size())); m.insert(m.end(), p.begin(), p.end());
}
void I32Const(std::vector<uint8_t>& o, int32_t v) { o.push_back(0x41); I32(o, v); }
void I64Const(std::vector<uint8_t>& o, int64_t v) { o.push_back(0x42); I64(o, v); }
void Mask(std::vector<uint8_t>& o, TypeName t) {
  if (t == xe::cpu::hir::INT8_TYPE) { I32Const(o, 0xFF); o.push_back(0x71); }
  if (t == xe::cpu::hir::INT16_TYPE) { I32Const(o, 0xFFFF); o.push_back(0x71); }
}

bool EmitValue(const Value* v, const ValueLocals& locals, std::vector<uint8_t>& o) {
  if (!v || !IsInt(v->type)) return false;
  if (v->IsConstant()) {
    if (IsI64(v->type)) I64Const(o, v->constant.i64);
    else { I32Const(o, v->constant.i32); Mask(o, v->type); }
    return true;
  }
  auto it = locals.find(v); if (it == locals.end()) return false;
  o.push_back(0x20); U32(o, it->second.index); return true;
}

bool EmitAsI32(const Value* v, const ValueLocals& locals, std::vector<uint8_t>& o) {
  if (!EmitValue(v, locals, o)) return false;
  if (IsI64(v->type)) o.push_back(0xA7);  // i32.wrap_i64
  return true;
}

bool EmitGuestHostAddress(const Value* address, const Value* offset,
                          const ValueLocals& locals, std::vector<uint8_t>& o) {
  if (!EmitAsI32(address, locals, o)) return false;
  if (offset) {
    if (!EmitAsI32(offset, locals, o)) return false;
    o.push_back(0x6A);  // i32.add guest offset
  }
  I32Const(o, static_cast<int32_t>(g_guest_base));
  o.push_back(0x6B);  // guest - guest_base
  I32Const(o, static_cast<int32_t>(g_guest_host_base));
  o.push_back(0x6A);  // + parent-memory host backing pointer
  return true;
}

bool EmitByteSwap(const Value* src, TypeName dest_type,
                  const ValueLocals& locals, std::vector<uint8_t>& o) {
  if (!src || !IsInt(src->type)) return false;
  if (dest_type == xe::cpu::hir::INT16_TYPE) {
    if (!EmitAsI32(src, locals, o)) return false;
    I32Const(o, 8); o.push_back(0x76);  // x >> 8
    if (!EmitAsI32(src, locals, o)) return false;
    I32Const(o, 8); o.push_back(0x74);  // x << 8
    o.push_back(0x72); Mask(o, dest_type); return true;
  }
  if (dest_type == xe::cpu::hir::INT32_TYPE) {
    // ((x&ff)<<24)|((x&ff00)<<8)|((x>>8)&ff00)|((x>>24)&ff)
    if (!EmitAsI32(src, locals, o)) return false; I32Const(o, 0xFF); o.push_back(0x71); I32Const(o, 24); o.push_back(0x74);
    if (!EmitAsI32(src, locals, o)) return false; I32Const(o, 0xFF00); o.push_back(0x71); I32Const(o, 8); o.push_back(0x74); o.push_back(0x72);
    if (!EmitAsI32(src, locals, o)) return false; I32Const(o, 8); o.push_back(0x76); I32Const(o, 0xFF00); o.push_back(0x71); o.push_back(0x72);
    if (!EmitAsI32(src, locals, o)) return false; I32Const(o, 24); o.push_back(0x76); I32Const(o, 0xFF); o.push_back(0x71); o.push_back(0x72);
    return true;
  }
  if (dest_type == xe::cpu::hir::INT8_TYPE) return EmitAsI32(src, locals, o);
  return false;
}

bool EmitLoad(const Instr* in, const ValueLocals& locals, std::vector<uint8_t>& o) {
  const Value* address = in->src1.value;
  const Value* offset = in->opcode->num == xe::cpu::hir::OPCODE_LOAD_OFFSET ? in->src2.value : nullptr;
  if (!EmitGuestHostAddress(address, offset, locals, o)) return false;
  switch (in->dest->type) {
    case xe::cpu::hir::INT8_TYPE: o.push_back(0x2D); o.push_back(0x00); break;
    case xe::cpu::hir::INT16_TYPE: o.push_back(0x2F); o.push_back(0x01); break;
    case xe::cpu::hir::INT32_TYPE: o.push_back(0x28); o.push_back(0x02); break;
    case xe::cpu::hir::INT64_TYPE: o.push_back(0x29); o.push_back(0x03); break;
    default: return false;
  }
  U32(o, 0);
  // Xenia may retain the byte-swap load flag instead of materializing a later
  // BYTE_SWAP. Handle the scalar 16/32-bit cases directly and fail closed for
  // unsupported widths.
  if (in->flags & xe::cpu::hir::LOAD_STORE_BYTE_SWAP) {
    if (in->dest->type != xe::cpu::hir::INT16_TYPE && in->dest->type != xe::cpu::hir::INT32_TYPE) return false;
    // Store the raw load into its local first; caller performs flag swap via a
    // synthetic use is not possible here, so reject. Current Xenia probe HIR
    // materializes BYTE_SWAP after portable compiler passes.
    return false;
  }
  return true;
}

bool EmitProducer(const Instr* in, const ValueLocals& locals, std::vector<uint8_t>& o) {
  if (!in || !in->opcode || !in->dest || !IsInt(in->dest->type)) return false;
  bool ok = false;
  switch (in->opcode->num) {
    case xe::cpu::hir::OPCODE_LOAD_CONTEXT:
      o.push_back(0x20); o.push_back(0x00);
      if (in->dest->type == xe::cpu::hir::INT8_TYPE) { o.push_back(0x2D); o.push_back(0); }
      else if (in->dest->type == xe::cpu::hir::INT16_TYPE) { o.push_back(0x2F); o.push_back(1); }
      else if (in->dest->type == xe::cpu::hir::INT32_TYPE) { o.push_back(0x28); o.push_back(2); }
      else { o.push_back(0x29); o.push_back(3); }
      U32(o, uint32_t(in->src1.offset)); ok = true; break;
    case xe::cpu::hir::OPCODE_ASSIGN:
    case xe::cpu::hir::OPCODE_CAST:
    case xe::cpu::hir::OPCODE_ZERO_EXTEND:
    case xe::cpu::hir::OPCODE_TRUNCATE:
      ok = EmitValue(in->src1.value, locals, o);
      if (ok && IsI64(in->src1.value->type) && !IsI64(in->dest->type)) o.push_back(0xA7);
      if (ok && !IsI64(in->src1.value->type) && IsI64(in->dest->type)) o.push_back(0xAD);
      if (ok) Mask(o, in->dest->type);
      break;
    case xe::cpu::hir::OPCODE_ADD:
      ok = EmitValue(in->src1.value, locals, o) && EmitValue(in->src2.value, locals, o);
      if (ok) o.push_back(IsI64(in->dest->type) ? 0x7C : 0x6A);
      break;
    case xe::cpu::hir::OPCODE_LOAD:
    case xe::cpu::hir::OPCODE_LOAD_OFFSET:
      ok = EmitLoad(in, locals, o); break;
    case xe::cpu::hir::OPCODE_BYTE_SWAP:
      ok = EmitByteSwap(in->src1.value, in->dest->type, locals, o); break;
    default: return false;
  }
  if (!ok) return false;
  auto it = locals.find(in->dest); if (it == locals.end()) return false;
  o.push_back(0x21); U32(o, it->second.index); return true;
}

bool EmitStoreGuest(const Instr* in, const ValueLocals& locals, std::vector<uint8_t>& o) {
  const bool offset_form = in->opcode->num == xe::cpu::hir::OPCODE_STORE_OFFSET;
  const Value* address = in->src1.value;
  const Value* offset = offset_form ? in->src2.value : nullptr;
  const Value* value = offset_form ? in->src3.value : in->src2.value;
  if (!address || !value || !IsInt(value->type) || in->flags) return false;
  if (!EmitGuestHostAddress(address, offset, locals, o) || !EmitValue(value, locals, o)) return false;
  switch (value->type) {
    case xe::cpu::hir::INT8_TYPE: o.push_back(0x3A); o.push_back(0); break;
    case xe::cpu::hir::INT16_TYPE: o.push_back(0x3B); o.push_back(1); break;
    case xe::cpu::hir::INT32_TYPE: o.push_back(0x36); o.push_back(2); break;
    case xe::cpu::hir::INT64_TYPE: o.push_back(0x37); o.push_back(3); break;
    default: return false;
  }
  U32(o, 0); return true;
}

bool EmitStoreContext(const Instr* in, const ValueLocals& locals, std::vector<uint8_t>& o) {
  if (!in->src2.value || !IsInt(in->src2.value->type)) return false;
  o.push_back(0x20); o.push_back(0x00);
  if (!EmitValue(in->src2.value, locals, o)) return false;
  switch (in->src2.value->type) {
    case xe::cpu::hir::INT8_TYPE: o.push_back(0x3A); o.push_back(0); break;
    case xe::cpu::hir::INT16_TYPE: o.push_back(0x3B); o.push_back(1); break;
    case xe::cpu::hir::INT32_TYPE: o.push_back(0x36); o.push_back(2); break;
    case xe::cpu::hir::INT64_TYPE: o.push_back(0x37); o.push_back(3); break;
    default: return false;
  }
  U32(o, uint32_t(in->src1.offset)); return true;
}

bool BuildLocals(HIRBuilder* b, ValueLocals* locals, uint32_t* i32n, uint32_t* i64n) {
  std::vector<const Value*> a, q; std::unordered_set<const Value*> seen;
  for (auto* bl=b->first_block(); bl; bl=bl->next) for (auto* in=bl->instr_head; in; in=in->next) {
    if (!in->dest || !IsInt(in->dest->type) || !seen.insert(in->dest).second) continue;
    (IsI64(in->dest->type) ? q : a).push_back(in->dest);
  }
  uint32_t next=2; // ctx=0, result i64=1
  for (auto* v:a) (*locals)[v]={next++,v->type}; *i32n=uint32_t(a.size());
  for (auto* v:q) (*locals)[v]={next++,v->type}; *i64n=uint32_t(q.size());
  return true;
}

bool BuildModule(HIRBuilder* b) {
  ValueLocals locals; uint32_t i32n=0,i64n=0; BuildLocals(b,&locals,&i32n,&i64n);
  std::vector<uint8_t> body; uint32_t lowered=0; bool saw_memory=false, returned=false;
  for (auto* bl=b->first_block(); bl; bl=bl->next) {
    for (auto* in=bl->instr_head; in; in=in->next) {
      if (!in->opcode) return false;
      if (in->dest && IsInt(in->dest->type)) {
        if (!EmitProducer(in,locals,body)) return false;
        if (in->opcode->num==xe::cpu::hir::OPCODE_LOAD || in->opcode->num==xe::cpu::hir::OPCODE_LOAD_OFFSET || in->opcode->num==xe::cpu::hir::OPCODE_BYTE_SWAP) saw_memory=true;
        ++lowered; continue;
      }
      switch (in->opcode->num) {
        case xe::cpu::hir::OPCODE_NOP:
        case xe::cpu::hir::OPCODE_SOURCE_OFFSET:
        case xe::cpu::hir::OPCODE_CONTEXT_BARRIER: break;
        case xe::cpu::hir::OPCODE_STORE_CONTEXT:
          if (!EmitStoreContext(in,locals,body)) return false; ++lowered; break;
        case xe::cpu::hir::OPCODE_STORE:
        case xe::cpu::hir::OPCODE_STORE_OFFSET:
          if (!EmitStoreGuest(in,locals,body)) return false; saw_memory=true; ++lowered; break;
        case xe::cpu::hir::OPCODE_CALL_INDIRECT:
          if ((in->flags & xe::cpu::hir::CALL_POSSIBLE_RETURN)==0) return false;
          returned=true; break;
        case xe::cpu::hir::OPCODE_RETURN: returned=true; break;
        default: return false;
      }
      if (returned) break;
    }
    if (returned) break;
  }
  if (!saw_memory) return false;

  body.push_back(0x20); body.push_back(0x00); body.push_back(0x29); body.push_back(0x03);
  U32(body,uint32_t(offsetof(PPCContext,r)+3*sizeof(uint64_t)));
  body.push_back(0x21); body.push_back(0x01); body.push_back(0x20); body.push_back(0x01); body.push_back(0x0B);

  std::vector<uint8_t> m={0,0x61,0x73,0x6D,1,0,0,0};
  std::vector<uint8_t> t; U32(t,1);t.push_back(0x60);U32(t,1);t.push_back(0x7F);U32(t,1);t.push_back(0x7E);Section(m,1,t);
  std::vector<uint8_t> im;U32(im,1);Name(im,"env");Name(im,"memory");im.push_back(2);im.push_back(0);U32(im,0);Section(m,2,im);
  std::vector<uint8_t> f;U32(f,1);U32(f,0);Section(m,3,f);
  std::vector<uint8_t> e;U32(e,1);Name(e,"run");e.push_back(0);U32(e,0);Section(m,7,e);
  std::vector<uint8_t> fb; uint32_t groups=1+(i32n?1:0)+(i64n?1:0); U32(fb,groups);
  U32(fb,1);fb.push_back(0x7E); // result local 1
  if(i32n){U32(fb,i32n);fb.push_back(0x7F);} if(i64n){U32(fb,i64n);fb.push_back(0x7E);}
  fb.insert(fb.end(),body.begin(),body.end()); std::vector<uint8_t> c;U32(c,1);U32(c,uint32_t(fb.size()));c.insert(c.end(),fb.begin(),fb.end());Section(m,10,c);
  g_module=std::move(m);g_lowered=lowered;return true;
}
}

void ResetWasmBackendMemoryProbe(){g_status=0;g_lowered=0;g_module.clear();std::memset(g_context,0,sizeof(g_context));}
bool BuildWasmBackendMemoryProbe(HIRBuilder* b,uint8_t* host,uint32_t guest,uint32_t size){
  ResetWasmBackendMemoryProbe(); if(!b||!host||!size){g_status=1;return false;}
  g_guest_host_base=uint32_t(reinterpret_cast<uintptr_t>(host));g_guest_base=guest;g_guest_size=size;
  if(!BuildModule(b)){g_status=1;g_module.clear();g_lowered=0;return false;}g_status=2;return true;
}
uint32_t GetWasmBackendMemoryProbeStatus(){return g_status;}
uint32_t GetWasmBackendMemoryProbeModuleSize(){return uint32_t(g_module.size());}
uint32_t GetWasmBackendMemoryProbeLoweredInstructions(){return g_lowered;}
uint8_t* GetWasmBackendMemoryProbeModuleData(){return g_module.empty()?nullptr:g_module.data();}
uint8_t* GetWasmBackendMemoryProbeContextData(){return g_context;}
}
extern "C" {
uint32_t r360_wasm_backend_memory_status(){return render360::xenia_web::GetWasmBackendMemoryProbeStatus();}
uint32_t r360_wasm_backend_memory_module_ptr(){return uint32_t(reinterpret_cast<uintptr_t>(render360::xenia_web::GetWasmBackendMemoryProbeModuleData()));}
uint32_t r360_wasm_backend_memory_module_size(){return render360::xenia_web::GetWasmBackendMemoryProbeModuleSize();}
uint32_t r360_wasm_backend_memory_lowered_instructions(){return render360::xenia_web::GetWasmBackendMemoryProbeLoweredInstructions();}
uint32_t r360_wasm_backend_memory_context_ptr(){return uint32_t(reinterpret_cast<uintptr_t>(render360::xenia_web::GetWasmBackendMemoryProbeContextData()));}
}
