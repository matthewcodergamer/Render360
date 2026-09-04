from pathlib import Path

MARK = 'R360_XENIA_ENTRY_ABI_V51'


def replace_once(text, old, new, label):
    if new in text:
        return text
    if old not in text:
        raise SystemExit(f'{label}: anchor changed')
    return text.replace(old, new, 1)


# 1) Public correctness-executor API for the special-register part of Xenia's
# Processor::Execute entry ABI.
p = Path('src/xenia_web_bootstrap/hir_correctness_executor.h')
s = p.read_text()
if 'SetHIRCorrectnessInitialLR' not in s:
    s = replace_once(
        s,
        'bool SetHIRCorrectnessInitialGPR(uint32_t index, uint64_t value);\n',
        'bool SetHIRCorrectnessInitialGPR(uint32_t index, uint64_t value);\n'
        'bool SetHIRCorrectnessInitialLR(uint64_t value);\n'
        'uint64_t GetHIRCorrectnessInitialLR();\n',
        'HIR initial LR declarations',
    )
    p.write_text(s)


# 2) Export the new ABI from the browser bootstrap. This intentionally sits next
# to the existing initial-GPR setter so reset semantics remain centralized.
p = Path('src/xenia_web_bootstrap/ppc_translation_probe.cpp')
s = p.read_text()
if 'r360_ppc_probe_set_initial_lr' not in s:
    anchor = '''uint32_t r360_ppc_probe_set_initial_gpr(uint32_t index, uint64_t value) {
  return render360::xenia_web::SetHIRCorrectnessInitialGPR(index, value) ? 1u : 0u;
}
'''
    replacement = anchor + '''
// R360_XENIA_ENTRY_ABI_V51: Xenia Processor::Execute installs a sentinel LR
// before entering the guest function. The browser HIR executor must start with
// the same architectural state instead of an all-zero special-register set.
uint32_t r360_ppc_probe_set_initial_lr(uint64_t value) {
  return render360::xenia_web::SetHIRCorrectnessInitialLR(value) ? 1u : 0u;
}

uint64_t r360_ppc_probe_initial_lr() {
  return render360::xenia_web::GetHIRCorrectnessInitialLR();
}
'''
    s = replace_once(s, anchor, replacement, 'PPC initial LR exports')
    p.write_text(s)


# 3) Extend the existing generated-HIR overlay rather than editing the generated
# build tree directly. This runs after the call/return stack overlay, so it sees
# the exact final context-initialization shape used by production builds.
p = Path('prepare-hir-return-metadata-v3-overlay.py')
s = p.read_text()
if MARK not in s:
    injection = r'''

# R360_XENIA_ENTRY_ABI_V51
# Xenia's real Processor::Execute does two architectural things before
# Function::Call: it reserves 64+112 bytes from r1 and sets LR to 0xBCBCBCBC.
# Render360 already mirrors the r1 reservation in render360-title-controller;
# preserve the LR side here as explicit initial special-register state.
initial_gprs_old = 'std::array<uint64_t, 32> g_initial_gprs{};\n'
initial_gprs_new = ('std::array<uint64_t, 32> g_initial_gprs{};\n'
                    'uint64_t g_initial_lr = 0;\n')
replace_once(initial_gprs_old, initial_gprs_new, 'initial LR storage')

reset_old = '''void ResetHIRCorrectnessInitialState() { g_initial_gprs.fill(0); }

bool SetHIRCorrectnessInitialGPR(uint32_t index, uint64_t value) {
  if (index >= g_initial_gprs.size()) return false;
  g_initial_gprs[index] = value;
  return true;
}
'''
reset_new = '''void ResetHIRCorrectnessInitialState() {
  g_initial_gprs.fill(0);
  g_initial_lr = 0;
}

bool SetHIRCorrectnessInitialGPR(uint32_t index, uint64_t value) {
  if (index >= g_initial_gprs.size()) return false;
  g_initial_gprs[index] = value;
  return true;
}

bool SetHIRCorrectnessInitialLR(uint64_t value) {
  g_initial_lr = value;
  return true;
}

uint64_t GetHIRCorrectnessInitialLR() { return g_initial_lr; }
'''
replace_once(reset_old, reset_new, 'initial LR API implementation')

context_old = '''    for (size_t i = 0; i < g_initial_gprs.size(); ++i) {
      local_context.r[i] = g_initial_gprs[i];
    }
    g_r360_stack_trace.initial_r1 = local_context.r[1];
