#!/usr/bin/env python3
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]

def r(p): return (ROOT/p).read_text()
def w(p,s): (ROOT/p).write_text(s)
def one(s,a,b,label):
    if s.count(a)!=1: raise SystemExit(f'{label}: expected 1 anchor, got {s.count(a)}')
    return s.replace(a,b,1)
def between(s,a,b,x,label):
    i=s.find(a); j=s.find(b,i)
    if i<0 or j<0: raise SystemExit(f'{label}: boundary missing')
    return s[:i]+x+s[j:]

# Keep Xbox PE .pdata runtime-function bounds after the prepared image is decoded.
h=r('src/xenia_web_bootstrap/xex_pe_guest_loader.h')
h=one(h,'uint32_t PreparedPeGuestRawBytes();\n','''uint32_t PreparedPeGuestRawBytes();
bool PreparedPeGuestFindRuntimeFunction(uint32_t address, uint32_t* begin,
                                        uint32_t* end_exclusive,
                                        uint32_t* prolog_bytes);
''','loader header')
w('src/xenia_web_bootstrap/xex_pe_guest_loader.h',h)

s=r('src/xenia_web_bootstrap/xex_pe_guest_loader.cpp')
s=one(s,'#include <cstdint>\n#include <map>\n','#include <algorithm>\n#include <cstdint>\n#include <cstring>\n#include <map>\n#include <vector>\n','loader includes')
s=one(s,'uint32_t g_raw_bytes = 0;\n\nbool Fail(uint32_t status) {',r'''uint32_t g_raw_bytes = 0;

struct PeRuntimeFunction { uint32_t begin=0,end=0,prolog_bytes=0; };
std::vector<PeRuntimeFunction> g_runtime_functions;
uint32_t ReadBe32(const uint8_t* p){return (uint32_t(p[0])<<24)|(uint32_t(p[1])<<16)|(uint32_t(p[2])<<8)|p[3];}
bool ExecutableAddress(const render360::xex::PEImageMetadata& m,uint32_t a){
  for(uint32_t i=0;i<m.section_count;++i){const auto& q=m.sections[i];if(!(q.characteristics&kPeMemExecute))continue;const uint32_t n=q.virtual_size>q.raw_size?q.virtual_size:q.raw_size;const uint64_t b=uint64_t(m.image_base)+q.virtual_address,e=b+n;if(uint64_t(a)>=b&&uint64_t(a)<e)return true;}return false;
}
void ParseRuntimeFunctions(const uint8_t* image,uint32_t length,const render360::xex::PEImageMetadata& m){
  g_runtime_functions.clear();
  for(uint32_t i=0;i<m.section_count;++i){const auto& q=m.sections[i];if(std::strncmp(q.name,".pdata",8)!=0)continue;if(uint64_t(q.raw_address)+q.raw_size>length)break;
    for(uint32_t o=0;o+8<=q.raw_size;o+=8){const uint8_t* p=image+q.raw_address+o;uint32_t begin=ReadBe32(p),data=ReadBe32(p+4);const uint32_t prolog=data&0xFFu,count=(data>>8)&0x003FFFFFu,insn=4u;if(!begin||!count)continue;
      if(!ExecutableAddress(m,begin)){const uint64_t rebased=uint64_t(m.image_base)+begin;if(rebased>UINT32_MAX||!ExecutableAddress(m,uint32_t(rebased)))continue;begin=uint32_t(rebased);}const uint64_t bytes=uint64_t(count)*insn,end=uint64_t(begin)+bytes;if(!bytes||end>UINT32_MAX||!ExecutableAddress(m,uint32_t(end-1)))continue;g_runtime_functions.push_back({begin,uint32_t(end),uint32_t(uint64_t(prolog)*insn)});
    }break;
  }
  std::sort(g_runtime_functions.begin(),g_runtime_functions.end(),[](const auto&a,const auto&b){return a.begin<b.begin;});
}
const PeRuntimeFunction* FindRuntimeFunction(uint32_t a){if(g_runtime_functions.empty())return nullptr;auto it=std::upper_bound(g_runtime_functions.begin(),g_runtime_functions.end(),a,[](uint32_t v,const auto&f){return v<f.begin;});if(it==g_runtime_functions.begin())return nullptr;--it;return a>=it->begin&&a<it->end?&*it:nullptr;}

bool Fail(uint32_t status) {''','loader pdata metadata')
s=one(s,'  g_sections = 0;\n  g_raw_bytes = 0;\n  ResetXexGuestMapper();','  g_sections = 0;\n  g_raw_bytes = 0;\n  g_runtime_functions.clear();\n  ResetXexGuestMapper();','loader reset')
s=one(s,'  if (render360::xex::DecodePE(image, length, &metadata) !=\n      render360::xex::kPEPass) {\n    return Fail(kPeGuestDecodeFailed);\n  }\n\n  // Build a page-level mapping plan','  if (render360::xex::DecodePE(image, length, &metadata) !=\n      render360::xex::kPEPass) {\n    return Fail(kPeGuestDecodeFailed);\n  }\n  ParseRuntimeFunctions(image, length, metadata);\n\n  // Build a page-level mapping plan','loader parse pdata')
s=one(s,'uint32_t PreparedPeGuestRawBytes() { return g_raw_bytes; }\n\n}  // namespace render360::xenia_web',r'''uint32_t PreparedPeGuestRawBytes() { return g_raw_bytes; }
bool PreparedPeGuestFindRuntimeFunction(uint32_t address,uint32_t* begin,uint32_t* end_exclusive,uint32_t* prolog_bytes){const auto* f=FindRuntimeFunction(address);if(!f)return false;if(begin)*begin=f->begin;if(end_exclusive)*end_exclusive=f->end;if(prolog_bytes)*prolog_bytes=f->prolog_bytes;return true;}

}  // namespace render360::xenia_web''','loader pdata query')
w('src/xenia_web_bootstrap/xex_pe_guest_loader.cpp',s)

