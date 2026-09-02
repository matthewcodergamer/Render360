#!/usr/bin/env python3
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def replace_once(path: Path, old: str, new: str) -> None:
    text = path.read_text()
    if new in text:
        print(f"{path}: already patched")
        return
    if old not in text:
        raise SystemExit(f"{path}: expected patch anchor not found")
    path.write_text(text.replace(old, new, 1))
    print(f"{path}: patched")


ppc = ROOT / "src/xenia_web_bootstrap/ppc_translation_probe.cpp"
replace_once(
    ppc,
    """enum ProbeStatus : uint32_t {\n  kProbeCold = 0,\n  kProbeRuntimeReady = 1,\n  kProbeCodeLoaded = 2,\n  kProbeTranslated = 3,\n  kProbeErrorMemory = 0xE001,\n  kProbeErrorProcessor = 0xE002,\n  kProbeErrorInput = 0xE003,\n  kProbeErrorTranslate = 0xE004,\n};\n\nxe::Memory* g_memory = nullptr;\nxe::cpu::Processor* g_processor = nullptr;\nProbeModule* g_probe_module = nullptr;\nuint32_t g_loaded_size = 0;\nuint32_t g_status = kProbeCold;\n""",
    """enum ProbeStatus : uint32_t {\n  kProbeCold = 0,\n  kProbeRuntimeReady = 1,\n  kProbeCodeLoaded = 2,\n  kProbeTranslated = 3,\n  kProbeErrorMemory = 0xE001,\n  kProbeErrorProcessor = 0xE002,\n  kProbeErrorInput = 0xE003,\n  kProbeErrorTranslate = 0xE004,\n};\n\n// Scanned-entry translation used to collapse four different outcomes into a\n// single zero return. Keep this diagnostic separate from ProbeStatus so the\n// title handoff can retain its stable 0x82000005 ABI while browser reports say\n// exactly which Xenia stage failed.\nenum ProbeScanDiagnostic : uint32_t {\n  kProbeScanIdle = 0,\n  kProbeScanGuardRejected = 1,\n  kProbeScanScannerFailed = 2,\n  kProbeScanDefineFailed = 3,\n  kProbeScanZeroHIR = 4,\n  kProbeScanTranslated = 5,\n};\n\nxe::Memory* g_memory = nullptr;\nxe::cpu::Processor* g_processor = nullptr;\nProbeModule* g_probe_module = nullptr;\nuint32_t g_loaded_size = 0;\nuint32_t g_status = kProbeCold;\nuint32_t g_scan_diagnostic = kProbeScanIdle;\nuint32_t g_scan_address = 0;\nuint32_t g_scan_window_end = 0;\nuint32_t g_scan_hir_instructions = 0;\n\nvoid ResetScanDiagnostic() {\n  g_scan_diagnostic = kProbeScanIdle;\n  g_scan_address = 0;\n  g_scan_window_end = 0;\n  g_scan_hir_instructions = 0;\n}\n""",
)

replace_once(
    ppc,
    """void r360_ppc_probe_reset() {\n  render360::xenia_web::ResetProbeTelemetry();\n  render360::xenia_web::ResetHIRCorrectnessInitialState();\n  render360::xenia_web::ResetWasmBackendCallProbe();\n""",
    """void r360_ppc_probe_reset() {\n  render360::xenia_web::ResetProbeTelemetry();\n  render360::xenia_web::ResetHIRCorrectnessInitialState();\n  render360::xenia_web::ResetWasmBackendCallProbe();\n  render360::xenia_web::ResetScanDiagnostic();\n""",
)

