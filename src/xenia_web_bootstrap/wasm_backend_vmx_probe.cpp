#include "wasm_backend_vmx_probe.h"

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
uint32_t g_vector_ops = 0;
uint32_t g_native_simd_ops = 0;
uint32_t g_scalarized_lane_ops = 0;
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
bool IsVec(TypeName t) { return t == xe::cpu::hir::VEC128_TYPE; }

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
void Simd(std::vector<uint8_t>& o, uint32_t opcode) { o.push_back(0xFD); U32(o, opcode); }
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
bool EmitVec(const Value* v, const ValueLocals& locals, std::vector<uint8_t>& o) {
  if (!v || !IsVec(v->type) || v->IsConstant()) return false;
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
  if (offset) { if (!EmitAsI32(offset, locals, o)) return false; o.push_back(0x6A); }
  I32Const(o, static_cast<int32_t>(g_guest_base)); o.push_back(0x6B);
  I32Const(o, static_cast<int32_t>(g_guest_host_base)); o.push_back(0x6A);
  return true;
}

bool EmitScalarByteSwap(const Value* src, TypeName dest_type,
                        const ValueLocals& locals, std::vector<uint8_t>& o) {
  if (!src || !IsInt(src->type)) return false;
  if (dest_type == xe::cpu::hir::INT8_TYPE) return EmitAsI32(src, locals, o);
  if (dest_type == xe::cpu::hir::INT16_TYPE) {
    if (!EmitAsI32(src, locals, o)) return false; I32Const(o, 8); o.push_back(0x76);
    if (!EmitAsI32(src, locals, o)) return false; I32Const(o, 8); o.push_back(0x74);
    o.push_back(0x72); Mask(o, dest_type); return true;
  }
  if (dest_type == xe::cpu::hir::INT32_TYPE) {
    if (!EmitAsI32(src, locals, o)) return false; I32Const(o, 0xFF); o.push_back(0x71); I32Const(o,24); o.push_back(0x74);
    if (!EmitAsI32(src, locals, o)) return false; I32Const(o, 0xFF00); o.push_back(0x71); I32Const(o,8); o.push_back(0x74); o.push_back(0x72);
    if (!EmitAsI32(src, locals, o)) return false; I32Const(o,8); o.push_back(0x76); I32Const(o,0xFF00); o.push_back(0x71); o.push_back(0x72);
    if (!EmitAsI32(src, locals, o)) return false; I32Const(o,24); o.push_back(0x76); I32Const(o,0xFF); o.push_back(0x71); o.push_back(0x72);
    return true;
  }
  return false;
}

bool EmitVectorByteSwap(const Value* src, const ValueLocals& locals,
                        std::vector<uint8_t>& o) {
  if (!EmitVec(src, locals, o) || !EmitVec(src, locals, o)) return false;
  Simd(o, 0x0D);  // i8x16.shuffle
  for (int i = 15; i >= 0; --i) o.push_back(uint8_t(i));
  ++g_native_simd_ops;
  return true;
}

bool EmitScalarLoad(const Instr* in, const ValueLocals& locals, std::vector<uint8_t>& o) {
  const bool off = in->opcode->num == xe::cpu::hir::OPCODE_LOAD_OFFSET;
  if (in->flags) return false;
  if (!EmitGuestHostAddress(in->src1.value, off ? in->src2.value : nullptr, locals, o)) return false;
  switch (in->dest->type) {
    case xe::cpu::hir::INT8_TYPE: o.push_back(0x2D); o.push_back(0); break;
    case xe::cpu::hir::INT16_TYPE: o.push_back(0x2F); o.push_back(1); break;
    case xe::cpu::hir::INT32_TYPE: o.push_back(0x28); o.push_back(2); break;
    case xe::cpu::hir::INT64_TYPE: o.push_back(0x29); o.push_back(3); break;
    default: return false;
  }
  U32(o, 0); return true;
}

bool EmitVectorLoad(const Instr* in, const ValueLocals& locals, std::vector<uint8_t>& o) {
  const bool off = in->opcode->num == xe::cpu::hir::OPCODE_LOAD_OFFSET;
  if (in->flags) return false;
  if (!EmitGuestHostAddress(in->src1.value, off ? in->src2.value : nullptr, locals, o)) return false;
  Simd(o, 0x00); U32(o, 4); U32(o, 0);  // v128.load align=16 offset=0
  ++g_native_simd_ops;
  return true;
}

