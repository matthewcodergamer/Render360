#!/usr/bin/env python3
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
thread_local uint32_t g_current_call_flags=0;
uint32_t CurrentLogicalGuestDepth();
''','state')
one('bool CurrentExpectedGuestReturn(uint64_t* out) {\n','''uint32_t CurrentLogicalGuestDepth(){if(!g_execution_depth||g_execution_depth>kR360MaxGuestCallDepth)return 0;const uint32_t d=g_logical_guest_depth[size_t(g_execution_depth-1)];return d?d:g_execution_depth;}
void PrepareNestedLogicalDepth(uint32_t flags){g_current_call_flags=flags;const uint32_t d=CurrentLogicalGuestDepth();g_pending_logical_depth=d+((flags&xe::cpu::hir::CALL_TAIL)?0u:1u);if(!g_pending_logical_depth)g_pending_logical_depth=1;g_pending_logical_depth_valid=true;}

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
uint32_t GetHIRCorrectnessCurrentCallFlags(){return g_current_call_flags;}

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
