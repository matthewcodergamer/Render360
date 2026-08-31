// Render360 developer tools are opt-in. Production mode keeps only the tiny UI guard.
const SETTINGS_KEY='render360.settings.v44';
const $=id=>document.getElementById(id);
const entries=[];
const MAX_LOGS=160;
let enabled=false;
let listenersInstalled=false;
let opened=false;
let lastBlocker=null;

function readDeveloperMode(){
  try{return !!JSON.parse(localStorage.getItem(SETTINGS_KEY)||'{}')?.developerMode;}catch{return false;}
}
function unlockNavigation(){
  for(const id of ['settingsButton','importButton','emptyImportButton']){
    const el=$(id);if(!el)continue;el.disabled=false;el.removeAttribute('disabled');el.removeAttribute('aria-disabled');el.style.pointerEvents='auto';
  }
}
function compactRuntimeStatus(){
  const el=$('runtimeSyncText');if(!el)return;
  const text=String(el.textContent||'');
  const match=text.match(/Runtime V(\d+).*?Core V(\d+).*?\(([^)]+)\)/i);
  if(match)el.textContent=`Runtime V${match[1]} · Core V${match[2]} · ${match[3]}`;
}
function addEntry(level,message,data=null){
  if(!enabled)return;entries.push({at:Date.now(),level:String(level||'info'),message:String(message||''),data});if(entries.length>MAX_LOGS)entries.splice(0,entries.length-MAX_LOGS);render();
}
function eventHandler(event){
  if(!enabled)return;const type=event.type.replace('render360:',''),detail=event.detail||{};
  if(type==='runtimeBlocker'||type==='fatalError'||detail?.stage==='blocked')lastBlocker=detail;
  const message=detail.message||detail.reason||detail.stage||type;
  addEntry(type==='runtimeBlocker'||type==='fatalError'?'error':detail.level||'info',`${type}: ${message}`,detail);
}
function installListeners(){
  if(listenersInstalled)return;listenersInstalled=true;
  for(const type of ['bootStage','runtimeBlocker','fatalError','titleStarted','ready','log','framePresented'])globalThis.addEventListener(`render360:${type}`,eventHandler);
  globalThis.addEventListener('error',e=>{if(enabled)addEntry('error',`${e.message||'Browser error'}${e.filename?` · ${e.filename.split('/').pop()}:${e.lineno||0}`:''}`);});
  globalThis.addEventListener('unhandledrejection',e=>{if(enabled)addEntry('error',`Unhandled promise rejection · ${e.reason?.message||String(e.reason)}`);});
}
function consoleCss(){return `
#r360DevConsole{position:fixed;inset:0;z-index:100000;background:rgba(0,0,0,.7);display:flex;align-items:flex-end}.r360-dev-panel{width:100%;height:min(88dvh,820px);background:#0b0c0e;color:#f5f5f7;border-radius:24px 24px 0 0;display:flex;flex-direction:column;overflow:hidden;border:1px solid rgba(255,255,255,.12)}.r360-dev-head{display:flex;align-items:center;gap:8px;padding:14px 14px 12px;border-bottom:1px solid rgba(255,255,255,.1)}.r360-dev-head b{font-size:17px;flex:1}.r360-dev-head button{height:38px;border:0;border-radius:11px;background:#242529;color:#fff;padding:0 12px;font-weight:700}.r360-dev-body{overflow:auto;-webkit-overflow-scrolling:touch;padding:12px 12px calc(18px + env(safe-area-inset-bottom))}.r360-dev-blocker{padding:11px 12px;margin-bottom:10px;border:1px solid rgba(255,69,58,.35);border-radius:14px;background:rgba(255,69,58,.1);font:11px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;word-break:break-word}.r360-dev-log{font:10px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;border:1px solid rgba(255,255,255,.09);border-radius:13px;overflow:hidden}.r360-dev-line{display:grid;grid-template-columns:64px 46px minmax(0,1fr);gap:6px;padding:7px 8px;border-bottom:1px solid rgba(255,255,255,.06)}.r360-dev-line:last-child{border-bottom:0}.r360-dev-line time{color:#6e6e73}.r360-dev-line strong{font-size:9px;color:#64d2ff}.r360-dev-line.error strong{color:#ff453a}.r360-dev-line.warn strong{color:#ffd60a}.r360-dev-line span{white-space:pre-wrap;word-break:break-word}.r360-console-fab{position:absolute;z-index:80;left:50%;top:max(6px,env(safe-area-inset-top));transform:translateX(-50%);width:48px;height:42px;border-radius:14px;border:1px solid rgba(255,255,255,.2);background:rgba(20,20,22,.7);color:#fff;font:700 12px ui-monospace,SFMono-Regular,Menlo,monospace}.r360-dev-settings-row .console-mark{color:#0a84ff;font:700 12px ui-monospace,SFMono-Regular,Menlo,monospace}#r360DevConsole.hidden{display:none!important}`;}
function ensureUi(){
  if(!$('r360DevConsoleStyle')){const s=document.createElement('style');s.id='r360DevConsoleStyle';s.textContent=consoleCss();document.head.appendChild(s);}
  if(!$('r360DevConsole')){const root=document.createElement('section');root.id='r360DevConsole';root.className='hidden';root.innerHTML='<div class="r360-dev-panel"><div class="r360-dev-head"><b>Developer Console</b><button id="r360DevCopy" type="button">Copy</button><button id="r360DevClose" type="button">Done</button></div><div class="r360-dev-body"><div id="r360DevBlocker" class="r360-dev-blocker"></div><div id="r360DevLog" class="r360-dev-log"></div></div></div>';document.body.appendChild(root);root.addEventListener('click',e=>{if(e.target===root)closeConsole();});$('r360DevClose').onclick=closeConsole;$('r360DevCopy').onclick=copyReport;}
  installEntryPoints();render();
}
function installEntryPoints(){
  const stage=document.querySelector('.runtime-stage');if(stage&&!$('r360RuntimeConsole')){const b=document.createElement('button');b.id='r360RuntimeConsole';b.type='button';b.className='r360-console-fab';b.textContent='>_';b.onclick=openConsole;stage.appendChild(b);}
  const anchor=$('appDiagnosticsButton');if(anchor&&!$('appDeveloperConsoleButton')){const b=document.createElement('button');b.id='appDeveloperConsoleButton';b.type='button';b.className='row row-button r360-dev-settings-row';b.innerHTML='<span>Developer Console</span><span class="console-mark">&gt;_</span>';b.onclick=openConsole;anchor.after(b);}
}
function removeEntryPoints(){$('r360RuntimeConsole')?.remove();$('appDeveloperConsoleButton')?.remove();$('r360DevConsole')?.classList.add('hidden');opened=false;}
function render(){
  if(!enabled)return;const blocker=$('r360DevBlocker'),log=$('r360DevLog');if(blocker){if(lastBlocker){blocker.hidden=false;blocker.textContent=`CURRENT BLOCKER\n${lastBlocker.message||lastBlocker.reason||JSON.stringify(lastBlocker)}`;}else{blocker.hidden=true;}}
  if(!log)return;log.innerHTML='';for(const e of entries){const row=document.createElement('div');row.className=`r360-dev-line ${e.level}`;row.innerHTML='<time></time><strong></strong><span></span>';row.children[0].textContent=new Date(e.at).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',second:'2-digit'});row.children[1].textContent=e.level.toUpperCase();row.children[2].textContent=e.message;log.appendChild(row);}if(!entries.length)log.innerHTML='<div class="r360-dev-line"><span></span><strong>INFO</strong><span>No runtime events captured yet.</span></div>';
}
function report(){return {generatedAt:new Date().toISOString(),page:location.href,state:document.body.dataset.state||null,blocker:lastBlocker,runtime:globalThis.render360ModernTitle||null,logs:entries};}
async function copyReport(){const text=JSON.stringify(report(),(k,v)=>typeof v==='bigint'?String(v):v,2);try{await navigator.clipboard.writeText(text);}catch{}}
function openConsole(){if(!enabled)return;ensureUi();opened=true;$('r360DevConsole').classList.remove('hidden');render();}
function closeConsole(){opened=false;$('r360DevConsole')?.classList.add('hidden');}
function setEnabled(next){
  next=!!next;if(next===enabled)return;enabled=next;globalThis.render360DeveloperMode=enabled;
  $('appDiagnosticsButton')?.classList.toggle('hidden',!enabled);$('diagnosticsButton')?.classList.toggle('hidden',!enabled);
  if(enabled){installListeners();ensureUi();addEntry('info','Developer Mode enabled');}else removeEntryPoints();
}
function tick(){unlockNavigation();compactRuntimeStatus();setEnabled(readDeveloperMode());if(enabled)installEntryPoints();}
function start(){unlockNavigation();compactRuntimeStatus();setEnabled(readDeveloperMode());setInterval(tick,500);globalThis.render360DeveloperConsole={open:openConsole,close:closeConsole,report,setEnabled,get enabled(){return enabled;}};}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start,{once:true});else start();
