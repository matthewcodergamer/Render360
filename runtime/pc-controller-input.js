const PORTAL_BUTTON_MAP=Object.freeze({
  A:{kind:'key',code:'Space',key:' '},
  B:{kind:'key',code:'ControlLeft',key:'Control'},
  X:{kind:'key',code:'KeyE',key:'e'},
  Y:{kind:'key',code:'KeyQ',key:'q'},
  BACK:{kind:'key',code:'Tab',key:'Tab'},
  START:{kind:'key',code:'Escape',key:'Escape'},
  LT:{kind:'mouse',button:2},
  RT:{kind:'mouse',button:0},
  LB:{kind:'wheel',deltaY:120},
  RB:{kind:'wheel',deltaY:-120},
});

const MOVE_KEYS=Object.freeze({forward:{code:'KeyW',key:'w'},back:{code:'KeyS',key:'s'},left:{code:'KeyA',key:'a'},right:{code:'KeyD',key:'d'}});
const clamp=value=>Math.max(-1,Math.min(1,Number(value)||0));

function keyboardTarget(canvas){return canvas?.ownerDocument?.defaultView||globalThis.window||globalThis;}
function dispatchKey(target,spec,pressed){
  if(!target?.dispatchEvent||typeof KeyboardEvent==='undefined')return false;
  const event=new KeyboardEvent(pressed?'keydown':'keyup',{key:spec.key,code:spec.code,bubbles:true,cancelable:true,repeat:false});
  target.dispatchEvent(event);return true;
}
function dispatchMouseButton(canvas,button,pressed){
  if(!canvas?.dispatchEvent||typeof MouseEvent==='undefined')return false;
  const buttons=pressed?(button===0?1:button===2?2:4):0;
  canvas.dispatchEvent(new MouseEvent(pressed?'mousedown':'mouseup',{button,buttons,bubbles:true,cancelable:true,clientX:canvas.clientWidth/2,clientY:canvas.clientHeight/2}));return true;
}
function dispatchWheel(canvas,deltaY){
  if(!canvas?.dispatchEvent||typeof WheelEvent==='undefined')return false;
  canvas.dispatchEvent(new WheelEvent('wheel',{deltaY,bubbles:true,cancelable:true}));return true;
}
function dispatchRelativeMouse(canvas,dx,dy){
  if(!canvas?.dispatchEvent||typeof MouseEvent==='undefined'||(!dx&&!dy))return false;
  const event=new MouseEvent('mousemove',{bubbles:true,cancelable:true,clientX:canvas.clientWidth/2,clientY:canvas.clientHeight/2});
  try{Object.defineProperty(event,'movementX',{value:dx});Object.defineProperty(event,'movementY',{value:dy});}catch{}
  canvas.dispatchEvent(event);return true;
}

export function portalControllerContract(){
  return {schema:'render360-pc-controller-v1',gameId:'portal-1-pc',layout:'xbox360-overlay',buttons:{...PORTAL_BUTTON_MAP},leftStick:'WASD',rightStick:'relative-mouse-look',touchAndPhysicalGamepad:true};
}

export function createPcControllerInput({canvas,gameId='portal-1-pc',lookSpeed=18,deadzone=.16,emitLog=()=>{}}={}){
  if(String(gameId).toLowerCase()!=='portal-1-pc')throw new Error(`No PC controller profile is registered for ${gameId}.`);
  const target=keyboardTarget(canvas),buttonState=new Map(),moveState=new Map();
  let lx=0,ly=0,rx=0,ry=0,paused=false,stopped=false,raf=0,lastTime=0;

  const setMove=(name,pressed)=>{
    if(moveState.get(name)===pressed)return;
    moveState.set(name,pressed);dispatchKey(target,MOVE_KEYS[name],pressed);
  };
  const updateMove=()=>{
    const d=Math.max(.05,Number(deadzone)||.16);
    setMove('left',lx<-d);setMove('right',lx>d);setMove('forward',ly<-d);setMove('back',ly>d);
  };
  const lookFrame=time=>{
    if(stopped)return;
    const dt=lastTime?Math.min(.05,Math.max(.001,(time-lastTime)/1000)):1/60;lastTime=time;
    if(!paused){
      const d=Math.max(.05,Number(deadzone)||.16),x=Math.abs(rx)>d?rx:0,y=Math.abs(ry)>d?ry:0;
      if(x||y){const scale=(Number(lookSpeed)||18)*dt*60;dispatchRelativeMouse(canvas,x*scale,y*scale);}
    }
    raf=(globalThis.requestAnimationFrame||((fn)=>setTimeout(()=>fn(Date.now()),16)))(lookFrame);
  };

  const api={
    schema:'render360-pc-controller-v1',gameId:'portal-1-pc',
    setKey(key,pressed){
      if(stopped)return false;
      const name=String(key||'').toUpperCase(),spec=PORTAL_BUTTON_MAP[name];if(!spec)return false;
      const next=Boolean(pressed);if(buttonState.get(name)===next)return true;buttonState.set(name,next);
      if(spec.kind==='key')dispatchKey(target,spec,next);
      else if(spec.kind==='mouse')dispatchMouseButton(canvas,spec.button,next);
      else if(spec.kind==='wheel'&&next)dispatchWheel(canvas,spec.deltaY);
      return true;
    },
    setMoveAnalog(nextLx,nextLy){lx=clamp(nextLx);ly=clamp(nextLy);if(!paused)updateMove();return {lx,ly};},
    setLookAnalog(nextRx,nextRy){rx=clamp(nextRx);ry=clamp(nextRy);return {rx,ry};},
    setAnalog(nextLx,nextLy,nextRx,nextRy){api.setMoveAnalog(nextLx,nextLy);api.setLookAnalog(nextRx,nextRy);return {lx,ly,rx,ry};},
    resetInput(){
      for(const [name,pressed] of buttonState)if(pressed){const spec=PORTAL_BUTTON_MAP[name];if(spec?.kind==='key')dispatchKey(target,spec,false);else if(spec?.kind==='mouse')dispatchMouseButton(canvas,spec.button,false);}
      for(const [name,pressed] of moveState)if(pressed)dispatchKey(target,MOVE_KEYS[name],false);
      buttonState.clear();moveState.clear();lx=ly=rx=ry=0;return true;
    },
    pause(){paused=true;api.resetInput();return true;},
    resume(){paused=false;lastTime=0;return true;},
    stop(){if(stopped)return;api.resetInput();stopped=true;if(raf&&globalThis.cancelAnimationFrame)cancelAnimationFrame(raf);emitLog('info','Portal PC controller bridge stopped.');},
    descriptor(){return {...portalControllerContract(),lookSpeed:Number(lookSpeed)||18,deadzone:Number(deadzone)||.16};},
  };
  emitLog('info','Portal PC controller bridge ready · Xbox 360 overlay + physical gamepad mapped to Source input.');
  raf=(globalThis.requestAnimationFrame||((fn)=>setTimeout(()=>fn(Date.now()),16)))(lookFrame);
  return api;
}
