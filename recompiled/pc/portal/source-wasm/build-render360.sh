#!/usr/bin/env bash
set -euo pipefail

SOURCE_DIR="${1:?usage: build-render360.sh <source-engine-dir> <output-dir> <render360-root>}"
OUTPUT_DIR="${2:?usage: build-render360.sh <source-engine-dir> <output-dir> <render360-root>}"
R360_ROOT="${3:?usage: build-render360.sh <source-engine-dir> <output-dir> <render360-root>}"
SOURCE_DIR="$(cd "$SOURCE_DIR" && pwd)"
R360_ROOT="$(cd "$R360_ROOT" && pwd)"
mkdir -p "$OUTPUT_DIR"
OUTPUT_DIR="$(cd "$OUTPUT_DIR" && pwd)"
OVERLAY_DIR="$R360_ROOT/recompiled/pc/portal/source-wasm"

cd "$SOURCE_DIR"
export CC=emcc
export CXX=em++

# The upstream Source Emscripten profile enables -pthread and SHARED_MEMORY for
# every Wasm object/side module. Render360 intentionally runs Portal in one
# dedicated browser Worker without SharedArrayBuffer/cross-origin isolation.
# Leaving the upstream flags enabled produces SIDE_MODULEs that import shared
# memory while our MAIN_MODULE imports ordinary memory. Patch only the pinned
# checkout used for this build; the upstream repository itself is not modified.
python3 - "$SOURCE_DIR/wscript" <<'PY'
from pathlib import Path
import sys
path = Path(sys.argv[1])
text = path.read_text()
old_pthread = "\tif conf.env.COMPILER_CC != 'msvc':\n\t\tflags += ['-pthread']"
new_pthread = "\tif conf.env.COMPILER_CC != 'msvc' and not conf.options.EMSCRIPTEN:\n\t\tflags += ['-pthread']"
old_shared = "\t\tflags += ['-sSHARED_MEMORY=1', '-msimd128', '-msse']"
new_shared = "\t\tflags += ['-msimd128', '-msse']"
if old_pthread not in text:
    raise SystemExit('Could not locate upstream global -pthread flag for Render360 single-worker patch')
if old_shared not in text:
    raise SystemExit('Could not locate upstream -sSHARED_MEMORY=1 flag for Render360 single-worker patch')
text = text.replace(old_pthread, new_pthread, 1)
text = text.replace(old_shared, new_shared, 1)
path.write_text(text)
print('Render360 Portal: patched upstream Emscripten profile to non-threaded/unshared memory')
PY

# The pinned community fork contains a browser-demo-only path in FindMap(): it
# posts a request to JavaScript to download a missing map and then blocks with
# __builtin_wasm_memory_atomic_wait32(). Render360 never uses that network map
# downloader: the player's complete owned Portal install is already mounted by
# WORKERFS before Source starts. Keeping this wait forces the Wasm atomics/shared
# memory target feature and contradicts our single-worker iPhone runtime. Remove
# only that Emscripten download/wait block from the temporary pinned checkout.
python3 - "$SOURCE_DIR/engine/vengineserver_impl.cpp" <<'PY'
from pathlib import Path
import re, sys
path = Path(sys.argv[1])
text = path.read_text()
pattern = re.compile(
    r"(\tvirtual eFindMapResult FindMap\( /\* in/out \*/ char \*pMapName, int nMapNameMax \)\n\t\{\n)"
    r"#ifdef __EMSCRIPTEN__\n.*?#endif\n",
    re.S,
)
replacement = r'''\1#ifdef __EMSCRIPTEN__
		// Render360: all player-owned Portal files are already mounted locally.
		// Do not invoke the community demo's remote-map downloader or block this
		// single game worker with memory.atomic.wait32.
#endif
'''
updated, count = pattern.subn(replacement, text, count=1)
if count != 1:
    raise SystemExit('Could not locate Source FindMap Emscripten atomic-wait block')
if '__builtin_wasm_memory_atomic_wait32(&lock, 1, -1)' in updated:
    raise SystemExit('Render360 Portal atomic-wait removal did not apply')
path.write_text(updated)
print('Render360 Portal: removed remote-map atomic wait; local WORKERFS path only')
PY

