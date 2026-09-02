#!/usr/bin/env python3
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def replace_once(path: Path, old: str, new: str) -> None:
    text = path.read_text()
    if new in text:
        print(f"{path}: already patched")
        return
    if old not in text:
        raise SystemExit(f"{path}: expected patch anchor not found:\n{old[:240]}")
    path.write_text(text.replace(old, new, 1))
    print(f"{path}: patched")


# Portal: preserve the function extent actually discovered by PPCScanner.
ppc = ROOT / "src/xenia_web_bootstrap/ppc_translation_probe.cpp"
replace_once(
    ppc,
    """uint32_t g_scan_address = 0;\nuint32_t g_scan_window_end = 0;\nuint32_t g_scan_hir_instructions = 0;\n""",
    """uint32_t g_scan_address = 0;\nuint32_t g_scan_window_end = 0;\nuint32_t g_scan_function_end = 0;\nuint32_t g_scan_hir_instructions = 0;\n""",
)
replace_once(
    ppc,
    """  g_scan_address = 0;\n  g_scan_window_end = 0;\n  g_scan_hir_instructions = 0;\n""",
    """  g_scan_address = 0;\n  g_scan_window_end = 0;\n  g_scan_function_end = 0;\n  g_scan_hir_instructions = 0;\n""",
)
replace_once(
    ppc,
    """  if (!scanner.Scan(&function, nullptr)) {\n    g_scan_diagnostic = kProbeScanScannerFailed;\n    g_status = kProbeErrorTranslate;\n    return 0;\n  }\n  if (!g_processor->frontend()->DefineFunction(&function, 0)) {\n""",
    """  if (!scanner.Scan(&function, nullptr)) {\n    g_scan_diagnostic = kProbeScanScannerFailed;\n    g_status = kProbeErrorTranslate;\n    return 0;\n  }\n  // scanWindowEnd is only the input ceiling. Preserve the boundary the Xenia\n  // scanner actually discovered so a one-instruction thunk/stub can be\n  // distinguished from a normal function whose assembler emitted zero HIR.\n  g_scan_function_end = function.end_address();\n  if (!g_processor->frontend()->DefineFunction(&function, 0)) {\n""",
)
replace_once(
    ppc,
    """uint32_t r360_ppc_probe_scan_window_end() {\n  return render360::xenia_web::g_scan_window_end;\n}\nuint32_t r360_ppc_probe_scan_hir_instructions() {\n""",
    """uint32_t r360_ppc_probe_scan_window_end() {\n  return render360::xenia_web::g_scan_window_end;\n}\nuint32_t r360_ppc_probe_scan_function_end() {\n  return render360::xenia_web::g_scan_function_end;\n}\nuint32_t r360_ppc_probe_scan_hir_instructions() {\n""",
)

# Root the new native diagnostic in the deployed browser ABI.
linker = ROOT / "link-xenia-ppc-bootstrap.sh"
replace_once(
    linker,
    """  r360_ppc_probe_scan_address\n  r360_ppc_probe_scan_window_end\n  r360_ppc_probe_scan_hir_instructions\n""",
    """  r360_ppc_probe_scan_address\n  r360_ppc_probe_scan_window_end\n  r360_ppc_probe_scan_function_end\n  r360_ppc_probe_scan_hir_instructions\n""",
)