# One-shot interior entry consumed by the next HIR correctness execution.
h=r('src/xenia_web_bootstrap/hir_correctness_executor.h')
h=one(h,'void SetHIRCorrectnessAddressResolver(HIRCorrectnessAddressResolver resolver);\nbool IsHIRCorrectnessExecutionActive();','void SetHIRCorrectnessAddressResolver(HIRCorrectnessAddressResolver resolver);\nvoid SetHIRCorrectnessExecutionEntry(uint32_t guest_address);\nbool IsHIRCorrectnessExecutionActive();','HIR entry API')
w('src/xenia_web_bootstrap/hir_correctness_executor.h',h)

# Translate nested tail targets using their owning .pdata function, then begin execution at the exact PPC branch target.
s=r('src/xenia_web_bootstrap/probe_backend.cpp')
s=one(s,'#include "kernel_import_probe.h"\n','#include "kernel_import_probe.h"\n#include "xex_pe_guest_loader.h"\n','backend loader include')
a='  std::fprintf(stderr, "R360_CALL_RESOLVE target=0x%08X active_base=0x%08X\\n",\n               address, r360_ppc_probe_guest_base());\n'
b='bool ResolveNestedGuestCall'
x=r'''  uint32_t fn_begin=address,fn_end=0,prolog=0;
  bool pdata=PreparedPeGuestFindRuntimeFunction(address,&fn_begin,&fn_end,&prolog);
  if(pdata&&(fn_end<=fn_begin||uint64_t(fn_end)-fn_begin>kProbeGuestSize)){pdata=false;fn_begin=address;fn_end=0;prolog=0;}
  auto loaded=[&](){return IsInLoadedProbeWindow(fn_begin)&&(!pdata||(fn_end>=fn_begin+4&&IsInLoadedProbeWindow(fn_end-4)));};
  std::fprintf(stderr,"R360_CALL_RESOLVE target=0x%08X function=0x%08X pdata=%u prolog=%u\n",address,fn_begin,pdata?1u:0u,prolog);
  if(!loaded()){const uint32_t paged=r360_ppc_probe_page_sparse_code(fn_begin);if(!paged||!loaded()){std::fprintf(stderr,"R360_CALL_RESOLVE rejected: owning function unavailable\n");return false;}}
  ProbeGuestFunction nested_function(module,fn_begin);
  const uint32_t loaded_base=r360_ppc_probe_guest_base(),loaded_size=r360_ppc_probe_loaded_size();if(loaded_size<4)return false;
  const uint32_t scan_end=pdata?fn_end-4:loaded_base+loaded_size-4;nested_function.set_end_address(scan_end);
  xe::cpu::ppc::PPCScanner scanner(frontend);if(!scanner.Scan(&nested_function,nullptr)){std::fprintf(stderr,"R360_CALL_RESOLVE scan failed target=0x%08X\n",address);return false;}
  if(pdata&&nested_function.end_address()<address)nested_function.set_end_address(scan_end);
  SetHIRCorrectnessExecutionEntry(address!=fn_begin?address:0u);
  const bool translated=frontend->DefineFunction(&nested_function,0);SetHIRCorrectnessExecutionEntry(0u);
  std::fprintf(stderr,"R360_CALL_RESOLVE translated target=0x%08X function=0x%08X end=0x%08X pdata=%u result=%u\n",address,fn_begin,nested_function.end_address(),pdata?1u:0u,translated?1u:0u);
  return translated;
}
'''
s=between(s,a,b,x,'nested resolver')
w('src/xenia_web_bootstrap/probe_backend.cpp',s)

