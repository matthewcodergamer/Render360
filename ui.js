import './ui-core.js';

const $=id=>document.getElementById(id);

function installResponsiveShell(){
  if(document.getElementById('r360-responsive-fix'))return;
  const style=document.createElement('style');
  style.id='r360-responsive-fix';
  style.textContent=`
    html,body,#app{width:100%;max-width:100%;height:100%;min-height:0!important;overflow:hidden}
    #app{height:var(--app-height,100dvh)!important;min-height:0!important}
    .view{width:100%;max-width:100%;min-height:0;overflow-x:hidden}
    .navbar,.detail-nav{max-width:100vw}
    .nav-row{min-width:0}.nav-actions{flex:0 0 auto}
    .r360-brand{min-width:0;overflow:hidden}.r360-brand>.nav-title{overflow:hidden;text-overflow:ellipsis}
    .settings-body,.detail-body{max-width:100%}
    .row{min-width:0}.setting-copy{min-width:0}.setting-tail{max-width:52%;min-width:0}
    .settings-select{max-width:100%}
    button,.ios-icon-button,.text-button,.row-button,.primary{touch-action:manipulation;cursor:pointer}
    #settingsButton,#importButton{position:relative;z-index:50;pointer-events:auto!important}
    @media(max-width:430px){
      .view{padding-left:max(12px,var(--safe-left));padding-right:max(12px,var(--safe-right))}
      .navbar,.detail-nav{margin-left:calc(-1 * max(12px,var(--safe-left)));margin-right:calc(-1 * max(12px,var(--safe-right)));padding-left:max(12px,var(--safe-left));padding-right:max(12px,var(--safe-right))}
      .r360-library-title-row>.nav-title.large{font-size:30px}
      .row{gap:10px;padding-left:13px;padding-right:13px}
      .setting-tail{max-width:48%}
    }
    @media(orientation:landscape) and (max-height:500px){
      #app{height:100dvh!important}
      .view:not(.runtime-view){padding-top:max(4px,var(--safe-top));padding-bottom:max(18px,var(--safe-bottom))}
    }
  `;
  document.head.appendChild(style);
}

function keepLibraryControlsInteractive(){
  const unlock=()=>{for(const id of ['importButton','emptyImportButton','settingsButton']){const el=$(id);if(el){el.disabled=false;el.removeAttribute('aria-disabled');el.style.pointerEvents='auto';}}};
  unlock();
  const observer=new MutationObserver(unlock);
  for(const id of ['importButton','emptyImportButton','settingsButton']){const el=$(id);if(el)observer.observe(el,{attributes:true,attributeFilter:['disabled','aria-disabled','style']});}
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

function updateViewport(){
  const vv=window.visualViewport;
  const h=Math.max(1,Math.round(vv?.height||window.innerHeight||document.documentElement.clientHeight||1));
  const w=Math.max(1,Math.round(vv?.width||window.innerWidth||document.documentElement.clientWidth||1));
  document.documentElement.style.setProperty('--app-height',`${h}px`);
  document.documentElement.style.setProperty('--app-width',`${w}px`);
}

function bootShellFix(){
  installResponsiveShell();
  updateViewport();
  keepLibraryControlsInteractive();
  installStartupWatchdog();
  visualViewport?.addEventListener('resize',updateViewport,{passive:true});
  visualViewport?.addEventListener('scroll',updateViewport,{passive:true});
  addEventListener('resize',updateViewport,{passive:true});
  addEventListener('orientationchange',()=>setTimeout(updateViewport,80),{passive:true});
  console.log('[Render360] responsive startup shell active');
}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',bootShellFix,{once:true});else bootShellFix();