# Portal: expose already-existing backend counters alongside the scanner extent.
controller = ROOT / "render360-title-controller.mjs"
replace_once(
    controller,
    """    const scanAddress=maybe(bootstrap,'r360_ppc_probe_scan_address')?.()>>>0||0;\n    const scanWindowEnd=maybe(bootstrap,'r360_ppc_probe_scan_window_end')?.()>>>0||0;\n    const scanHir=maybe(bootstrap,'r360_ppc_probe_scan_hir_instructions')?.()>>>0||0;\n""",
    """    const scanAddress=maybe(bootstrap,'r360_ppc_probe_scan_address')?.()>>>0||0;\n    const scanWindowEnd=maybe(bootstrap,'r360_ppc_probe_scan_window_end')?.()>>>0||0;\n    const scanFunctionEnd=maybe(bootstrap,'r360_ppc_probe_scan_function_end')?.()>>>0||0;\n    const scanHir=maybe(bootstrap,'r360_ppc_probe_scan_hir_instructions')?.()>>>0||0;\n    const assembledFunctions=maybe(bootstrap,'r360_ppc_probe_assembled_functions')?.()>>>0||0;\n    const hirBlocks=maybe(bootstrap,'r360_ppc_probe_hir_block_count')?.()>>>0||0;\n""",
)
replace_once(
    controller,
    """scanAddress=${hex(scanAddress)} scanWindowEnd=${hex(scanWindowEnd)} scanHIR=${scanHir}`);\n""",
    """scanAddress=${hex(scanAddress)} scanWindowEnd=${hex(scanWindowEnd)} scanFunctionEnd=${hex(scanFunctionEnd)} assembledFunctions=${assembledFunctions} hirBlocks=${hirBlocks} scanHIR=${scanHir}`);\n""",
)
replace_once(
    controller,
    """error.render360={kind:'ppc-entry-translation-failure',handoffStatus,probeStatus,scanDiagnostic,scanReason,scanAddress,scanWindowEnd,scanHir,entry:entry>>>0,entryExecutionMode};\n""",
    """error.render360={kind:'ppc-entry-translation-failure',handoffStatus,probeStatus,scanDiagnostic,scanReason,scanAddress,scanWindowEnd,scanFunctionEnd,assembledFunctions,hirBlocks,scanHir,entry:entry>>>0,entryExecutionMode};\n""",
)

# Braid: SparseGuestMemory is authoritative for commercial-title data. The
# xe::Memory mirror is only a synthetic fixture/code-decoder window and must not
# satisfy arbitrary title stack/data misses with unrelated decoder bytes.
hir = ROOT / "src/xenia_web_bootstrap/hir_correctness_executor.cpp"
replace_once(
    hir,
    """#include \"sparse_guest_memory.h\"\n#include \"title_gpu_runtime.h\"\n\nnamespace render360::xenia_web {\n""",
    """#include \"sparse_guest_memory.h\"\n#include \"title_gpu_runtime.h\"\n\nextern \"C\" {\nuint32_t r360_ppc_probe_guest_base();\nuint32_t r360_ppc_probe_loaded_size();\n}\n\nnamespace render360::xenia_web {\n""",
)
replace_once(
    hir,
    """bool TranslateGuestRange(xe::Memory* memory, uint32_t guest_address,\n                         size_t size, uint8_t** host_address) {\n  if (!memory || !host_address || !size) return false;\n  const uint64_t last = uint64_t(guest_address) + size - 1u;\n  if (last > std::numeric_limits<uint32_t>::max()) return false;\n  auto* first = memory->TranslateVirtual<uint8_t*>(guest_address);\n  auto* last_ptr =\n      memory->TranslateVirtual<uint8_t*>(static_cast<uint32_t>(last));\n  if (!first || !last_ptr) return false;\n  *host_address = first;\n  return true;\n}\n\n""",
    """bool TranslateGuestRange(xe::Memory* memory, uint32_t guest_address,\n                         size_t size, uint8_t** host_address) {\n  if (!memory || !host_address || !size) return false;\n  const uint64_t last = uint64_t(guest_address) + size - 1u;\n  if (last > std::numeric_limits<uint32_t>::max()) return false;\n  auto* first = memory->TranslateVirtual<uint8_t*>(guest_address);\n  auto* last_ptr =\n      memory->TranslateVirtual<uint8_t*>(static_cast<uint32_t>(last));\n  if (!first || !last_ptr) return false;\n  *host_address = first;\n  return true;\n}\n\nbool IsSyntheticProbeWindowRange(uint32_t guest_address, size_t size) {\n  if (!size) return false;\n  const uint32_t base = r360_ppc_probe_guest_base();\n  const uint32_t loaded = r360_ppc_probe_loaded_size();\n  if (!loaded || guest_address < base) return false;\n  const uint64_t end = uint64_t(guest_address) + size;\n  const uint64_t window_end = uint64_t(base) + loaded;\n  return end <= window_end && end <= 0x100000000ull;\n}\n\n""",
)
replace_once(
    hir,
    """    const uint32_t sparse_fault = SparseGuestLastFaultCode();\n    const uint32_t sparse_fault_address = SparseGuestLastFaultAddress();\n    uint8_t* host = nullptr;\n    if (!TranslateGuestRange(memory, guest_address, size, &host)) {\n      std::fprintf(stderr,\n                   \"R360_HIR_MEMORY_FAIL op=load address=0x%08X fault=%u fault_address=0x%08X size=%u\\n\",\n                   guest_address, sparse_fault, sparse_fault_address,\n                   static_cast<unsigned>(size));\n      return false;\n    }\n    std::memcpy(&loaded.value, host, size);\n""",
    """    const uint32_t sparse_fault = SparseGuestLastFaultCode();\n    const uint32_t sparse_fault_address = SparseGuestLastFaultAddress();\n    const bool in_probe_window = IsSyntheticProbeWindowRange(guest_address, size);\n    uint8_t* host = nullptr;\n    if (!in_probe_window ||\n        !TranslateGuestRange(memory, guest_address, size, &host)) {\n      std::fprintf(stderr,\n                   \"R360_HIR_MEMORY_FAIL op=load address=0x%08X fault=%u fault_address=0x%08X size=%u in_window=%u\\n\",\n                   guest_address, sparse_fault, sparse_fault_address,\n                   static_cast<unsigned>(size), in_probe_window ? 1u : 0u);\n      return false;\n    }\n    std::memcpy(&loaded.value, host, size);\n""",
)
replace_once(
    hir,
    """  const uint32_t sparse_fault = SparseGuestLastFaultCode();\n  const uint32_t sparse_fault_address = SparseGuestLastFaultAddress();\n  uint8_t* host = nullptr;\n  if (!TranslateGuestRange(memory, guest_address, size, &host)) {\n    std::fprintf(stderr,\n                 \"R360_HIR_MEMORY_FAIL op=store address=0x%08X fault=%u fault_address=0x%08X size=%u\\n\",\n                 guest_address, sparse_fault, sparse_fault_address,\n                 static_cast<unsigned>(size));\n    return false;\n  }\n  std::memcpy(host, &stored.value, size);\n""",
    """  const uint32_t sparse_fault = SparseGuestLastFaultCode();\n  const uint32_t sparse_fault_address = SparseGuestLastFaultAddress();\n  const bool in_probe_window = IsSyntheticProbeWindowRange(guest_address, size);\n  uint8_t* host = nullptr;\n  if (!in_probe_window ||\n      !TranslateGuestRange(memory, guest_address, size, &host)) {\n    std::fprintf(stderr,\n                 \"R360_HIR_MEMORY_FAIL op=store address=0x%08X fault=%u fault_address=0x%08X size=%u in_window=%u\\n\",\n                 guest_address, sparse_fault, sparse_fault_address,\n                 static_cast<unsigned>(size), in_probe_window ? 1u : 0u);\n    return false;\n  }\n  std::memcpy(host, &stored.value, size);\n""",
)

