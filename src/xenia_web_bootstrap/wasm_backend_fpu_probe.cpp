#include "wasm_backend_fpu_probe.h"

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
bool IsF32(TypeName t) { return t == xe::cpu::hir::FLOAT32_TYPE; }
bool IsF64(TypeName t) { return t == xe::cpu::hir::FLOAT64_TYPE; }

void U32(std::vector<uint8_t>& o, uint32_t v) {
  do { uint8_t b=uint8_t(v&0x7F); v>>=7; if(v)b|=0x80; o.push_back(b); } while(v);
}
void I32(std::vector<uint8_t>& o, int32_t v) {
  bool more=true; while(more){uint8_t b=uint8_t(v&0x7F); bool s=(b&0x40)!=0; v>>=7;
    more=!((v==0&&!s)||(v==-1&&s)); if(more)b|=0x80; o.push_back(b);}
}
void I64(std::vector<uint8_t>& o, int64_t v) {
  bool more=true; while(more){uint8_t b=uint8_t(v&0x7F); bool s=(b&0x40)!=0; v>>=7;
    more=!((v==0&&!s)||(v==-1&&s)); if(more)b|=0x80; o.push_back(b);}
}
void Name(std::vector<uint8_t>& o,const char*s){uint32_t n=uint32_t(std::strlen(s));U32(o,n);o.insert(o.end(),s,s+n);}
void Section(std::vector<uint8_t>&m,uint8_t id,const std::vector<uint8_t>&p){m.push_back(id);U32(m,uint32_t(p.size()));m.insert(m.end(),p.begin(),p.end());}
void I32Const(std::vector<uint8_t>&o,int32_t v){o.push_back(0x41);I32(o,v);}
void I64Const(std::vector<uint8_t>&o,int64_t v){o.push_back(0x42);I64(o,v);}
void F32Const(std::vector<uint8_t>&o,float v){o.push_back(0x43);uint32_t b;std::memcpy(&b,&v,4);for(int i=0;i<4;i++)o.push_back(uint8_t(b>>(8*i)));}
void F64Const(std::vector<uint8_t>&o,double v){o.push_back(0x44);uint64_t b;std::memcpy(&b,&v,8);for(int i=0;i<8;i++)o.push_back(uint8_t(b>>(8*i)));}
void Mask(std::vector<uint8_t>&o,TypeName t){if(t==xe::cpu::hir::INT8_TYPE){I32Const(o,0xFF);o.push_back(0x71);}else if(t==xe::cpu::hir::INT16_TYPE){I32Const(o,0xFFFF);o.push_back(0x71);}}

bool EmitValue(const Value*v,const ValueLocals&locals,std::vector<uint8_t>&o){
  if(!v) return false;
  if(v->IsConstant()){
    if(IsI64(v->type)) I64Const(o,v->constant.i64);
    else if(IsInt(v->type)){I32Const(o,v->constant.i32);Mask(o,v->type);}
    else if(IsF32(v->type)) F32Const(o,v->constant.f32);
    else if(IsF64(v->type)) F64Const(o,v->constant.f64);
    else return false;
    return true;
  }
  auto it=locals.find(v); if(it==locals.end()) return false;
  o.push_back(0x20); U32(o,it->second.index); return true;
}
bool EmitAsI32(const Value*v,const ValueLocals&locals,std::vector<uint8_t>&o){
  if(!v||!IsInt(v->type)||!EmitValue(v,locals,o)) return false;
  if(IsI64(v->type)) o.push_back(0xA7); return true;
}
bool EmitGuestHostAddress(const Value*address,const Value*offset,const ValueLocals&locals,std::vector<uint8_t>&o){
  if(!EmitAsI32(address,locals,o)) return false;
  if(offset){if(!EmitAsI32(offset,locals,o))return false;o.push_back(0x6A);}
  I32Const(o,static_cast<int32_t>(g_guest_base));o.push_back(0x6B);
  I32Const(o,static_cast<int32_t>(g_guest_host_base));o.push_back(0x6A);return true;
}

