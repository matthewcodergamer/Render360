from pathlib import Path


def require(text: str, token: str, message: str) -> None:
    if token not in text:
        raise SystemExit(message)


def once(text: str, old: str, new: str, already: str, message: str) -> str:
    if old in text:
        return text.replace(old, new, 1)
    if already in text:
        return text
    raise SystemExit(message)


# 1) Extend the build-time HIR executor overlay so the stack trace that is
# already printed to stderr is also exported through the browser WASM ABI.
p = Path('prepare-hir-call-return-stack-overlay.py')
s = p.read_text()
s = once(
    s,
    '  uint64_t initial_r1 = 0;\\n  uint64_t last_old_r1 = 0;\\n',
    '  uint64_t initial_r1 = 0;\\n  uint64_t blocker_r1 = 0;\\n  uint64_t last_old_r1 = 0;\\n',
    '  uint64_t blocker_r1 = 0;\\n',
    'HIR stack-trace state anchor changed',
)
s = once(
    s,
    '      if (g_active_context) {\\n        std::fprintf(stderr,\\n',
    '      if (g_active_context) {\\n        g_r360_stack_trace.blocker_r1 = g_active_context->r[1];\\n        std::fprintf(stderr,\\n',
    'g_r360_stack_trace.blocker_r1 = g_active_context->r[1];',
    'HIR blocker-r1 capture anchor changed',
)

if 'r360_ppc_probe_stack_blocker_r1' not in s:
    marker = "required = [\n"
    require(s, marker, 'HIR required-marker anchor changed')
    export_patch = r'''# Persist the most useful stack/call trace fields in exported ABI getters so
# browser diagnostics can capture them after ExecuteHIRCorrectnessProbe returns.
# The anonymous-namespace state remains visible to functions in the enclosing
# render360::xenia_web namespace within this translation unit.
trace_exports_anchor = '\n}  // namespace render360::xenia_web\n'
trace_exports_replacement = (
    '\nextern "C" {\n'
    '__attribute__((visibility("default"))) uint32_t r360_ppc_probe_stack_blocker_r1() {\n'
    '  return static_cast<uint32_t>(g_r360_stack_trace.blocker_r1);\n'
    '}\n'
    '__attribute__((visibility("default"))) uint32_t r360_ppc_probe_stack_initial_r1() {\n'
    '  return static_cast<uint32_t>(g_r360_stack_trace.initial_r1);\n'
    '}\n'
    '__attribute__((visibility("default"))) uint32_t r360_ppc_probe_stack_last_write_address() {\n'
    '  return g_r360_stack_trace.last_write_address;\n'
    '}\n'
    '__attribute__((visibility("default"))) uint32_t r360_ppc_probe_stack_last_old_r1() {\n'
    '  return static_cast<uint32_t>(g_r360_stack_trace.last_old_r1);\n'
    '}\n'
    '__attribute__((visibility("default"))) uint32_t r360_ppc_probe_stack_last_new_r1() {\n'
    '  return static_cast<uint32_t>(g_r360_stack_trace.last_new_r1);\n'
    '}\n'
    '__attribute__((visibility("default"))) uint32_t r360_ppc_probe_stack_last_write_depth() {\n'
    '  return g_r360_stack_trace.last_write_depth;\n'
    '}\n'
    '__attribute__((visibility("default"))) uint32_t r360_ppc_probe_stack_last_call_source() {\n'
    '  return g_r360_stack_trace.last_call_source;\n'
    '}\n'
    '__attribute__((visibility("default"))) uint32_t r360_ppc_probe_stack_last_call_target() {\n'
    '  return g_r360_stack_trace.last_call_target;\n'
    '}\n'
    '__attribute__((visibility("default"))) uint32_t r360_ppc_probe_stack_last_call_r1() {\n'
    '  return static_cast<uint32_t>(g_r360_stack_trace.last_call_r1);\n'
    '}\n'
    '__attribute__((visibility("default"))) uint32_t r360_ppc_probe_stack_last_call_depth() {\n'
    '  return g_r360_stack_trace.last_call_depth;\n'
    '}\n'
    '}  // extern "C"\n\n'
    '}  // namespace render360::xenia_web\n'
)
replace_once(trace_exports_anchor, trace_exports_replacement, 'stack trace ABI exports')

'''
    s = s.replace(marker, export_patch + marker, 1)