bool EmitLaneShift(const Instr* in, const ValueLocals& locals, std::vector<uint8_t>& o,
                   bool right) {
  TypeName part = static_cast<TypeName>(in->flags & 0xFFu);
  uint32_t lanes = 0, extract = 0, replace = 0, mask = 0;
  if (part == xe::cpu::hir::INT8_TYPE) { lanes=16; extract=0x16; replace=0x17; mask=7; }
  else if (part == xe::cpu::hir::INT16_TYPE) { lanes=8; extract=0x19; replace=0x1A; mask=15; }
  else if (part == xe::cpu::hir::INT32_TYPE) { lanes=4; extract=0x1B; replace=0x1C; mask=31; }
  else return false;
  Simd(o, 0x0C); for (uint32_t i=0;i<16;++i) o.push_back(0);  // zero accumulator
  ++g_native_simd_ops;
  for (uint32_t lane=0; lane<lanes; ++lane) {
    if (!EmitVec(in->src1.value, locals, o)) return false;
    Simd(o, extract); o.push_back(uint8_t(lane));
    if (!EmitVec(in->src2.value, locals, o)) return false;
    Simd(o, extract); o.push_back(uint8_t(lane));
    I32Const(o, int32_t(mask)); o.push_back(0x71);
    o.push_back(right ? 0x76 : 0x74);  // i32.shr_u / i32.shl
    Simd(o, replace); o.push_back(uint8_t(lane));
    g_native_simd_ops += 3;
    ++g_scalarized_lane_ops;
  }
  return true;
}

bool EmitVectorProducer(const Instr* in, const ValueLocals& locals, std::vector<uint8_t>& o) {
  if (!in || !in->dest || !IsVec(in->dest->type)) return false;
  bool ok=false;
  switch (in->opcode->num) {
    case xe::cpu::hir::OPCODE_LOAD_CONTEXT:
      o.push_back(0x20); o.push_back(0x00); Simd(o,0x00); U32(o,4); U32(o,uint32_t(in->src1.offset));
      ++g_native_simd_ops; ok=true; break;
    case xe::cpu::hir::OPCODE_LOAD:
    case xe::cpu::hir::OPCODE_LOAD_OFFSET:
      ok=EmitVectorLoad(in,locals,o); break;
    case xe::cpu::hir::OPCODE_ASSIGN:
    case xe::cpu::hir::OPCODE_CAST:
      ok=EmitVec(in->src1.value,locals,o); break;
    case xe::cpu::hir::OPCODE_BYTE_SWAP:
      ok=EmitVectorByteSwap(in->src1.value,locals,o); break;
    case xe::cpu::hir::OPCODE_VECTOR_ADD:
    case xe::cpu::hir::OPCODE_VECTOR_SUB: {
      TypeName part=static_cast<TypeName>(in->flags & 0xFFu);
      const uint32_t arithmetic_flags=uint32_t(in->flags)>>8;
      if (arithmetic_flags & xe::cpu::hir::ARITHMETIC_SATURATE) return false;
      if (!EmitVec(in->src1.value,locals,o)||!EmitVec(in->src2.value,locals,o)) return false;
      uint32_t op=0;
      if (in->opcode->num==xe::cpu::hir::OPCODE_VECTOR_ADD) {
        if(part==xe::cpu::hir::INT8_TYPE)op=0x6E; else if(part==xe::cpu::hir::INT16_TYPE)op=0x8E; else if(part==xe::cpu::hir::INT32_TYPE)op=0xAE; else return false;
      } else {
        if(part==xe::cpu::hir::INT8_TYPE)op=0x71; else if(part==xe::cpu::hir::INT16_TYPE)op=0x91; else if(part==xe::cpu::hir::INT32_TYPE)op=0xB1; else return false;
      }
      Simd(o,op); ++g_native_simd_ops; ok=true; break;
    }
    case xe::cpu::hir::OPCODE_AND:
    case xe::cpu::hir::OPCODE_OR:
    case xe::cpu::hir::OPCODE_XOR:
      if(!EmitVec(in->src1.value,locals,o)||!EmitVec(in->src2.value,locals,o))return false;
      Simd(o,in->opcode->num==xe::cpu::hir::OPCODE_AND?0x4E:in->opcode->num==xe::cpu::hir::OPCODE_OR?0x50:0x51);
      ++g_native_simd_ops; ok=true; break;
    case xe::cpu::hir::OPCODE_VECTOR_COMPARE_EQ: {
      TypeName part=static_cast<TypeName>(in->flags & 0xFFu);
      if(!EmitVec(in->src1.value,locals,o)||!EmitVec(in->src2.value,locals,o))return false;
      uint32_t op=part==xe::cpu::hir::INT8_TYPE?0x23:part==xe::cpu::hir::INT16_TYPE?0x2D:part==xe::cpu::hir::INT32_TYPE?0x37:0;
      if(!op)return false; Simd(o,op); ++g_native_simd_ops; ok=true; break;
    }
    case xe::cpu::hir::OPCODE_VECTOR_SHL:
      ok=EmitLaneShift(in,locals,o,false); break;
    case xe::cpu::hir::OPCODE_VECTOR_SHR:
      ok=EmitLaneShift(in,locals,o,true); break;
    default: return false;
  }
  if(!ok)return false;
  auto it=locals.find(in->dest);if(it==locals.end())return false;
  o.push_back(0x21);U32(o,it->second.index);++g_vector_ops;return true;
}

