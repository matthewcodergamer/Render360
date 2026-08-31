import './ui-core.js';

const $=id=>document.getElementById(id);

function installResponsiveShell(){
  if(document.getElementById('r360-responsive-fix'))return;
  const style=document.createElement('style');
  style.id='r360-responsive-fix';
  style.textContent=`
    html,body,#app{width:100%;max-width:100%;height:100%;min-height:0!important;overflow:hidden}
    #app{width:var(--app-width,100vw)!important;height:var(--app-height,100dvh)!important;min-height:0!important;inset:0 auto auto 0!important}
    .view{width:100%;max-width:100%;min-height:0;overflow-x:hidden}
    .navbar,.detail-nav{max-width:100%}
    .nav-row{min-width:0}.nav-actions{flex:0 0 auto;isolation:isolate}
    .r360-brand{min-width:0;overflow:hidden}.r360-brand>.nav-title{overflow:hidden;text-overflow:ellipsis}
    .settings-body,.detail-body{max-width:100%}
    .row{min-width:0}.setting-copy{min-width:0}.setting-tail{max-width:52%;min-width:0}
    .settings-select{max-width:100%}
    button,.ios-icon-button,.text-button,.row-button,.primary{touch-action:manipulation;cursor:pointer}
    #settingsButton,#profileButton,#importButton{position:relative;z-index:50;pointer-events:auto!important;flex:0 0 36px}
    #settingsButton,#profileButton{margin:0!important}
    @media(max-width:430px){
      .view{padding-left:max(12px,var(--safe-left));padding-right:max(12px,var(--safe-right))}
      .navbar,.detail-nav{margin-left:calc(-1 * max(12px,var(--safe-left)));margin-right:calc(-1 * max(12px,var(--safe-right)));padding-left:max(12px,var(--safe-left));padding-right:max(12px,var(--safe-right))}
      .r360-library-title-row>.nav-title.large{font-size:30px}
      .row{gap:10px;padding-left:13px;padding-right:13px}
      .setting-tail{max-width:48%}
    }
    @media(orientation:landscape) and (max-height:500px){
      #app{height:var(--app-height,100dvh)!important;width:var(--app-width,100vw)!important}
      .view:not(.runtime-view){padding-top:max(4px,var(--safe-top));padding-bottom:max(18px,var(--safe-bottom))}
      .runtime-stage,.controller-layer,.boot-overlay{width:100%!important;height:100%!important;inset:0!important}
    }
  `;
  document.head.appendChild(style);
}

function keepLibraryControlsInteractive(){
  const unlock=()=>{for(const id of ['importButton','emptyImportButton','settingsButton','profileButton']){const el=$(id);if(el){el.disabled=false;el.removeAttribute('aria-disabled');el.style.pointerEvents='auto';}}};
  unlock();
  const observer=new MutationObserver(unlock);
  for(const id of ['importButton','emptyImportButton','settingsButton','profileButton']){const el=$(id);if(el)observer.observe(el,{attributes:true,attributeFilter:['disabled','aria-disabled','style']});}
}

function bindExistingProfile(){
  const button=$('profileButton');
  if(!button||button.dataset.r360Bound==='1')return;
  button.dataset.r360Bound='1';
  button.addEventListener('click',()=>{
    $('profileSheet')?.classList.remove('hidden');
    $('scrim')?.classList.remove('hidden');
  });
}

function installStartupWatchdog(){
  const status=$('runtimeSyncStatus'),text=$('runtimeSyncText');
  if(!status||!text)return;
  const started=performance.now();
  const timer=setInterval(()=>{
    if(status.classList.contains('ready')||status.classList.contains('error')){clearInterval(timer);return;}
    const seconds=Math.floor((performance.now()-started)/1000);
    if(seconds>=8){status.classList.add('slow');text.textContent='Runtime loading in background · Library, Settings and Add Game are ready';}
    else if(seconds>=3)text.textContent='Loading emulator core…';
  },500);
  setTimeout(()=>clearInterval(timer),60000);
}

let viewportFrame=0;
function updateViewport(){
  if(viewportFrame)cancelAnimationFrame(viewportFrame);
  viewportFrame=requestAnimationFrame(()=>{
    viewportFrame=0;
    const vv=window.visualViewport;
    const h=Math.max(1,Math.round(vv?.height||window.innerHeight||document.documentElement.clientHeight||1));
    const w=Math.max(1,Math.round(vv?.width||window.innerWidth||document.documentElement.clientWidth||1));
    document.documentElement.style.setProperty('--app-height',`${h}px`);
    document.documentElement.style.setProperty('--app-width',`${w}px`);
  });
}

function bootShellFix(){
  installResponsiveShell();
  updateViewport();
  keepLibraryControlsInteractive();
  bindExistingProfile();
  installStartupWatchdog();
  visualViewport?.addEventListener('resize',updateViewport,{passive:true});
  visualViewport?.addEventListener('scroll',updateViewport,{passive:true});
  addEventListener('resize',updateViewport,{passive:true});
  addEventListener('orientationchange',()=>{updateViewport();setTimeout(updateViewport,80);setTimeout(updateViewport,240);},{passive:true});
  console.log('[Render360] responsive startup shell active');
}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',bootShellFix,{once:true});else bootShellFix();