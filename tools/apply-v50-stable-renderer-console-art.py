from pathlib import Path

MARK='R360_STABLE_RENDERER_V50'
STABLE_WASM='./xenia_ppc_bootstrap.stable.wasm'
STABLE_META='./xenia_ppc_bootstrap.stable.meta.json'

def replace_once(text, old, new, label):
    if new in text:
        return text
    if old not in text:
        raise SystemExit(f'{label}: source marker missing')
    return text.replace(old,new,1)

# 1) Keep the modern UI/runtime, but pin the user-facing PPC engine to the exact
# verified bootstrap from the uploaded v45 snapshot. The fastlane may continue
# publishing xenia_ppc_bootstrap.wasm for development without silently replacing
# the stable player lane.
p=Path('render360-browser-title-runtime.mjs')
s=p.read_text()
s=replace_once(s,"export const PPC_BOOTSTRAP_URL='./xenia_ppc_bootstrap.wasm';",f"// {MARK}: stable player lane verified from Render360 v45.\nexport const PPC_BOOTSTRAP_URL='{STABLE_WASM}';",'stable bootstrap url')
s=replace_once(s,"export const PPC_BOOTSTRAP_META_URL='./xenia_ppc_bootstrap.meta.json';",f"export const PPC_BOOTSTRAP_META_URL='{STABLE_META}';",'stable bootstrap metadata url')
p.write_text(s)

# 2) The developer console must be present before title execution starts, not
# dependent on the delayed secondary UI lane. Load it only when Play is pressed
# so page startup stays fast.
p=Path('app.js')
s=p.read_text()
if 'R360_RUNTIME_CONSOLE_V50' not in s:
    helper="""\n// R360_RUNTIME_CONSOLE_V50: console is cold during app startup, guaranteed during title launch.\nlet runtimeConsolePromise=null;\nasync function ensureRuntimeDeveloperConsole(){\n  runtimeConsolePromise??=Promise.all([import('./developer-console.js'),import('./developer-console-fab.js')]);\n  await runtimeConsolePromise;\n  globalThis.render360DeveloperConsole?.setEnabled?.(true);\n  return globalThis.render360DeveloperConsole||null;\n}\n"""
    anchor="const yieldUi=()=>new Promise(resolve=>setTimeout(resolve,0));\n"
    if anchor not in s: raise SystemExit('app lazy helper anchor missing')
    s=s.replace(anchor,anchor+helper,1)
    old="async function playCurrent(){if(!currentGame)return;const source=runtime.getSource(currentGame.id);if(!source){startRelink();return;}closeSheets();setState('BOOTING_GAME');$('bootOverlay').classList.remove('frame-live');setText('bootTitle',currentGame.name);setText('bootMessage','Preparing Xbox 360 runtime…');setText('bootStage',String(currentGame.sourceType||'game').toUpperCase());const profile=resolveTitleProfile(currentGame,loadTitleProfile(currentGame),appSettings);runtime.configure(profile);try{await markPlayed(currentGame.id);const result=await runtime.play(currentGame,source,profile);if(appState==='BOOTING_GAME')setState('RUNNING');setText('bootMessage','Guest execution is running. Waiting for real title pixels…');return result;}catch(error){setState('GAME_DETAILS');await renderDetail();showAlert('Game Stopped',error.message,[{label:'Done'}]);}}"
    new="""async function playCurrent(){\n  if(!currentGame)return;const source=runtime.getSource(currentGame.id);if(!source){startRelink();return;}\n  closeSheets();setState('BOOTING_GAME');$('bootOverlay').classList.remove('frame-live');setText('bootTitle',currentGame.name);setText('bootMessage','Preparing Xbox 360 runtime…');setText('bootStage',String(currentGame.sourceType||'game').toUpperCase());\n  try{await ensureRuntimeDeveloperConsole();}catch(error){log('warn',`Developer console unavailable: ${error.message}`);}\n  const profile=resolveTitleProfile(currentGame,loadTitleProfile(currentGame),appSettings);runtime.configure(profile);\n  try{await markPlayed(currentGame.id);const result=await runtime.play(currentGame,source,profile);if(appState==='BOOTING_GAME')setState('RUNNING');setText('bootMessage','Guest execution is running. Waiting for real title pixels…');return result;}catch(error){setState('GAME_DETAILS');await renderDetail();showAlert('Game Stopped',error.message,[{label:'Done'}]);}\n}\n"""
    if old not in s: raise SystemExit('playCurrent anchor missing')
    s=s.replace(old,new,1)
p.write_text(s)

# 3) Broaden the profile art toward classic male/action Xbox 360 characters while
# keeping the user's existing custom-photo and Render360 icon options.
p=Path('v47-ui.js')
s=p.read_text()
old="const XBOX360_GAMERPICS=Array.from({length:12},(_,i)=>`https://raw.githubusercontent.com/birabittoh/xtitles/refs/heads/main/titles/413607d9/${(0x20400+i).toString(16)}.png`);"
new="""// R360_XBOX_HERO_ART_V50: action-oriented Xbox 360 gamerpics (GTA IV + Halo 3).\nconst XBOX360_GAMERPICS=[\n  ...Array.from({length:9},(_,i)=>`https://raw.githubusercontent.com/birabittoh/xtitles/refs/heads/main/titles/545407f2/${(0x28000+i).toString(16)}.png`),\n  ...Array.from({length:9},(_,i)=>`https://raw.githubusercontent.com/birabittoh/xtitles/refs/heads/main/titles/4d5307e6/${(0x28000+i).toString(16)}.png`),\n];"""
if old in s:s=s.replace(old,new,1)
elif 'R360_XBOX_HERO_ART_V50' not in s:raise SystemExit('gamerpic source anchor missing')
s=s.replace('<div class="r360-avatar-heading">Xbox 360 Gamerpics</div>','<div class="r360-avatar-heading">Xbox 360 Action Gamerpics</div>',1)
s=s.replace('Xbox 360 gamerpics load from the public xtitles archive; your selection is saved on this device.','Classic GTA IV and Halo 3 Xbox 360 gamerpics load from the public xtitles archive; your selection is saved on this device.',1)
p.write_text(s)

# 4) Update asset identity tests to lock the stable lane rather than the development lane.
for name in ['test-runtime-asset-identity.mjs','test-braid-startup-critic.mjs','test-browser-title-runtime.mjs']:
    p=Path(name);s=p.read_text()
    s=s.replace("PPC_BOOTSTRAP_URL='./xenia_ppc_bootstrap.wasm'",f"PPC_BOOTSTRAP_URL='{STABLE_WASM}'")
    s=s.replace("PPC_BOOTSTRAP_META_URL='./xenia_ppc_bootstrap.meta.json'",f"PPC_BOOTSTRAP_META_URL='{STABLE_META}'")
    s=s.replace("contract.bootstrapUrl,'./xenia_ppc_bootstrap.wasm'",f"contract.bootstrapUrl,'{STABLE_WASM}'")
    s=s.replace("contract.bootstrapMetadataUrl,'./xenia_ppc_bootstrap.meta.json'",f"contract.bootstrapMetadataUrl,'{STABLE_META}'")
    p.write_text(s)

print('Render360 V50 stable renderer + runtime console + action art patch applied')
