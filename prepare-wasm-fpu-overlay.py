#!/usr/bin/env python3
from pathlib import Path

root = Path(__file__).resolve().parent
src = root / 'src/xenia_web_bootstrap/wasm_backend_fpu_probe.cpp'
out = root / 'build/xenia-web-overlay/render360/wasm_backend_fpu_probe_v2.cpp'
text = src.read_text()

# The FPU backend originally grew from the straight-line arithmetic probe.  Keep
# the canonical source small while applying the hardened mixed-width/CFG layer
# in the generated build overlay.  Every replacement below is source-contract
# checked so upstream/local drift fails the build instead of silently changing
# semantics.

marker = '''bool EmitGuestHostAddress(const Value*address,const Value*offset,const ValueLocals&locals,std::vector<uint8_t>&o){'''
if marker not in text:
    raise SystemExit('FPU overlay: guest-address marker changed')
adapt = r'''bool EmitAdaptedIntValue(const Value*v,bool want_i64,bool sign_extend,const ValueLocals&locals,std::vector<uint8_t>&o){
  if(!v||!IsInt(v->type)||!EmitValue(v,locals,o))return false;
  const bool source_i64=IsI64(v->type);
  if(source_i64==want_i64)return true;
  if(want_i64)o.push_back(sign_extend?0xAC:0xAD);  // i64.extend_i32_s/u
  else o.push_back(0xA7);                           // i32.wrap_i64
  return true;
}
bool EmitTruthy(const Value*v,bool invert,const ValueLocals&locals,std::vector<uint8_t>&o){
  if(!v||!IsInt(v->type)||!EmitValue(v,locals,o))return false;
  o.push_back(IsI64(v->type)?0x50:0x45); // *.eqz
  if(!invert)o.push_back(0x45);           // eqz(eqz(x)) => truthy
  return true;
}
void EmitSetPc(std::vector<uint8_t>&o,uint32_t pc){I32Const(o,static_cast<int32_t>(pc));o.push_back(0x21);U32(o,1);}

'''
text = text.replace(marker, adapt + marker, 1)

convert_marker = '''    case xe::cpu::hir::OPCODE_ZERO_EXTEND:
    case xe::cpu::hir::OPCODE_TRUNCATE:
    case xe::cpu::hir::OPCODE_SIGN_EXTEND:'''
if convert_marker not in text:
    raise SystemExit('FPU overlay: conversion insertion marker changed')
convert_case = r'''    case xe::cpu::hir::OPCODE_CONVERT: {
      const TypeName st=in->src1.value?in->src1.value->type:xe::cpu::hir::INT8_TYPE;
      if(!in->src1.value||!EmitValue(in->src1.value,locals,o))break;
      if(IsF64(st)&&IsF32(dt)){o.push_back(0xB6);ok=true;}            // f32.demote_f64
      else if(IsF32(st)&&IsF64(dt)){o.push_back(0xBB);ok=true;}       // f64.promote_f32
      else if(IsF64(st)&&dt==xe::cpu::hir::INT32_TYPE){
        if(in->flags!=xe::cpu::hir::ROUND_TO_ZERO)return false;
        o.push_back(0xAA);ok=true;                                    // i32.trunc_f64_s
      }else if(IsF64(st)&&dt==xe::cpu::hir::INT64_TYPE){
        if(in->flags!=xe::cpu::hir::ROUND_TO_ZERO)return false;
        o.push_back(0xB0);ok=true;                                    // i64.trunc_f64_s
      }else if(st==xe::cpu::hir::INT32_TYPE&&IsF32(dt)){o.push_back(0xB2);ok=true;}
      else if(st==xe::cpu::hir::INT64_TYPE&&IsF32(dt)){o.push_back(0xB4);ok=true;}
      else if(st==xe::cpu::hir::INT32_TYPE&&IsF64(dt)){o.push_back(0xB7);ok=true;}
      else if(st==xe::cpu::hir::INT64_TYPE&&IsF64(dt)){o.push_back(0xB9);ok=true;}
      else return false;
      break;
    }
'''
text = text.replace(convert_marker, convert_case + convert_marker, 1)

old_shift = '''    case xe::cpu::hir::OPCODE_SHL:
    case xe::cpu::hir::OPCODE_SHR:
      if(!IsInt(dt)||!EmitValue(in->src1.value,locals,o)||!EmitValue(in->src2.value,locals,o))break;
      o.push_back(IsI64(dt)?(in->opcode->num==xe::cpu::hir::OPCODE_SHL?0x86:0x88):(in->opcode->num==xe::cpu::hir::OPCODE_SHL?0x74:0x76));ok=true;break;'''