bool EmitScalarProducer(const Instr* in,const ValueLocals& locals,std::vector<uint8_t>& o){
  if(!in||!in->dest||!IsInt(in->dest->type))return false;bool ok=false;
  switch(in->opcode->num){
    case xe::cpu::hir::OPCODE_LOAD_CONTEXT:
      o.push_back(0x20);o.push_back(0);if(in->dest->type==xe::cpu::hir::INT8_TYPE){o.push_back(0x2D);o.push_back(0);}else if(in->dest->type==xe::cpu::hir::INT16_TYPE){o.push_back(0x2F);o.push_back(1);}else if(in->dest->type==xe::cpu::hir::INT32_TYPE){o.push_back(0x28);o.push_back(2);}else{o.push_back(0x29);o.push_back(3);}U32(o,uint32_t(in->src1.offset));ok=true;break;
    case xe::cpu::hir::OPCODE_ASSIGN:
    case xe::cpu::hir::OPCODE_CAST:
    case xe::cpu::hir::OPCODE_ZERO_EXTEND:
    case xe::cpu::hir::OPCODE_TRUNCATE:
      ok=EmitValue(in->src1.value,locals,o);if(ok&&IsI64(in->src1.value->type)&&!IsI64(in->dest->type))o.push_back(0xA7);if(ok&&!IsI64(in->src1.value->type)&&IsI64(in->dest->type))o.push_back(0xAD);if(ok)Mask(o,in->dest->type);break;
    case xe::cpu::hir::OPCODE_ADD:
    case xe::cpu::hir::OPCODE_AND:
      ok=EmitValue(in->src1.value,locals,o)&&EmitValue(in->src2.value,locals,o);if(ok)o.push_back(IsI64(in->dest->type)?(in->opcode->num==xe::cpu::hir::OPCODE_ADD?0x7C:0x83):(in->opcode->num==xe::cpu::hir::OPCODE_ADD?0x6A:0x71));break;
    case xe::cpu::hir::OPCODE_LOAD:
    case xe::cpu::hir::OPCODE_LOAD_OFFSET:
      ok=EmitScalarLoad(in,locals,o);break;
    case xe::cpu::hir::OPCODE_BYTE_SWAP:
      ok=EmitScalarByteSwap(in->src1.value,in->dest->type,locals,o);break;
    default:return false;
  }
  if(!ok)return false;auto it=locals.find(in->dest);if(it==locals.end())return false;o.push_back(0x21);U32(o,it->second.index);return true;
}

