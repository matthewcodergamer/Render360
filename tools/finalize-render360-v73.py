#!/usr/bin/env python3
"""Finish the V73 adaptive CPU/runtime release without hand-patching generated artifacts.

This migration is intentionally idempotent. It closes two remaining V73 gaps:
1. make VERSION authoritative across the browser runtime/service worker/bootstrap
   provenance contract, and
2. add Xenia HIR CNTLZ to the callable generated-Wasm function backend so Braid
   can move from the correctness fallback toward translatedFunctions > 0.
"""
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]
VERSION = (ROOT / 'VERSION').read_text(encoding='utf-8').strip()
if not VERSION.isdigit():
    raise SystemExit(f'Invalid VERSION: {VERSION!r}')
VERSION_N = int(VERSION)

changed = []

def write_if_changed(path: str, text: str) -> None:
    p = ROOT / path
    old = p.read_text(encoding='utf-8')
    if text != old:
        p.write_text(text, encoding='utf-8')
        changed.append(path)


def replace_required(text: str, pattern: str, repl: str, label: str, count: int = 1) -> str:
    out, n = re.subn(pattern, repl, text, count=count, flags=re.MULTILINE)
    if n != count:
        raise SystemExit(f'{label}: expected {count} replacement(s), got {n}')
    return out

# ---------------------------------------------------------------------------
# One authoritative release number: VERSION.
# ---------------------------------------------------------------------------
runtime_path = 'runtime/render360-runtime.js'
runtime = (ROOT / runtime_path).read_text(encoding='utf-8')
runtime = replace_required(runtime, r'const RENDER360_RELEASE=\d+;', f'const RENDER360_RELEASE={VERSION_N};', 'runtime release')
runtime = replace_required(runtime, r'const REQUIRED_CORE_BUILD=\d+;', f'const REQUIRED_CORE_BUILD={VERSION_N};', 'runtime core release')
runtime = replace_required(runtime, r'const CONTENT_BRIDGE=\{release:\d+,', f'const CONTENT_BRIDGE={{release:{VERSION_N},', 'content bridge release')
old_gate = "if(this.core.buildVersion<REQUIRED_CORE_BUILD)throw new Error(`Runtime contract requires Core V${REQUIRED_CORE_BUILD}+; loaded V${this.core.buildVersion}`);"
new_gate = "if(this.core.buildVersion!==REQUIRED_CORE_BUILD)throw new Error(`Render360 V${RENDER360_RELEASE} requires synchronized package core V${REQUIRED_CORE_BUILD}; loaded V${this.core.buildVersion}. Refresh after the release artifacts finish publishing.`);"
if old_gate in runtime:
    runtime = runtime.replace(old_gate, new_gate, 1)
elif new_gate not in runtime:
    raise SystemExit('runtime exact package-core version gate anchor not found')
write_if_changed(runtime_path, runtime)

sw_path = 'render360-sw.js'
sw = (ROOT / sw_path).read_text(encoding='utf-8')
sw = replace_required(sw, r"const VERSION='\d+';", f"const VERSION='{VERSION_N}';", 'service worker release')
write_if_changed(sw_path, sw)

# Browser bootstrap provenance now carries the same release number and rejects
# a valid-but-stale Wasm binary from another Render360 release.
title_runtime_path = 'render360-browser-title-runtime.mjs'
title_runtime = (ROOT / title_runtime_path).read_text(encoding='utf-8')
release_decl = f'const RENDER360_RELEASE={VERSION_N};\n'
if 'const RENDER360_RELEASE=' in title_runtime:
    title_runtime = replace_required(title_runtime, r'const RENDER360_RELEASE=\d+;\n', release_decl, 'bootstrap runtime release')
else:
    anchor = "export const PPC_BOOTSTRAP_META_URL='./xenia_ppc_bootstrap.meta.json';\n"
    if anchor not in title_runtime:
        raise SystemExit('bootstrap release declaration anchor not found')
    title_runtime = title_runtime.replace(anchor, anchor + release_decl, 1)

release_validation = "  const release=Number(metadata.release);\n  if(!Number.isSafeInteger(release)||release!==RENDER360_RELEASE)throw new Error(`Render360 bootstrap release mismatch: expected V${RENDER360_RELEASE}, received ${metadata.release??'missing'}`);\n"
if 'Render360 bootstrap release mismatch:' not in title_runtime:
    anchor = "  if(!/^\\d+$/.test(String(metadata.sourceRun||'')))throw new Error('Render360 bootstrap source run is invalid');\n"
    if anchor not in title_runtime:
        raise SystemExit('bootstrap metadata validation anchor not found')
    title_runtime = title_runtime.replace(anchor, anchor + release_validation, 1)
