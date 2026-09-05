from pathlib import Path


def require(text: str, token: str, message: str) -> None:
    if token not in text:
        raise SystemExit(message)


def replace_once(text: str, old: str, new: str, message: str) -> str:
    if new in text:
        return text
    if old not in text:
        raise SystemExit(message)
    return text.replace(old, new, 1)


# 1) Make the production bootstrap build actually apply the HIR call/return
# overlays before compiling the executor. Keep the new stack-history pass last.
p = Path('build-xenia-ppc-bootstrap.sh')
s = p.read_text()
anchor = 'python3 "$ROOT/prepare-title-runtime-memory-overlay.py"\n'
replacement = (
    anchor
    + 'python3 "$ROOT/prepare-hir-call-return-stack-overlay.py"\n'
    + 'python3 "$ROOT/prepare-hir-return-metadata-v3-overlay.py"\n'
    + 'python3 "$ROOT/prepare-hir-stack-history-overlay.py"\n'
)
s = replace_once(s, anchor, replacement, 'bootstrap HIR overlay ordering anchor changed')
p.write_text(s)


# 2) Persist an ordered cross-function timeline of every r1 context write and
# guest call. The previous diagnostic retained only the final event, which is
# enough to prove the guard violation but not enough to distinguish a missing
# prologue from a duplicate epilogue.
p = Path('prepare-hir-stack-history-overlay.py')
p.write_text(r'''#!/usr/bin/env python3
from pathlib import Path

root = Path(__file__).resolve().parent
path = root / 'build/xenia-web-overlay/render360/hir_correctness_executor_vmx.cpp'
text = path.read_text()


def replace_once(old: str, new: str, label: str) -> None:
    global text
    if new in text:
        return
    if old not in text:
        raise SystemExit(f'HIR stack history overlay: {label} anchor changed')
    text = text.replace(old, new, 1)


state_anchor = '''thread_local R360StackTraceState g_r360_stack_trace{};
'''
state_replacement = state_anchor + '''
constexpr uint32_t kR360StackHistoryCapacity = 32;
struct R360StackWriteHistoryEvent {
  uint32_t sequence = 0;
  uint32_t source = 0;
  uint32_t depth = 0;
  uint64_t old_r1 = 0;
  uint64_t new_r1 = 0;
};
struct R360StackCallHistoryEvent {
  uint32_t sequence = 0;
  uint32_t source = 0;
  uint32_t target = 0;
  uint32_t depth = 0;
  uint32_t flags = 0;
  uint64_t r1 = 0;
};
thread_local std::array<R360StackWriteHistoryEvent, kR360StackHistoryCapacity>
    g_r360_stack_write_history{};
thread_local std::array<R360StackCallHistoryEvent, kR360StackHistoryCapacity>
    g_r360_stack_call_history{};
thread_local uint32_t g_r360_stack_write_history_count = 0;
thread_local uint32_t g_r360_stack_call_history_count = 0;
thread_local uint32_t g_r360_stack_event_sequence = 0;

template <typename T, size_t N>
void PushBoundedHistory(std::array<T, N>& history, uint32_t* count,
                        const T& event) {
  if (!count) return;
  if (*count < N) {
    history[*count] = event;
    ++(*count);
    return;
  }
  for (size_t i = 1; i < N; ++i) history[i - 1] = history[i];
  history[N - 1] = event;
}

void RecordStackWriteHistory(uint32_t source, uint64_t old_r1,
                             uint64_t new_r1, uint32_t depth) {
  R360StackWriteHistoryEvent event;
  event.sequence = ++g_r360_stack_event_sequence;
  event.source = source;
  event.depth = depth;
  event.old_r1 = old_r1;
  event.new_r1 = new_r1;
  PushBoundedHistory(g_r360_stack_write_history,
                     &g_r360_stack_write_history_count, event);
}

void RecordStackCallHistory(uint32_t target, uint32_t flags) {
  if (!g_active_context) return;
  R360StackCallHistoryEvent event;
  event.sequence = ++g_r360_stack_event_sequence;
  event.source = g_current_source_address;
  event.target = target;
  event.depth = g_execution_depth;
  event.flags = flags;
  event.r1 = g_active_context->r[1];
  PushBoundedHistory(g_r360_stack_call_history,
                     &g_r360_stack_call_history_count, event);
}
'''
replace_once(state_anchor, state_replacement, 'history state')

call_old = '''void RecordGuestCall(uint32_t target) {
  if (!g_active_context) return;
  g_r360_stack_trace.last_call_r1 = g_active_context->r[1];
  g_r360_stack_trace.last_call_source = g_current_source_address;
  g_r360_stack_trace.last_call_target = target;
  g_r360_stack_trace.last_call_depth = g_execution_depth;
  std::fprintf(stderr,
               "R360_STACK_CALL source=0x%08X target=0x%08X depth=%u r1=0x%08X\\n",
               g_current_source_address, target, g_execution_depth,
               static_cast<uint32_t>(g_active_context->r[1]));
}
'''
call_new = '''void RecordGuestCall(uint32_t target, uint32_t flags) {
  if (!g_active_context) return;
  g_r360_stack_trace.last_call_r1 = g_active_context->r[1];
  g_r360_stack_trace.last_call_source = g_current_source_address;
  g_r360_stack_trace.last_call_target = target;
  g_r360_stack_trace.last_call_depth = g_execution_depth;
  RecordStackCallHistory(target, flags);
  std::fprintf(stderr,
               "R360_STACK_CALL source=0x%08X target=0x%08X depth=%u r1=0x%08X flags=0x%X\\n",
               g_current_source_address, target, g_execution_depth,
               static_cast<uint32_t>(g_active_context->r[1]), flags);
}
'''
replace_once(call_old, call_new, 'guest call history')

replace_once(
    'if (function) RecordGuestCall(static_cast<uint32_t>(function->address()));',
    'if (function) RecordGuestCall(static_cast<uint32_t>(function->address()), flags);',
    'function call flags',
)
replace_once(
    '  RecordGuestCall(target);\n',
    '  RecordGuestCall(target, flags);\n',
    'address call flags',
)

write_anchor = '''            g_r360_stack_trace.last_write_address = current_source_address;
            g_r360_stack_trace.last_write_depth = g_execution_depth;
            std::fprintf(stderr,
'''
write_replacement = '''            g_r360_stack_trace.last_write_address = current_source_address;
            g_r360_stack_trace.last_write_depth = g_execution_depth;
            RecordStackWriteHistory(current_source_address, old_r1,
                                    context.r[1], g_execution_depth);
            std::fprintf(stderr,
'''
replace_once(write_anchor, write_replacement, 'r1 write history')

reset_anchor = '''    g_current_source_address = 0;
    g_r360_stack_trace = {};
'''
reset_replacement = '''    g_current_source_address = 0;
    g_r360_stack_trace = {};
    g_r360_stack_write_history = {};
    g_r360_stack_call_history = {};
    g_r360_stack_write_history_count = 0;
    g_r360_stack_call_history_count = 0;
    g_r360_stack_event_sequence = 0;
'''
replace_once(reset_anchor, reset_replacement, 'outer history reset')

export_anchor = '''__attribute__((visibility("default"))) uint32_t r360_ppc_probe_stack_last_call_depth() {
  return g_r360_stack_trace.last_call_depth;
}
}  // extern "C"
'''
export_replacement = '''__attribute__((visibility("default"))) uint32_t r360_ppc_probe_stack_last_call_depth() {
  return g_r360_stack_trace.last_call_depth;
}
__attribute__((visibility("default"))) uint32_t r360_ppc_probe_stack_write_count() {
  return g_r360_stack_write_history_count;
}
__attribute__((visibility("default"))) uint32_t r360_ppc_probe_stack_write_sequence(uint32_t index) {
  return index < g_r360_stack_write_history_count ? g_r360_stack_write_history[index].sequence : 0;
}
__attribute__((visibility("default"))) uint32_t r360_ppc_probe_stack_write_address(uint32_t index) {
  return index < g_r360_stack_write_history_count ? g_r360_stack_write_history[index].source : 0;
}
__attribute__((visibility("default"))) uint32_t r360_ppc_probe_stack_write_old_r1(uint32_t index) {
  return index < g_r360_stack_write_history_count ? static_cast<uint32_t>(g_r360_stack_write_history[index].old_r1) : 0;
}
__attribute__((visibility("default"))) uint32_t r360_ppc_probe_stack_write_new_r1(uint32_t index) {
  return index < g_r360_stack_write_history_count ? static_cast<uint32_t>(g_r360_stack_write_history[index].new_r1) : 0;
}
__attribute__((visibility("default"))) uint32_t r360_ppc_probe_stack_write_depth(uint32_t index) {
  return index < g_r360_stack_write_history_count ? g_r360_stack_write_history[index].depth : 0;
}
__attribute__((visibility("default"))) uint32_t r360_ppc_probe_stack_call_count() {
  return g_r360_stack_call_history_count;
}
__attribute__((visibility("default"))) uint32_t r360_ppc_probe_stack_call_sequence(uint32_t index) {
  return index < g_r360_stack_call_history_count ? g_r360_stack_call_history[index].sequence : 0;
}
__attribute__((visibility("default"))) uint32_t r360_ppc_probe_stack_call_source(uint32_t index) {
  return index < g_r360_stack_call_history_count ? g_r360_stack_call_history[index].source : 0;
}
__attribute__((visibility("default"))) uint32_t r360_ppc_probe_stack_call_target(uint32_t index) {
  return index < g_r360_stack_call_history_count ? g_r360_stack_call_history[index].target : 0;
}
__attribute__((visibility("default"))) uint32_t r360_ppc_probe_stack_call_r1(uint32_t index) {
  return index < g_r360_stack_call_history_count ? static_cast<uint32_t>(g_r360_stack_call_history[index].r1) : 0;
}
__attribute__((visibility("default"))) uint32_t r360_ppc_probe_stack_call_depth(uint32_t index) {
  return index < g_r360_stack_call_history_count ? g_r360_stack_call_history[index].depth : 0;
}
__attribute__((visibility("default"))) uint32_t r360_ppc_probe_stack_call_flags(uint32_t index) {
  return index < g_r360_stack_call_history_count ? g_r360_stack_call_history[index].flags : 0;
}
}  // extern "C"
'''
replace_once(export_anchor, export_replacement, 'history ABI exports')

for marker in [
    'r360_ppc_probe_stack_write_count',
    'r360_ppc_probe_stack_call_count',
    'RecordStackWriteHistory',
    'RecordStackCallHistory',
    'g_r360_stack_event_sequence',
]:
    if marker not in text:
        raise SystemExit(f'HIR stack history overlay missing marker: {marker}')

path.write_text(text)
print('HIR_STACK_HISTORY_OVERLAY=PASS')
''')