bool EmitByteSwap(const Value*src,TypeName type,const ValueLocals&locals,std::vector<uint8_t>&o){
  if(!src||!IsInt(src->type)||src->type!=type) return false;
  if(type==xe::cpu::hir::INT32_TYPE){
    for(int i=0;i<4;i++){
      if(!EmitValue(src,locals,o))return false;
      I32Const(o,8*i);o.push_back(0x76);I32Const(o,0xFF);o.push_back(0x71);
      int sh=8*(3-i); if(sh){I32Const(o,sh);o.push_back(0x74);} if(i)o.push_back(0x72);
    } return true;
  }
  if(type==xe::cpu::hir::INT64_TYPE){
    for(int i=0;i<8;i++){
      if(!EmitValue(src,locals,o))return false;
      I64Const(o,8*i);o.push_back(0x88);I64Const(o,0xFF);o.push_back(0x83);
      int sh=8*(7-i); if(sh){I64Const(o,sh);o.push_back(0x86);} if(i)o.push_back(0x84);
    } return true;
  }
  return false;
}

bool EmitLoad(const Instr*in,const ValueLocals&locals,std::vector<uint8_t>&o){
  const Value*offset=in->opcode->num==xe::cpu::hir::OPCODE_LOAD_OFFSET?in->src2.value:nullptr;
  if(!EmitGuestHostAddress(in->src1.value,offset,locals,o))return false;
  switch(in->dest->type){
    case xe::cpu::hir::INT32_TYPE:o.push_back(0x28);o.push_back(2);break;
    case xe::cpu::hir::INT64_TYPE:o.push_back(0x29);o.push_back(3);break;
    case xe::cpu::hir::FLOAT32_TYPE:o.push_back(0x2A);o.push_back(2);break;
    case xe::cpu::hir::FLOAT64_TYPE:o.push_back(0x2B);o.push_back(3);break;
    default:return false;
  }
  U32(o,0); return in->flags==0;
}

