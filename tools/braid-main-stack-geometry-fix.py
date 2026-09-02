from pathlib import Path


def replace_once(text: str, old: str, new: str, marker: str, error: str) -> str:
    if old in text:
        return text.replace(old, new, 1)
    if marker in text:
        return text
    raise SystemExit(error)


# ---------------------------------------------------------------------------
# Browser main-thread stack: match Xenia's lower-guard geometry.
# ---------------------------------------------------------------------------
p = Path('render360-title-controller.mjs')
s = p.read_text()
s = replace_once(
    s,
    """  const pageSize=4096;
  const stackBase=0x70000000;
  const stackPages=128;
  const stackLimit=stackBase;
  // Xenia ThreadState starts r1 at the high stack boundary. Processor::Execute
  // then reserves 64 + 112 bytes before entering guest code. We previously
  // entered default.xex with an invented -0x100 stack pointer, which is not the
  // Xenia/Xbox entry ABI and can make title prologues consume zeroed slots.
  const stackBasePointer=(stackBase+stackPages*pageSize)>>>0;
""",
    """  const pageSize=4096;
  // Match Xenia XThread::AllocateStack: one unmapped guard page precedes the
  // usable stack, stack_limit points immediately above that guard, and
  // stack_base is the high boundary. Keeping the guard inside the 0x70000000
  // slot also fixes the old one-page downward shift that left 0x70080020 just
  // beyond Render360's stack even though it is inside the Xenia geometry.
  const stackSlotBase=0x70000000;
  const stackGuardBytes=pageSize;
  const stackLimit=(stackSlotBase+stackGuardBytes)>>>0;
  const stackPages=128;
  // Xenia ThreadState starts r1 at the high stack boundary. Processor::Execute
  // then reserves 64 + 112 bytes before entering guest code.
  const stackBasePointer=(stackLimit+stackPages*pageSize)>>>0;
""",
    'const stackSlotBase=0x70000000;',
    'title main-thread stack geometry anchor changed',
)
s = replace_once(
    s,
    """  const stackBacking=alloc(stackPages)>>>0;
  if(!stackBacking||(map(stackBase,stackPages,stackBacking,0,readWrite)>>>0)!==1)throw new Error('unable to map Xbox main-thread stack');
""",
    """  const stackBacking=alloc(stackPages)>>>0;
  if(!stackBacking||(map(stackLimit,stackPages,stackBacking,0,readWrite)>>>0)!==1)throw new Error('unable to map Xbox main-thread stack');
""",
    'map(stackLimit,stackPages,stackBacking,0,readWrite)',
    'title stack mapping anchor changed',
)
s = replace_once(
    s,
    'be32(threadAddress+0x0D0,stackBase);',
    'be32(threadAddress+0x0D0,stackBasePointer);',
    'be32(threadAddress+0x0D0,stackBasePointer)',
    'title XTHREAD stack-base anchor changed',
)
s = replace_once(
    s,
    "return {kind:'xenia-main-thread-context',stackBase,stackLimit,stackBasePointer,stackTop,xeniaCallFrameBytes,pcrAddress,tlsAddress,threadAddress,startAddress:entry>>>0,stackBytes:stackPages*pageSize,zeroPageCompat:true,lowMemoryCompatBytes:lowMemoryPages*pageSize};",
    "return {kind:'xenia-main-thread-context',stackSlotBase,stackBase:stackBasePointer,stackLimit,stackBasePointer,stackTop,stackGuardBytes,xeniaCallFrameBytes,pcrAddress,tlsAddress,threadAddress,startAddress:entry>>>0,stackBytes:stackPages*pageSize,zeroPageCompat:true,lowMemoryCompatBytes:lowMemoryPages*pageSize};",
    'stackSlotBase,stackBase:stackBasePointer',
    'title main-thread telemetry anchor changed',
)
p.write_text(s)


