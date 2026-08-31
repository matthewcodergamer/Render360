// Production startup guard only. The old developer console/event capture was removed.
const unlock=()=>{
  for(const id of ['settingsButton','importButton','emptyImportButton']){
    const el=document.getElementById(id);
    if(!el)continue;
    el.disabled=false;
    el.removeAttribute('disabled');
    el.removeAttribute('aria-disabled');
    el.style.pointerEvents='auto';
  }
};
const start=()=>{
  unlock();
  const observer=new MutationObserver(unlock);
  for(const id of ['settingsButton','importButton','emptyImportButton']){
    const el=document.getElementById(id);
    if(el)observer.observe(el,{attributes:true,attributeFilter:['disabled','aria-disabled','style']});
  }
};
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start,{once:true});else start();