bool EmitProducer(const Instr*in,const ValueLocals&locals,std::vector<uint8_t>&o){
  if(!in||!in->opcode||!in->dest) return false;
  const TypeName dt=in->dest->type; bool ok=false;
  switch(in->opcode->num){
    case xe::cpu::hir::OPCODE_LOAD_CONTEXT:
      o.push_back(0x20);o.push_back(0x00);
      if(dt==xe::cpu::hir::INT8_TYPE){o.push_back(0x2D);o.push_back(0);}
      else if(dt==xe::cpu::hir::INT16_TYPE){o.push_back(0x2F);o.push_back(1);}
      else if(dt==xe::cpu::hir::INT32_TYPE){o.push_back(0x28);o.push_back(2);}
      else if(dt==xe::cpu::hir::INT64_TYPE){o.push_back(0x29);o.push_back(3);}
      else if(dt==xe::cpu::hir::FLOAT32_TYPE){o.push_back(0x2A);o.push_back(2);}
      else if(dt==xe::cpu::hir::FLOAT64_TYPE){o.push_back(0x2B);o.push_back(3);}
      else return false;
      U32(o,uint32_t(in->src1.offset));ok=true;break;
    case xe::cpu::hir::OPCODE_ASSIGN:
      ok=EmitValue(in->src1.value,locals,o);break;
    case xe::cpu::hir::OPCODE_CAST:
      if(!EmitValue(in->src1.value,locals,o))break;
      if(in->src1.value->type==xe::cpu::hir::INT64_TYPE&&dt==xe::cpu::hir::FLOAT64_TYPE)o.push_back(0xBF);
      else if(in->src1.value->type==xe::cpu::hir::FLOAT64_TYPE&&dt==xe::cpu::hir::INT64_TYPE)o.push_back(0xBD);
      else if(in->src1.value->type==dt){}
      else return false; ok=true;break;
    case xe::cpu::hir::OPCODE_ZERO_EXTEND:
    case xe::cpu::hir::OPCODE_TRUNCATE:
    case xe::cpu::hir::OPCODE_SIGN_EXTEND:
      if(!IsInt(dt)||!IsInt(in->src1.value->type)||!EmitValue(in->src1.value,locals,o))break;
      if(IsI64(in->src1.value->type)&&!IsI64(dt))o.push_back(0xA7);
      else if(!IsI64(in->src1.value->type)&&IsI64(dt))o.push_back(in->opcode->num==xe::cpu::hir::OPCODE_SIGN_EXTEND?0xAC:0xAD);
      Mask(o,dt);ok=true;break;
    case xe::cpu::hir::OPCODE_ADD:
    case xe::cpu::hir::OPCODE_SUB:
    case xe::cpu::hir::OPCODE_MUL:
    case xe::cpu::hir::OPCODE_DIV:
      if(!EmitValue(in->src1.value,locals,o)||!EmitValue(in->src2.value,locals,o))break;
      if(IsF64(dt)) o.push_back(in->opcode->num==xe::cpu::hir::OPCODE_ADD?0xA0:in->opcode->num==xe::cpu::hir::OPCODE_SUB?0xA1:in->opcode->num==xe::cpu::hir::OPCODE_MUL?0xA2:0xA3);
      else if(IsF32(dt)) o.push_back(in->opcode->num==xe::cpu::hir::OPCODE_ADD?0x92:in->opcode->num==xe::cpu::hir::OPCODE_SUB?0x93:in->opcode->num==xe::cpu::hir::OPCODE_MUL?0x94:0x95);
      else if(IsI64(dt)) o.push_back(in->opcode->num==xe::cpu::hir::OPCODE_ADD?0x7C:0x7D);
      else if(IsInt(dt)) o.push_back(in->opcode->num==xe::cpu::hir::OPCODE_ADD?0x6A:0x6B);
      else return false;ok=true;break;
    case xe::cpu::hir::OPCODE_AND:
    case xe::cpu::hir::OPCODE_OR:
    case xe::cpu::hir::OPCODE_XOR:
      if(!IsInt(dt)||!EmitValue(in->src1.value,locals,o)||!EmitValue(in->src2.value,locals,o))break;
      o.push_back(IsI64(dt)?(in->opcode->num==xe::cpu::hir::OPCODE_AND?0x83:in->opcode->num==xe::cpu::hir::OPCODE_OR?0x84:0x85):(in->opcode->num==xe::cpu::hir::OPCODE_AND?0x71:in->opcode->num==xe::cpu::hir::OPCODE_OR?0x72:0x73));ok=true;break;
    case xe::cpu::hir::OPCODE_SHL:
    case xe::cpu::hir::OPCODE_SHR:
      if(!IsInt(dt)||!EmitValue(in->src1.value,locals,o)||!EmitValue(in->src2.value,locals,o))break;
      o.push_back(IsI64(dt)?(in->opcode->num==xe::cpu::hir::OPCODE_SHL?0x86:0x88):(in->opcode->num==xe::cpu::hir::OPCODE_SHL?0x74:0x76));ok=true;break;
    case xe::cpu::hir::OPCODE_IS_NAN:
      if(!(IsF64(in->src1.value->type)||IsF32(in->src1.value->type))||!IsInt(dt))break;
      if(!EmitValue(in->src1.value,locals,o)||!EmitValue(in->src1.value,locals,o))break;
      o.push_back(IsF64(in->src1.value->type)?0x62:0x5C);ok=true;break;
    case xe::cpu::hir::OPCODE_COMPARE_EQ:
    case xe::cpu::hir::OPCODE_COMPARE_NE:
    case xe::cpu::hir::OPCODE_COMPARE_SLT:
    case xe::cpu::hir::OPCODE_COMPARE_SLE:
    case xe::cpu::hir::OPCODE_COMPARE_SGT:
    case xe::cpu::hir::OPCODE_COMPARE_SGE: {
      TypeName st=in->src1.value->type;
      if(!EmitValue(in->src1.value,locals,o)||!EmitValue(in->src2.value,locals,o))break;
      if(IsF64(st)) o.push_back(in->opcode->num==xe::cpu::hir::OPCODE_COMPARE_EQ?0x61:in->opcode->num==xe::cpu::hir::OPCODE_COMPARE_NE?0x62:in->opcode->num==xe::cpu::hir::OPCODE_COMPARE_SLT?0x63:in->opcode->num==xe::cpu::hir::OPCODE_COMPARE_SGT?0x64:in->opcode->num==xe::cpu::hir::OPCODE_COMPARE_SLE?0x65:0x66);
      else return false; ok=true; break; }
    case xe::cpu::hir::OPCODE_SELECT:
      if(!EmitValue(in->src2.value,locals,o)||!EmitValue(in->src3.value,locals,o)||!EmitValue(in->src1.value,locals,o))break;
      o.push_back(0x1B);ok=true;break;
    case xe::cpu::hir::OPCODE_LOAD:
    case xe::cpu::hir::OPCODE_LOAD_OFFSET:
      ok=EmitLoad(in,locals,o);break;
    case xe::cpu::hir::OPCODE_BYTE_SWAP:
      ok=EmitByteSwap(in->src1.value,dt,locals,o);break;
    default:return false;
  }
  if(!ok)return false; auto it=locals.find(in->dest);if(it==locals.end())return false;
  o.push_back(0x21);U32(o,it->second.index);return true;
}