# Strengthen the published Portal scanner diagnostic test.
scan_test = ROOT / "test-ppc-scan-diagnostics.mjs"
replace_once(
    scan_test,
    """'r360_ppc_probe_scan_address','r360_ppc_probe_scan_window_end','r360_ppc_probe_scan_hir_instructions'];\n""",
    """'r360_ppc_probe_scan_address','r360_ppc_probe_scan_window_end','r360_ppc_probe_scan_function_end','r360_ppc_probe_scan_hir_instructions','r360_ppc_probe_assembled_functions','r360_ppc_probe_hir_block_count'];\n""",
)
replace_once(
    scan_test,
    """if((pick('r360_ppc_probe_scan_window_end')()>>>0)!==base+4)throw new Error('scan window end telemetry mismatch');\nif((pick('r360_ppc_probe_scan_hir_instructions')()>>>0)!==hir)throw new Error('scan HIR telemetry mismatch');\n""",
    """if((pick('r360_ppc_probe_scan_window_end')()>>>0)!==base+4)throw new Error('scan window end telemetry mismatch');\nif((pick('r360_ppc_probe_scan_function_end')()>>>0)!==base+4)throw new Error('scanner-discovered function end telemetry mismatch');\nif((pick('r360_ppc_probe_assembled_functions')()>>>0)<1)throw new Error('successful scan did not assemble a function');\nif((pick('r360_ppc_probe_hir_block_count')()>>>0)<1)throw new Error('successful scan did not produce HIR blocks');\nif((pick('r360_ppc_probe_scan_hir_instructions')()>>>0)!==hir)throw new Error('scan HIR telemetry mismatch');\n""",
)
replace_once(
    scan_test,
    """for(const token of ['kProbeScanScannerFailed','kProbeScanDefineFailed','kProbeScanZeroHIR','g_status = kProbeErrorTranslate;'])if(!probeSource.includes(token))throw new Error(`missing scan source contract ${token}`);\n""",
    """for(const token of ['kProbeScanScannerFailed','kProbeScanDefineFailed','kProbeScanZeroHIR','g_scan_function_end = function.end_address();','g_status = kProbeErrorTranslate;'])if(!probeSource.includes(token))throw new Error(`missing scan source contract ${token}`);\n""",
)
replace_once(
    scan_test,
    """for(const token of ['scanner-failed','define-function-failed','zero-hir','R360_TITLE_ENTRY_HANDOFF_FAILED','ppc-entry-translation-failure'])if(!controller.includes(token))throw new Error(`missing title-controller diagnostic ${token}`);\n""",
    """for(const token of ['scanner-failed','define-function-failed','zero-hir','scanFunctionEnd','assembledFunctions','hirBlocks','R360_TITLE_ENTRY_HANDOFF_FAILED','ppc-entry-translation-failure'])if(!controller.includes(token))throw new Error(`missing title-controller diagnostic ${token}`);\n""",
)