replace_once(
    ppc,
    """  g_status = kProbeTranslated;\n  return GetProbeTelemetry().hir_instructions;\n}\n\nuint32_t r360_ppc_probe_translate_scanned_at(uint32_t address) {\n  using namespace render360::xenia_web;\n  if (!EnsureRuntime() || !g_loaded_size || !g_probe_module || (address & 3u) ||\n      !IsProbeGuestRange(address, 4u)) {\n    if (g_status < 0xE000) g_status = kProbeErrorInput;\n    return 0;\n  }\n\n  ResetProbeTelemetry();\n  ProbeGuestFunction function(g_probe_module, address);\n  // Give upstream Xenia a hard upper bound equal to the RX bytes currently\n  // paged into the movable wasm32 code window, then let PPCScanner discover the\n  // actual function end (blr/bctr/control-flow) within that real title span.\n  function.set_end_address(g_active_guest_base + g_loaded_size - 4u);\n  xe::cpu::ppc::PPCScanner scanner(g_processor->frontend());\n  if (!scanner.Scan(&function, nullptr) ||\n      !g_processor->frontend()->DefineFunction(&function, 0)) {\n    g_status = kProbeErrorTranslate;\n    return 0;\n  }\n\n  g_status = kProbeTranslated;\n  return GetProbeTelemetry().hir_instructions;\n}\n""",
    """  const uint32_t hir = GetProbeTelemetry().hir_instructions;\n  if (!hir) {\n    // A zero-HIR translation is not success. The old path marked the probe as\n    // translated and then returned zero, leaving the caller and telemetry in\n    // contradictory states.\n    g_status = kProbeErrorTranslate;\n    return 0;\n  }\n  g_status = kProbeTranslated;\n  return hir;\n}\n\nuint32_t r360_ppc_probe_translate_scanned_at(uint32_t address) {\n  using namespace render360::xenia_web;\n  ResetScanDiagnostic();\n  g_scan_address = address;\n  g_scan_window_end =\n      g_loaded_size >= 4u ? g_active_guest_base + g_loaded_size - 4u : 0u;\n\n  if (!EnsureRuntime() || !g_loaded_size || !g_probe_module || (address & 3u) ||\n      !IsProbeGuestRange(address, 4u)) {\n    g_scan_diagnostic = kProbeScanGuardRejected;\n    if (g_status < 0xE000) g_status = kProbeErrorInput;\n    return 0;\n  }\n\n  ResetProbeTelemetry();\n  ProbeGuestFunction function(g_probe_module, address);\n  // Give upstream Xenia a hard upper bound equal to the RX bytes currently\n  // paged into the movable wasm32 code window, then let PPCScanner discover the\n  // actual function end (blr/bctr/control-flow) within that real title span.\n  function.set_end_address(g_active_guest_base + g_loaded_size - 4u);\n  xe::cpu::ppc::PPCScanner scanner(g_processor->frontend());\n  if (!scanner.Scan(&function, nullptr)) {\n    g_scan_diagnostic = kProbeScanScannerFailed;\n    g_status = kProbeErrorTranslate;\n    return 0;\n  }\n  if (!g_processor->frontend()->DefineFunction(&function, 0)) {\n    g_scan_diagnostic = kProbeScanDefineFailed;\n    g_status = kProbeErrorTranslate;\n    return 0;\n  }\n\n  const uint32_t hir = GetProbeTelemetry().hir_instructions;\n  g_scan_hir_instructions = hir;\n  if (!hir) {\n    g_scan_diagnostic = kProbeScanZeroHIR;\n    g_status = kProbeErrorTranslate;\n    return 0;\n  }\n\n  g_scan_diagnostic = kProbeScanTranslated;\n  g_status = kProbeTranslated;\n  return hir;\n}\n""",
)

replace_once(
    ppc,
    """uint32_t r360_ppc_probe_loaded_size() {\n  return render360::xenia_web::g_loaded_size;\n}\n\n}  // extern \"C\"\n""",
    """uint32_t r360_ppc_probe_loaded_size() {\n  return render360::xenia_web::g_loaded_size;\n}\nuint32_t r360_ppc_probe_scan_diagnostic() {\n  return render360::xenia_web::g_scan_diagnostic;\n}\nuint32_t r360_ppc_probe_scan_address() {\n  return render360::xenia_web::g_scan_address;\n}\nuint32_t r360_ppc_probe_scan_window_end() {\n  return render360::xenia_web::g_scan_window_end;\n}\nuint32_t r360_ppc_probe_scan_hir_instructions() {\n  return render360::xenia_web::g_scan_hir_instructions;\n}\n\n}  // extern \"C\"\n""",
)

linker = ROOT / "link-xenia-ppc-bootstrap.sh"
replace_once(
    linker,
    """CRITICAL_EXPORTS=(\n  r360_ppc_probe_set_execute_on_translate\n  r360_ppc_probe_execute_on_translate\n""",
    """CRITICAL_EXPORTS=(\n  r360_ppc_probe_set_execute_on_translate\n  r360_ppc_probe_execute_on_translate\n  r360_ppc_probe_scan_diagnostic\n  r360_ppc_probe_scan_address\n  r360_ppc_probe_scan_window_end\n  r360_ppc_probe_scan_hir_instructions\n""",
)