bool EmitStoreContext(const Instr*in,const ValueLocals&locals,std::vector<uint8_t>&o){
  const Value*v=in->src2.value;if(!v||!EmitValue(v,locals,o))return false;
  // address must precede value, so re-emit in correct order using a scratch is
  // avoided by rebuilding: remove is impossible; use local tee not available.
  // Caller uses this helper only through the ordered sequence below.
  return false;
}

bool EmitStoreContextOrdered(const Instr*in,const ValueLocals&locals,std::vector<uint8_t>&o){
  const Value*v=in->src2.value;if(!v)return false;o.push_back(0x20);o.push_back(0x00);if(!EmitValue(v,locals,o))return false;
  if(v->type==xe::cpu::hir::INT8_TYPE){o.push_back(0x3A);o.push_back(0);}
  else if(v->type==xe::cpu::hir::INT16_TYPE){o.push_back(0x3B);o.push_back(1);}
  else if(v->type==xe::cpu::hir::INT32_TYPE){o.push_back(0x36);o.push_back(2);}
  else if(v->type==xe::cpu::hir::INT64_TYPE){o.push_back(0x37);o.push_back(3);}
  else if(v->type==xe::cpu::hir::FLOAT32_TYPE){o.push_back(0x38);o.push_back(2);}
  else if(v->type==xe::cpu::hir::FLOAT64_TYPE){o.push_back(0x39);o.push_back(3);}
  else return false;U32(o,uint32_t(in->src1.offset));return true;
}
bool EmitStoreGuest(const Instr*in,const ValueLocals&locals,std::vector<uint8_t>&o){
  bool off=in->opcode->num==xe::cpu::hir::OPCODE_STORE_OFFSET;const Value*addr=in->src1.value;const Value*offset=off?in->src2.value:nullptr;const Value*v=off?in->src3.value:in->src2.value;
  if(!v||in->flags||!EmitGuestHostAddress(addr,offset,locals,o)||!EmitValue(v,locals,o))return false;
  if(v->type==xe::cpu::hir::INT32_TYPE){o.push_back(0x36);o.push_back(2);}
  else if(v->type==xe::cpu::hir::INT64_TYPE){o.push_back(0x37);o.push_back(3);}
  else if(v->type==xe::cpu::hir::FLOAT32_TYPE){o.push_back(0x38);o.push_back(2);}
  else if(v->type==xe::cpu::hir::FLOAT64_TYPE){o.push_back(0x39);o.push_back(3);}
  else return false;U32(o,0);return true;
}

bool BuildLocals(HIRBuilder*b,ValueLocals*locals,std::vector<uint8_t>*groups){
  std::vector<const Value*> i32s,i64s,f32s,f64s;std::unordered_set<const Value*>seen;
  for(auto*bl=b->first_block();bl;bl=bl->next)for(auto*in=bl->instr_head;in;in=in->next){if(!in->dest||!seen.insert(in->dest).second)continue;
    if(IsI64(in->dest->type))i64s.push_back(in->dest);else if(IsInt(in->dest->type))i32s.push_back(in->dest);else if(IsF32(in->dest->type))f32s.push_back(in->dest);else if(IsF64(in->dest->type))f64s.push_back(in->dest);}
  uint32_t next=2; // ctx=0, result=1(i64)
  for(auto*v:i32s)(*locals)[v]={next++,v->type};for(auto*v:i64s)(*locals)[v]={next++,v->type};for(auto*v:f32s)(*locals)[v]={next++,v->type};for(auto*v:f64s)(*locals)[v]={next++,v->type};
  uint32_t ng=(i32s.empty()?0:1)+(i64s.empty()?0:1)+(f32s.empty()?0:1)+(f64s.empty()?0:1);U32(*groups,ng);
  if(!i32s.empty()){U32(*groups,uint32_t(i32s.size()));groups->push_back(0x7F);}if(!i64s.empty()){U32(*groups,uint32_t(i64s.size()));groups->push_back(0x7E);}if(!f32s.empty()){U32(*groups,uint32_t(f32s.size()));groups->push_back(0x7D);}if(!f64s.empty()){U32(*groups,uint32_t(f64s.size()));groups->push_back(0x7C);}return true;
}