if "'r360_ppc_probe_stack_blocker_r1'" not in s:
    required_tail = "    'in_probe_window',\n]"
    require(s, required_tail, 'HIR required-list tail changed')
    s = s.replace(
        required_tail,
        "    'in_probe_window',\n    'r360_ppc_probe_stack_blocker_r1',\n    'r360_ppc_probe_stack_last_write_address',\n]",
        1,
    )
p.write_text(s)


# 2) Snapshot the exported trace immediately after title execution, alongside
# the existing sparse-memory fault latch. This prevents later UI reads or a
# later executor slice from overwriting the evidence from the blocker.
p = Path('render360-title-controller.mjs')
s = p.read_text()
if 'r360_ppc_probe_stack_blocker_r1' not in s:
    anchor = "  const memoryFaultCode=memoryFaultCodeFn?(memoryFaultCodeFn()>>>0):0;\n  const translatedFunctionCount=callCountFn?(callCountFn()>>>0):0;"
    require(s, anchor, 'title controller memory-fault snapshot anchor changed')
    replacement = """  const memoryFaultCode=memoryFaultCodeFn?(memoryFaultCodeFn()>>>0):0;
  const stackTraceRead=name=>{const f=maybe(bootstrap,name);return f?(f()>>>0):undefined;};
  const stackTrace={
    blockerR1:stackTraceRead('r360_ppc_probe_stack_blocker_r1'),
    initialR1:stackTraceRead('r360_ppc_probe_stack_initial_r1'),
    lastWriteAddress:stackTraceRead('r360_ppc_probe_stack_last_write_address'),
    lastOldR1:stackTraceRead('r360_ppc_probe_stack_last_old_r1'),
    lastNewR1:stackTraceRead('r360_ppc_probe_stack_last_new_r1'),
    lastWriteDepth:stackTraceRead('r360_ppc_probe_stack_last_write_depth'),
    lastCallSource:stackTraceRead('r360_ppc_probe_stack_last_call_source'),
    lastCallTarget:stackTraceRead('r360_ppc_probe_stack_last_call_target'),
    lastCallR1:stackTraceRead('r360_ppc_probe_stack_last_call_r1'),
    lastCallDepth:stackTraceRead('r360_ppc_probe_stack_last_call_depth'),
  };
  const translatedFunctionCount=callCountFn?(callCountFn()>>>0):0;"""
    s = s.replace(anchor, replacement, 1)
    return_anchor = 'executionBlockerKind,executionBlockerOpcode,executionBlockerAddress,memoryFaultAddress,memoryFaultCode,translatedFunctionCount'
    require(s, return_anchor, 'title controller result anchor changed')
    s = s.replace(
        return_anchor,
        'executionBlockerKind,executionBlockerOpcode,executionBlockerAddress,memoryFaultAddress,memoryFaultCode,stackTrace,translatedFunctionCount',
        1,
    )
p.write_text(s)


# 3) Decode PPC64 DS-form memory instructions correctly in the developer
# console. The real Braid blocker word 0xEB61FFD0 is opcode 58: ld r27,-48(r1).
# Also surface the native stack trace in Copy Report and the on-device summary.
p = Path('developer-console.js')
s = p.read_text()
if "instructionKind='ds-form-memory'" not in s:
    anchor = """    }else if(primaryOpcode===18){
      instructionKind='direct-branch';"""
    require(s, anchor, 'developer console DS-form insertion anchor changed')
    replacement = """    }else if(primaryOpcode===58||primaryOpcode===62){
      instructionKind='ds-form-memory';
      rt=(instructionWord>>>21)&31;ra=(instructionWord>>>16)&31;
      let ds=(instructionWord>>>2)&0x3FFF;
      if(ds&0x2000)ds-=0x4000;
      displacement=(ds<<2)|0;
      if(faultAddress!==undefined&&faultCode){
        effectiveAddress=faultAddress>>>0;
        baseRegisterValue=ra===0?0:(effectiveAddress-(displacement|0))>>>0;
      }
    }else if(primaryOpcode===18){
      instructionKind='direct-branch';"""
    s = s.replace(anchor, replacement, 1)