bool EmitStoreContext(const Instr* in,const ValueLocals& locals,std::vector<uint8_t>& o){
  if(!in->src2.value)return false;o.push_back(0x20);o.push_back(0);
  if(IsVec(in->src2.value->type)){
    if(!EmitVec(in->src2.value,locals,o))return false;Simd(o,0x0B);U32(o,4);U32(o,uint32_t(in->src1.offset));++g_native_simd_ops;return true;
  }
  if(!IsInt(in->src2.value->type)||!EmitValue(in->src2.value,locals,o))return false;
  switch(in->src2.value->type){case xe::cpu::hir::INT8_TYPE:o.push_back(0x3A);o.push_back(0);break;case xe::cpu::hir::INT16_TYPE:o.push_back(0x3B);o.push_back(1);break;case xe::cpu::hir::INT32_TYPE:o.push_back(0x36);o.push_back(2);break;case xe::cpu::hir::INT64_TYPE:o.push_back(0x37);o.push_back(3);break;default:return false;}U32(o,uint32_t(in->src1.offset));return true;
}
bool EmitStoreGuest(const Instr* in,const ValueLocals& locals,std::vector<uint8_t>& o){
  const bool off=in->opcode->num==xe::cpu::hir::OPCODE_STORE_OFFSET;const Value* address=in->src1.value;const Value* offset=off?in->src2.value:nullptr;const Value* value=off?in->src3.value:in->src2.value;if(!address||!value||in->flags)return false;
  if(!EmitGuestHostAddress(address,offset,locals,o))return false;
  if(IsVec(value->type)){if(!EmitVec(value,locals,o))return false;Simd(o,0x0B);U32(o,4);U32(o,0);++g_native_simd_ops;return true;}
  if(!IsInt(value->type)||!EmitValue(value,locals,o))return false;switch(value->type){case xe::cpu::hir::INT8_TYPE:o.push_back(0x3A);o.push_back(0);break;case xe::cpu::hir::INT16_TYPE:o.push_back(0x3B);o.push_back(1);break;case xe::cpu::hir::INT32_TYPE:o.push_back(0x36);o.push_back(2);break;case xe::cpu::hir::INT64_TYPE:o.push_back(0x37);o.push_back(3);break;default:return false;}U32(o,0);return true;
}

bool BuildLocals(HIRBuilder* b,ValueLocals* locals,uint32_t* i32n,uint32_t* i64n,uint32_t* v128n){
  std::vector<const Value*> a,q,v;std::unordered_set<const Value*> seen;
  for(auto* bl=b->first_block();bl;bl=bl->next)for(auto* in=bl->instr_head;in;in=in->next){if(!in->dest||!seen.insert(in->dest).second)continue;if(IsVec(in->dest->type))v.push_back(in->dest);else if(IsInt(in->dest->type))(IsI64(in->dest->type)?q:a).push_back(in->dest);}
  uint32_t next=1;for(auto* x:a)(*locals)[x]={next++,x->type};*i32n=uint32_t(a.size());for(auto* x:q)(*locals)[x]={next++,x->type};*i64n=uint32_t(q.size());for(auto* x:v)(*locals)[x]={next++,x->type};*v128n=uint32_t(v.size());return true;
}

bool BuildModule(HIRBuilder* b){
  ValueLocals locals;uint32_t i32n=0,i64n=0,v128n=0;BuildLocals(b,&locals,&i32n,&i64n,&v128n);std::vector<uint8_t> body;uint32_t lowered=0;bool saw_vec=false,returned=false;
  for(auto* bl=b->first_block();bl;bl=bl->next)for(auto* in=bl->instr_head;in;in=in->next){
    if(!in->opcode)return false;
    if(in->dest&&IsVec(in->dest->type)){if(!EmitVectorProducer(in,locals,body))return false;++lowered;saw_vec=true;continue;}
    if(in->dest&&IsInt(in->dest->type)){if(!EmitScalarProducer(in,locals,body))return false;++lowered;continue;}
    switch(in->opcode->num){
      case xe::cpu::hir::OPCODE_NOP:case xe::cpu::hir::OPCODE_SOURCE_OFFSET:case xe::cpu::hir::OPCODE_CONTEXT_BARRIER:case xe::cpu::hir::OPCODE_MEMORY_BARRIER:++lowered;break;
      case xe::cpu::hir::OPCODE_STORE_CONTEXT:if(!EmitStoreContext(in,locals,body))return false;++lowered;break;
      case xe::cpu::hir::OPCODE_STORE:case xe::cpu::hir::OPCODE_STORE_OFFSET:if(!EmitStoreGuest(in,locals,body))return false;++lowered;break;
      case xe::cpu::hir::OPCODE_SET_RETURN_ADDRESS:++lowered;break;
      case xe::cpu::hir::OPCODE_CALL_INDIRECT:
        if(!(in->flags & xe::cpu::hir::CALL_POSSIBLE_RETURN))return false;returned=true;++lowered;break;
      case xe::cpu::hir::OPCODE_RETURN:returned=true;++lowered;break;
      default:return false;
    }
  }
  if(!saw_vec||!returned)return false;
  I64Const(body,0);body.push_back(0x0B); // function end
  std::vector<uint8_t> m={0x00,0x61,0x73,0x6D,0x01,0x00,0x00,0x00};
  std::vector<uint8_t> type;U32(type,1);type.push_back(0x60);U32(type,1);type.push_back(0x7F);U32(type,1);type.push_back(0x7E);Section(m,1,type);
  std::vector<uint8_t> imp;U32(imp,1);Name(imp,"env");Name(imp,"memory");imp.push_back(0x02);imp.push_back(0x00);U32(imp,0);Section(m,2,imp);
  std::vector<uint8_t> fn;U32(fn,1);U32(fn,0);Section(m,3,fn);
  std::vector<uint8_t> ex;U32(ex,1);Name(ex,"run");ex.push_back(0x00);U32(ex,0);Section(m,7,ex);
  std::vector<uint8_t> code,fb;uint32_t groups=(i32n?1:0)+(i64n?1:0)+(v128n?1:0);U32(fb,groups);if(i32n){U32(fb,i32n);fb.push_back(0x7F);}if(i64n){U32(fb,i64n);fb.push_back(0x7E);}if(v128n){U32(fb,v128n);fb.push_back(0x7B);}fb.insert(fb.end(),body.begin(),body.end());U32(code,1);U32(code,uint32_t(fb.size()));code.insert(code.end(),fb.begin(),fb.end());Section(m,10,code);
  g_module=std::move(m);g_lowered=lowered;return true;
}
}  // namespace

