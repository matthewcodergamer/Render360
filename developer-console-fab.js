import './v47-ui.js';
import './v48-dashboard-gamerpics.js';
if(!document.querySelector('link[data-r360-ui="v47"]')){const link=document.createElement('link');link.rel='stylesheet';link.href='./styles/v47.css';link.dataset.r360Ui='v47';document.head.appendChild(link);}

// Render360 movable developer-console launcher. Tap opens; hold/drag moves it; pushing to an edge docks it.
const KEY='render360.dev-console-fab.v45';
const BUTTON_ID='r360RuntimeConsole';
const EDGE=42;
const PAD=8;
const MIN_TOP=72;
const BOTTOM_PAD=70;
let activeButton=null;

function loadState(){try{return {...JSON.parse(localStorage.getItem(KEY)||'{}')}}catch{return {}}}
function saveState(state){try{localStorage.setItem(KEY,JSON.stringify(state))}catch{}}
function viewport(){const v=visualViewport;return {w:Math.max(220,Math.round(v?.width||innerWidth||320)),h:Math.max(320,Math.round(v?.height||innerHeight||568))}}
function clamp(value,min,max){return Math.max(min,Math.min(max,value))}
function dimensions(button){const r=button.getBoundingClientRect();return {w:Math.max(28,r.width||48),h:Math.max(42,r.height||42)}}

function apply(button,state){
  const {w:vw,h:vh}=viewport();
  const dock=state.dock==='left'||state.dock==='right'?state.dock:null;
  button.classList.toggle('r360-fab-docked',!!dock);
  button.dataset.dock=dock||'';
  button.textContent=dock?(dock==='left'?'›':'‹'):'>_';
  button.setAttribute('aria-label',dock?'Expand Developer Console launcher':'Open Developer Console');
  const size=dimensions(button);
  let x=Number.isFinite(state.x)?state.x:Math.round(vw/2-size.w/2);
  let y=Number.isFinite(state.y)?state.y:Math.max(MIN_TOP,Math.round(vh*.18));
  y=clamp(y,MIN_TOP,Math.max(MIN_TOP,vh-size.h-BOTTOM_PAD));
  if(dock)x=dock==='left'?-4:vw-size.w+4;else x=clamp(x,PAD,Math.max(PAD,vw-size.w-PAD));
  button.style.left=`${Math.round(x)}px`;button.style.top=`${Math.round(y)}px`;
  state.x=x;state.y=y;saveState(state);
}

function bind(button){
  if(!button||button.dataset.r360FabV45==='1')return;
  button.dataset.r360FabV45='1';button.classList.add('r360-fab-v45');button.onclick=null;activeButton=button;
  const state=loadState();apply(button,state);
  let drag=null;
  button.addEventListener('pointerdown',event=>{
    if(event.pointerType==='mouse'&&event.button!==0)return;
    const r=button.getBoundingClientRect();drag={id:event.pointerId,startX:event.clientX,startY:event.clientY,offsetX:event.clientX-r.left,offsetY:event.clientY-r.top,moved:false};
    try{button.setPointerCapture(event.pointerId)}catch{}
    event.preventDefault();
  });
  button.addEventListener('pointermove',event=>{
    if(!drag||drag.id!==event.pointerId)return;
    const {w:vw,h:vh}=viewport(),size=dimensions(button);
    if(Math.hypot(event.clientX-drag.startX,event.clientY-drag.startY)>5){drag.moved=true;button.classList.add('r360-fab-dragging');}
    if(!drag.moved)return;
    state.dock=null;button.classList.remove('r360-fab-docked');button.dataset.dock='';button.textContent='>_';
    state.x=clamp(event.clientX-drag.offsetX,PAD,Math.max(PAD,vw-size.w-PAD));
    state.y=clamp(event.clientY-drag.offsetY,MIN_TOP,Math.max(MIN_TOP,vh-size.h-BOTTOM_PAD));
    button.style.left=`${state.x}px`;button.style.top=`${state.y}px`;event.preventDefault();
  });
  const finish=event=>{
    if(!drag||drag.id!==event.pointerId)return;
    const moved=drag.moved;drag=null;button.classList.remove('r360-fab-dragging');try{button.releasePointerCapture(event.pointerId)}catch{}
    const {w:vw}=viewport(),r=button.getBoundingClientRect();
    if(moved){
      if(r.left<=EDGE)state.dock='left';else if(vw-r.right<=EDGE)state.dock='right';else state.dock=null;
      state.x=r.left;state.y=r.top;apply(button,state);return;
    }
    if(state.dock){const dock=state.dock;state.dock=null;state.x=dock==='left'?PAD+8:Math.max(PAD,vw-64);apply(button,state);return;}
    globalThis.render360DeveloperConsole?.open?.();
  };
  button.addEventListener('pointerup',finish);button.addEventListener('pointercancel',()=>{drag=null;button.classList.remove('r360-fab-dragging');apply(button,state)});
}

function scan(){const button=document.getElementById(BUTTON_ID);if(button)bind(button)}
new MutationObserver(scan).observe(document.documentElement,{childList:true,subtree:true});
visualViewport?.addEventListener('resize',()=>{if(activeButton)apply(activeButton,loadState())});
window.addEventListener('orientationchange',()=>setTimeout(()=>{if(activeButton)apply(activeButton,loadState())},100));
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',scan,{once:true});else scan();
