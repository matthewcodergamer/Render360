#!/usr/bin/env python3
from pathlib import Path

controller = Path('render360-title-controller.mjs')
s = controller.read_text()

anchor = "function stagePreparedPeImage(bootstrap,prepared){"
helper = r'''function prepareBrowserMainThreadContext(bootstrap){
  const alloc=maybe(bootstrap,'r360_sparse_guest_memory_alloc');
  const map=maybe(bootstrap,'r360_sparse_guest_memory_map');
  const write8=maybe(bootstrap,'r360_sparse_guest_memory_write_u8');
  if(!alloc||!map||!write8)throw new Error('published browser bootstrap is missing sparse guest-memory main-thread support');

  // Match the important parts of Xenia's real ThreadState/XThread startup.
  // Xbox user stacks live in 0x70000000-0x7F000000 and r13 points at the
  // per-thread PCR. The fallback used to enter the XEX with every GPR zero.
  const pageSize=4096;
  const stackBase=0x70000000;
  const stackPages=128;
  const stackLimit=stackBase;
  const stackTop=(stackBase+stackPages*pageSize-0x100)&~0xF;
  const pcrAddress=0x50000000;
  const tlsAddress=0x50001000;
  const threadAddress=0x50002000;
  const contextPages=3;
  const readWrite=3;

  const stackBacking=alloc(stackPages)>>>0;
  if(!stackBacking||(map(stackBase,stackPages,stackBacking,0,readWrite)>>>0)!==1)throw new Error('unable to map Xbox main-thread stack');
  const contextBacking=alloc(contextPages)>>>0;
  if(!contextBacking||(map(pcrAddress,contextPages,contextBacking,0,readWrite)>>>0)!==1)throw new Error('unable to map Xbox main-thread PCR/TLS');

  const be32=(address,value)=>{
    const v=Number(value)>>>0;
    for(let i=0;i<4;i++){
      if((write8((address+i)>>>0,(v>>>(24-i*8))&0xFF)>>>0)!==1){
        throw new Error(`unable to initialize Xbox thread memory @ 0x${(address+i).toString(16)}`);
      }
    }
  };

  be32(pcrAddress+0x000,tlsAddress);
  be32(pcrAddress+0x030,pcrAddress);
  be32(pcrAddress+0x070,stackTop);
  be32(pcrAddress+0x074,stackLimit);
  be32(pcrAddress+0x100,threadAddress);
  be32(pcrAddress+0x150,0);

  be32(threadAddress+0x05C,stackTop);
  be32(threadAddress+0x060,stackLimit);
  be32(threadAddress+0x068,tlsAddress);
  be32(threadAddress+0x14C,1);

  return {kind:'xenia-main-thread-context',stackBase,stackLimit,stackTop,pcrAddress,tlsAddress,threadAddress,stackBytes:stackPages*pageSize};
}

'''
if 'function prepareBrowserMainThreadContext(bootstrap)' not in s:
    if anchor not in s:
        raise SystemExit('stagePreparedPeImage anchor missing')
    s = s.replace(anchor, helper + anchor, 1)

old_sig = "export async function handoffDefaultXex({core,bootstrap,defaultXex,encryptedSecurityKey=null,useDevkitKey=false,entryBytes=8,scanEntryFunction=false,implementedKernelExports={},initialGprs={},installDefaultBrowserHle=true}){"
new_sig = "export async function handoffDefaultXex({core,bootstrap,defaultXex,encryptedSecurityKey=null,useDevkitKey=false,entryBytes=8,scanEntryFunction=false,implementedKernelExports={},initialGprs={},installDefaultBrowserHle=true,prepareMainThreadContext=false}){"
if old_sig in s:
    s = s.replace(old_sig, new_sig, 1)
elif new_sig not in s:
    raise SystemExit('handoff signature marker missing')

old_gpr = "  pick(bootstrap,'r360_title_handoff_reset')();\n  const startupGprCount=applyInitialGprs(bootstrap,initialGprs);"
new_gpr = "  pick(bootstrap,'r360_title_handoff_reset')();\n  const mainThreadContext=prepareMainThreadContext?prepareBrowserMainThreadContext(bootstrap):null;\n  let startupGprCount=0;\n  if(mainThreadContext){\n    startupGprCount+=applyInitialGprs(bootstrap,{1:mainThreadContext.stackTop,13:mainThreadContext.pcrAddress});\n  }\n  startupGprCount+=applyInitialGprs(bootstrap,initialGprs);"
if old_gpr in s:
    s = s.replace(old_gpr, new_gpr, 1)
elif new_gpr not in s:
    raise SystemExit('startup GPR marker missing')

old_return = 'entryExecutionMode,startupGprCount,executionStatus'
new_return = 'entryExecutionMode,startupGprCount,mainThreadContext,executionStatus'
if old_return in s:
    s = s.replace(old_return, new_return, 1)
elif new_return not in s:
    raise SystemExit('controller telemetry marker missing')
controller.write_text(s)

bridge = Path('render360-browser-modern-content-bridge.mjs')
s = bridge.read_text()
old_call = "result=await handoffDefaultXex({core,bootstrap,defaultXex:bytes,encryptedSecurityKey:securityKey,scanEntryFunction:true});"
new_call = "result=await handoffDefaultXex({core,bootstrap,defaultXex:bytes,encryptedSecurityKey:securityKey,scanEntryFunction:true,prepareMainThreadContext:true});"
if new_call not in s:
    hits = [i for i in range(len(s)) if s.startswith(old_call, i)]
    if len(hits) != 2:
        raise SystemExit(f'expected two title handoff calls, found {len(hits)}')
    second = hits[1]
    s = s[:second] + s[second:].replace(old_call, new_call, 1)
s = s.replace("./render360-title-controller.mjs?v=44.4", "./render360-title-controller.mjs?v=44.6")
bridge.write_text(s)

replacements = {
    'runtime/render360-runtime.js': [
        ('render360-browser-modern-content-bridge.mjs?v=44.5', 'render360-browser-modern-content-bridge.mjs?v=44.6'),
    ],
    'app-v41.js': [
        ('runtime/render360-runtime.js?v=44.5', 'runtime/render360-runtime.js?v=44.6'),
    ],
    'index.html': [
        ('app-v41.js?v=44.5', 'app-v41.js?v=44.6'),
        ('app-v42-patch.js?v=44.5', 'app-v42-patch.js?v=44.6'),
    ],
}
for name, pairs in replacements.items():
    p = Path(name)
    text = p.read_text()
    for old, new in pairs:
        text = text.replace(old, new)
    p.write_text(text)

controller_text = controller.read_text()
bridge_text = bridge.read_text()
for needle in [
    'prepareBrowserMainThreadContext',
    'r360_sparse_guest_memory_alloc',
    'r360_sparse_guest_memory_map',
    'r360_sparse_guest_memory_write_u8',
    'prepareMainThreadContext=false',
    'mainThreadContext',
]:
    if needle not in controller_text:
        raise SystemExit(f'controller missing {needle}')
for needle in ['prepareMainThreadContext:true', 'render360-title-controller.mjs?v=44.6']:
    if needle not in bridge_text:
        raise SystemExit(f'bridge missing {needle}')

print('R360_MAIN_THREAD_R1_STACK=PATCHED')
print('R360_MAIN_THREAD_R13_PCR=PATCHED')
print('R360_MAIN_THREAD_SPARSE_MEMORY=PATCHED')