controller = ROOT / "render360-title-controller.mjs"
replace_once(
    controller,
    """  if(!hir)throw new Error(`title entry handoff failed 0x${(pick(bootstrap,'r360_title_handoff_status')()>>>0).toString(16)} mode=${entryExecutionMode}`);\n""",
    """  if(!hir){\n    const handoffStatus=pick(bootstrap,'r360_title_handoff_status')()>>>0;\n    const probeStatus=maybe(bootstrap,'r360_ppc_probe_status')?.()>>>0||0;\n    const scanDiagnostic=maybe(bootstrap,'r360_ppc_probe_scan_diagnostic')?.()>>>0||0;\n    const scanAddress=maybe(bootstrap,'r360_ppc_probe_scan_address')?.()>>>0||0;\n    const scanWindowEnd=maybe(bootstrap,'r360_ppc_probe_scan_window_end')?.()>>>0||0;\n    const scanHir=maybe(bootstrap,'r360_ppc_probe_scan_hir_instructions')?.()>>>0||0;\n    const scanReason=['idle','guard-rejected','scanner-failed','define-function-failed','zero-hir','translated'][scanDiagnostic]||'unknown';\n    const hex=value=>`0x${(value>>>0).toString(16).toUpperCase()}`;\n    const error=new Error(`title entry handoff failed ${hex(handoffStatus)} mode=${entryExecutionMode} scan=${scanReason}(${scanDiagnostic}) probe=${hex(probeStatus)} entry=${hex(entry)} scanAddress=${hex(scanAddress)} scanWindowEnd=${hex(scanWindowEnd)} scanHIR=${scanHir}`);\n    error.code='R360_TITLE_ENTRY_HANDOFF_FAILED';\n    error.render360={kind:'ppc-entry-translation-failure',handoffStatus,probeStatus,scanDiagnostic,scanReason,scanAddress,scanWindowEnd,scanHir,entry:entry>>>0,entryExecutionMode};\n    throw error;\n  }\n""",
)

bridge = ROOT / "render360-browser-modern-content-bridge.mjs"
replace_once(
    bridge,
    """  let result;\n  try{result=await handoffDefaultXex({core,bootstrap,defaultXex:bytes,encryptedSecurityKey:securityKey,scanEntryFunction:true});}\n  finally{setExecute(previous?1:0);}\n""",
    """  let result;\n  try{result=await handoffDefaultXex({core,bootstrap,defaultXex:bytes,encryptedSecurityKey:securityKey,scanEntryFunction:true});}\n  catch(error){\n    const blocker=error?.render360??{kind:'title-translation-failure',message:error?.message||String(error)};\n    stage(onStage,'blocked',error?.message||String(error),{blocker});\n    throw error;\n  }\n  finally{setExecute(previous?1:0);}\n""",
)

