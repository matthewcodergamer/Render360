from pathlib import Path

MARK='R360_CORE_PRELOAD_V49'

# Match the early WASM preload's anonymous fetch mode so Safari can reuse the
# preloaded response instead of issuing a second request.
p=Path('wasm-core.js')
s=p.read_text()
old="fetch(this.url,{cache:'force-cache'})"
new="fetch(this.url,{cache:'force-cache',credentials:'omit'})"
if old in s:
    s=s.replace(old,new,1)
elif new not in s:
    raise SystemExit('wasm core fetch marker missing')
p.write_text(s)

p=Path('index.html')
s=p.read_text()
if MARK not in s:
    preload=f'''<!-- {MARK}: begin the emulator core fetch while the shell is still parsing. -->
<link rel="modulepreload" href="./runtime/render360-runtime.js">
<link rel="preload" href="./render360_xenia_core.wasm" as="fetch" type="application/wasm" crossorigin="anonymous" fetchpriority="high">
'''
    if '</head>' not in s:
        raise SystemExit('index head marker missing')
    s=s.replace('</head>',preload+'</head>',1)

old_ui='<script type="module" src="ui-behavior.js"></script>\n'
new_ui='''<script type="module">
// R360_SECONDARY_UI_LANE_V49: give the emulator core the first network/CPU lane.
const loadSecondaryUi=()=>import('./ui-behavior.js').catch(error=>console.error('[Render360] secondary UI load failed',error));
if(typeof requestIdleCallback==='function')requestIdleCallback(loadSecondaryUi,{timeout:800});else setTimeout(loadSecondaryUi,250);
</script>
'''
if old_ui in s:
    s=s.replace(old_ui,new_ui,1)
elif 'R360_SECONDARY_UI_LANE_V49' not in s:
    raise SystemExit('index ui behavior script marker missing')
# Keep the old standalone FAB out of the initial graph even on mixed revisions.
s=s.replace('<script type="module" src="developer-console-fab.js"></script>\n','')
p.write_text(s)

print('Render360 V49 core preload lane applied')