# 3) Keep the fastlane synchronized with this new runtime overlay.
p = Path('.github/workflows/xenia-browser-bootstrap-fastlane.yml')
s = p.read_text()
path_anchor = "      - 'prepare-hir-return-metadata-v3-overlay.py'\n"
path_replacement = path_anchor + "      - 'prepare-hir-stack-history-overlay.py'\n"
s = replace_once(s, path_anchor, path_replacement, 'fastlane stack-history path anchor changed')
p.write_text(s)


# 4) Snapshot the bounded histories immediately after execution, before another
# title slice can overwrite native thread-local diagnostics.
p = Path('render360-title-controller.mjs')
s = p.read_text()
s = replace_once(
    s,
    "  const stackTraceRead=name=>{const f=maybe(bootstrap,name);return f?(f()>>>0):undefined;};\n",
    "  const stackTraceRead=(name,...args)=>{const f=maybe(bootstrap,name);return f?(f(...args)>>>0):undefined;};\n",
    'title stack getter args anchor changed',
)
stack_tail = """    lastCallR1:stackTraceRead('r360_ppc_probe_stack_last_call_r1'),
    lastCallDepth:stackTraceRead('r360_ppc_probe_stack_last_call_depth'),
  };
"""
stack_tail_new = """    lastCallR1:stackTraceRead('r360_ppc_probe_stack_last_call_r1'),
    lastCallDepth:stackTraceRead('r360_ppc_probe_stack_last_call_depth'),
  };
  const stackWriteCount=Math.min(stackTraceRead('r360_ppc_probe_stack_write_count')??0,32);
  const stackCallCount=Math.min(stackTraceRead('r360_ppc_probe_stack_call_count')??0,32);
  stackTrace.writeHistory=Array.from({length:stackWriteCount},(_,index)=>({
    sequence:stackTraceRead('r360_ppc_probe_stack_write_sequence',index),
    address:stackTraceRead('r360_ppc_probe_stack_write_address',index),
    oldR1:stackTraceRead('r360_ppc_probe_stack_write_old_r1',index),
    newR1:stackTraceRead('r360_ppc_probe_stack_write_new_r1',index),
    depth:stackTraceRead('r360_ppc_probe_stack_write_depth',index),
  }));
  stackTrace.callHistory=Array.from({length:stackCallCount},(_,index)=>({
    sequence:stackTraceRead('r360_ppc_probe_stack_call_sequence',index),
    source:stackTraceRead('r360_ppc_probe_stack_call_source',index),
    target:stackTraceRead('r360_ppc_probe_stack_call_target',index),
    r1:stackTraceRead('r360_ppc_probe_stack_call_r1',index),
    depth:stackTraceRead('r360_ppc_probe_stack_call_depth',index),
    flags:stackTraceRead('r360_ppc_probe_stack_call_flags',index),
  }));
"""
s = replace_once(s, stack_tail, stack_tail_new, 'title stack history snapshot anchor changed')
p.write_text(s)