void ResetWasmBackendVmxProbe(){g_status=0;g_lowered=0;g_vector_ops=0;g_native_simd_ops=0;g_scalarized_lane_ops=0;g_module.clear();std::memset(g_context,0,sizeof(g_context));}
bool BuildWasmBackendVmxProbe(HIRBuilder* b,uint8_t* host,uint32_t guest,uint32_t size){ResetWasmBackendVmxProbe();if(!b||!host||!size){g_status=1;return false;}g_guest_host_base=uint32_t(reinterpret_cast<uintptr_t>(host));g_guest_base=guest;g_guest_size=size;if(!BuildModule(b)){g_status=1;g_module.clear();g_lowered=0;return false;}g_status=2;return true;}
uint32_t GetWasmBackendVmxProbeStatus(){return g_status;}
uint32_t GetWasmBackendVmxProbeModuleSize(){return uint32_t(g_module.size());}
uint32_t GetWasmBackendVmxProbeLoweredInstructions(){return g_lowered;}
uint32_t GetWasmBackendVmxProbeModulePtr(){return g_module.empty()?0:uint32_t(reinterpret_cast<uintptr_t>(g_module.data()));}
uint32_t GetWasmBackendVmxProbeContextPtr(){return uint32_t(reinterpret_cast<uintptr_t>(g_context));}
uint32_t GetWasmBackendVmxProbeVectorOps(){return g_vector_ops;}
uint32_t GetWasmBackendVmxProbeNativeSimdOps(){return g_native_simd_ops;}
uint32_t GetWasmBackendVmxProbeScalarizedLaneOps(){return g_scalarized_lane_ops;}
}  // namespace render360::xenia_web

extern "C" {
uint32_t r360_wasm_backend_vmx_status(){return render360::xenia_web::GetWasmBackendVmxProbeStatus();}
uint32_t r360_wasm_backend_vmx_module_ptr(){return render360::xenia_web::GetWasmBackendVmxProbeModulePtr();}
uint32_t r360_wasm_backend_vmx_module_size(){return render360::xenia_web::GetWasmBackendVmxProbeModuleSize();}
uint32_t r360_wasm_backend_vmx_lowered_instructions(){return render360::xenia_web::GetWasmBackendVmxProbeLoweredInstructions();}
uint32_t r360_wasm_backend_vmx_context_ptr(){return render360::xenia_web::GetWasmBackendVmxProbeContextPtr();}
uint32_t r360_wasm_backend_vmx_vector_ops(){return render360::xenia_web::GetWasmBackendVmxProbeVectorOps();}
uint32_t r360_wasm_backend_vmx_native_simd_ops(){return render360::xenia_web::GetWasmBackendVmxProbeNativeSimdOps();}
uint32_t r360_wasm_backend_vmx_scalarized_lane_ops(){return render360::xenia_web::GetWasmBackendVmxProbeScalarizedLaneOps();}
}