# Source's Emscripten Sys_LoadModule sanitizer assumes every module path starts
# with /bin/lib. With Render360's WORKERFS cwd, Source can pass an absolute path
# such as /render360-game/bin/filesystem_stdio.so. The old prefix-eating logic
# stripped only the first slash and then prepended "lib" to the entire remainder,
# yielding the impossible path librender360-game/bin/filesystem_stdio.so. Dynamic
# SIDE_MODULEs live in the engine runtime package and are located by filename, so
# normalize to the basename before adding the conventional lib prefix.
python3 - "$SOURCE_DIR/tier1/interface.cpp" <<'PY'
from pathlib import Path
import sys
path = Path(sys.argv[1])
text = path.read_text()
old = '''\tchar szModuleName[1024] = { 0 };
\tchar fmtBuf[1024] = "lib%s";

#define EAT(prefix) if(strncmp(pModuleName, prefix, strlen(prefix)) == 0) pModuleName += strlen(prefix)
\tEAT("/"); EAT("bin"); EAT("/"); EAT("lib");
#undef EAT

\tif(!string_endsWith(pModuleName, ".so")) {
\t\tstrcat(fmtBuf, ".so");
\t}

\tQ_snprintf(szModuleName, sizeof(szModuleName), fmtBuf, pModuleName);
\tMsg("LoadLibrary: path: %s\\n", szModuleName);

\thDLL = (HMODULE)dlopen( szModuleName, RTLD_NOW );
'''
new = '''\tchar szModuleName[1024] = { 0 };
\tconst char *pBaseName = strrchr(pModuleName, '/');
\tif(!pBaseName) pBaseName = strrchr(pModuleName, '\\\\');
\tpBaseName = pBaseName ? pBaseName + 1 : pModuleName;

\tchar szBaseName[1024] = { 0 };
\tQ_strncpy(szBaseName, pBaseName, sizeof(szBaseName));
\tif(!string_endsWith(szBaseName, ".so")) {
\t\tstrcat(szBaseName, ".so");
\t}

\tif(strncmp(szBaseName, "lib", 3) == 0) {
\t\tQ_strncpy(szModuleName, szBaseName, sizeof(szModuleName));
\t} else {
\t\tQ_snprintf(szModuleName, sizeof(szModuleName), "lib%s", szBaseName);
\t}
\tMsg("Render360 LoadLibrary: pModule: %s, file: %s\\n", pModuleName, szModuleName);

\thDLL = (HMODULE)dlopen( szModuleName, RTLD_NOW );
'''
if old not in text:
    raise SystemExit('Could not locate Source Emscripten Sys_LoadModule path sanitizer')
updated = text.replace(old, new, 1)
if 'librender360-game/bin/' in updated:
    raise SystemExit('Unexpected hard-coded bad Render360 dylib path remains')
if 'Render360 LoadLibrary: pModule:' not in updated:
    raise SystemExit('Render360 dylib basename patch did not apply')
path.write_text(updated)
print('Render360 Portal: patched Emscripten Sys_LoadModule to load SIDE_MODULEs by basename')
PY

python3 waf configure -T release --notests -4 --togles --emscripten \
  --disable-warns --build-games=portal --prefix=build/install
python3 waf install
find build/ -name '*.map' -exec cp {} build/install/ \; || true

