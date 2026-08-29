function activeScheduler(){return globalThis.render360ModernTitle?.threadScheduler||null;}

export function pauseActiveTitle(){
  const scheduler=activeScheduler();
  if(!scheduler||typeof scheduler.pause!=='function')return false;
  scheduler.pause();return true;
}

export function resumeActiveTitle(){
  const scheduler=activeScheduler();
  if(!scheduler||typeof scheduler.resume!=='function')return false;
  scheduler.resume();return true;
}

export function activeTitleControlState(){
  const scheduler=activeScheduler();
  if(!scheduler)return {available:false,running:false,paused:false};
  return {available:true,running:Boolean(scheduler.running),paused:Boolean(scheduler.paused),inspect:scheduler.inspect?.()??null};
}