# ---------------------------------------------------------------------------
# Generic guest threads: default 256 KiB, two guards, reserve browser slot 16.
# ---------------------------------------------------------------------------
p = Path('src/xenia_web_bootstrap/kernel_runtime_foundation.cpp')
s = p.read_text()
s = replace_once(
    s,
    """// Browser guest stacks live in a dedicated 512 MiB sparse virtual arena below
// the normal 0x82000000 retail XEX region. Each thread owns a 16 MiB slot, and
// the first page is intentionally left unmapped as a downward-growing stack
// guard.
constexpr uint32_t kGuestStackArenaBase = 0x60000000u;
constexpr uint32_t kGuestStackSlotStride = 0x01000000u;
constexpr uint32_t kGuestStackGuardBytes = kGuestPageSize;
constexpr uint32_t kGuestStackTopReserve = 0x100u;
constexpr uint32_t kGuestStackMaxBytes =
    kGuestStackSlotStride - kGuestStackGuardBytes;
""",
    """// Browser guest stacks live in a dedicated 512 MiB sparse virtual arena below
// the normal 0x82000000 retail XEX region. Each thread owns a 16 MiB slot with
// an unmapped guard page at both the low and high ends, matching Xenia's
// XThread::AllocateStack geometry. Slot 16 is reserved for the browser-created
// main thread at 0x70000000 so later guest-thread creation cannot collide with
// the launch context.
constexpr uint32_t kGuestStackArenaBase = 0x60000000u;
constexpr uint32_t kGuestStackSlotStride = 0x01000000u;
constexpr uint32_t kGuestStackGuardBytes = kGuestPageSize;
constexpr uint32_t kGuestStackDefaultBytes = 0x00040000u;  // 256 KiB.
constexpr uint32_t kGuestStackTopReserve = 0x100u;
constexpr uint32_t kBrowserMainThreadReservedSlot = 16u;
constexpr uint32_t kGuestStackMaxBytes =
    kGuestStackSlotStride - 2u * kGuestStackGuardBytes;
""",
    'kGuestStackDefaultBytes',
    'kernel stack constants anchor changed',
)
s = replace_once(
    s,
    """  const uint64_t base64 = slot64 + kGuestStackGuardBytes;
  const uint64_t end64 = base64 + stack_size;
  if (end64 > uint64_t(kGuestStackArenaBase) + 0x20000000ull ||
      end64 > 0x100000000ull) {
    return false;
  }
""",
    """  const uint64_t base64 = slot64 + kGuestStackGuardBytes;
  const uint64_t end64 = base64 + stack_size;
  const uint64_t upper_guard_end64 = end64 + kGuestStackGuardBytes;
  if (upper_guard_end64 > slot64 + kGuestStackSlotStride ||
      upper_guard_end64 > uint64_t(kGuestStackArenaBase) + 0x20000000ull ||
      upper_guard_end64 > 0x100000000ull) {
    return false;
  }
""",
    'upper_guard_end64',
    'kernel stack upper-guard anchor changed',
)
s = replace_once(
    s,
    'if (!stack_size) stack_size = 0x4000u;',
    'if (!stack_size) stack_size = kGuestStackDefaultBytes;',
    'stack_size = kGuestStackDefaultBytes',
    'kernel default stack anchor changed',
)
s = replace_once(
    s,
    """  for (uint32_t i = 0; i < g_threads.size(); ++i) {
    auto& thread = g_threads[i];
    if (thread.state != ThreadState::kUnused &&
        thread.state != ThreadState::kTerminated) {
      continue;
    }
""",
    """  for (uint32_t i = 0; i < g_threads.size(); ++i) {
    // The JavaScript title handoff owns this entire 16 MiB slot for the real
    // main-thread stack/PCR launch context. Never let a later kernel-created
    // thread alias it.
    if (i == kBrowserMainThreadReservedSlot) continue;
    auto& thread = g_threads[i];
    if (thread.state != ThreadState::kUnused &&
        thread.state != ThreadState::kTerminated) {
      continue;
    }
""",
    'i == kBrowserMainThreadReservedSlot',
    'kernel thread-slot loop anchor changed',
)
p.write_text(s)