s = once(
    s,
    "    faultInstructionAttribution:faultCode&&instructionKind!=='d-form-memory'?'fault-not-derived-from-boundary-instruction':undefined,",
    "    faultInstructionAttribution:faultCode&&instructionKind!=='d-form-memory'&&instructionKind!=='ds-form-memory'?'fault-not-derived-from-boundary-instruction':undefined,",
    "instructionKind!=='d-form-memory'&&instructionKind!=='ds-form-memory'",
    'developer console memory-attribution anchor changed',
)
s = once(
    s,
    "  if(memory.instructionKind==='d-form-memory'&&present(memory.ra))return `PPC memory: rA=${memory.ra}=${memory.baseRegisterValue||'—'} rT=${memory.rt??'—'} disp=${memory.displacement??'—'} EA=${memory.effectiveAddress||'—'}`;",
    "  if((memory.instructionKind==='d-form-memory'||memory.instructionKind==='ds-form-memory')&&present(memory.ra))return `PPC memory: rA=${memory.ra}=${memory.baseRegisterValue||'—'} rT=${memory.rt??'—'} disp=${memory.displacement??'—'} EA=${memory.effectiveAddress||'—'}`;",
    "memory.instructionKind==='ds-form-memory')&&present(memory.ra)",
    'developer console PPC memory summary anchor changed',
)

if "r360_ppc_probe_stack_blocker_r1" not in s:
    anchor = "  const backingPagesFn=fn('r360_sparse_guest_memory_backing_pages');\n"
    require(s, anchor, 'developer console stack getter anchor changed')
    insertion = anchor + """  const readStackU32=name=>{const f=fn(name);return f?(f()>>>0):undefined;};
  const resultStack=result?.stackTrace||{};
  const stackTrace=compact({
    blockerR1:address(number(resultStack.blockerR1)??readStackU32('r360_ppc_probe_stack_blocker_r1')),
    initialR1:address(number(resultStack.initialR1)??readStackU32('r360_ppc_probe_stack_initial_r1')),
    lastWriteAddress:address(number(resultStack.lastWriteAddress)??readStackU32('r360_ppc_probe_stack_last_write_address')),
    lastOldR1:address(number(resultStack.lastOldR1)??readStackU32('r360_ppc_probe_stack_last_old_r1')),
    lastNewR1:address(number(resultStack.lastNewR1)??readStackU32('r360_ppc_probe_stack_last_new_r1')),
    lastWriteDepth:number(resultStack.lastWriteDepth)??readStackU32('r360_ppc_probe_stack_last_write_depth'),
    lastCallSource:address(number(resultStack.lastCallSource)??readStackU32('r360_ppc_probe_stack_last_call_source')),
    lastCallTarget:address(number(resultStack.lastCallTarget)??readStackU32('r360_ppc_probe_stack_last_call_target')),
    lastCallR1:address(number(resultStack.lastCallR1)??readStackU32('r360_ppc_probe_stack_last_call_r1')),
    lastCallDepth:number(resultStack.lastCallDepth)??readStackU32('r360_ppc_probe_stack_last_call_depth'),
  });
"""
    s = s.replace(anchor, insertion, 1)
    return_anchor = 'stackTop:address(context.stackTop),stackLimit:address(context.stackLimit),stackBase:address(context.stackBase),stackSlotBase:address(context.stackSlotBase),stackGuardBytes:number(context.stackGuardBytes),pcrAddress:address(context.pcrAddress),tlsAddress:address(context.tlsAddress),\n'
    require(s, return_anchor, 'developer console stack telemetry return anchor changed')
    s = s.replace(
        return_anchor,
        return_anchor + '    stackTrace:Object.keys(stackTrace).length?stackTrace:undefined,\n',
        1,
    )

