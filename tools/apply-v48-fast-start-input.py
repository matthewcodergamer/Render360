from pathlib import Path
import re


def replace_once(path, old, new):
    p=Path(path); text=p.read_text()
    if new in text: return
    if old not in text: raise SystemExit(f'missing needle in {path}: {old[:100]}')
    p.write_text(text.replace(old,new,1))

# Keep the verified package/XEX core in Safari's HTTP cache instead of forcing
# a redownload on every launch.
replace_once('wasm-core.js',"fetch(this.url,{cache:'no-store'})","fetch(this.url,{cache:'force-cache'})")

# The telemetry/input worker starts in parallel, but it is not allowed to hold
# the visible emulator-ready gate after the main core has already initialized.
replace_once('runtime/render360-runtime.js','await Promise.allSettled([inputPromise]);this.ready=true;','void inputPromise;this.ready=true;')

# More resilient touch behavior without changing the existing control layout.
p=Path('app.js'); text=p.read_text()
if 'R360_TOUCH_CONTROLS_V48' not in text:
    pattern=re.compile(r"function wireDigitalControls\(\)\{.*?\nconst GAMEPAD_BUTTONS=",re.S)
    replacement="""// R360_TOUCH_CONTROLS_V48
function wireDigitalControls(){document.querySelectorAll('[data-key]').forEach(button=>{if(button.dataset.r360ControlBound==='1')return;button.dataset.r360ControlBound='1';const key=button.dataset.key;let pointer=null;const down=e=>{if(pointer!==null)return;e.preventDefault();pointer=e.pointerId;try{button.setPointerCapture?.(pointer)}catch{}button.classList.add('pressed');runtime.setKey(key,true);};const up=e=>{if(pointer!==null&&e?.pointerId!==undefined&&e.pointerId!==pointer)return;e?.preventDefault?.();pointer=null;button.classList.remove('pressed');runtime.setKey(key,false);};button.addEventListener('pointerdown',down,{passive:false});button.addEventListener('pointerup',up,{passive:false});button.addEventListener('pointercancel',up,{passive:false});button.addEventListener('lostpointercapture',up);button.addEventListener('contextmenu',e=>e.preventDefault());});}
function wireStick(zone,knob){if(!zone||!knob||zone.dataset.r360StickBound==='1')return;zone.dataset.r360StickBound='1';let pointer=null;const neutral=()=>{pointer=null;knob.style.transform='';touchAnalog.lx=touchAnalog.ly=0;runtime.setAnalog(0,0,touchAnalog.rx,touchAnalog.ry);};const move=e=>{if(pointer!==e.pointerId)return;e.preventDefault();const r=zone.getBoundingClientRect(),cx=r.left+r.width/2,cy=r.top+r.height/2,max=Math.max(1,Math.min(r.width,r.height)*.34),dx=e.clientX-cx,dy=e.clientY-cy,d=Math.hypot(dx,dy)||1,s=Math.min(1,max/d),x=dx*s,y=dy*s;knob.style.transform=`translate(${x}px,${y}px)`;touchAnalog.lx=Math.max(-1,Math.min(1,x/max));touchAnalog.ly=Math.max(-1,Math.min(1,y/max));runtime.setAnalog(touchAnalog.lx,touchAnalog.ly,touchAnalog.rx,touchAnalog.ry);};const end=e=>{if(pointer===null||(e?.pointerId!==undefined&&pointer!==e.pointerId))return;e?.preventDefault?.();neutral();};zone.addEventListener('pointerdown',e=>{if(pointer!==null)return;e.preventDefault();pointer=e.pointerId;try{zone.setPointerCapture?.(pointer)}catch{}move(e);},{passive:false});zone.addEventListener('pointermove',move,{passive:false});zone.addEventListener('pointerup',end,{passive:false});zone.addEventListener('pointercancel',end,{passive:false});zone.addEventListener('lostpointercapture',end);zone.addEventListener('contextmenu',e=>e.preventDefault());window.addEventListener('blur',neutral);window.addEventListener('orientationchange',()=>setTimeout(neutral,0));}
const GAMEPAD_BUTTONS="""
    text,n=pattern.subn(replacement,text,count=1)
    if n!=1: raise SystemExit('touch-control block not found')

if 'R360_FAST_BOOT_V48' not in text:
    pattern=re.compile(r"async function boot\(\)\{.*?\n\}\nboot\(\);",re.S)
    replacement="""// R360_FAST_BOOT_V48
async function boot(){
  setState('LIBRARY');$('importButton').disabled=true;$('emptyImportButton').disabled=true;
  runtime.addEventListener('log',e=>log(e.detail.level,e.detail.message));runtime.addEventListener('telemetry',e=>updateHud(e.detail));runtime.addEventListener('framePresented',()=>{$('bootOverlay').classList.add('frame-live');if(appState==='BOOTING_GAME')setState('RUNNING',{keepScroll:true});});runtime.addEventListener('bootStage',e=>{setText('bootMessage',e.detail.message||'Working…');setText('bootStage',String(e.detail.stage||'runtime').toUpperCase());});runtime.addEventListener('runtimeBlocker',e=>log('warn',e.detail.message||'Runtime blocker'));runtime.addEventListener('fatalError',e=>log('error',e.detail.message));
  const libraryPromise=refreshLibrary().catch(error=>log('warn',`Library load: ${error.message}`));
  const runtimePromise=runtime.init();
  let runtimeReady=false;
  try{await runtimePromise;runtimeReady=true;const c=runtime.contract();$('runtimeSyncStatus').classList.add('ready');setText('runtimeSyncText',`Emulator ready · Core build ${c.loadedCoreBuild} · ${c.coreSource} · ${c.stfsExtraction}`);setText('aboutCore',`Build ${c.loadedCoreBuild} · ${c.coreSource} · ${c.stfsExtraction}`);setText('aboutAbi',fmtHex(c.loadedAbi));$('importButton').disabled=false;$('emptyImportButton').disabled=false;log('ok',`Render360 ready · Core build ${c.loadedCoreBuild} · ABI ${fmtHex(c.loadedAbi)} · ${c.stfsExtraction} · ISO/XEX/STFS launch adapters active`);}catch(error){$('runtimeSyncStatus').classList.add('error');setText('runtimeSyncText',`Runtime contract failed · ${error.message}`);setText('aboutCore','Unavailable');setText('aboutAbi','Unavailable');log('error',error.message);}
  await libraryPromise;
  if(runtimeReady)void restorePersistentSources().catch(error=>log('warn',`Saved game restore: ${error.message}`));
  void cleanupGameStorage(games.map(game=>game.opfsPath).filter(Boolean)).catch(error=>log('warn',`Storage cleanup skipped: ${error.message}`));
  void updateStorageUi().catch(error=>log('warn',`Storage status: ${error.message}`));
}
boot();"""
    text,n=pattern.subn(replacement,text,count=1)
    if n!=1: raise SystemExit('boot function not found')

p.write_text(text)
print('V48 fast startup + touch input patch applied')