# 5) Teach the problem-first console to normalize and reason over the ordered
# history. This turns the next report into a yes/no answer about the missing
# 0x100 frame allocation rather than another generic memory-fault report.
p = Path('developer-console.js')
s = p.read_text()
s = s.replace('// V53: Braid blocker console — diagnosis first, full report always retained.',
              '// V54: Braid frame-history console — prove prologue vs duplicate teardown.')
result_stack_anchor = "  const resultStack=result?.stackTrace||{};\n  const stackTrace=compact({\n"
result_stack_replacement = """  const resultStack=result?.stackTrace||{};
  const writeHistory=(Array.isArray(resultStack.writeHistory)?resultStack.writeHistory:[]).map(event=>compact({
    sequence:number(event.sequence),address:address(event.address),oldR1:address(event.oldR1),newR1:address(event.newR1),depth:number(event.depth),
  }));
  const callHistory=(Array.isArray(resultStack.callHistory)?resultStack.callHistory:[]).map(event=>compact({
    sequence:number(event.sequence),source:address(event.source),target:address(event.target),r1:address(event.r1),depth:number(event.depth),flags:number(event.flags),
  }));
  const stackTrace=compact({
"""
s = replace_once(s, result_stack_anchor, result_stack_replacement, 'developer history normalization anchor changed')
stack_object_tail = """    lastCallR1:address(number(resultStack.lastCallR1)??readStackU32('r360_ppc_probe_stack_last_call_r1')),
    lastCallDepth:number(resultStack.lastCallDepth)??readStackU32('r360_ppc_probe_stack_last_call_depth'),
  });
"""
stack_object_tail_new = """    lastCallR1:address(number(resultStack.lastCallR1)??readStackU32('r360_ppc_probe_stack_last_call_r1')),
    lastCallDepth:number(resultStack.lastCallDepth)??readStackU32('r360_ppc_probe_stack_last_call_depth'),
    writeHistory:writeHistory.length?writeHistory:undefined,
    callHistory:callHistory.length?callHistory:undefined,
  });
"""
s = replace_once(s, stack_object_tail, stack_object_tail_new, 'developer history object anchor changed')

