#!/usr/bin/env python3
"""Apply Render360 V77 browser scanned-entry wasm trap hardening.

The iPhone failure is a raw wasm `unreachable` escaping from Xenia translation.
Pinned Xenia intentionally DebugBreaks on an unimplemented PPC instruction;
that is appropriate for a native debugger, but fatal in standalone wasm32.
V77 keeps native behavior intact, reports the exact guest instruction, fails
browser translation cleanly, and turns any remaining wasm trap into a
structured Render360 diagnostic.
"""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def read(path):
    return (ROOT / path).read_text()


def write(path, text):
    (ROOT / path).write_text(text)


def replace_once(text, old, new, label):
    if new in text:
        return text
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected one anchor, found {count}")
    return text.replace(old, new, 1)


# 1) Build the browser-only HIR builder overlay and compile it in place of the
# pristine upstream translation unit.
build_path = "build-xenia-ppc-bootstrap.sh"
build = read(build_path)
build = replace_once(
    build,
    'python3 "$ROOT/prepare-xenia-compiler-overlay.py"\npython3 "$ROOT/prepare-vmx-executor-overlay.py"\n',
    'python3 "$ROOT/prepare-xenia-compiler-overlay.py"\npython3 "$ROOT/prepare-xenia-ppc-hir-failclosed-overlay.py"\npython3 "$ROOT/prepare-vmx-executor-overlay.py"\n',
    "browser HIR overlay invocation",
)
build = replace_once(
    build,
    '    "src/xenia/cpu/ppc/ppc_scanner.cc") queue_cpp "$rel" "$OVERLAY/xenia/cpu/ppc/ppc_scanner.cc" ;;\n',
    '    "src/xenia/cpu/ppc/ppc_scanner.cc") queue_cpp "$rel" "$OVERLAY/xenia/cpu/ppc/ppc_scanner.cc" ;;\n    "src/xenia/cpu/ppc/ppc_hir_builder.cc") queue_cpp "$rel" "$OVERLAY/xenia/cpu/ppc/ppc_hir_builder.cc" ;;\n',
    "browser HIR overlay compile route",
)
write(build_path, build)

# 2) Persist exact unsupported-PPC telemetry across the clean translation
# failure so JavaScript can identify the instruction instead of receiving only
# a generic DefineFunction failure.
probe_path = "src/xenia_web_bootstrap/ppc_translation_probe.cpp"
probe = read(probe_path)
probe = replace_once(
    probe,
    'uint32_t g_scan_hir_instructions = 0;\n',
    'uint32_t g_scan_hir_instructions = 0;\nuint32_t g_unimplemented_ppc_address = 0;\nuint32_t g_unimplemented_ppc_code = 0;\n',
    "unimplemented PPC telemetry globals",
)
probe = replace_once(
    probe,
    '  g_scan_hir_instructions = 0;\n}\n\nbool EnsureRuntime() {\n',
    '  g_scan_hir_instructions = 0;\n  g_unimplemented_ppc_address = 0;\n  g_unimplemented_ppc_code = 0;\n}\n\nbool EnsureRuntime() {\n',
    "unimplemented PPC telemetry reset",
)
probe_reporter = '''void r360_ppc_probe_report_unimplemented(uint32_t address, uint32_t code) {
  using namespace render360::xenia_web;
  g_unimplemented_ppc_address = address;
  g_unimplemented_ppc_code = code;
  std::fprintf(stderr,
               "R360_PPC_UNIMPLEMENTED address=0x%08X code=0x%08X fail_closed=1\\n",
               address, code);
}
uint32_t r360_ppc_probe_unimplemented_address() {
  return render360::xenia_web::g_unimplemented_ppc_address;
}
uint32_t r360_ppc_probe_unimplemented_code() {
  return render360::xenia_web::g_unimplemented_ppc_code;
}

'''
if "void r360_ppc_probe_report_unimplemented" not in probe:
    anchor = "uint32_t r360_ppc_probe_status() {\n"
    if anchor not in probe:
        raise SystemExit("PPC reporter insertion anchor drifted")
    probe = probe.replace(anchor, probe_reporter + anchor, 1)
write(probe_path, probe)