if 'release,' not in title_runtime.split('return {', 1)[-1][:500]:
    anchor = '    verified:true,\n'
    if anchor not in title_runtime:
        raise SystemExit('bootstrap identity return anchor not found')
    title_runtime = title_runtime.replace(anchor, anchor + '    release,\n', 1)
write_if_changed(title_runtime_path, title_runtime)

# Fastlane must rebuild when VERSION changes and stamp the verified PPC bootstrap
# with that same version. The runtime above will refuse anything else.
fastlane_path = '.github/workflows/xenia-browser-bootstrap-fastlane.yml'
fastlane = (ROOT / fastlane_path).read_text(encoding='utf-8')
if "      - 'VERSION'\n" not in fastlane:
    anchor = "      - 'build-xenia-ppc-bootstrap.sh'\n"
    if anchor not in fastlane:
        raise SystemExit('fastlane VERSION trigger anchor not found')
    fastlane = fastlane.replace(anchor, "      - 'VERSION'\n" + anchor, 1)
if "'release': int(Path('VERSION').read_text().strip())," not in fastlane:
    anchor = "          meta={\n            'sourceCommit': os.environ['SOURCE_COMMIT'],\n"
    if anchor not in fastlane:
        raise SystemExit('fastlane provenance metadata anchor not found')
    fastlane = fastlane.replace(anchor, "          meta={\n            'release': int(Path('VERSION').read_text().strip()),\n            'sourceCommit': os.environ['SOURCE_COMMIT'],\n", 1)
strict_check = "          node ./test-render360-version-consistency.mjs\n"
if strict_check not in fastlane:
    anchor = "          Path('xenia_ppc_bootstrap.meta.json').write_text(json.dumps(meta,indent=2)+'\\n')\n          PY\n"
    if anchor not in fastlane:
        raise SystemExit('fastlane metadata write anchor not found')
    fastlane = fastlane.replace(anchor, anchor + strict_check, 1)
if "      - 'test-render360-version-consistency.mjs'\n" not in fastlane:
    anchor = "      - 'test-hir-cntlz.mjs'\n"
    if anchor not in fastlane:
        raise SystemExit('fastlane version-test trigger anchor not found')
    fastlane = fastlane.replace(anchor, anchor + "      - 'test-render360-version-consistency.mjs'\n", 1)
write_if_changed(fastlane_path, fastlane)

# ---------------------------------------------------------------------------
# Callable Xenia HIR -> Wasm CNTLZ. The scalar probe already has native clz;
# this closes the production function-registry gap that kept title functions
# from being admitted when cntlzw/cntlzd appeared in the HIR dependency graph.
# ---------------------------------------------------------------------------
call_path = 'src/xenia_web_bootstrap/wasm_backend_call_probe.cpp'
call_src = (ROOT / call_path).read_text(encoding='utf-8')
if 'case xe::cpu::hir::OPCODE_CNTLZ:' not in call_src:
    anchor = '    case xe::cpu::hir::OPCODE_BYTE_SWAP: {\n'
    if anchor not in call_src:
        raise SystemExit('callable CNTLZ insertion anchor not found')
    cntlz = '''    case xe::cpu::hir::OPCODE_CNTLZ: {
      const Value* source = instr->src1.value;
      if (!source || value->type != xe::cpu::hir::INT8_TYPE ||
          !ScalarTypeSize(source->type) ||
          !EmitI64Value(source, producers, visiting, body, lowered)) {
        break;
      }
      // The callable backend represents integer expressions as i64. Preserve
      // Xenia's source width, use Wasm's native clz, then return the count as
      // the INT8 HIR destination. For 8/16-bit values i32.clz includes the
      // unused high bits, so subtract the width bias exactly as the scalar
      // generated-Wasm backend does.
      EmitI64Mask(body, source->type);
      if (source->type == xe::cpu::hir::INT64_TYPE) {
        body.push_back(0x79);  // i64.clz
      } else {
        body.push_back(0xA7);  // i32.wrap_i64
        body.push_back(0x67);  // i32.clz
        const uint32_t bits = ScalarTypeSize(source->type) * 8u;
        const uint32_t bias = 32u - bits;
        if (bias) {
          body.push_back(0x41);  // i32.const
          EmitI32Leb(body, static_cast<int32_t>(bias));
          body.push_back(0x6B);  // i32.sub
        }
        body.push_back(0xAD);  // i64.extend_i32_u
      }
      EmitI64Mask(body, value->type);
      ok = true;
      break;
    }
'''
    call_src = call_src.replace(anchor, cntlz + anchor, 1)