code_window_anchor = """      r1Write:readPpcWindow(read8,stackTrace.lastWriteAddress,3),
      callSite:readPpcWindow(read8,stackTrace.lastCallSource,2),
      blocker:readPpcWindow(read8,blockerAddress,2),
"""
code_window_new = """      entry:readPpcWindow(read8,result?.entry,4),
      r1Write:readPpcWindow(read8,stackTrace.lastWriteAddress,3),
      callSite:readPpcWindow(read8,stackTrace.lastCallSource,2),
      blocker:readPpcWindow(read8,blockerAddress,2),
"""
s = replace_once(s, code_window_anchor, code_window_new, 'developer entry code window anchor changed')

focus_anchor = """  const writeWindow=memory?.codeWindows?.r1Write||[];
  const writeInstruction=writeWindow.find(row=>row.current);
  const classification=crossedGuard&&isR1Fault?'STACK_FRAME_TEARDOWN_MISMATCH':memory?.faultCode?'GUEST_MEMORY_BOUNDARY':'CPU_RUNTIME_BLOCKER';
"""
focus_new = """  const writeWindow=memory?.codeWindows?.r1Write||[];
  const writeInstruction=writeWindow.find(row=>row.current);
  const writes=trace.writeHistory||[],calls=trace.callHistory||[];
  const suspectWrite=[...writes].reverse().find(event=>event.address===trace.lastWriteAddress&&event.newR1===trace.lastNewR1)||writes.at(-1);
  const suspectSequence=number(suspectWrite?.sequence),suspectDepth=number(suspectWrite?.depth)??number(trace.lastWriteDepth);
  const enteringCall=suspectDepth===undefined?undefined:[...calls].reverse().find(event=>number(event.depth)===suspectDepth-1&&(suspectSequence===undefined||number(event.sequence)<suspectSequence));
  const frameWrites=writes.filter(event=>{
    const seq=number(event.sequence),depth=number(event.depth);
    return depth===suspectDepth&&(!enteringCall||seq>number(enteringCall.sequence))&&(suspectSequence===undefined||seq<=suspectSequence);
  });
  const frameDeltas=frameWrites.map(event=>({event,delta:(number(event.newR1)-number(event.oldR1))})).filter(item=>Number.isFinite(item.delta));
  const matchingAllocation=r1WriteDelta>0?[...frameDeltas].reverse().find(item=>item.delta===-r1WriteDelta&&item.event.address!==trace.lastWriteAddress):undefined;
  const historyReady=writes.length>0&&calls.length>0;
  const missingAllocation=historyReady&&r1WriteDelta>0&&suspectDepth>1&&!!enteringCall&&!matchingAllocation;
  const classification=crossedGuard&&isR1Fault?(missingAllocation?'FRAME_ENTRY_MISSING_PROLOGUE':historyReady?'STACK_BALANCE_OR_EPILOGUE_MISMATCH':'STACK_FRAME_TEARDOWN_MISMATCH'):memory?.faultCode?'GUEST_MEMORY_BOUNDARY':'CPU_RUNTIME_BLOCKER';
  const timeline=[...writes.map(event=>({kind:'r1',...event})),...calls.map(event=>({kind:'call',...event}))].sort((a,b)=>(number(a.sequence)||0)-(number(b.sequence)||0)).map(event=>event.kind==='call'
    ?`#${event.sequence} CALL d${event.depth} ${event.source} → ${event.target} r1=${event.r1} flags=0x${(number(event.flags)||0).toString(16).toUpperCase()}`
    :`#${event.sequence} r1 d${event.depth} ${event.address} ${event.oldR1} → ${event.newR1} (${hexDelta((number(event.newR1)||0)-(number(event.oldR1)||0))})`);
"""
s = replace_once(s, focus_anchor, focus_new, 'developer frame-history analysis anchor changed')