new_shift = '''    case xe::cpu::hir::OPCODE_SHL:
    case xe::cpu::hir::OPCODE_SHR:
      if(!IsInt(dt)||!EmitAdaptedIntValue(in->src1.value,IsI64(dt),false,locals,o)||!EmitAdaptedIntValue(in->src2.value,IsI64(dt),false,locals,o))break;
      o.push_back(IsI64(dt)?(in->opcode->num==xe::cpu::hir::OPCODE_SHL?0x86:0x88):(in->opcode->num==xe::cpu::hir::OPCODE_SHL?0x74:0x76));ok=true;break;'''
if old_shift not in text:
    raise SystemExit('FPU overlay: mixed-width shift source contract changed')
text = text.replace(old_shift, new_shift, 1)

start = text.find('bool BuildLocals(')
end = text.find('\n}\n\nvoid ResetWasmBackendFpuProbe', start)
if start < 0 or end < 0:
    raise SystemExit('FPU overlay: BuildLocals/BuildModule boundary changed')

new_builder = r'''bool BuildLocals(HIRBuilder*b,ValueLocals*locals,std::vector<uint8_t>*groups){
  std::vector<const Value*>i32s,i64s,f32s,f64s;std::unordered_set<const Value*>seen;
  for(auto*bl=b->first_block();bl;bl=bl->next)for(auto*in=bl->instr_head;in;in=in->next){
    if(!in->dest||!seen.insert(in->dest).second)continue;
    if(IsI64(in->dest->type))i64s.push_back(in->dest);else if(IsInt(in->dest->type))i32s.push_back(in->dest);
    else if(IsF32(in->dest->type))f32s.push_back(in->dest);else if(IsF64(in->dest->type))f64s.push_back(in->dest);
    else return false;
  }
  // run(ctx): ctx=0, dispatcher pc=1, safety budget=2, HIR locals begin at 3.
  uint32_t next=3;
  for(auto*v:i32s)(*locals)[v]={next++,v->type};for(auto*v:i64s)(*locals)[v]={next++,v->type};
  for(auto*v:f32s)(*locals)[v]={next++,v->type};for(auto*v:f64s)(*locals)[v]={next++,v->type};
  uint32_t ng=1+(i64s.empty()?0:1)+(f32s.empty()?0:1)+(f64s.empty()?0:1);U32(*groups,ng);
  U32(*groups,uint32_t(2+i32s.size()));groups->push_back(0x7F);
  if(!i64s.empty()){U32(*groups,uint32_t(i64s.size()));groups->push_back(0x7E);}
  if(!f32s.empty()){U32(*groups,uint32_t(f32s.size()));groups->push_back(0x7D);}
  if(!f64s.empty()){U32(*groups,uint32_t(f64s.size()));groups->push_back(0x7C);}
  return true;
}

bool BuildModule(HIRBuilder*b){
  if(!b||!b->first_block())return false;
  ValueLocals locals;std::vector<uint8_t>decls;if(!BuildLocals(b,&locals,&decls))return false;
  std::unordered_map<const xe::cpu::hir::Block*,uint32_t>indices;uint32_t bi=0;
  for(auto*bl=b->first_block();bl;bl=bl->next)indices[bl]=bi++;

  std::vector<uint8_t>body;uint32_t lowered=0;bool saw_fpu=false,saw_return=false;
  EmitSetPc(body,0);I32Const(body,100000);body.push_back(0x21);U32(body,2);
  body.push_back(0x02);body.push_back(0x40); // outer block
  body.push_back(0x03);body.push_back(0x40); // dispatcher loop
  // Trap rather than spin forever if malformed HIR ever escapes the critic.
  body.push_back(0x20);U32(body,2);body.push_back(0x45);body.push_back(0x04);body.push_back(0x40);body.push_back(0x00);body.push_back(0x0B);
  body.push_back(0x20);U32(body,2);I32Const(body,1);body.push_back(0x6B);body.push_back(0x21);U32(body,2);

  for(auto*bl=b->first_block();bl;bl=bl->next){
    auto bit=indices.find(bl);if(bit==indices.end())return false;
    body.push_back(0x20);U32(body,1);I32Const(body,static_cast<int32_t>(bit->second));body.push_back(0x46);
    body.push_back(0x04);body.push_back(0x40); // if pc==this block
    bool terminated=false;
    for(auto*in=bl->instr_head;in;in=in->next){
      if(!in->opcode)return false;
      if(in->dest){
        if(!EmitProducer(in,locals,body))return false;
        if(IsF32(in->dest->type)||IsF64(in->dest->type)||in->opcode->num==xe::cpu::hir::OPCODE_CAST||in->opcode->num==xe::cpu::hir::OPCODE_CONVERT)saw_fpu=true;
        ++lowered;continue;
      }
      switch(in->opcode->num){
        case xe::cpu::hir::OPCODE_NOP:case xe::cpu::hir::OPCODE_SOURCE_OFFSET:
        case xe::cpu::hir::OPCODE_CONTEXT_BARRIER:case xe::cpu::hir::OPCODE_MEMORY_BARRIER:
        case xe::cpu::hir::OPCODE_SET_RETURN_ADDRESS:break;
        case xe::cpu::hir::OPCODE_STORE_CONTEXT:
          if(!EmitStoreContextOrdered(in,locals,body))return false;++lowered;break;
        case xe::cpu::hir::OPCODE_STORE:case xe::cpu::hir::OPCODE_STORE_OFFSET:
          if(!EmitStoreGuest(in,locals,body))return false;++lowered;break;
        case xe::cpu::hir::OPCODE_BRANCH:{
          if(!in->src1.label||!in->src1.label->block)return false;auto t=indices.find(in->src1.label->block);if(t==indices.end())return false;
          EmitSetPc(body,t->second);body.push_back(0x0C);U32(body,1);++lowered;terminated=true;break;
        }
        case xe::cpu::hir::OPCODE_BRANCH_TRUE:case xe::cpu::hir::OPCODE_BRANCH_FALSE:{
          if(!in->src1.value||!in->src2.label||!in->src2.label->block)return false;auto t=indices.find(in->src2.label->block);if(t==indices.end())return false;
          const bool invert=in->opcode->num==xe::cpu::hir::OPCODE_BRANCH_FALSE;
          if(!EmitTruthy(in->src1.value,invert,locals,body))return false;
          body.push_back(0x04);body.push_back(0x40);EmitSetPc(body,t->second);body.push_back(0x0C);U32(body,2);body.push_back(0x0B);
          ++lowered;break; // not-taken continues with the next HIR instruction
        }
        case xe::cpu::hir::OPCODE_RETURN:
          body.push_back(0x0C);U32(body,2);++lowered;terminated=true;saw_return=true;break;
        case xe::cpu::hir::OPCODE_CALL_INDIRECT:
          if(!(in->flags&xe::cpu::hir::CALL_POSSIBLE_RETURN))return false;
          body.push_back(0x0C);U32(body,2);++lowered;terminated=true;saw_return=true;break;
        default:return false;
      }
      if(terminated)break;
    }
    if(!terminated){
      if(bl->next){auto n=indices.find(bl->next);if(n==indices.end())return false;EmitSetPc(body,n->second);body.push_back(0x0C);U32(body,1);}
      else {body.push_back(0x0C);U32(body,2);}
    }
    body.push_back(0x0B); // pc block if
  }
  // No pc match: exit rather than spin. Normal return paths also branch here.
  body.push_back(0x0C);U32(body,1);body.push_back(0x0B);body.push_back(0x0B);
  body.push_back(0x20);body.push_back(0x00);body.push_back(0x29);body.push_back(0x03);
  U32(body,uint32_t(offsetof(PPCContext,r)+3*sizeof(uint64_t)));body.push_back(0x0B);
  if(!saw_return||!saw_fpu)return false;

  std::vector<uint8_t>m={0,0x61,0x73,0x6D,1,0,0,0};std::vector<uint8_t>type;U32(type,1);type.push_back(0x60);U32(type,1);type.push_back(0x7F);U32(type,1);type.push_back(0x7E);Section(m,1,type);
  std::vector<uint8_t>imp;U32(imp,1);Name(imp,"env");Name(imp,"memory");imp.push_back(0x02);imp.push_back(0);U32(imp,0);Section(m,2,imp);
  std::vector<uint8_t>fn;U32(fn,1);U32(fn,0);Section(m,3,fn);std::vector<uint8_t>ex;U32(ex,1);Name(ex,"run");ex.push_back(0);U32(ex,0);Section(m,7,ex);
  std::vector<uint8_t>fb=decls;fb.insert(fb.end(),body.begin(),body.end());std::vector<uint8_t>code;U32(code,1);U32(code,uint32_t(fb.size()));code.insert(code.end(),fb.begin(),fb.end());Section(m,10,code);
  g_module=std::move(m);g_lowered=lowered;return true;
}
'''
text = text[:start] + new_builder + text[end:]

out.parent.mkdir(parents=True, exist_ok=True)
out.write_text(text)
print(f'FPU backend overlay: {src.relative_to(root)} -> {out.relative_to(root)}')