test_path = ROOT / "test-ppc-scan-diagnostics.mjs"
if not test_path.exists():
    test_path.write_text(r'''import fs from 'node:fs';
import { WASI } from 'node:wasi';

const wasmPath=process.argv[2]||'build/xenia-ppc-bootstrap/xenia_ppc_bootstrap.wasm';
if(!fs.existsSync(wasmPath))throw new Error(`missing bootstrap ${wasmPath}`);
const module=await WebAssembly.compile(fs.readFileSync(wasmPath));
const wasi=new WASI({version:'preview1',args:[],env:{},preopens:{},returnOnExit:true});
const imports=wasi.getImportObject(module);
for(const item of WebAssembly.Module.imports(module)){
  if(item.module==='env'&&item.name==='emscripten_notify_memory_growth'){
    imports.env||={};imports.env.emscripten_notify_memory_growth=()=>{};
  }
}
const instance=await WebAssembly.instantiate(module,imports);wasi.initialize(instance);
const pick=name=>instance.exports[name]??instance.exports[`_${name}`];
const required=['r360_ppc_probe_reset','r360_ppc_probe_set_execute_on_translate','r360_ppc_probe_input_buffer','r360_ppc_probe_load_at','r360_ppc_probe_translate_scanned_at','r360_ppc_probe_status','r360_ppc_probe_scan_diagnostic','r360_ppc_probe_scan_address','r360_ppc_probe_scan_window_end','r360_ppc_probe_scan_hir_instructions'];
for(const name of required)if(typeof pick(name)!=='function')throw new Error(`missing scan diagnostic export ${name}`);

const base=0x80000000;
const bytes=Uint8Array.from([0x38,0x60,0x00,0x01,0x4E,0x80,0x00,0x20]); // li r3,1; blr
const input=pick('r360_ppc_probe_input_buffer')()>>>0;
const load=()=>{
  new Uint8Array(instance.exports.memory.buffer,input,bytes.length).set(bytes);
  if((pick('r360_ppc_probe_load_at')(base,input,bytes.length)>>>0)!==bytes.length)throw new Error('diagnostic fixture load failed');
};

pick('r360_ppc_probe_reset')();
pick('r360_ppc_probe_set_execute_on_translate')(0);
load();
const hir=pick('r360_ppc_probe_translate_scanned_at')(base)>>>0;
if(!hir)throw new Error(`valid scanned function failed diag=${pick('r360_ppc_probe_scan_diagnostic')()>>>0}`);
if((pick('r360_ppc_probe_scan_diagnostic')()>>>0)!==5)throw new Error('successful scan did not report translated diagnostic');
if((pick('r360_ppc_probe_scan_address')()>>>0)!==base)throw new Error('scan address telemetry mismatch');
if((pick('r360_ppc_probe_scan_window_end')()>>>0)!==base+4)throw new Error('scan window end telemetry mismatch');
if((pick('r360_ppc_probe_scan_hir_instructions')()>>>0)!==hir)throw new Error('scan HIR telemetry mismatch');
if((pick('r360_ppc_probe_status')()>>>0)!==3)throw new Error('successful scan probe status mismatch');
console.log('PPC_SCAN_DIAGNOSTIC_SUCCESS=PASS');

pick('r360_ppc_probe_reset')();
pick('r360_ppc_probe_set_execute_on_translate')(0);
load();
if((pick('r360_ppc_probe_translate_scanned_at')(base+2)>>>0)!==0)throw new Error('misaligned scan unexpectedly succeeded');
if((pick('r360_ppc_probe_scan_diagnostic')()>>>0)!==1)throw new Error('misaligned scan did not report guard-rejected');
if((pick('r360_ppc_probe_scan_address')()>>>0)!==base+2)throw new Error('guard-rejected scan address telemetry mismatch');
if((pick('r360_ppc_probe_status')()>>>0)!==0xE003)throw new Error('guard-rejected scan did not report probe input error');
console.log('PPC_SCAN_DIAGNOSTIC_GUARD=PASS');

const probeSource=fs.readFileSync('src/xenia_web_bootstrap/ppc_translation_probe.cpp','utf8');
for(const token of ['kProbeScanScannerFailed','kProbeScanDefineFailed','kProbeScanZeroHIR','g_status = kProbeErrorTranslate;'])if(!probeSource.includes(token))throw new Error(`missing scan source contract ${token}`);
const controller=fs.readFileSync('render360-title-controller.mjs','utf8');
for(const token of ['scanner-failed','define-function-failed','zero-hir','R360_TITLE_ENTRY_HANDOFF_FAILED','ppc-entry-translation-failure'])if(!controller.includes(token))throw new Error(`missing title-controller diagnostic ${token}`);
const bridge=fs.readFileSync('render360-browser-modern-content-bridge.mjs','utf8');
if(!bridge.includes("stage(onStage,'blocked',error?.message||String(error),{blocker})"))throw new Error('modern content bridge does not propagate translation blocker');
console.log('PPC_SCAN_DIAGNOSTIC_BROWSER_PROPAGATION=PASS');
console.log('PPC_SCAN_DIAGNOSTICS=PASS');
''')
    print(f"{test_path}: created")
else:
    print(f"{test_path}: already exists")

workflow = ROOT / ".github/workflows/xenia-wasm32-bootstrap.yml"
replace_once(
    workflow,
    """      - 'test-xenia-ppc-translation-probe.mjs'\n""",
    """      - 'test-xenia-ppc-translation-probe.mjs'\n      - 'test-ppc-scan-diagnostics.mjs'\n""",
)
replace_once(
    workflow,
    """      - name: Verify upstream Xenia LZX decoder in wasm32\n        run: node ./test-xenia-lzx-wasm.mjs build/xenia-ppc-bootstrap/xenia_ppc_bootstrap.wasm\n""",
    """      - name: Verify scanned-entry failure diagnostics in wasm32\n        run: node ./test-ppc-scan-diagnostics.mjs build/xenia-ppc-bootstrap/xenia_ppc_bootstrap.wasm\n      - name: Verify upstream Xenia LZX decoder in wasm32\n        run: node ./test-xenia-lzx-wasm.mjs build/xenia-ppc-bootstrap/xenia_ppc_bootstrap.wasm\n""",
)

print("Portal/PPC scan diagnostics patch complete")