# 3) Guard the JS -> Wasm scanned-entry boundary. The fail-closed HIR path now
# normally returns zero, but any unrelated assert/trap must still become a
# Render360 diagnostic instead of Safari's bare 'Unreachable code' modal.
controller_path = "render360-title-controller.mjs"
controller = read(controller_path)
old_handoff = '''  const scannedEntry=maybe(bootstrap,'r360_title_handoff_translate_scanned_entry');
  if(scanEntryFunction&&!scannedEntry)throw new Error('browser bootstrap is missing scanned title-entry execution');
  const hir=scanEntryFunction?(scannedEntry()>>>0):(pick(bootstrap,'r360_title_handoff_translate_entry')(entryBytes)>>>0);
  const entryExecutionMode=scanEntryFunction?'xenia-scanned-entry-function':'bounded-entry-byte-probe';
'''
new_handoff = '''  const scannedEntry=maybe(bootstrap,'r360_title_handoff_translate_scanned_entry');
  if(scanEntryFunction&&!scannedEntry)throw new Error('browser bootstrap is missing scanned title-entry execution');
  const entryExecutionMode=scanEntryFunction?'xenia-scanned-entry-function':'bounded-entry-byte-probe';
  let hir=0;
  try{
    hir=scanEntryFunction?(scannedEntry()>>>0):(pick(bootstrap,'r360_title_handoff_translate_entry')(entryBytes)>>>0);
  }catch(cause){
    const get32=name=>maybe(bootstrap,name)?.()>>>0||0;
    const handoffStatus=get32('r360_title_handoff_status');
    const probeStatus=get32('r360_ppc_probe_status');
    const scanDiagnostic=get32('r360_ppc_probe_scan_diagnostic');
    const scanAddress=get32('r360_ppc_probe_scan_address');
    const scanWindowEnd=get32('r360_ppc_probe_scan_window_end');
    const scanFunctionEnd=get32('r360_ppc_probe_scan_function_end');
    const unsupportedPpcAddress=get32('r360_ppc_probe_unimplemented_address');
    const unsupportedPpcCode=get32('r360_ppc_probe_unimplemented_code');
    const hex=value=>`0x${(value>>>0).toString(16).toUpperCase().padStart(8,'0')}`;
    const causeMessage=cause?.message||String(cause);
    const unsupported=unsupportedPpcAddress?` unsupportedPpc=${hex(unsupportedPpcAddress)} code=${hex(unsupportedPpcCode)}`:'';
    const error=new Error(`title entry translation trapped inside browser Wasm: ${causeMessage} mode=${entryExecutionMode} entry=${hex(entry)} scanAddress=${hex(scanAddress)} scanWindowEnd=${hex(scanWindowEnd)} scanFunctionEnd=${hex(scanFunctionEnd)}${unsupported}`);
    error.code='R360_TITLE_ENTRY_WASM_TRAP';
    error.cause=cause;
    error.render360={kind:'ppc-entry-wasm-trap',handoffStatus,probeStatus,scanDiagnostic,scanAddress,scanWindowEnd,scanFunctionEnd,unsupportedPpcAddress,unsupportedPpcCode,entry:entry>>>0,entryExecutionMode,causeMessage};
    throw error;
  }
'''
controller = replace_once(controller, old_handoff, new_handoff, "scanned-entry Wasm trap guard")
controller = replace_once(
    controller,
    "    const assembledFunctions=maybe(bootstrap,'r360_ppc_probe_assembled_functions')?.()>>>0||0;\n",
    "    const unsupportedPpcAddress=maybe(bootstrap,'r360_ppc_probe_unimplemented_address')?.()>>>0||0;\n    const unsupportedPpcCode=maybe(bootstrap,'r360_ppc_probe_unimplemented_code')?.()>>>0||0;\n    const assembledFunctions=maybe(bootstrap,'r360_ppc_probe_assembled_functions')?.()>>>0||0;\n",
    "clean translation failure PPC telemetry",
)
controller = replace_once(
    controller,
    "assembledFunctions=${assembledFunctions} hirBlocks=${hirBlocks} scanHIR=${scanHir}`);\n",
    "assembledFunctions=${assembledFunctions} hirBlocks=${hirBlocks} scanHIR=${scanHir} unsupportedPpcAddress=${hex(unsupportedPpcAddress)} unsupportedPpcCode=${hex(unsupportedPpcCode)}`);\n",
    "clean translation failure message telemetry",
)
controller = replace_once(
    controller,
    "scanFunctionEnd,assembledFunctions,hirBlocks,scanHir,entry:entry>>>0,entryExecutionMode};\n",
    "scanFunctionEnd,unsupportedPpcAddress,unsupportedPpcCode,assembledFunctions,hirBlocks,scanHir,entry:entry>>>0,entryExecutionMode};\n",
    "clean translation failure structured telemetry",
)
write(controller_path, controller)

