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


# Browser main thread: Xenia leaves a low guard page, then stack_limit, and the
# usable stack extends upward to stack_base (high boundary).
p = Path('render360-title-controller.mjs')
s = p.read_text()
s = once(
    s,
    "  const stackBase=0x70000000;\n  const stackPages=128;\n  const stackLimit=stackBase;",
    "  const stackSlotBase=0x70000000;\n  const stackGuardBytes=pageSize;\n  const stackLimit=(stackSlotBase+stackGuardBytes)>>>0;\n  const stackPages=128;",
    'const stackSlotBase=0x70000000;',
    'title stack base/limit anchor changed',
)
s = once(
    s,
    'const stackBasePointer=(stackBase+stackPages*pageSize)>>>0;',
    'const stackBasePointer=(stackLimit+stackPages*pageSize)>>>0;',
    'const stackBasePointer=(stackLimit+stackPages*pageSize)>>>0;',
    'title stack high-boundary anchor changed',
)
s = once(
    s,
    'map(stackBase,stackPages,stackBacking,0,readWrite)',
    'map(stackLimit,stackPages,stackBacking,0,readWrite)',
    'map(stackLimit,stackPages,stackBacking,0,readWrite)',
    'title stack sparse mapping anchor changed',
)
s = once(
    s,
    'be32(threadAddress+0x0D0,stackBase);',
    'be32(threadAddress+0x0D0,stackBasePointer);',
    'be32(threadAddress+0x0D0,stackBasePointer);',
    'XTHREAD stack-base field anchor changed',
)
s = once(
    s,
    "return {kind:'xenia-main-thread-context',stackBase,stackLimit,stackBasePointer,stackTop,xeniaCallFrameBytes,pcrAddress,tlsAddress,threadAddress,startAddress:entry>>>0,stackBytes:stackPages*pageSize,zeroPageCompat:true,lowMemoryCompatBytes:lowMemoryPages*pageSize};",
    "return {kind:'xenia-main-thread-context',stackSlotBase,stackBase:stackBasePointer,stackLimit,stackBasePointer,stackTop,stackGuardBytes,xeniaCallFrameBytes,pcrAddress,tlsAddress,threadAddress,startAddress:entry>>>0,stackBytes:stackPages*pageSize,zeroPageCompat:true,lowMemoryCompatBytes:lowMemoryPages*pageSize};",
    'stackSlotBase,stackBase:stackBasePointer',
    'title stack telemetry anchor changed',
)
p.write_text(s)


# Kernel-created guest threads: 256 KiB default when the title doesn't request
# a size, Xenia-style upper/lower guards, and no allocation in slot 16 because
# the browser main thread owns 0x70000000-0x70FFFFFF.
p = Path('src/xenia_web_bootstrap/kernel_runtime_foundation.cpp')
s = p.read_text()
s = once(
    s,
    'constexpr uint32_t kGuestStackGuardBytes = kGuestPageSize;\nconstexpr uint32_t kGuestStackTopReserve = 0x100u;',
    'constexpr uint32_t kGuestStackGuardBytes = kGuestPageSize;\nconstexpr uint32_t kGuestStackDefaultBytes = 0x00040000u;  // 256 KiB.\nconstexpr uint32_t kGuestStackTopReserve = 0x100u;\nconstexpr uint32_t kBrowserMainThreadReservedSlot = 16u;',
    'kGuestStackDefaultBytes = 0x00040000u',
    'kernel stack constant insertion anchor changed',
)
s = once(
    s,
    'kGuestStackSlotStride - kGuestStackGuardBytes;',
    'kGuestStackSlotStride - 2u * kGuestStackGuardBytes;',
    'kGuestStackSlotStride - 2u * kGuestStackGuardBytes;',
    'kernel max-stack guard geometry anchor changed',
)
s = once(
    s,
    """  const uint64_t end64 = base64 + stack_size;
  if (end64 > uint64_t(UINT32_MAX) + 1u ||
      end64 > slot64 + kGuestStackSlotStride) {
    return false;
  }
""",
    """  const uint64_t end64 = base64 + stack_size;
  const uint64_t upper_guard_end64 = end64 + kGuestStackGuardBytes;
  if (upper_guard_end64 > uint64_t(UINT32_MAX) + 1u ||
      upper_guard_end64 > slot64 + kGuestStackSlotStride) {
    return false;
  }
""",
    'const uint64_t upper_guard_end64',
    'kernel upper guard range anchor changed',
)
s = once(
    s,
    'if (!stack_size) stack_size = 0x4000u;',
    'if (!stack_size) stack_size = kGuestStackDefaultBytes;',
    'stack_size = kGuestStackDefaultBytes;',
    'kernel default stack anchor changed',
)
s = once(
    s,
    '  for (uint32_t i = 0; i < kMaxThreads; ++i) {\n    auto& thread = g_threads[i];',
    '  for (uint32_t i = 0; i < kMaxThreads; ++i) {\n    if (i == kBrowserMainThreadReservedSlot) continue;\n    auto& thread = g_threads[i];',
    'if (i == kBrowserMainThreadReservedSlot) continue;',
    'kernel reserved main-thread slot anchor changed',
)
p.write_text(s)


