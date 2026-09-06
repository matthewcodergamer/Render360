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

# Keep the community port's Source/Portal compile configuration, but link a
# Render360-specific host instead of the demo HTML/chunk downloader. The engine
# is an engine-only artifact: no Portal VPK/BSP/game data is present here.
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

# iPhone-first host profile. The upstream demo reserves ~2 GiB and uses eight
# pthread workers. For the first Render360 bring-up we instead run the whole
# Emscripten module in a dedicated browser Worker, use WORKERFS for zero-copy
# read-only File/Blob access, and let Wasm memory grow from 384 MiB to 1.5 GiB.
# This avoids requiring SharedArrayBuffer/COOP/COEP just to reach Portal's first
# frame. A threaded profile can be added later once the single-worker path is
# proven and profiled.
emcc \
  -sUSE_BZIP2=1 -sUSE_SDL=2 -sUSE_FREETYPE=1 -sUSE_LIBJPEG=1 -sUSE_LIBPNG=1 -sMALLOC=mimalloc \
  -sMAIN_MODULE=1 \
  -sINITIAL_MEMORY=384mb -sMAXIMUM_MEMORY=1536mb -sALLOW_MEMORY_GROWTH=1 \
  -sFULL_ES3 -sSTACK_SIZE=4mb -sENVIRONMENT=worker \
  -sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=createPortalSourceModule \
  -sFORCE_FILESYSTEM=1 -sEXPORTED_RUNTIME_METHODS=FS,WORKERFS,callMain \
  -sOFFSCREENCANVAS_SUPPORT=1 -sEXIT_RUNTIME=0 \
  -lworkerfs.js \
  --pre-js "$OVERLAY_DIR/render360-pre.js" \
  -L build/install/ \
  build/launcher_main/libhl2_launcher.a \
  "${link_libs[@]}" \
  -o build/launcher_main/portal-source-engine.mjs

cp build/launcher_main/portal-source-engine.mjs "$OUTPUT_DIR/"
cp build/launcher_main/portal-source-engine.wasm "$OUTPUT_DIR/"
for lib in build/install/*.so; do cp "$lib" "$OUTPUT_DIR/"; done
cp "$OVERLAY_DIR/portal-package-adapter.mjs" "$OUTPUT_DIR/"
cp "$OVERLAY_DIR/portal-source-worker.mjs" "$OUTPUT_DIR/"
cp LICENSE "$OUTPUT_DIR/SOURCE_SDK_LICENSE.txt"

# Fail hard if a retail asset somehow enters the engine artifact.
if find "$OUTPUT_DIR" -type f \( -iname '*.vpk' -o -iname '*.bsp' -o -iname '*.vtf' -o -iname '*.vmt' \) -print -quit | grep -q .; then
  echo 'Retail Portal/Source game data was found in the engine-only runtime artifact.' >&2
  exit 1
fi

python3 - "$OUTPUT_DIR" <<'PY'
import hashlib, json, pathlib, sys
out = pathlib.Path(sys.argv[1])
files = sorted(p.name for p in out.iterdir() if p.is_file() and p.name != 'render360-port.json')
sha = {}
for name in files:
    sha[name] = hashlib.sha256((out / name).read_bytes()).hexdigest()
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
        'profile': 'render360-single-worker-workerfs-v1',
    },
    'content': {
        'retailAssetsBundled': False,
        'playerOwnedInstallRequired': True,
        'mount': 'WORKERFS-readonly',
        'wholeInstallCopiedIntoWasm': False,
    },
    'sha256': sha,
}
(out / 'render360-port.json').write_text(json.dumps(manifest, indent=2) + '\n')
PY

printf 'Portal Source WebAssembly package:\n'
ls -lh "$OUTPUT_DIR"
