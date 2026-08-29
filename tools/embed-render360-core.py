#!/usr/bin/env python3
import base64
import gzip
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WASM = ROOT / 'render360_xenia_core.wasm'
EMBEDDED = ROOT / 'render360_xenia_core_embedded.js'
META = ROOT / 'render360_xenia_core.meta.json'
VERSION = (ROOT / 'VERSION').read_text().strip()

raw = WASM.read_bytes()
packed = gzip.compress(raw, compresslevel=9, mtime=0)
b64 = base64.b64encode(packed).decode('ascii')
sha = hashlib.sha256(raw).hexdigest()

EMBEDDED.write_text(
    f"// Render360 V{VERSION} synchronized embedded package WASM (gzip + base64).\n"
    f"// Generated from render360_xenia_core.wasm; do not hand-edit.\n"
    f"export const CORE_WASM_GZIP_BASE64='{b64}';\n",
    encoding='utf-8',
)
META.write_text(json.dumps({
    'release': int(VERSION),
    'wasm': 'render360_xenia_core.wasm',
    'sha256': sha,
    'bytes': len(raw),
    'embedded_gzip_bytes': len(packed),
    'source': 'build-core.sh',
}, indent=2) + '\n', encoding='utf-8')
print(f'embedded package core release={VERSION} bytes={len(raw)} sha256={sha}')
