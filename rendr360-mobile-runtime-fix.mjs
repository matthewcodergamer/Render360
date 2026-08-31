// Rendr360 V44.22 — iPhone visual-viewport/orientation recovery.
// Keeps the runtime stage and touch controls bound to the *visual* viewport
// across Safari fullscreen, portrait/landscape rotation, toolbar collapse and
// repeated orientation changes. This is presentation/reflow only.

const $=id=>document.getElementById(id);
const root=document.documentElement;
const RUNTIME_STATES=new Set(['BOOTING_GAME','RUNNING','PAUSED']);
let lastKey='';

function readViewport(){
  const vv=globalThis.visualViewport;
  const width=Math.max(1,Math.round(vv?.width||globalThis.innerWidth||root.clientWidth||1));
  const height=Math.max(1,Math.round(vv?.height||globalThis.innerHeight||root.clientHeight||1));
  const x=Math.max(0,Math.round(vv?.offsetLeft||0));
  const y=Math.max(0,Math.round(vv?.offsetTop||0));
  return {width,height,x,y};
}

function syncViewport(force=false){
  const {width,height,x,y}=readViewport();
  const key=`${width}x${height}@${x},${y}`;
  if(!force&&key===lastKey)return;
  lastKey=key;

  root.style.setProperty('--r360-vw',`${width}px`);
  root.style.setProperty('--r360-vh',`${height}px`);
  root.style.setProperty('--r360-vx',`${x}px`);
  root.style.setProperty('--r360-vy',`${y}px`);
  root.style.setProperty('--app-height',`${height}px`);
  root.dataset.r360Orientation=width>=height?'landscape':'portrait';

  const app=$('app');
  if(app){
    app.style.setProperty('width',`${width}px`,'important');
    app.style.setProperty('height',`${height}px`,'important');
  }

  const runtime=$('runtimeView');
  if(runtime&&!runtime.classList.contains('hidden')){
    runtime.style.setProperty('width',`${width}px`,'important');
    runtime.style.setProperty('height',`${height}px`,'important');
    runtime.style.setProperty('left','0px','important');
    runtime.style.setProperty('top','0px','important');

    const stage=runtime.querySelector('.runtime-stage');
    if(stage){
      stage.style.setProperty('width','100%','important');
      stage.style.setProperty('height','100%','important');
      // Force WebKit to resolve percentage-based controller geometry against
      // the newly measured stage instead of a stale pre-rotation box.
      void stage.offsetWidth;
    }

    const controls=$('controllerLayer');
    if(controls){
      controls.style.setProperty('display','block','important');
      if(!controls.classList.contains('paused'))controls.style.setProperty('opacity','1','important');
    }
  }
}

function syncBurst(){
  for(const delay of [0,40,100,180,320,520,800,1200])setTimeout(()=>syncViewport(true),delay);
}

function installRuntimeStateRecovery(){
  if(!document.body)return;
  new MutationObserver(()=>{
    if(RUNTIME_STATES.has(document.body.dataset.state||''))syncBurst();
  }).observe(document.body,{attributes:true,attributeFilter:['data-state']});
}

function installViewportRecovery(){
  syncBurst();
  globalThis.addEventListener('resize',syncBurst,{passive:true});
  globalThis.addEventListener('orientationchange',syncBurst,{passive:true});
  globalThis.addEventListener('fullscreenchange',syncBurst,{passive:true});
  globalThis.addEventListener('pageshow',syncBurst,{passive:true});
  globalThis.addEventListener('focus',syncBurst,{passive:true});
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)syncBurst();});
  globalThis.visualViewport?.addEventListener('resize',syncBurst,{passive:true});
  globalThis.visualViewport?.addEventListener('scroll',()=>syncViewport(),{passive:true});
  globalThis.screen?.orientation?.addEventListener?.('change',syncBurst);
  try{
    matchMedia('(orientation: landscape)').addEventListener?.('change',syncBurst);
  }catch{}
  installRuntimeStateRecovery();
}

if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',installViewportRecovery,{once:true});
else installViewportRecovery();