# ---------------------------------------------------------------------------
# Developer Console: decode the PPC instruction according to its actual form.
# ---------------------------------------------------------------------------
p = Path('developer-console.js')
s = p.read_text()
start = s.index('function memoryDiagnostics(state,result){')
end = s.index('function addEntry(level,message){', start)
replacement = r'''function memoryDiagnostics(state,result){
  const bootstrap=state?.bootstrap,exp=bootstrap?.exports||{};
  const fn=name=>{const value=exp[name]??exp[`_${name}`];return typeof value==='function'?value:null;};
  const faultAddressFn=fn('r360_sparse_guest_memory_last_fault_address');
  const faultCodeFn=fn('r360_sparse_guest_memory_last_fault_code');
  const mappedPagesFn=fn('r360_sparse_guest_memory_mapped_pages');
  const backingPagesFn=fn('r360_sparse_guest_memory_backing_pages');
  const capturedFaultAddress=number(result?.memoryFaultAddress);
  const capturedFaultCode=number(result?.memoryFaultCode);
  const faultAddress=capturedFaultAddress!==undefined?capturedFaultAddress:(faultAddressFn?(faultAddressFn()>>>0):undefined);
  const faultCode=capturedFaultCode!==undefined?capturedFaultCode:(faultCodeFn?(faultCodeFn()>>>0):undefined);
  const blockerAddress=number(result?.executionBlockerAddress);
  let instructionWord,primaryOpcode,instructionKind='unknown';
  let rt,ra,displacement,baseRegisterValue,effectiveAddress;
  let branchDisplacement,branchTarget,branchAbsolute,branchLink,branchBO,branchBI;
  const read8=fn('r360_sparse_guest_memory_read_u8');
  if(read8&&blockerAddress!==undefined){
    const a=blockerAddress>>>0;
    const bytes=[0,1,2,3].map(i=>read8((a+i)>>>0)>>>0);
    instructionWord=((bytes[0]<<24)|(bytes[1]<<16)|(bytes[2]<<8)|bytes[3])>>>0;
    primaryOpcode=instructionWord>>>26;
    if(primaryOpcode>=32&&primaryOpcode<=55){
      instructionKind='d-form-memory';
      rt=(instructionWord>>>21)&31;ra=(instructionWord>>>16)&31;
      displacement=(instructionWord<<16)>>16;
      if(faultAddress!==undefined&&faultCode){
        effectiveAddress=faultAddress>>>0;
        baseRegisterValue=ra===0?0:(effectiveAddress-(displacement|0))>>>0;
      }
    }else if(primaryOpcode===18){
      instructionKind='direct-branch';
      const li=instructionWord&0x03FFFFFC;
      branchDisplacement=((li&0x02000000)?(li|0xFC000000):li)|0;
      branchAbsolute=!!(instructionWord&2);branchLink=!!(instructionWord&1);
      branchTarget=(branchAbsolute?branchDisplacement:(a+branchDisplacement))>>>0;
    }else if(primaryOpcode===16){
      instructionKind='conditional-branch';
      const bd=instructionWord&0x0000FFFC;
      branchDisplacement=(bd<<16)>>16;
      branchAbsolute=!!(instructionWord&2);branchLink=!!(instructionWord&1);
      branchBO=(instructionWord>>>21)&31;branchBI=(instructionWord>>>16)&31;
      branchTarget=(branchAbsolute?branchDisplacement:(a+branchDisplacement))>>>0;
    }else{
      instructionKind='other';
    }
  }
  const faultNames={0:'none',1:'unmapped',2:'read-protection',3:'write-protection',4:'invalid-argument',5:'already-mapped'};
  const context=result?.mainThreadContext||{};
  return compact({
    faultAddress:faultAddress===undefined?undefined:address(faultAddress),
    faultCode,faultName:faultCode===undefined?undefined:(faultNames[faultCode]||`fault-${faultCode}`),
    faultCapturedAtExecution:capturedFaultCode!==undefined,
    blockerInstruction:instructionWord===undefined?undefined:`0x${instructionWord.toString(16).toUpperCase().padStart(8,'0')}`,
    instructionKind,ppcPrimaryOpcode:primaryOpcode,rt,ra,displacement,
    effectiveAddress:effectiveAddress===undefined?undefined:address(effectiveAddress),
    baseRegisterValue:baseRegisterValue===undefined?undefined:address(baseRegisterValue),
    branchDisplacement,branchTarget:branchTarget===undefined?undefined:address(branchTarget),
    branchAbsolute,branchLink,branchBO,branchBI,
    faultInstructionAttribution:faultCode&&instructionKind!=='d-form-memory'?'fault-not-derived-from-boundary-instruction':undefined,
    mappedPages:mappedPagesFn?(mappedPagesFn()>>>0):undefined,backingPages:backingPagesFn?(backingPagesFn()>>>0):undefined,
    stackTop:address(context.stackTop),stackLimit:address(context.stackLimit),stackBase:address(context.stackBase),stackSlotBase:address(context.stackSlotBase),stackGuardBytes:number(context.stackGuardBytes),pcrAddress:address(context.pcrAddress),tlsAddress:address(context.tlsAddress),
  });
}
function ppcDiagnosticSummary(memory){
  if(!memory?.blockerInstruction)return undefined;
  if(memory.instructionKind==='d-form-memory'&&present(memory.ra))return `PPC memory: rA=${memory.ra}=${memory.baseRegisterValue||'—'} rT=${memory.rt??'—'} disp=${memory.displacement??'—'} EA=${memory.effectiveAddress||'—'}`;
  if(memory.instructionKind==='direct-branch'||memory.instructionKind==='conditional-branch')return `PPC ${memory.instructionKind}: target=${memory.branchTarget||'—'} disp=${memory.branchDisplacement??'—'} AA=${memory.branchAbsolute?1:0} LK=${memory.branchLink?1:0}${memory.faultInstructionAttribution?' · memory fault belongs to an earlier/different boundary':''}`;
  return `PPC ${memory.instructionKind||'other'} · primary opcode ${memory.ppcPrimaryOpcode??'—'}`;
}
'''
s = s[:start] + replacement + s[end:]
old_render = "present(summary.memory?.ra)&&`PPC operands: rA=${summary.memory.ra}=${summary.memory.baseRegisterValue||'—'} rT=${summary.memory.rt??'—'} disp=${summary.memory.displacement??'—'} EA=${summary.memory.effectiveAddress||'—'}`"
if old_render in s:
    s = s.replace(old_render, 'ppcDiagnosticSummary(summary.memory)', 1)
