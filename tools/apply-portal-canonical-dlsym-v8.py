from pathlib import Path

BUILD = Path('recompiled/pc/portal/source-wasm/build-render360.sh')
TEST = Path('test-portal-source-wasm-contract.mjs')

build = BUILD.read_text()
test = TEST.read_text()

if 'render360-single-worker-workerfs-v8-canonical-dlsym' in build:
    print('Portal v8 canonical dlsym patch already applied')
    raise SystemExit(0)

old_comment = '''# 3. Source asks every module for CreateInterface through dlsym(). The stock
#    dlsym path lazily searches the entire WebAssembly function table before it
#    can give a direct SIDE_MODULE export a C function pointer. That boundary is
#    exactly where the real Portal run stops on iPhone/WebKit. Prime the table
#    map while SIDE_MODULEs are loaded and give each module's CreateInterface a
#    stable, handle-local table slot directly. Other dlsym symbols retain the
#    stock Emscripten path.
'''
new_comment = '''# 3. Source asks every module for CreateInterface through dlsym(). Prime the
#    Emscripten function->table map before SIDE_MODULE loading so WebKit never
#    has to scan the full indirect-function table at first use. Reuse the exact
#    canonical table address Emscripten assigned to each SIDE_MODULE export;
#    only use addFunction() as the stock fallback when an address is genuinely
#    absent. This preserves the module-specific CreateInterface ABI identity.
'''
if old_comment not in build:
    raise SystemExit('Portal v8: dlsym comment anchor not found')
build = build.replace(old_comment, new_comment, 1)

old_dlsym = '''      if (typeof result == 'function') {
        // Source's module ABI always asks a CSysModule handle for its own
        // CreateInterface export. On WebKit this was the measured startup
        // boundary. Keep module identity exact and avoid the generic first-use
        // function-table search: create one stable indirect-call slot per DSO.
        if (symbol === 'CreateInterface') {
          if (lib.render360CreateInterfaceAddress) {
            result = lib.render360CreateInterfaceAddress;
          } else {
            var slot = getEmptyTableSlot();
            setWasmTableEntry(slot, result);
            if (!functionsInTableMap) functionsInTableMap = new WeakMap();
            functionsInTableMap.set(result, slot);
            lib.render360CreateInterfaceAddress = slot;
            result = slot;
            HEAPU32[((symbolIndex)>>2)] = newSymIndex;
          }
          err(`Render360 Source CreateInterface resolved · ${lib.name} · table ${result}`);
          return result;
        }

        var addr = getFunctionAddress(result);
        if (addr) {
          result = addr;
        } else {
          result = addFunction(result, result.sig);
          HEAPU32[((symbolIndex)>>2)] = newSymIndex;
        }
      }
'''
new_dlsym = '''      if (typeof result == 'function') {
        // postInstantiation() has already populated functionsInTableMap for
        // every SIDE_MODULE. Reuse that exact ABI-correct table identity. A
        // fresh manual table slot can change the indirect-call type/identity on
        // WebKit even when the JavaScript Function object itself looks valid.
        var addr = getFunctionAddress(result);
        var addressSource = 'existing';
        if (addr) {
          result = addr;
        } else {
          result = addFunction(result, result.sig);
          HEAPU32[((symbolIndex)>>2)] = newSymIndex;
          addressSource = 'added';
        }
        if (symbol === 'CreateInterface') {
          err(`Render360 Source CreateInterface resolved · ${lib.name} · table ${result} · ${addressSource}`);
        }
      }
'''
if old_dlsym not in build:
    raise SystemExit('Portal v8: CreateInterface manual-slot block not found')
build = build.replace(old_dlsym, new_dlsym, 1)

old_required = '''    'Render360 Source CreateInterface resolved',
    'render360CreateInterfaceAddress',
    'updateTableMap(0, wasmTable.length)',
'''
new_required = '''    'Render360 Source CreateInterface resolved',
    "addressSource = 'existing'",
    "addressSource = 'added'",
    'getFunctionAddress(result)',
    'updateTableMap(0, wasmTable.length)',
'''
if old_required not in build:
    raise SystemExit('Portal v8: generated-runtime required-marker block not found')
build = build.replace(old_required, new_required, 1)