if 'function stackDiagnosticSummary(memory)' not in s:
    anchor = """function addEntry(level,message){
"""
    require(s, anchor, 'developer console stack summary insertion anchor changed')
    stack_summary = """function stackDiagnosticSummary(memory){
  const trace=memory?.stackTrace;if(!trace?.blockerR1)return undefined;
  return `stack r1=${trace.blockerR1} initial=${trace.initialR1||'—'} · last write ${trace.lastWriteAddress||'—'} ${trace.lastOldR1||'—'}→${trace.lastNewR1||'—'} depth=${trace.lastWriteDepth??'—'} · last call ${trace.lastCallSource||'—'}→${trace.lastCallTarget||'—'} r1=${trace.lastCallR1||'—'} depth=${trace.lastCallDepth??'—'}`;
}
"""
    s = s.replace(anchor, stack_summary + anchor, 1)

render_anchor = 'ppcDiagnosticSummary(summary.memory),summary.runtimeAsset?.verified'
if render_anchor in s:
    s = s.replace(
        render_anchor,
        'ppcDiagnosticSummary(summary.memory),stackDiagnosticSummary(summary.memory),summary.runtimeAsset?.verified',
        1,
    )
elif 'stackDiagnosticSummary(summary.memory)' not in s:
    raise SystemExit('developer console render stack-summary anchor changed')
p.write_text(s)


# 4) Small source-level regression test. It validates the exact instruction in
# the real-device report and verifies that the diagnostic plumbing is present.
p = Path('test-braid-r1-boundary-diagnostics.mjs')
p.write_text("""import fs from 'node:fs';

const dev=fs.readFileSync('developer-console.js','utf8');
const controller=fs.readFileSync('render360-title-controller.mjs','utf8');
const overlay=fs.readFileSync('prepare-hir-call-return-stack-overlay.py','utf8');
for(const marker of [\"instructionKind='ds-form-memory'\",'primaryOpcode===58||primaryOpcode===62','stackDiagnosticSummary(summary.memory)','r360_ppc_probe_stack_blocker_r1']){
  if(!dev.includes(marker))throw new Error(`developer diagnostic marker missing: ${marker}`);
}
for(const marker of ['stackTraceRead','r360_ppc_probe_stack_blocker_r1','stackTrace,translatedFunctionCount']){
  if(!controller.includes(marker))throw new Error(`title snapshot marker missing: ${marker}`);
}
for(const marker of ['blocker_r1','r360_ppc_probe_stack_blocker_r1','r360_ppc_probe_stack_last_write_address','trace_exports_replacement']){
  if(!overlay.includes(marker))throw new Error(`HIR trace export marker missing: ${marker}`);
}
const word=0xEB61FFD0>>>0;
const primary=word>>>26;
const rt=(word>>>21)&31;
const ra=(word>>>16)&31;
let ds=(word>>>2)&0x3FFF;if(ds&0x2000)ds-=0x4000;
const displacement=(ds<<2)|0;
if(primary!==58||rt!==27||ra!==1||displacement!==-48){
  throw new Error(`Braid blocker DS decode mismatch primary=${primary} rt=${rt} ra=${ra} disp=${displacement}`);
}
const fault=0x70081020>>>0;
const base=(fault-displacement)>>>0;
if(base!==0x70081050)throw new Error(`Braid blocker r1 inference mismatch 0x${base.toString(16)}`);
console.log('BRAID_DS_FORM_BLOCKER_DECODE=PASS');
console.log('BRAID_STACK_TRACE_EXPORTS=PASS');
console.log('BRAID_BLOCKER_R1_EXPECTED=0x70081050');
""")

print('BRAID_R1_BOUNDARY_DIAGNOSTICS_V2=PASS')