# Apply the same owning-function rule to the scanned XEX entry path.
s=r('src/xenia_web_bootstrap/ppc_translation_probe.cpp')
s=one(s,'#include "wasm_backend_call_probe.h"\n','#include "wasm_backend_call_probe.h"\n#include "xex_pe_guest_loader.h"\n','probe loader include')
a='uint32_t r360_ppc_probe_translate_scanned_at(uint32_t address) {'; b='uint32_t r360_ppc_probe_status() {'
x=r'''uint32_t r360_ppc_probe_translate_scanned_at(uint32_t address) {
  using namespace render360::xenia_web;ResetScanDiagnostic();g_scan_address=address;
  uint32_t fn_begin=address,fn_end=0,prolog=0;bool pdata=PreparedPeGuestFindRuntimeFunction(address,&fn_begin,&fn_end,&prolog);
  if(pdata&&(fn_end<=fn_begin||uint64_t(fn_end)-fn_begin>kProbeMaxBytes)){pdata=false;fn_begin=address;fn_end=0;prolog=0;}
  auto loaded=[&](){return IsProbeGuestRange(fn_begin,4)&&(!pdata||(fn_end>=fn_begin+4&&IsProbeGuestRange(fn_end-4,4)));};
  if(!loaded()&&(!PageSparseCodeWindow(fn_begin)||!loaded())){g_scan_diagnostic=kProbeScanGuardRejected;if(g_status<0xE000)g_status=kProbeErrorInput;return 0;}
  g_scan_window_end=g_loaded_size>=4?g_active_guest_base+g_loaded_size-4:0;if(!EnsureRuntime()||!g_probe_module||(address&3u)){g_scan_diagnostic=kProbeScanGuardRejected;return 0;}
  ResetProbeTelemetry();ProbeGuestFunction function(g_probe_module,fn_begin);const uint32_t scan_end=pdata?fn_end-4:g_active_guest_base+g_loaded_size-4;function.set_end_address(scan_end);
  xe::cpu::ppc::PPCScanner scanner(g_processor->frontend());if(!scanner.Scan(&function,nullptr)){g_scan_diagnostic=kProbeScanScannerFailed;g_status=kProbeErrorTranslate;return 0;}if(pdata&&function.end_address()<address)function.set_end_address(scan_end);g_scan_function_end=function.end_address();
  SetHIRCorrectnessExecutionEntry(address!=fn_begin?address:0u);const bool defined=g_processor->frontend()->DefineFunction(&function,0);SetHIRCorrectnessExecutionEntry(0u);if(!defined){g_scan_diagnostic=kProbeScanDefineFailed;g_status=kProbeErrorTranslate;return 0;}
  const uint32_t hir=GetProbeTelemetry().hir_instructions;g_scan_hir_instructions=hir;if(!hir){g_scan_diagnostic=kProbeScanZeroHIR;g_status=kProbeErrorTranslate;return 0;}
  std::fprintf(stderr,"R360_SCAN_RANGE entry=0x%08X function=0x%08X end=0x%08X pdata=%u prolog=%u\n",address,fn_begin,g_scan_function_end,pdata?1u:0u,prolog);g_scan_diagnostic=kProbeScanTranslated;g_status=kProbeTranslated;return hir;
}

'''
s=between(s,a,b,x,'scanned entry')
w('src/xenia_web_bootstrap/ppc_translation_probe.cpp',s)