# 4) Make the newly discovered regression part of the actual browser-bootstrap
# CI, including execution of the pre-existing scanned-entry runtime test that
# was not in the fastlane verification job.
fastlane_path = ".github/workflows/xenia-browser-bootstrap-fastlane.yml"
fastlane = read(fastlane_path)
fastlane = replace_once(
    fastlane,
    "      - 'prepare-wasm-backend-cfg-overlay.py'\n",
    "      - 'prepare-wasm-backend-cfg-overlay.py'\n      - 'prepare-xenia-ppc-hir-failclosed-overlay.py'\n      - 'test-browser-wasm-trap-failclosed-v77.mjs'\n      - 'test-title-scanned-entry-runtime.mjs'\n",
    "fastlane V77 path triggers",
)
fastlane_step = '''
      - name: Verify browser unsupported-PPC translation fails closed
        run: node ./test-browser-wasm-trap-failclosed-v77.mjs

      - name: Execute scanned-entry title runtime regression
        run: timeout 90s node ./test-title-scanned-entry-runtime.mjs build/xenia-ppc-bootstrap/xenia_ppc_bootstrap.wasm
'''
if "Verify browser unsupported-PPC translation fails closed" not in fastlane:
    anchor = "      - name: Verify Xenia title-entry LR ABI\n"
    if anchor not in fastlane:
        raise SystemExit("fastlane verification insertion anchor drifted")
    fastlane = fastlane.replace(anchor, fastlane_step + "\n" + anchor, 1)
write(fastlane_path, fastlane)

# 5) Synchronized release contract.
version = read("VERSION").strip()
if version not in {"76", "77"}:
    raise SystemExit(f"V77 updater expected VERSION 76 or 77, found {version}")
write("VERSION", "77\n")

runtime_path = "runtime/render360-runtime.js"
runtime = read(runtime_path)
runtime = replace_once(runtime, "const RENDER360_RELEASE=76;", "const RENDER360_RELEASE=77;", "runtime release")
runtime = replace_once(runtime, "const REQUIRED_CORE_BUILD=76;", "const REQUIRED_CORE_BUILD=77;", "runtime core requirement")
runtime = replace_once(runtime, "const CONTENT_BRIDGE={release:76,", "const CONTENT_BRIDGE={release:77,", "runtime bridge release")
write(runtime_path, runtime)

title_runtime_path = "render360-browser-title-runtime.mjs"
title_runtime = read(title_runtime_path)
title_runtime = replace_once(title_runtime, "const RENDER360_RELEASE=76;", "const RENDER360_RELEASE=77;", "title runtime release")
write(title_runtime_path, title_runtime)

modern_bridge_path = "render360-browser-modern-content-bridge.mjs"
modern_bridge = read(modern_bridge_path)
modern_bridge = replace_once(modern_bridge, "return {release:76,inputs:", "return {release:77,inputs:", "modern bridge contract")
write(modern_bridge_path, modern_bridge)

sw_path = "render360-sw.js"
sw = read(sw_path)
sw = replace_once(sw, "const VERSION='76';", "const VERSION='77';", "service worker release")
write(sw_path, sw)

index_path = "index.html"
index = read(index_path)
if "Render360 76" in index:
    index = index.replace("Render360 76", "Render360 77")
if '<span>UI Release</span><span class="value">76</span>' in index:
    index = index.replace('<span>UI Release</span><span class="value">76</span>', '<span>UI Release</span><span class="value">77</span>')
if "Render360 77" not in index:
    raise SystemExit("index.html V77 release label was not found/applied")
write(index_path, index)

print("R360_V77_BROWSER_WASM_TRAP_FAILCLOSED_APPLIED=1")