# Developer diagnostics: opcode 18 is a branch, not a D-form memory access.
p = Path('developer-console.js')
s = p.read_text()
if "instructionKind='direct-branch'" not in s:
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
require(s, 'ppcDiagnosticSummary(summary.memory)', 'developer console summary anchor changed')
p.write_text(s)


# Braid startup critic: validate Xenia main-stack geometry and the exact
# 0x70080020 address from the real-device report.
p = Path('test-braid-startup-critic.mjs')
s = p.read_text()
if 'const stackSlotBase=0x70000000' not in s.split("const mod=", 1)[0]:
    marker_anchor = '"map(0,lowMemoryPages,lowMemoryBacking,0,readWrite)",'
    marker_insert = '"map(0,lowMemoryPages,lowMemoryBacking,0,readWrite)","const stackSlotBase=0x70000000","const stackLimit=(stackSlotBase+stackGuardBytes)>>>0","map(stackLimit,stackPages,stackBacking,0,readWrite)","be32(threadAddress+0x0D0,stackBasePointer)",'
    require(s, marker_anchor, 'Braid critic controller marker anchor changed')
    s = s.replace(marker_anchor, marker_insert, 1)
if 'BRAID_70080020_STACK_ADDRESS failed' not in s:
    anchor = "if(!lowBacking||(p('r360_sparse_guest_memory_map')(0,lowPages,lowBacking,0,3)>>>0)!==1)throw new Error('LOW_64K_APERTURE_MAPPED failed');\n"
    require(s, anchor, 'Braid critic low-memory setup anchor changed')
    insert = anchor + "const stackSlotBase=0x70000000,stackLimit=0x70001000,stackPages=128,stackBasePointer=0x70081000,stackTop=(stackBasePointer-176)&~15;\nconst stackBacking=p('r360_sparse_guest_memory_alloc')(stackPages)>>>0;\nif(!stackBacking||(p('r360_sparse_guest_memory_map')(stackLimit,stackPages,stackBacking,0,3)>>>0)!==1)throw new Error('XENIA_MAIN_STACK_GEOMETRY failed');\nif((p('r360_ppc_probe_write_guest_u32_be')(stackSlotBase,0xBAD0BAD0)>>>0)!==0)throw new Error('MAIN_STACK_LOW_GUARD failed');\nif((p('r360_ppc_probe_write_guest_u32_be')(0x70080020,0x13579BDF)>>>0)!==1||(p('r360_ppc_probe_read_guest_u32_be')(0x70080020)>>>0)!==0x13579BDF)throw new Error('BRAID_70080020_STACK_ADDRESS failed');\nif((p('r360_ppc_probe_write_guest_u32_be')(stackBasePointer,0xBAD1BAD1)>>>0)!==0)throw new Error('MAIN_STACK_HIGH_GUARD failed');\n"
    s = s.replace(anchor, insert, 1)