elif 'ppcDiagnosticSummary(summary.memory)' not in s:
    raise SystemExit('developer console render anchor changed')
p.write_text(s)


# ---------------------------------------------------------------------------
# Braid startup critic: exact guarded main-stack layout and 0x70080020 mapping.
# ---------------------------------------------------------------------------
p = Path('test-braid-startup-critic.mjs')
s = p.read_text()
old_markers = "for(const marker of [\"const lowMemoryPages=0x10000/pageSize\",\"map(0,lowMemoryPages,lowMemoryBacking,0,readWrite)\",\"lowMemoryCompatBytes:lowMemoryPages*pageSize\",\"applyInitialGprs(bootstrap,{1:mainThreadContext.stackTop,13:mainThreadContext.pcrAddress})\",\"r360_ppc_probe_page_sparse_code\",\"xenia-main-thread-context\"])"
new_markers = "for(const marker of [\"const lowMemoryPages=0x10000/pageSize\",\"map(0,lowMemoryPages,lowMemoryBacking,0,readWrite)\",\"const stackSlotBase=0x70000000\",\"const stackLimit=(stackSlotBase+stackGuardBytes)>>>0\",\"map(stackLimit,stackPages,stackBacking,0,readWrite)\",\"be32(threadAddress+0x0D0,stackBasePointer)\",\"lowMemoryCompatBytes:lowMemoryPages*pageSize\",\"applyInitialGprs(bootstrap,{1:mainThreadContext.stackTop,13:mainThreadContext.pcrAddress})\",\"r360_ppc_probe_page_sparse_code\",\"xenia-main-thread-context\"])"
s = replace_once(s, old_markers, new_markers, 'const stackSlotBase=0x70000000', 'Braid critic marker anchor changed')
s = replace_once(
    s,
    """if(!lowBacking||(p('r360_sparse_guest_memory_map')(0,lowPages,lowBacking,0,3)>>>0)!==1)throw new Error('LOW_64K_APERTURE_MAPPED failed');
if((p('r360_ppc_probe_set_initial_gpr')(1,BigInt(0x7007ff50))>>>0)!==1)throw new Error('MAIN_THREAD_R1_VALID failed');
""",
    """if(!lowBacking||(p('r360_sparse_guest_memory_map')(0,lowPages,lowBacking,0,3)>>>0)!==1)throw new Error('LOW_64K_APERTURE_MAPPED failed');
const stackSlotBase=0x70000000,stackLimit=0x70001000,stackPages=128,stackBasePointer=0x70081000,stackTop=(stackBasePointer-176)&~15;
const stackBacking=p('r360_sparse_guest_memory_alloc')(stackPages)>>>0;
if(!stackBacking||(p('r360_sparse_guest_memory_map')(stackLimit,stackPages,stackBacking,0,3)>>>0)!==1)throw new Error('XENIA_MAIN_STACK_GEOMETRY failed');
if((p('r360_ppc_probe_write_guest_u32_be')(stackSlotBase,0xBAD0BAD0)>>>0)!==0)throw new Error('MAIN_STACK_LOW_GUARD failed');
if((p('r360_ppc_probe_write_guest_u32_be')(0x70080020,0x13579BDF)>>>0)!==1||(p('r360_ppc_probe_read_guest_u32_be')(0x70080020)>>>0)!==0x13579BDF)throw new Error('BRAID_70080020_STACK_ADDRESS failed');
if((p('r360_ppc_probe_write_guest_u32_be')(stackBasePointer,0xBAD1BAD1)>>>0)!==0)throw new Error('MAIN_STACK_HIGH_GUARD failed');
if((p('r360_ppc_probe_set_initial_gpr')(1,BigInt(stackTop))>>>0)!==1)throw new Error('MAIN_THREAD_R1_VALID failed');
""",
    'BRAID_70080020_STACK_ADDRESS',
    'Braid critic stack setup anchor changed',
)
if "console.log('XENIA_MAIN_STACK_GEOMETRY=PASS')" not in s:
    s = s.replace(
        "console.log('LOW_64K_APERTURE_MAPPED=PASS');console.log('MAIN_THREAD_R1_VALID=PASS');",
        "console.log('LOW_64K_APERTURE_MAPPED=PASS');console.log('XENIA_MAIN_STACK_GEOMETRY=PASS');console.log('BRAID_70080020_STACK_ADDRESS=PASS');console.log('MAIN_THREAD_R1_VALID=PASS');",
        1,
    )