# Post-stack-history HIR overlay: host recursive depth != Xbox guest frame depth.
overlay=r"""#!/usr/bin/env python3
from pathlib import Path
p=Path(__file__).resolve().parent/'build/xenia-web-overlay/render360/hir_correctness_executor_vmx.cpp';s=p.read_text()
def one(a,b,n):
 global s
 if s.count(a)!=1: raise SystemExit(f'tail frame {n}: {s.count(a)} anchors')
 s=s.replace(a,b,1)
one('constexpr uint32_t kR360MaxGuestCallDepth = 64;\n','''constexpr uint32_t kR360MaxGuestCallDepth = 64;
thread_local std::array<uint32_t,kR360MaxGuestCallDepth> g_logical_guest_depth{};
thread_local uint32_t g_pending_logical_depth=0;
thread_local bool g_pending_logical_depth_valid=false;
thread_local uint32_t g_requested_execution_entry=0;
''','state')
one('bool CurrentExpectedGuestReturn(uint64_t* out) {\n','''uint32_t CurrentLogicalGuestDepth(){if(!g_execution_depth||g_execution_depth>kR360MaxGuestCallDepth)return 0;const uint32_t d=g_logical_guest_depth[size_t(g_execution_depth-1)];return d?d:g_execution_depth;}
void PrepareNestedLogicalDepth(uint32_t flags){const uint32_t d=CurrentLogicalGuestDepth();g_pending_logical_depth=d+((flags&xe::cpu::hir::CALL_TAIL)?0u:1u);if(!g_pending_logical_depth)g_pending_logical_depth=1;g_pending_logical_depth_valid=true;}

bool CurrentExpectedGuestReturn(uint64_t* out) {
''','helpers')
one('void PrepareNestedGuestReturn(uint32_t flags) {\n','void PrepareNestedGuestReturn(uint32_t flags) {\n  PrepareNestedLogicalDepth(flags);\n','prepare')
one('  event.depth = g_execution_depth;\n','  event.depth = CurrentLogicalGuestDepth();\n','call history depth')
one('  g_r360_stack_trace.last_call_depth = g_execution_depth;\n','  g_r360_stack_trace.last_call_depth = CurrentLogicalGuestDepth();\n','last call depth')
one('            g_r360_stack_trace.last_write_depth = g_execution_depth;\n','            g_r360_stack_trace.last_write_depth = CurrentLogicalGuestDepth();\n','last write depth')
one('            RecordStackWriteHistory(current_source_address, old_r1,\n                                    context.r[1], g_execution_depth);\n','            RecordStackWriteHistory(current_source_address, old_r1,\n                                    context.r[1], CurrentLogicalGuestDepth());\n','write history depth')
one('''HIRCorrectnessResult ExecuteBuilder(xe::cpu::hir::HIRBuilder* builder,
                                    xe::Memory* memory,
                                    xe::cpu::ppc::PPCContext& context) {
''','''HIRCorrectnessResult ExecuteBuilder(xe::cpu::hir::HIRBuilder* builder,
                                    xe::Memory* memory,
                                    xe::cpu::ppc::PPCContext& context,
                                    uint32_t execution_entry) {
''','builder signature')
one('''  auto* block = builder->first_block();

  while (block && supported && !reached_return) {
    auto* next_block = block->next;
    bool block_terminated = false;
    for (auto* instr = block->instr_head;
         instr && supported && !reached_return; instr = instr->next) {
''','''  auto* block=builder->first_block();
  auto* entry_instr=static_cast<xe::cpu::hir::Instr*>(nullptr);
  if(execution_entry){bool found=false;for(auto* b=builder->first_block();b&&!found;b=b->next){for(auto* i=b->instr_head;i;i=i->next){if(i->opcode&&i->opcode->num==xe::cpu::hir::OPCODE_SOURCE_OFFSET&&uint32_t(i->src1.offset)==execution_entry){block=b;entry_instr=i;found=true;break;}}}if(!found){result.blocker_kind=kHIRBlockerUnresolvedCall;result.blocker_address=execution_entry;std::fprintf(stderr,"R360_HIR_INTERIOR_ENTRY_MISSING address=0x%08X\\n",execution_entry);return result;}std::fprintf(stderr,"R360_HIR_INTERIOR_ENTRY address=0x%08X logical=%u host=%u\\n",execution_entry,CurrentLogicalGuestDepth(),g_execution_depth);}
  bool first_execution_block=true;
  while (block && supported && !reached_return) {
    auto* next_block = block->next;
    bool block_terminated = false;
    auto* first_instr=first_execution_block&&entry_instr?entry_instr:block->instr_head;first_execution_block=false;
    for (auto* instr = first_instr;
         instr && supported && !reached_return; instr = instr->next) {
''','interior start')
one('''void SetHIRCorrectnessAddressResolver(HIRCorrectnessAddressResolver resolver) {
  g_address_resolver = resolver;
}

bool IsHIRCorrectnessExecutionActive()''','''void SetHIRCorrectnessAddressResolver(HIRCorrectnessAddressResolver resolver) {
  g_address_resolver = resolver;
}
void SetHIRCorrectnessExecutionEntry(uint32_t guest_address){g_requested_execution_entry=guest_address;}

bool IsHIRCorrectnessExecutionActive()''','entry setter')
one('''  ++g_execution_depth;
  result = ExecuteBuilder(builder, memory, *g_active_context);
  --g_execution_depth;
''','''  ++g_execution_depth;
  if(g_execution_depth<=kR360MaxGuestCallDepth){const size_t slot=size_t(g_execution_depth-1);if(outermost)g_logical_guest_depth[slot]=1;else if(g_pending_logical_depth_valid)g_logical_guest_depth[slot]=g_pending_logical_depth;else g_logical_guest_depth[slot]=g_execution_depth;}
  g_pending_logical_depth=0;g_pending_logical_depth_valid=false;
  const uint32_t execution_entry=g_requested_execution_entry;g_requested_execution_entry=0;
  result = ExecuteBuilder(builder, memory, *g_active_context, execution_entry);
  --g_execution_depth;
''','execute')
p.write_text(s);print('HIR_TAIL_FRAME_BOUNDARY_OVERLAY=PASS')
"""
w('prepare-hir-tail-frame-overlay.py',overlay)

s=r('build-xenia-ppc-bootstrap.sh')
s=one(s,'python3 "$ROOT/prepare-hir-stack-history-overlay.py"\npython3 "$ROOT/prepare-xenia-shader-interpreter-overlay.py"','python3 "$ROOT/prepare-hir-stack-history-overlay.py"\npython3 "$ROOT/prepare-hir-tail-frame-overlay.py"\npython3 "$ROOT/prepare-xenia-shader-interpreter-overlay.py"','build order')
w('build-xenia-ppc-bootstrap.sh',s)

s=r('.github/workflows/xenia-browser-bootstrap-fastlane.yml')
if "      - 'prepare-hir-tail-frame-overlay.py'\n" not in s: raise SystemExit('fastlane tail-frame path missing')

# Keep the existing source-contract test aware of the final HIR overlay order.
s=r('test-braid-frame-history.mjs')
s=one(s,"  'prepare-hir-stack-history-overlay.py',\n];","  'prepare-hir-stack-history-overlay.py',\n  'prepare-hir-tail-frame-overlay.py',\n];",'history overlay order')
w('test-braid-frame-history.mjs',s)
print('TAIL_FRAME_BOUNDARY_V55_PATCH=PASS')