trace_anchor = "print('Render360 Portal: patched Emscripten Sys_LoadModule to load SIDE_MODULEs by basename')\nPY\n\n"
trace_block = r'''print('Render360 Portal: patched Emscripten Sys_LoadModule to load SIDE_MODULEs by basename')
PY

# Trace the first real call through the Source module factory. The browser-side
# dlsym log proves that an address was returned; these three low-volume markers
# distinguish an indirect-call ABI failure from a stall inside Source's module
# registry or inside the selected interface constructor.
python3 - "$SOURCE_DIR/tier1/interface.cpp" <<'PY'
from pathlib import Path
import sys
path = Path(sys.argv[1])
text = path.read_text()
old = '''void* CreateInterfaceInternal( const char *pName, int *pReturnCode )
{
\tInterfaceReg *pCur;
\t
\tfor (pCur=InterfaceReg::s_pInterfaceRegs; pCur; pCur=pCur->m_pNext)
\t{
\t\tif (strcmp(pCur->m_pName, pName) == 0)
\t\t{
\t\t\tif (pReturnCode)
\t\t\t{
\t\t\t\t*pReturnCode = IFACE_OK;
\t\t\t}
\t\t\treturn pCur->m_CreateFn();
\t\t}
\t}
\t
\tif (pReturnCode)
\t{
\t\t*pReturnCode = IFACE_FAILED;
\t}
\treturn NULL;\t
}
'''
new = '''void* CreateInterfaceInternal( const char *pName, int *pReturnCode )
{
\tInterfaceReg *pCur;
#ifdef __EMSCRIPTEN__
\tMsg("Render360 Source CreateInterface enter · %s\\n", pName ? pName : "(null)");
#endif
\t
\tfor (pCur=InterfaceReg::s_pInterfaceRegs; pCur; pCur=pCur->m_pNext)
\t{
\t\tif (strcmp(pCur->m_pName, pName) == 0)
\t\t{
#ifdef __EMSCRIPTEN__
\t\t\tMsg("Render360 Source CreateInterface match · %s\\n", pName ? pName : "(null)");
#endif
\t\t\tif (pReturnCode)
\t\t\t{
\t\t\t\t*pReturnCode = IFACE_OK;
\t\t\t}
\t\t\tvoid *pInterface = pCur->m_CreateFn();
#ifdef __EMSCRIPTEN__
\t\t\tMsg("Render360 Source CreateInterface factory returned · %s · %p\\n", pName ? pName : "(null)", pInterface);
#endif
\t\t\treturn pInterface;
\t\t}
\t}
\t
#ifdef __EMSCRIPTEN__
\tMsg("Render360 Source CreateInterface miss · %s\\n", pName ? pName : "(null)");
#endif
\tif (pReturnCode)
\t{
\t\t*pReturnCode = IFACE_FAILED;
\t}
\treturn NULL;\t
}
'''
if old not in text:
    raise SystemExit('Could not locate CreateInterfaceInternal for Render360 factory trace')
text = text.replace(old, new, 1)
path.write_text(text)
print('Render360 Portal: instrumented CreateInterface factory entry/match/return')
PY

'''
if trace_anchor not in build:
    raise SystemExit('Portal v8: interface trace insertion anchor not found')
build = build.replace(trace_anchor, trace_block, 1)

build = build.replace("'profile': 'render360-single-worker-workerfs-v7-createinterface-webkit'", "'profile': 'render360-single-worker-workerfs-v8-canonical-dlsym'", 1)
old_diag = "        'createInterfaceHandleBridge': True,\n        'dlsymTableMapPrimed': True,"
new_diag = "        'createInterfaceHandleBridge': True,\n        'createInterfaceCanonicalTableAddress': True,\n        'createInterfaceManualTableSlot': False,\n        'createInterfaceFactoryTrace': True,\n        'dlsymTableMapPrimed': True,"
if old_diag not in build:
    raise SystemExit('Portal v8: diagnostics manifest anchor not found')
build = build.replace(old_diag, new_diag, 1)

old_test = '''assert.match(build,/createInterfaceHandleBridge': True/);
assert.match(build,/dlsymTableMapPrimed': True/);'''
new_test = '''assert.match(build,/createInterfaceHandleBridge': True/);
assert.match(build,/createInterfaceCanonicalTableAddress': True/);
assert.match(build,/createInterfaceManualTableSlot': False/);
assert.match(build,/createInterfaceFactoryTrace': True/);
assert.match(build,/dlsymTableMapPrimed': True/);'''
if old_test not in test:
    raise SystemExit('Portal v8: test diagnostics anchor not found')
test = test.replace(old_test, new_test, 1)

test = test.replace("assert.match(build,/render360-single-worker-workerfs-v7-createinterface-webkit/);", "assert.match(build,/render360-single-worker-workerfs-v8-canonical-dlsym/);", 1)

old_table_tests = '''assert.match(build,/Render360 Source CreateInterface resolved/);
assert.match(build,/render360CreateInterfaceAddress/);
assert.match(build,/updateTableMap\\(0, wasmTable\\.length\\)/);
assert.match(build,/getEmptyTableSlot\\(\\)/);
assert.match(build,/setWasmTableEntry\\(slot, result\\)/);'''
new_table_tests = '''assert.match(build,/Render360 Source CreateInterface resolved/);
assert.match(build,/addressSource = 'existing'/);
assert.match(build,/addressSource = 'added'/);
assert.match(build,/getFunctionAddress\\(result\\)/);
assert.match(build,/updateTableMap\\(0, wasmTable\\.length\\)/);
assert.match(build,/Render360 Source CreateInterface enter/);
assert.match(build,/Render360 Source CreateInterface match/);
assert.match(build,/Render360 Source CreateInterface factory returned/);
assert.doesNotMatch(build,/render360CreateInterfaceAddress/);
assert.doesNotMatch(build,/setWasmTableEntry\\(slot, result\\)/);'''
if old_table_tests not in test:
    raise SystemExit('Portal v8: table contract test anchor not found')
test = test.replace(old_table_tests, new_table_tests, 1)

log_anchor = "console.log('PORTAL_SOURCE_CREATEINTERFACE_HANDLE_BRIDGE=PASS');\n"
log_new = "console.log('PORTAL_SOURCE_CREATEINTERFACE_HANDLE_BRIDGE=PASS');\nconsole.log('PORTAL_SOURCE_CREATEINTERFACE_CANONICAL_TABLE=PASS');\nconsole.log('PORTAL_SOURCE_CREATEINTERFACE_FACTORY_TRACE=PASS');\n"
if log_anchor not in test:
    raise SystemExit('Portal v8: contract log anchor not found')
test = test.replace(log_anchor, log_new, 1)

for marker in (
    'render360-single-worker-workerfs-v8-canonical-dlsym',
    "addressSource = 'existing'",
    'createInterfaceCanonicalTableAddress',
    'Render360 Source CreateInterface factory returned',
):
    if marker not in build:
        raise SystemExit(f'Portal v8 build marker missing: {marker}')

BUILD.write_text(build)
TEST.write_text(test)
print('Portal v8 canonical dlsym + CreateInterface factory trace applied')