bool BuildModule(HIRBuilder*b){
  ValueLocals locals;std::vector<uint8_t>decls;BuildLocals(b,&locals,&decls);std::vector<uint8_t>body;uint32_t lowered=0;bool saw_fpu=false,ret=false;
  for(auto*bl=b->first_block();bl&&!ret;bl=bl->next)for(auto*in=bl->instr_head;in;in=in->next){if(!in->opcode)return false;
    if(in->dest){if(!EmitProducer(in,locals,body))return false;if(IsF32(in->dest->type)||IsF64(in->dest->type)||in->opcode->num==xe::cpu::hir::OPCODE_CAST)saw_fpu=true;++lowered;continue;}
    switch(in->opcode->num){
      case xe::cpu::hir::OPCODE_NOP:case xe::cpu::hir::OPCODE_SOURCE_OFFSET:case xe::cpu::hir::OPCODE_CONTEXT_BARRIER:case xe::cpu::hir::OPCODE_SET_RETURN_ADDRESS:break;
      case xe::cpu::hir::OPCODE_STORE_CONTEXT:if(!EmitStoreContextOrdered(in,locals,body))return false;++lowered;break;
      case xe::cpu::hir::OPCODE_STORE:case xe::cpu::hir::OPCODE_STORE_OFFSET:if(!EmitStoreGuest(in,locals,body))return false;++lowered;break;
      case xe::cpu::hir::OPCODE_CALL_INDIRECT:
        if(!(in->flags&xe::cpu::hir::CALL_POSSIBLE_RETURN))return false;
        body.push_back(0x20);body.push_back(0x00);body.push_back(0x29);body.push_back(0x03);U32(body,uint32_t(offsetof(PPCContext,r)+3*sizeof(uint64_t)));body.push_back(0x0F);ret=true;++lowered;break;
      default:return false;
    } if(ret)break;
  }
  if(!ret||!saw_fpu)return false;body.push_back(0x0B);
  std::vector<uint8_t>m={0,0x61,0x73,0x6D,1,0,0,0};std::vector<uint8_t>type;U32(type,1);type.push_back(0x60);U32(type,1);type.push_back(0x7F);U32(type,1);type.push_back(0x7E);Section(m,1,type);
  std::vector<uint8_t>imp;U32(imp,1);Name(imp,"env");Name(imp,"memory");imp.push_back(0x02);imp.push_back(0);U32(imp,0);Section(m,2,imp);
  std::vector<uint8_t>fn;U32(fn,1);U32(fn,0);Section(m,3,fn);std::vector<uint8_t>ex;U32(ex,1);Name(ex,"run");ex.push_back(0);U32(ex,0);Section(m,7,ex);
  std::vector<uint8_t>fb=decls;fb.insert(fb.end(),body.begin(),body.end());std::vector<uint8_t>code;U32(code,1);U32(code,uint32_t(fb.size()));code.insert(code.end(),fb.begin(),fb.end());Section(m,10,code);
  g_module=std::move(m);g_lowered=lowered;return true;
}
}

void ResetWasmBackendFpuProbe(){g_status=0;g_lowered=0;g_module.clear();std::memset(g_context,0,sizeof(g_context));g_guest_host_base=g_guest_base=g_guest_size=0;}
bool BuildWasmBackendFpuProbe(HIRBuilder*b,uint8_t*host,uint32_t base,uint32_t size){ResetWasmBackendFpuProbe();if(!b||!host||!size){g_status=1;return false;}g_guest_host_base=uint32_t(reinterpret_cast<uintptr_t>(host));g_guest_base=base;g_guest_size=size;if(!BuildModule(b)){g_status=1;g_module.clear();g_lowered=0;return false;}g_status=2;return true;}
uint32_t GetWasmBackendFpuProbeStatus(){return g_status;}uint32_t GetWasmBackendFpuProbeModuleSize(){return uint32_t(g_module.size());}uint32_t GetWasmBackendFpuProbeLoweredInstructions(){return g_lowered;}uint8_t*GetWasmBackendFpuProbeModuleData(){return g_module.empty()?nullptr:g_module.data();}uint8_t*GetWasmBackendFpuProbeContextData(){return g_context;}
}

extern "C" {
uint32_t r360_wasm_backend_fpu_status(){return render360::xenia_web::GetWasmBackendFpuProbeStatus();}
uint32_t r360_wasm_backend_fpu_module_ptr(){return uint32_t(reinterpret_cast<uintptr_t>(render360::xenia_web::GetWasmBackendFpuProbeModuleData()));}
uint32_t r360_wasm_backend_fpu_module_size(){return render360::xenia_web::GetWasmBackendFpuProbeModuleSize();}
uint32_t r360_wasm_backend_fpu_lowered_instructions(){return render360::xenia_web::GetWasmBackendFpuProbeLoweredInstructions();}
uint32_t r360_wasm_backend_fpu_context_ptr(){return uint32_t(reinterpret_cast<uintptr_t>(render360::xenia_web::GetWasmBackendFpuProbeContextData()));}
}