evidence_anchor = """    trace.lastCallSource&&trace.lastCallTarget?`Immediate call edge: ${trace.lastCallSource} → ${trace.lastCallTarget}, depth ${trace.lastCallDepth??'—'}, r1=${trace.lastCallR1||'—'}.`:undefined,
  ].filter(Boolean);
"""
evidence_new = """    trace.lastCallSource&&trace.lastCallTarget?`Immediate call edge: ${trace.lastCallSource} → ${trace.lastCallTarget}, depth ${trace.lastCallDepth??'—'}, r1=${trace.lastCallR1||'—'}.`:undefined,
    historyReady&&enteringCall?`Frame-entry call for depth ${suspectDepth}: ${enteringCall.source} → ${enteringCall.target} with r1=${enteringCall.r1}.`:undefined,
    historyReady&&matchingAllocation?`Matching frame allocation found at ${matchingAllocation.event.address}: ${matchingAllocation.event.oldR1} → ${matchingAllocation.event.newR1} (${hexDelta(matchingAllocation.delta)}).`:undefined,
    missingAllocation?`No ${hexDelta(-r1WriteDelta)} r1 allocation was observed in depth ${suspectDepth} after its entry call and before the ${hexDelta(r1WriteDelta)} teardown.`:undefined,
  ].filter(Boolean);
"""
s = replace_once(s, evidence_anchor, evidence_new, 'developer frame evidence anchor changed')