# BuildModule has a separate fail-closed admission list from EmitI64Value. A
# lowering case without admission still produces zero callable functions. Keep
# CNTLZ in both places so the production registry can actually accept it.
cntlz_allow = '''               instr->opcode->num == xe::cpu::hir::OPCODE_LOAD_OFFSET ||
               instr->opcode->num == xe::cpu::hir::OPCODE_CNTLZ ||
               instr->opcode->num == xe::cpu::hir::OPCODE_BYTE_SWAP ||'''
if cntlz_allow not in call_src:
    anchor = '''               instr->opcode->num == xe::cpu::hir::OPCODE_LOAD_OFFSET ||
               instr->opcode->num == xe::cpu::hir::OPCODE_BYTE_SWAP ||'''
    if anchor not in call_src:
        raise SystemExit('callable CNTLZ admission anchor not found')
    call_src = call_src.replace(anchor, cntlz_allow, 1)
write_if_changed(call_path, call_src)

# Focused production-path regression: dynamic r4 -> cntlzw r3,r4 -> blr must
# produce one callable generated function and match the correctness oracle.
test_path = 'test-wasm-backend-calls.mjs'
test = (ROOT / test_path).read_text(encoding='utf-8')
if 'WASM_BACKEND_CALL_CNTLZ=PASS' not in test:
    anchor = "console.log('WASM_BACKEND_CALL_DIRECT=PASS');\n"
    if anchor not in test:
        raise SystemExit('call-backend CNTLZ test insertion anchor not found')
    regression = '''// V73 production regression: CNTLZ must be admitted by the callable function
// backend, not only by the scalar probe/correctness oracle. Keep r4 dynamic so
// Xenia cannot constant-fold the count before Render360 lowers it.
pick('r360_ppc_probe_reset')();
if ((pick('r360_ppc_probe_set_initial_gpr')(4,1n)>>>0)!==1) throw new Error('Could not seed callable CNTLZ r4');
const callableCntlz = wordBytes(
  0x7C830034,  // cntlzw r3,r4
  0x4E800020,  // blr
);
const cntlzInput = pick('r360_ppc_probe_input_buffer')()>>>0;
new Uint8Array(parent.exports.memory.buffer,cntlzInput,callableCntlz.length).set(callableCntlz);
if ((pick('r360_ppc_probe_load')(cntlzInput,callableCntlz.length)>>>0)!==callableCntlz.length) throw new Error('Could not load callable CNTLZ PPC');
pick('r360_ppc_probe_translate')();
const cntlzOracleStatus=pick('r360_ppc_probe_correctness_status')()>>>0;
const cntlzOracleR3=BigInt.asUintN(64,pick('r360_ppc_probe_correctness_r3')());
if(cntlzOracleStatus!==3||cntlzOracleR3!==31n)throw new Error(`Callable CNTLZ oracle failed status=${cntlzOracleStatus} r3=${cntlzOracleR3}`);
if((pick('r360_wasm_backend_call_function_count')()>>>0)!==1)throw new Error(`Callable CNTLZ produced ${pick('r360_wasm_backend_call_function_count')()>>>0} functions`);
const cntlzSession=await createPersistentPpcSession({bootstrap:parent,initialGprs:{4:1n}});
const cntlzResult=await cntlzSession.runFunctionSlice(guestBase);
if(cntlzResult.r3!==31n||cntlzResult.result!==31n)throw new Error(`Callable CNTLZ mismatch generated=${cntlzResult.r3} oracle=${cntlzOracleR3}`);
console.log('WASM_BACKEND_CALL_CNTLZ=PASS');

'''
    test = test.replace(anchor, regression + anchor, 1)
write_if_changed(test_path, test)

print(f'FINALIZE_RENDER360_V73 version={VERSION_N} changed={len(changed)}')
for path in changed:
    print(f'  {path}')