s = s.replace("BigInt(0x7007ff50)", 'BigInt(stackTop)', 1)
if "XENIA_MAIN_STACK_GEOMETRY=PASS" not in s:
    s = s.replace(
        "console.log('LOW_64K_APERTURE_MAPPED=PASS');",
        "console.log('LOW_64K_APERTURE_MAPPED=PASS');console.log('XENIA_MAIN_STACK_GEOMETRY=PASS');console.log('BRAID_70080020_STACK_ADDRESS=PASS');",
        1,
    )
p.write_text(s)


# Opcode39 stack fixture: use the same guarded stack layout as production.
p = Path('test-opcode39-main-thread.mjs')
s = p.read_text()
if 'Braid high-side stack address is not mapped' not in s:
    s = once(
        s,
        "const stackBase=0x70000000;\nconst stackPages=128;\nconst stackTop=0x7007ff00;\nconst backing=p('r360_sparse_guest_memory_alloc')(stackPages)>>>0;\nif(!backing)throw new Error('stack backing allocation failed');\nif((p('r360_sparse_guest_memory_map')(stackBase,stackPages,backing,0,3)>>>0)!==1)throw new Error('stack mapping failed');",
        "const stackSlotBase=0x70000000;\nconst stackLimit=0x70001000;\nconst stackPages=128;\nconst stackBasePointer=stackLimit+stackPages*4096;\nconst stackTop=(stackBasePointer-(64+112))&~15;\nconst backing=p('r360_sparse_guest_memory_alloc')(stackPages)>>>0;\nif(!backing)throw new Error('stack backing allocation failed');\nif((p('r360_sparse_guest_memory_map')(stackLimit,stackPages,backing,0,3)>>>0)!==1)throw new Error('stack mapping failed');\nif((p('r360_sparse_guest_memory_write_u32_be')(stackSlotBase,0xBAD0BAD0)>>>0)!==0)throw new Error('lower stack guard unexpectedly mapped');\nif((p('r360_sparse_guest_memory_write_u32_be')(0x70080020,0x01020304)>>>0)!==1)throw new Error('Braid high-side stack address is not mapped');\nif((p('r360_sparse_guest_memory_write_u32_be')(stackBasePointer,0xBAD1BAD1)>>>0)!==0)throw new Error('upper stack guard unexpectedly mapped');",
        'Braid high-side stack address is not mapped',
        'opcode39 stack fixture anchor changed',
    )
p.write_text(s)


# Guest runtime critic: prove default stack size, upper and lower guards, and
# that child-thread allocation skips browser main-thread slot 16.
p = Path('test-guest-runtime-critic.mjs')
s = p.read_text()
if 'default guest stack must be 256 KiB' not in s:
    old = "const a=pick('r360_guest_thread_create')(0x82001000,0x1111,1,0xA5)>>>0;const b=pick('r360_guest_thread_create')(0x82002000,0x2222,0x5000,0x5A)>>>0;if(!a||!b||a===b)throw new Error('thread creation/identity failed');if((pick('r360_guest_thread_stack_size')(a)>>>0)!==0x4000||(pick('r360_guest_thread_stack_size')(b)>>>0)!==0x8000)throw new Error('stack alignment failed');"
    new = "const a=pick('r360_guest_thread_create')(0x82001000,0x1111,1,0xA5)>>>0;const b=pick('r360_guest_thread_create')(0x82002000,0x2222,0x5000,0x5A)>>>0;const defaultThread=pick('r360_guest_thread_create')(0x82002500,0,0,0)>>>0;if(!a||!b||!defaultThread||a===b)throw new Error('thread creation/identity failed');if((pick('r360_guest_thread_stack_size')(a)>>>0)!==0x4000||(pick('r360_guest_thread_stack_size')(b)>>>0)!==0x8000)throw new Error('stack alignment failed');if((pick('r360_guest_thread_stack_size')(defaultThread)>>>0)!==0x40000)throw new Error('default guest stack must be 256 KiB');"
    require(s, old, 'guest runtime default-stack anchor changed')
    s = s.replace(old, new, 1)