'''
context_new = '''    for (size_t i = 0; i < g_initial_gprs.size(); ++i) {
      local_context.r[i] = g_initial_gprs[i];
    }
    local_context.lr = g_initial_lr;
    std::fprintf(stderr,
                 "R360_INITIAL_SPECIALS lr=0x%08X\\n",
                 static_cast<uint32_t>(local_context.lr));
    g_r360_stack_trace.initial_r1 = local_context.r[1];
'''
replace_once(context_old, context_new, 'initial LR context application')
'''
    # Inject immediately before the final required-marker validation so all
    # replacements operate on the same generated translation unit.
    marker = '\nrequired = [\n'
    if marker not in s:
        raise SystemExit('return metadata overlay validation marker changed')
    s = s.replace(marker, injection + marker, 1)
    p.write_text(s)


# 4) Browser main-thread handoff: mirror Processor::Execute exactly. Xenia's
# ThreadState begins at stack_base, Processor::Execute subtracts 64+112 and puts
# 0xBCBCBCBC in LR before Function::Call.
p = Path('render360-title-controller.mjs')
s = p.read_text()
if MARK not in s:
    s = replace_once(
        s,
        '  const xeniaCallFrameBytes=64+112;\n'
        '  const stackTop=(stackBasePointer-xeniaCallFrameBytes)&~0xF;\n',
        '  const xeniaCallFrameBytes=64+112;\n'
        '  const xeniaInitialLr=0xBCBCBCBC;\n'
        '  const stackTop=(stackBasePointer-xeniaCallFrameBytes)&~0xF;\n',
        'main-thread Xenia LR constant',
    )
    s = replace_once(
        s,
        "  return {kind:'xenia-main-thread-context',stackSlotBase,stackBase:stackBasePointer,stackLimit,stackBasePointer,stackTop,stackGuardBytes,xeniaCallFrameBytes,pcrAddress,tlsAddress,threadAddress,startAddress:entry>>>0,stackBytes:stackPages*pageSize,zeroPageCompat:true,lowMemoryCompatBytes:lowMemoryPages*pageSize};\n",
        "  return {kind:'xenia-main-thread-context',stackSlotBase,stackBase:stackBasePointer,stackLimit,stackBasePointer,stackTop,stackGuardBytes,xeniaCallFrameBytes,xeniaInitialLr,pcrAddress,tlsAddress,threadAddress,startAddress:entry>>>0,stackBytes:stackPages*pageSize,zeroPageCompat:true,lowMemoryCompatBytes:lowMemoryPages*pageSize};\n",
        'main-thread context telemetry',
    )
    old = '''  if(mainThreadContext){
    startupGprCount+=applyInitialGprs(bootstrap,{1:mainThreadContext.stackTop,13:mainThreadContext.pcrAddress});
  }
'''
    new = '''  if(mainThreadContext){
    // R360_XENIA_ENTRY_ABI_V51: match upstream Processor::Execute special state.
    const setInitialLr=maybe(bootstrap,'r360_ppc_probe_set_initial_lr');
    const readInitialLr=maybe(bootstrap,'r360_ppc_probe_initial_lr');
    if(!setInitialLr||!readInitialLr)throw new Error('published browser bootstrap is missing Xenia initial-LR support');
    if((setInitialLr(BigInt(mainThreadContext.xeniaInitialLr))>>>0)!==1)throw new Error('unable to initialize Xenia title-entry LR');
    if(Number(readInitialLr()&0xFFFFFFFFn)!==(mainThreadContext.xeniaInitialLr>>>0))throw new Error('Xenia title-entry LR verification failed');
    startupGprCount+=applyInitialGprs(bootstrap,{1:mainThreadContext.stackTop,13:mainThreadContext.pcrAddress});
  }
'''
    s = replace_once(s, old, new, 'main-thread LR handoff')
    p.write_text(s)


# 5) Make the LR setter a required production export, not an optional debug API.
p = Path('link-xenia-ppc-bootstrap.sh')
s = p.read_text()
if '  r360_ppc_probe_set_initial_lr\n' not in s:
    s = replace_once(
        s,
        'CRITICAL_EXPORTS=(\n  r360_ppc_probe_set_execute_on_translate\n',
        'CRITICAL_EXPORTS=(\n  r360_ppc_probe_set_initial_lr\n  r360_ppc_probe_set_execute_on_translate\n',
        'critical initial LR export',
    )
    p.write_text(s)

print('XENIA_ENTRY_ABI_V51=PASS')