p.write_text(s)


# ---------------------------------------------------------------------------
# Opcode39 fixture: same production main-thread stack geometry.
# ---------------------------------------------------------------------------
p = Path('test-opcode39-main-thread.mjs')
s = p.read_text()
s = replace_once(
    s,
    """const stackBase=0x70000000;
const stackPages=128;
const stackTop=0x7007ff00;
const backing=p('r360_sparse_guest_memory_alloc')(stackPages)>>>0;
if(!backing)throw new Error('stack backing allocation failed');
if((p('r360_sparse_guest_memory_map')(stackBase,stackPages,backing,0,3)>>>0)!==1)throw new Error('stack mapping failed');
""",
    """const stackSlotBase=0x70000000;
const stackLimit=0x70001000;
const stackPages=128;
const stackBasePointer=stackLimit+stackPages*4096;
const stackTop=(stackBasePointer-(64+112))&~15;
const backing=p('r360_sparse_guest_memory_alloc')(stackPages)>>>0;
if(!backing)throw new Error('stack backing allocation failed');
if((p('r360_sparse_guest_memory_map')(stackLimit,stackPages,backing,0,3)>>>0)!==1)throw new Error('stack mapping failed');
if((p('r360_sparse_guest_memory_write_u32_be')(stackSlotBase,0xBAD0BAD0)>>>0)!==0)throw new Error('lower stack guard unexpectedly mapped');
if((p('r360_sparse_guest_memory_write_u32_be')(0x70080020,0x01020304)>>>0)!==1)throw new Error('Braid high-side stack address is not mapped');
if((p('r360_sparse_guest_memory_write_u32_be')(stackBasePointer,0xBAD1BAD1)>>>0)!==0)throw new Error('upper stack guard unexpectedly mapped');
""",
    'Braid high-side stack address is not mapped',
    'opcode39 stack fixture anchor changed',
)
s = s.replace(
    "// Braid's first observed compatibility state produced 0x7007FF58, exactly\n// stackTop + 0x58. Exercise a real PPC lwz through finalized HIR OPCODE_LOAD\n// against that sparse main-thread stack address.",
    "// Exercise a real PPC lwz through finalized HIR OPCODE_LOAD using the same\n// Xenia-style guarded main-thread stack geometry as production.",
    1,
)
p.write_text(s)


