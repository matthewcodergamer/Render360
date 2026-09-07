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

# Emscripten's generated MAIN_MODULE loader leaves the loadDylibs run
# dependency installed when a side module rejects. That creates an infinite
# blank screen. Patch only that generated block so the exact dylib is reported
# and the modularized factory rejects instead of hanging forever.
#
# Also repair the exact Emscripten #22195-style failure at the point where it
# is detected. For this linked MAIN_MODULE the real stack end is a non-zero
# link-time constant. If emscripten_stack_get_end() ever becomes zero after
# dynamic loading, do not move the cookie to address 0x00000004. Re-run
# Emscripten's own stackCheckInit(), then continue only if the real stack end is
# restored. This preserves stack checking instead of disabling it.
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
if 'Render360 Source dylib failed:' not in updated:
    raise SystemExit('Render360 dylib diagnostic patch was not applied')
if 'Render360 Source stack metadata remained zero after stackCheckInit()' not in updated:
    raise SystemExit('Render360 zero-stack-end self-heal patch was not applied')
if 'render360RepairStackGeometry' not in updated:
    raise SystemExit('Render360 Emscripten stack-geometry repair was not embedded by --pre-js')
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
        'profile': 'render360-single-worker-workerfs-v6-dylib-basename-direct-webgl',
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