next_anchor = """    trace.lastWriteAddress?`Inspect the frame teardown at ${trace.lastWriteAddress}; determine whether its positive r1 restore has a matching earlier allocation in the same guest frame.`:undefined,
    trace.lastCallSource?`Verify function/shared-epilogue classification around ${trace.lastCallSource} and the target ${trace.lastCallTarget||'—'}.`:undefined,
"""
next_new = """    missingAllocation&&enteringCall?`Inspect the translated function entered at ${enteringCall.target}; the runtime reached its +0x100 teardown without recording a -0x100 r1 allocation in that frame.`:trace.lastWriteAddress?`Inspect the frame teardown at ${trace.lastWriteAddress}; determine whether its positive r1 restore has a matching earlier allocation in the same guest frame.`:undefined,
    historyReady&&matchingAllocation?`A matching allocation exists, so inspect intervening r1 writes/branches for a duplicate restore or wrong shared epilogue.`:trace.lastCallSource?`Verify function/shared-epilogue classification around ${trace.lastCallSource} and the target ${trace.lastCallTarget||'—'}.`:undefined,
"""
s = replace_once(s, next_anchor, next_new, 'developer next target anchor changed')

return_focus_anchor = """    callEdge:trace.lastCallSource&&trace.lastCallTarget?`${trace.lastCallSource} -> ${trace.lastCallTarget}`:undefined,
    evidence,ruledOut,next,
"""
return_focus_new = """    callEdge:trace.lastCallSource&&trace.lastCallTarget?`${trace.lastCallSource} -> ${trace.lastCallTarget}`:undefined,
    historyReady,missingAllocation,frameEntryCall:enteringCall,matchingAllocation:matchingAllocation?.event,
    timeline,evidence,ruledOut,next,
"""
s = replace_once(s, return_focus_anchor, return_focus_new, 'developer focus history fields anchor changed')

headline_anchor = """    headline:crossedGuard?'r1 crossed the Xenia stack base before the restore load':'CPU execution stopped at a guest-memory boundary',
"""
headline_new = """    headline:missingAllocation?`depth ${suspectDepth} reached a ${hexDelta(r1WriteDelta)} epilogue without its matching allocation`:crossedGuard?'r1 crossed the Xenia stack base before the restore load':'CPU execution stopped at a guest-memory boundary',
"""
s = replace_once(s, headline_anchor, headline_new, 'developer history headline anchor changed')

render_anchor = """  appendTextList(root,'Evidence',focus.evidence);
  appendCodeWindow(root,'PPC around last r1 write',summary.memory?.codeWindows?.r1Write);
"""
render_new = """  appendTextList(root,'Evidence',focus.evidence);
  appendTextList(root,'Stack / call timeline',focus.timeline);
  appendCodeWindow(root,'PPC around title entry',summary.memory?.codeWindows?.entry);
  appendCodeWindow(root,'PPC around last r1 write',summary.memory?.codeWindows?.r1Write);
"""
s = replace_once(s, render_anchor, render_new, 'developer history render anchor changed')
p.write_text(s)


# 6) Regression test for the exact diagnostic contract. The runtime test remains
# source-level because Braid's commercial XEX is intentionally not committed.
p = Path('test-braid-frame-history.mjs')
p.write_text("""import fs from 'node:fs';

const overlay=fs.readFileSync('prepare-hir-stack-history-overlay.py','utf8');
const build=fs.readFileSync('build-xenia-ppc-bootstrap.sh','utf8');
const controller=fs.readFileSync('render360-title-controller.mjs','utf8');
const dev=fs.readFileSync('developer-console.js','utf8');
for(const marker of ['prepare-hir-call-return-stack-overlay.py','prepare-hir-return-metadata-v3-overlay.py','prepare-hir-stack-history-overlay.py']){
  if(!build.includes(marker))throw new Error(`build overlay ordering missing ${marker}`);
}
for(const marker of ['r360_ppc_probe_stack_write_count','r360_ppc_probe_stack_call_count','g_r360_stack_event_sequence','RecordStackWriteHistory','RecordStackCallHistory']){
  if(!overlay.includes(marker))throw new Error(`history overlay missing ${marker}`);
}
for(const marker of ['stackTrace.writeHistory','stackTrace.callHistory','r360_ppc_probe_stack_write_sequence','r360_ppc_probe_stack_call_flags']){
  if(!controller.includes(marker))throw new Error(`title snapshot missing ${marker}`);
}
for(const marker of ['FRAME_ENTRY_MISSING_PROLOGUE','Stack / call timeline','PPC around title entry','matchingAllocation','missingAllocation']){
  if(!dev.includes(marker))throw new Error(`problem-first console missing ${marker}`);
}
console.log('BRAID_FRAME_HISTORY_CONTRACT=PASS');
""")

print('BRAID_FRAME_HISTORY_SURGERY=PASS')
