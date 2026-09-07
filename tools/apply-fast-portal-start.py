from pathlib import Path

# Avoid parsing the very large embedded Xbox core during every Render360 page load.
p = Path('wasm-core.js')
s = p.read_text()
s = s.replace("import {CORE_WASM_GZIP_BASE64} from './render360_xenia_core_embedded.js';\n", '')
old = """    if(!result&&CORE_WASM_GZIP_BASE64){
      try{result=await WebAssembly.instantiate(await gunzip(decodeBase64(CORE_WASM_GZIP_BASE64)),{});validateInstance(result.instance,'Embedded');this.source='embedded';}
      catch(error){embeddedError=error;result=null;}
    }
"""
new = """    if(!result){
      try{
        const {CORE_WASM_GZIP_BASE64}=await import('./render360_xenia_core_embedded.js');
        if(CORE_WASM_GZIP_BASE64){result=await WebAssembly.instantiate(await gunzip(decodeBase64(CORE_WASM_GZIP_BASE64)),{});validateInstance(result.instance,'Embedded');this.source='embedded';}
      }catch(error){embeddedError=error;result=null;}
    }
"""
if old in s:
    s = s.replace(old, new)
elif "await import('./render360_xenia_core_embedded.js')" not in s:
    raise SystemExit('wasm-core fallback block not found')
s = s.replace('timeoutMs=4500', 'timeoutMs=2500').replace('timeoutMs:4500', 'timeoutMs:2500')
p.write_text(s)

# Never hold the Library UI for the optional input/statistics worker.
p = Path('runtime/render360-runtime.js')
s = p.read_text()
old = 'await Promise.allSettled([inputPromise]);this.ready=true;'
if old in s:
    s = s.replace(old, 'this.ready=true;void inputPromise;')
elif 'this.ready=true;void inputPromise;' not in s:
    raise SystemExit('runtime input wait block not found')
p.write_text(s)

# Portal is a native PC->WASM route. It does not require the Xbox 360 core.
p = Path('runtime/pc-recompiled-runtime.js')
s = p.read_text()
s = s.replace("    if(!this.ready||!this.core)throw new Error('Render360 core is still loading');\n", '')
s = s.replace('    this.inputHost.setSession({kind:30,stage:5,titleId:0});', '    this.inputHost?.setSession?.({kind:30,stage:5,titleId:0});')
p.write_text(s)

print('FAST_PORTAL_START_PATCH=PASS')