shopt -s nullglob
link_libs=()
for lib in build/install/*.so; do
  libname="$(basename "$lib")"
  libname="${libname#lib}"
  libname="${libname%.so}"
  link_libs+=("-l${libname}")
done
shopt -u nullglob

# iPhone-first host profile. The full Source module runs in one dedicated
# browser Worker. WORKERFS supplies player-owned files without copying the
# entire Portal install into Wasm memory.
emcc \
  -sUSE_BZIP2=1 -sUSE_SDL=2 -sUSE_FREETYPE=1 -sUSE_LIBJPEG=1 -sUSE_LIBPNG=1 -sMALLOC=mimalloc \
  -sMAIN_MODULE=1 \
  -sINITIAL_MEMORY=384mb -sMAXIMUM_MEMORY=1536mb -sALLOW_MEMORY_GROWTH=1 \
  -sFULL_ES3 -sSTACK_SIZE=4mb -sENVIRONMENT=worker \
  -sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=createPortalSourceModule \
  -sFORCE_FILESYSTEM=1 -sEXPORTED_RUNTIME_METHODS=FS,WORKERFS,callMain,HEAPU8 \
  -sOFFSCREENCANVAS_SUPPORT=1 -sEXIT_RUNTIME=0 \
  -lworkerfs.js \
  --pre-js "$OVERLAY_DIR/render360-pre.js" \
  -L build/install/ \
  build/launcher_main/libhl2_launcher.a \
  "${link_libs[@]}" \
  -o build/launcher_main/portal-source-engine.mjs

# Patch three Emscripten 4.0.9 browser-runtime boundaries that matter on iOS:
# 1. rejected load-time SIDE_MODULEs must reject the modularized factory rather
#    than leaving the loadDylibs run dependency installed forever;
# 2. a corrupted zero stack-end must be restored using Emscripten's own stack
#    metadata instead of writing a cookie at address 0x00000004;
# 3. Source asks every module for CreateInterface through dlsym(). The stock
#    dlsym path lazily searches the entire WebAssembly function table before it
#    can give a direct SIDE_MODULE export a C function pointer. That boundary is
#    exactly where the real Portal run stops on iPhone/WebKit. Prime the table
#    map while SIDE_MODULEs are loaded and give each module's CreateInterface a
#    stable, handle-local table slot directly. Other dlsym symbols retain the
#    stock Emscripten path.
python3 - build/launcher_main/portal-source-engine.mjs <<'PY'
from pathlib import Path
import re, sys
path=Path(sys.argv[1])
text=path.read_text()
pattern=re.compile(r"  var loadDylibs = \(\) => \{.*?\n    \};\n",re.S)
replacement=r'''  var loadDylibs = () => {
      if (!dynamicLibraries.length) {
        reportUndefinedSymbols();
        return;
      }

      addRunDependency('loadDylibs');
      dynamicLibraries
        .reduce((chain, lib) => chain.then(() =>
          loadDynamicLibrary(lib, {loadAsync: true, global: true, nodelete: true, allowUndefined: true})
            .catch((error) => {
              throw new Error(`Render360 Source dylib failed: ${lib}: ${error?.message || error}`);
            })
        ), Promise.resolve())
        .then(() => {
          reportUndefinedSymbols();
          removeRunDependency('loadDylibs');
        })
        .catch((error) => {
          err(`Render360 dynamic library bootstrap failed: ${error?.stack || error}`);
          removeRunDependency('loadDylibs');
          readyPromiseReject(error);
        });
    };
'''
updated,count=pattern.subn(replacement,text,count=1)
if count != 1:
    raise SystemExit('Could not locate Emscripten loadDylibs block for Render360 fail-fast patch')

# Initialize Emscripten's function->table-address map before side modules load.
# postInstantiation() already calls updateTableMap() for every SIDE_MODULE, but
# stock Emscripten makes that call a no-op until the first later dlsym. Keeping
# the map alive here makes later symbol lookup constant-time and deterministic.
map_old = "    LDSO.init();\n    loadDylibs();"
map_new = """    LDSO.init();
    if (!functionsInTableMap) {
      functionsInTableMap = new WeakMap();
      updateTableMap(0, wasmTable.length);
    }
    loadDylibs();"""
if map_old not in updated:
    raise SystemExit('Could not locate LDSO.init/loadDylibs sequence for Render360 table-map prime')
updated = updated.replace(map_old, map_new, 1)

stack_pattern = re.compile(
    r"(function checkStackCookie\(\) \{\n  if \(ABORT\) return;\n  var max = _emscripten_stack_get_end\(\);\n)"
    r"  // See writeStackCookie\(\)\.\n  if \(max == 0\) \{\n    max \+= 4;\n  \}\n"
)
stack_replacement = r'''\1  // A zero stack end is impossible for this linked Render360 MAIN_MODULE.
  // Emscripten issue #22195 reports the same 0x00000004 cookie symptom. Rather
  // than accepting address four as a fake stack boundary, restore the exact
  // link-time limits generated by Emscripten and verify them before checking.
  if (max == 0) {
    stackCheckInit();
    max = _emscripten_stack_get_end();
    if (max == 0) {
      abort('Render360 Source stack metadata remained zero after stackCheckInit()');
    }
  }
'''
updated,stack_count=stack_pattern.subn(stack_replacement,updated,count=1)
if stack_count != 1:
    raise SystemExit('Could not locate Emscripten checkStackCookie zero-stack fallback for Render360 repair')

dlsym_pattern = re.compile(
    r"  var __dlsym_js = \(handle, symbol, symbolIndex\) => \{.*?\n  \};\n  __dlsym_js\.sig = 'pppp';",
    re.S,
)
dlsym_replacement = r'''  var __dlsym_js = (handle, symbol, symbolIndex) => {
      symbol = UTF8ToString(symbol);
      var result;
      var newSymIndex;
      var lib = LDSO.loadedLibsByHandle[handle];
      assert(lib, `Tried to dlsym() from an unopened handle: ${handle}`);
      if (!lib.exports.hasOwnProperty(symbol) || lib.exports[symbol].stub) {
        dlSetError(`Tried to lookup unknown symbol "${symbol}" in dynamic lib: ${lib.name}`)
        return 0;
      }
      newSymIndex = Object.keys(lib.exports).indexOf(symbol);
      result = lib.exports[symbol];

      if (typeof result == 'function') {
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
      return result;
    };
  __dlsym_js.sig = 'pppp';'''
updated,dlsym_count=dlsym_pattern.subn(dlsym_replacement,updated,count=1)
if dlsym_count != 1:
    raise SystemExit('Could not locate Emscripten __dlsym_js block for Render360 CreateInterface bridge')

for required in (
    'Render360 Source dylib failed:',
    'Render360 Source stack metadata remained zero after stackCheckInit()',
    'render360RepairStackGeometry',
    'Render360 Source CreateInterface resolved',
    'render360CreateInterfaceAddress',
    'updateTableMap(0, wasmTable.length)',
):
    if required not in updated:
        raise SystemExit(f'Render360 generated-runtime patch missing required marker: {required}')
path.write_text(updated)
PY

cp build/launcher_main/portal-source-engine.mjs "$OUTPUT_DIR/"
cp build/launcher_main/portal-source-engine.wasm "$OUTPUT_DIR/"
for lib in build/install/*.so; do cp "$lib" "$OUTPUT_DIR/"; done
cp "$OVERLAY_DIR/portal-package-adapter.mjs" "$OUTPUT_DIR/"
cp "$OVERLAY_DIR/portal-source-worker.mjs" "$OUTPUT_DIR/"
cp LICENSE "$OUTPUT_DIR/SOURCE_SDK_LICENSE.txt"

if find "$OUTPUT_DIR" -type f \( -iname '*.vpk' -o -iname '*.bsp' -o -iname '*.vtf' -o -iname '*.vmt' \) -print -quit | grep -q .; then
  echo 'Retail Portal/Source game data was found in the engine-only runtime artifact.' >&2
  exit 1
fi

# This module is the first dylib Source requests during Portal startup. Its
# presence makes the basename-path contract concrete instead of relying on a
# generic "some .so exists" package check.
test -s "$OUTPUT_DIR/libfilesystem_stdio.so"

# The measured iPhone stop occurs when Source requests this module's factory.
# Verify the first SIDE_MODULE actually exports CreateInterface before shipping
# a runtime package; WebAssembly.validate() alone cannot prove symbol presence.
python3 - "$OUTPUT_DIR/libfilesystem_stdio.so" <<'PY'
from pathlib import Path
import sys
path=Path(sys.argv[1])
data=path.read_bytes()

def uleb(i):
    value=0
    shift=0
    while True:
        b=data[i]
        i+=1
        value|=(b & 0x7f)<<shift
        if not (b & 0x80): return value,i
        shift+=7

def name(i):
    size,i=uleb(i)
    return data[i:i+size].decode('utf-8','replace'),i+size

if data[:4] != b'\0asm':
    raise SystemExit('libfilesystem_stdio.so is not WebAssembly')
i=8
found=False
while i < len(data):
    section=data[i]; i+=1
    size,i=uleb(i)
    end=i+size
    if section==7:
        count,i=uleb(i)
        for _ in range(count):
            symbol,i=name(i)
            kind=data[i]; i+=1
            _,i=uleb(i)
            if symbol=='CreateInterface' and kind==0:
                found=True
        break
    i=end
if not found:
    raise SystemExit('libfilesystem_stdio.so does not export function CreateInterface')
print('Render360 Portal CreateInterface export verification PASS')
PY

# Binary contract check: every runtime module must use the same unshared memory
# model as the single-worker main module. WebAssembly.validate() alone does not
# catch a shared-vs-unshared import mismatch because each file is valid in
# isolation. Parse the Wasm import section and reject any shared-memory import.
python3 - "$OUTPUT_DIR" <<'PY'
from pathlib import Path
import sys
out = Path(sys.argv[1])

def uleb(data, i):
    value = 0
    shift = 0
    while True:
        b = data[i]
        i += 1
        value |= (b & 0x7f) << shift
        if not (b & 0x80):
            return value, i
        shift += 7

def name(data, i):
    size, i = uleb(data, i)
    return data[i:i+size].decode('utf-8', 'replace'), i + size

def shared_memory_imports(path):
    data = path.read_bytes()
    if data[:4] != b'\0asm':
        raise SystemExit(f'{path.name}: not a WebAssembly module')
    i = 8
    found = []
    while i < len(data):
        section_id = data[i]
        i += 1
        section_size, i = uleb(data, i)
        section = data[i:i+section_size]
        i += section_size
        if section_id != 2:
            continue
        j = 0
        count, j = uleb(section, j)
        for _ in range(count):
            module, j = name(section, j)
            field, j = name(section, j)
            kind = section[j]
            j += 1
            if kind == 0:
                _, j = uleb(section, j)
            elif kind == 1:
                j += 1
                flags, j = uleb(section, j)
                _, j = uleb(section, j)
                if flags & 1:
                    _, j = uleb(section, j)
            elif kind == 2:
                flags, j = uleb(section, j)
                _, j = uleb(section, j)
                if flags & 1:
                    _, j = uleb(section, j)
                if flags & 2:
                    found.append((module, field))
            elif kind == 3:
                j += 2
            elif kind == 4:
                j += 1
                _, j = uleb(section, j)
        break
    return found

modules = [out / 'portal-source-engine.wasm', *sorted(out.glob('*.so'))]
for module in modules:
    shared = shared_memory_imports(module)
    if shared:
        raise SystemExit(f'{module.name}: imports shared WebAssembly memory {shared}; Render360 Portal single-worker runtime requires unshared memory')
print(f'Render360 Portal memory-model verification PASS: {len(modules)} modules, all unshared')
PY

python3 - "$OUTPUT_DIR" <<'PY'
import hashlib, json, pathlib, sys
out = pathlib.Path(sys.argv[1])
files = sorted(p.name for p in out.iterdir() if p.is_file() and p.name != 'render360-port.json')
sha = {name: hashlib.sha256((out / name).read_bytes()).hexdigest() for name in files}
manifest = {
    'schema': 'render360-pc-wasm-package-v1',
    'gameId': 'portal-1-pc',
    'name': 'Portal 1 · Source Community WebAssembly',
    'format': 'render360-adapter',
    'entry': 'portal-package-adapter.mjs',
    'wasm': 'portal-source-engine.wasm',
    'files': files,
    'requirements': {
        'webassembly': True,
        'webgl2': True,
        'webgpu': False,
        'sharedArrayBuffer': False,
        'crossOriginIsolated': False,
        'threads': False,
        'worker': True,
        'offscreenCanvas': True,
    },
    'arguments': ['-game', 'portal', '-noip', '-language', 'english', '-windowed', '+mat_hdr_level', '0'],
    'source': {
        'repository': 'https://github.com/weliveinhell/source-engine',
        'commit': '63f8364fe7b22b239e72dfb5f1024665b3a91567',
        'emscripten': '4.0.9',
        'profile': 'render360-single-worker-workerfs-v7-createinterface-webkit',
    },
    'content': {
        'retailAssetsBundled': False,
        'playerOwnedInstallRequired': True,
        'mount': 'WORKERFS-readonly',
        'wholeInstallCopiedIntoWasm': False,
    },
    'diagnostics': {
        'workerLocalObjectUrls': True,
        'dylibPreflight': True,
        'dylibFailFast': True,
        'dylibBasenameFix': True,
        'createInterfaceExportVerified': True,
        'createInterfaceHandleBridge': True,
        'dlsymTableMapPrimed': True,
        'workerFsKeptReadOnly': True,
        'workerSafeAlertShim': True,
        'stackGeometryRepair': True,
        'stackRepairAfterRuntimeInit': True,
        'stackRepairBeforeCallMain': True,
        'stackZeroEndSelfHeal': True,
        'heapU8Exported': True,
        'sharedMemoryVerifiedFalse': True,
        'upstreamPthreadsRemoved': True,
        'remoteMapAtomicWaitRemoved': True,
        'directWebglPresentation': True,
    },
    'sha256': sha,
}
(out / 'render360-port.json').write_text(json.dumps(manifest, indent=2) + '\n')
PY

printf 'Portal Source WebAssembly package:\n'
ls -lh "$OUTPUT_DIR"