# ---------------------------------------------------------------------------
# Generic guest-runtime critic: default stack, both guards, reserved slot 16.
# ---------------------------------------------------------------------------
p = Path('test-guest-runtime-critic.mjs')
s = p.read_text()
s = replace_once(
    s,
    "const a=pick('r360_guest_thread_create')(0x82001000,0x1111,1,0xA5)>>>0;const b=pick('r360_guest_thread_create')(0x82002000,0x2222,0x5000,0x5A)>>>0;if(!a||!b||a===b)throw new Error('thread creation/identity failed');if((pick('r360_guest_thread_stack_size')(a)>>>0)!==0x4000||(pick('r360_guest_thread_stack_size')(b)>>>0)!==0x8000)throw new Error('stack alignment failed');",
    "const a=pick('r360_guest_thread_create')(0x82001000,0x1111,1,0xA5)>>>0;const b=pick('r360_guest_thread_create')(0x82002000,0x2222,0x5000,0x5A)>>>0;const defaultThread=pick('r360_guest_thread_create')(0x82002500,0,0,0)>>>0;if(!a||!b||!defaultThread||a===b)throw new Error('thread creation/identity failed');if((pick('r360_guest_thread_stack_size')(a)>>>0)!==0x4000||(pick('r360_guest_thread_stack_size')(b)>>>0)!==0x8000)throw new Error('stack alignment failed');if((pick('r360_guest_thread_stack_size')(defaultThread)>>>0)!==0x40000)throw new Error('default guest stack must be 256 KiB');",
    'default guest stack must be 256 KiB',
    'guest runtime default-stack anchor changed',
)
s = replace_once(
    s,
    "if((pick('r360_sparse_guest_memory_write_u8')(stackBaseA,0x7B)>>>0)!==1||(pick('r360_sparse_guest_memory_read_u8')(stackBaseA)>>>0)!==0x7B)throw new Error('thread stack is not backed by sparse guest RAM');if((pick('r360_sparse_guest_memory_write_u8')((stackBaseA-1)>>>0,0x55)>>>0)!==0||(pick('r360_sparse_guest_memory_last_fault_code')()>>>0)!==1)throw new Error('thread stack guard page is not fail-closed/unmapped');\nconsole.log('GUEST_RUNTIME_THREAD_CREATE=PASS');console.log('GUEST_RUNTIME_THREAD_STACK_MAPPING=PASS');console.log('GUEST_RUNTIME_THREAD_STACK_GUARD=PASS');console.log('GUEST_RUNTIME_THREAD_METADATA=PASS');",
    "if((pick('r360_sparse_guest_memory_write_u8')(stackBaseA,0x7B)>>>0)!==1||(pick('r360_sparse_guest_memory_read_u8')(stackBaseA)>>>0)!==0x7B)throw new Error('thread stack is not backed by sparse guest RAM');if((pick('r360_sparse_guest_memory_write_u8')((stackBaseA-1)>>>0,0x55)>>>0)!==0||(pick('r360_sparse_guest_memory_last_fault_code')()>>>0)!==1)throw new Error('thread lower stack guard page is not fail-closed/unmapped');const stackSizeA=pick('r360_guest_thread_stack_size')(a)>>>0;if((pick('r360_sparse_guest_memory_write_u8')((stackBaseA+stackSizeA)>>>0,0x56)>>>0)!==0||(pick('r360_sparse_guest_memory_last_fault_code')()>>>0)!==1)throw new Error('thread upper stack guard page is not fail-closed/unmapped');\nconsole.log('GUEST_RUNTIME_THREAD_CREATE=PASS');console.log('GUEST_RUNTIME_DEFAULT_STACK_256K=PASS');console.log('GUEST_RUNTIME_THREAD_STACK_MAPPING=PASS');console.log('GUEST_RUNTIME_THREAD_STACK_GUARDS=PASS');console.log('GUEST_RUNTIME_THREAD_METADATA=PASS');",
    'GUEST_RUNTIME_THREAD_STACK_GUARDS=PASS',
    'guest runtime guard anchor changed',
)
if 'GUEST_RUNTIME_BROWSER_MAIN_STACK_SLOT_RESERVED=PASS' not in s:
    s += """

// The browser launch context occupies guest stack slot 16 (0x70000000).
pick('r360_kernel_runtime_reset')();
for(let i=0;i<17;i++){
  const h=pick('r360_guest_thread_create')(0x82100000+i*4,0,0x4000,0)>>>0;
  if(!h)throw new Error(`reserved-slot setup failed at thread ${i}`);
  const base=pick('r360_guest_thread_stack_base')(h)>>>0;
  if(base>=0x70000000&&base<0x71000000)throw new Error(`kernel thread collided with browser main stack slot at 0x${base.toString(16)}`);
}
console.log('GUEST_RUNTIME_BROWSER_MAIN_STACK_SLOT_RESERVED=PASS');
"""
p.write_text(s)


