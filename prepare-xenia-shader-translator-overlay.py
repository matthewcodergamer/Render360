#!/usr/bin/env python3
from pathlib import Path

root = Path(__file__).resolve().parent
src = root / 'upstream/xenia/src/xenia/gpu/shader_translator.cc'
out = root / 'build/xenia-web-overlay/xenia/gpu/shader_translator.cc'
text = src.read_text()
old = '''  // An empty shader can be created internally by shader translators as a dummy,\n  // don't dump it.\n  if (!cvars::dump_shaders.empty() && !ucode_data().empty()) {\n    DumpUcode(cvars::dump_shaders);\n  }\n'''
new = '''  // Render360 browser/WASM: shader dumping is a desktop debugging side effect\n  // that pulls filesystem syscalls into the standalone bootstrap. Keep the\n  // real AnalyzeUcode parser/binding/disassembly work above, but do not dump\n  // shader files from the browser runtime.\n'''
# prepare-xenia-shader-interpreter-overlay.py already removes this same optional
# desktop dump from the pinned upstream checkout because its interpreter probe
# uses AnalyzeUcode too. Accept either ordering so this overlay is idempotent
# instead of treating the already browser-safe source as upstream drift.
if old in text:
    text = text.replace(old, new, 1)
elif ('Render360 browser/WASM: preserve AnalyzeUcode semantics' in text or
      'Render360 browser/WASM: shader dumping is a desktop debugging side effect' in text):
    pass
else:
    raise SystemExit('ERROR: upstream Shader::AnalyzeUcode dump block drifted')
out.parent.mkdir(parents=True, exist_ok=True)
out.write_text(text)
print(f'Generated browser shader translator overlay: {out}')
print('Shader rule: AnalyzeUcode semantics preserved; optional desktop shader file dumping removed')