if 'thread upper stack guard page is not fail-closed/unmapped' not in s:
    guard_anchor = "if((pick('r360_sparse_guest_memory_write_u8')(stackBaseA,0x7B)>>>0)!==1||(pick('r360_sparse_guest_memory_read_u8')(stackBaseA)>>>0)!==0x7B)throw new Error('thread stack is not backed by sparse guest RAM');if((pick('r360_sparse_guest_memory_write_u8')((stackBaseA-1)>>>0,0x55)>>>0)!==0||(pick('r360_sparse_guest_memory_last_fault_code')()>>>0)!==1)throw new Error('thread stack guard page is not fail-closed/unmapped');"
    guard_new = "if((pick('r360_sparse_guest_memory_write_u8')(stackBaseA,0x7B)>>>0)!==1||(pick('r360_sparse_guest_memory_read_u8')(stackBaseA)>>>0)!==0x7B)throw new Error('thread stack is not backed by sparse guest RAM');if((pick('r360_sparse_guest_memory_write_u8')((stackBaseA-1)>>>0,0x55)>>>0)!==0||(pick('r360_sparse_guest_memory_last_fault_code')()>>>0)!==1)throw new Error('thread lower stack guard page is not fail-closed/unmapped');const stackSizeA=pick('r360_guest_thread_stack_size')(a)>>>0;if((pick('r360_sparse_guest_memory_write_u8')((stackBaseA+stackSizeA)>>>0,0x56)>>>0)!==0||(pick('r360_sparse_guest_memory_last_fault_code')()>>>0)!==1)throw new Error('thread upper stack guard page is not fail-closed/unmapped');"
    require(s, guard_anchor, 'guest runtime stack guard anchor changed')
    s = s.replace(guard_anchor, guard_new, 1)
s = s.replace("console.log('GUEST_RUNTIME_THREAD_STACK_GUARD=PASS');", "console.log('GUEST_RUNTIME_DEFAULT_STACK_256K=PASS');console.log('GUEST_RUNTIME_THREAD_STACK_GUARDS=PASS');", 1)
if 'GUEST_RUNTIME_BROWSER_MAIN_STACK_SLOT_RESERVED=PASS' not in s:
    s += """

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


# UI contract: require opcode-aware report semantics.
p = Path('test-ui-contract.mjs')
s = p.read_text()
if 'opcode-aware diagnostic' not in s:
    anchor = "for(const token of ['runtimeBlocker','fatalError','render360-blocker-report-v1','render360PpcRuntimeIdentity'])must(has(developerConsole,token),`developer console missing ${token}`);"
    require(s, anchor, 'UI diagnostic contract anchor changed')
    s = s.replace(
        anchor,
        anchor + "\nfor(const token of ['instructionKind','direct-branch','branchTarget','fault-not-derived-from-boundary-instruction','ppcDiagnosticSummary'])must(has(developerConsole,token),`developer console missing opcode-aware diagnostic ${token}`);",
        1,
    )
p.write_text(s)


# Final static assertions.
kernel = Path('src/xenia_web_bootstrap/kernel_runtime_foundation.cpp').read_text()
for token in ['kGuestStackDefaultBytes = 0x00040000u', 'kBrowserMainThreadReservedSlot = 16u', 'kGuestStackSlotStride - 2u * kGuestStackGuardBytes', 'upper_guard_end64', 'i == kBrowserMainThreadReservedSlot']:
    require(kernel, token, f'missing kernel invariant: {token}')
controller = Path('render360-title-controller.mjs').read_text()
for token in ['const stackLimit=(stackSlotBase+stackGuardBytes)>>>0', 'const stackBasePointer=(stackLimit+stackPages*pageSize)>>>0', 'map(stackLimit,stackPages,stackBacking,0,readWrite)', 'be32(threadAddress+0x0D0,stackBasePointer)']:
    require(controller, token, f'missing title invariant: {token}')
print('R360_XENIA_MAIN_STACK_GUARD_GEOMETRY=ENABLED')
print('R360_BRAID_70080020_INSIDE_STACK=YES')
print('R360_GUEST_THREAD_DEFAULT_STACK=0x40000')
print('R360_BROWSER_MAIN_STACK_SLOT=RESERVED_16')
print('R360_PPC_DIAGNOSTICS=OPCODE_AWARE')