# ---------------------------------------------------------------------------
# UI contract: preserve opcode-aware developer diagnostics.
# ---------------------------------------------------------------------------
p = Path('test-ui-contract.mjs')
s = p.read_text()
anchor = "for(const token of ['runtimeBlocker','fatalError','render360-blocker-report-v1','render360PpcRuntimeIdentity'])must(has(developerConsole,token),`developer console missing ${token}`);"
if 'opcode-aware diagnostic' not in s:
    if anchor not in s:
        raise SystemExit('UI developer-console contract anchor changed')
    s = s.replace(
        anchor,
        anchor + "\nfor(const token of ['instructionKind','direct-branch','branchTarget','fault-not-derived-from-boundary-instruction','ppcDiagnosticSummary'])must(has(developerConsole,token),`developer console missing opcode-aware diagnostic ${token}`);",
        1,
    )
p.write_text(s)


# Final static invariants.
kernel = Path('src/xenia_web_bootstrap/kernel_runtime_foundation.cpp').read_text()
for marker in [
    'kGuestStackDefaultBytes = 0x00040000u',
    'kBrowserMainThreadReservedSlot = 16u',
    'kGuestStackSlotStride - 2u * kGuestStackGuardBytes',
    'upper_guard_end64',
    'i == kBrowserMainThreadReservedSlot',
]:
    if marker not in kernel:
        raise SystemExit(f'missing kernel stack invariant: {marker}')
controller = Path('render360-title-controller.mjs').read_text()
for marker in [
    'const stackLimit=(stackSlotBase+stackGuardBytes)>>>0',
    'const stackBasePointer=(stackLimit+stackPages*pageSize)>>>0',
    'map(stackLimit,stackPages,stackBacking,0,readWrite)',
    'be32(threadAddress+0x0D0,stackBasePointer)',
]:
    if marker not in controller:
        raise SystemExit(f'missing title stack invariant: {marker}')

print('R360_XENIA_MAIN_STACK_GUARD_GEOMETRY=ENABLED')
print('R360_GUEST_THREAD_DEFAULT_STACK=0x40000')
print('R360_BROWSER_MAIN_STACK_SLOT=RESERVED_16')
print('R360_PPC_DIAGNOSTICS=OPCODE_AWARE')