# Add an exact fail-closed regression for the Braid failure class.
fail_closed = ROOT / "test-hir-sparse-fail-closed.mjs"
fail_closed.write_text(r'''import fs from 'node:fs';
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
const required=['r360_ppc_probe_reset','r360_ppc_probe_set_initial_gpr','r360_ppc_probe_input_buffer','r360_ppc_probe_load','r360_ppc_probe_translate','r360_ppc_probe_guest_base','r360_ppc_probe_correctness_status','r360_ppc_probe_correctness_blocker_kind','r360_ppc_probe_correctness_blocker_address'];
for(const name of required)if(typeof pick(name)!=='function')throw new Error(`missing export ${name}`);
const wordBytes=(...words)=>Uint8Array.from(words.flatMap(word=>[(word>>>24)&255,(word>>>16)&255,(word>>>8)&255,word&255]));
const input=pick('r360_ppc_probe_input_buffer')()>>>0;
const codeBase=pick('r360_ppc_probe_guest_base')()>>>0;
const unmapped=0x70081020;

function run(program,{r3=0,r4=unmapped}={}){
  pick('r360_ppc_probe_reset')();
  if((pick('r360_ppc_probe_set_initial_gpr')(3,BigInt(r3))>>>0)!==1)throw new Error('unable to seed r3');
  if((pick('r360_ppc_probe_set_initial_gpr')(4,BigInt(r4))>>>0)!==1)throw new Error('unable to seed r4');
  new Uint8Array(instance.exports.memory.buffer,input,program.length).set(program);
  if((pick('r360_ppc_probe_load')(input,program.length)>>>0)!==program.length)throw new Error('fixture load failed');
  if((pick('r360_ppc_probe_translate')()>>>0)===0)throw new Error('fixture did not translate');
  const status=pick('r360_ppc_probe_correctness_status')()>>>0;
  const kind=pick('r360_ppc_probe_correctness_blocker_kind')()>>>0;
  const address=pick('r360_ppc_probe_correctness_blocker_address')()>>>0;
  if(status!==1||kind!==5)throw new Error(`real-title sparse miss did not fail closed status=${status} kind=${kind}`);
  if(address!==codeBase)throw new Error(`memory blocker attribution mismatch got=0x${address.toString(16)} expected=0x${codeBase.toString(16)}`);
}

run(wordBytes(0x80640000,0x4E800020)); // lwz r3,0(r4); blr
console.log('HIR_SPARSE_LOAD_FAIL_CLOSED=PASS');
run(wordBytes(0x90640000,0x4E800020),{r3:0x12345678}); // stw r3,0(r4); blr
console.log('HIR_SPARSE_STORE_FAIL_CLOSED=PASS');

const source=fs.readFileSync('src/xenia_web_bootstrap/hir_correctness_executor.cpp','utf8');
for(const token of ['IsSyntheticProbeWindowRange','in_window=%u','!in_probe_window ||'])if(!source.includes(token))throw new Error(`missing fail-closed source contract ${token}`);
console.log('HIR_SPARSE_FAIL_CLOSED=PASS');
''')
print(f"{fail_closed}: written")

print("Braid/Portal runtime follow-up patch complete")
