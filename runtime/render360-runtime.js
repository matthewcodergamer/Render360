import {Render360Core,containerName} from '../wasm-core-v32.js';
import {RuntimeHost} from '../runtime-host-v32.js';
import {runModernXboxIso} from '../render360-browser-modern-iso-bridge.mjs';
import {mountXdvdfs} from '../render360-xdvdfs.mjs';

const ext=name=>String(name||'').toLowerCase().split('.').pop()||'';
const fmtHex=value=>`0x${(Number(value)>>>0).toString(16).toUpperCase().padStart(8,'0')}`;

export class Render360Runtime extends EventTarget{
  constructor(){
    super();this.core=new Render360Core();this.ready=false;this.sources=new Map();this.currentGame=null;
    this.telemetryTimer=0;this.frameTimes=[];this.lastGeneration=null;this.lastFrameAt=0;this.backend='WASM';
    this.workerStats={hz:0,ticks:0,work:0};
    this.inputHost=new RuntimeHost((level,message)=>this.emit('log',{level,message}),stats=>{this.workerStats=stats;this.emit('workerTelemetry',stats);});
  }
  emit(type,detail={}){this.dispatchEvent(new CustomEvent(type,{detail}));}
  async init(){
    this.emit('bootStage',{stage:'core',message:'Starting Render360…'});
    const tasks=[this.core.init(),this.inputHost.init().catch(error=>{this.emit('log',{level:'warn',message:`Input worker unavailable: ${error.message}`});return null;})];
    await tasks[0];await Promise.allSettled(tasks.slice(1));this.ready=true;
    this.emit('ready',{buildVersion:this.core.buildVersion,abiVersion:this.core.abiVersion,featureBits:this.core.featureBits});
    this.startTelemetry();return this;
  }
  bindSource(gameId,file){if(gameId&&file)this.sources.set(gameId,file);}
  getSource(gameId){return this.sources.get(gameId)||null;}
  setKey(key,pressed){this.inputHost.setKey(key,pressed);}
  setAnalog(lx=0,ly=0,rx=0,ry=0){this.inputHost.setAnalog(lx,ly,rx,ry);}
  pause(){this.inputHost.pause();this.emit('paused',{});}
  resume(){this.inputHost.resume();this.emit('resumed',{});}
  resetInput(){this.inputHost.reset();}
  async inspectFile(file){
    if(!this.ready)throw new Error('Render360 core is not ready');
    const lower=String(file.name||'').toLowerCase();
    if(lower.endsWith('.iso')){
      try{
        this.emit('importProgress',{phase:'inspect',done:0,total:file.size,name:'Mounting XDVDFS'});
        const volume=await mountXdvdfs(file);
        const node=await volume.stat('/default.xex');
        if(node.isDirectory||node.size<0x18)throw new Error('Disc default.xex is invalid');
        if(node.size>256*1024*1024)throw new Error('Disc default.xex exceeds browser metadata limit');
        const bytes=await volume.readDefaultXex({maxBytes:256*1024*1024});
        const xexFile=new File([bytes],'default.xex',{type:'application/octet-stream'});
        const probe=await this.core.probeFile(xexFile);
        this.emit('importProgress',{phase:'inspect',done:file.size,total:file.size,name:'default.xex metadata'});
        return {sourceType:'iso',displayType:'Xbox 360 Disc / XDVDFS',name:stripExtension(file.name),titleId:probe.xex?.titleId||0,mediaId:0,probe,discLayout:volume.layout,defaultXexBytes:node.size};
      }catch(error){return {sourceType:'iso',displayType:'Xbox 360 Disc / XDVDFS',name:stripExtension(file.name),titleId:0,mediaId:0,probe:null,inspectionWarning:error.message};}
    }
    const probe=await this.core.probeFile(file);
    let titleId=probe.xex?.titleId||probe.stfs?.titleId||0,mediaId=probe.stfs?.mediaId||0,name=stripExtension(file.name),displayType=containerName(probe.kind);
    if(probe.kind>=10&&probe.kind<=12){
      try{
        const mount=await this.core.mountStfs(file,{onExtractProgress:s=>this.emit('importProgress',{phase:'inspect',done:s.bytesDone||0,total:s.bytesTotal||0,name:'default.xex'})});
        name=mount?.stfs?.displayName||probe.stfs?.displayName||name;
        titleId=mount?.stfs?.titleId||titleId;mediaId=mount?.stfs?.mediaId||mediaId;
        return {sourceType:lower.endsWith('.live')?'live':lower.endsWith('.pirs')?'pirs':'con',displayType,name,titleId,mediaId,probe,mount};
      }catch(error){return {sourceType:ext(file.name),displayType,name,titleId,mediaId,probe,inspectionWarning:error.message};}
    }
    return {sourceType:lower.endsWith('.xex')?'xex':ext(file.name),displayType,name,titleId,mediaId,probe};
  }
  async play(game,file=this.getSource(game.id)){
    if(!file)throw new Error('The original game file is not linked in this browser session. Choose the file again to play.');
    this.currentGame=game;this.bindSource(game.id,file);this.inputHost.setSession({kind:0,stage:5,titleId:game.titleId||0});
    this.emit('bootStage',{stage:'launch',message:`Starting ${game.name}…`});
    const type=game.sourceType||ext(file.name);
    if(type!=='iso'){
      this.emit('fatalError',{message:`${String(type).toUpperCase()} execution is not yet wired into the modern browser launch adapter. ISO/XDVDFS uses the current real-title runtime.`});
      throw new Error('This launch type is not yet wired into the modern browser runtime');
    }
    try{const result=await runModernXboxIso(file);this.emit('titleStarted',{game,result});return result;}
    catch(error){this.emit('fatalError',{message:error?.message||String(error),error});throw error;}
  }
  startTelemetry(){clearInterval(this.telemetryTimer);this.telemetryTimer=setInterval(()=>this.sampleTelemetry(),250);}
  sampleTelemetry(){
    const state=globalThis.render360ModernTitle||null,canvas=document.getElementById('titleFrameCanvas');
    const generation=canvas?.dataset?.render360Generation??null,now=performance.now();
    if(generation!==null&&generation!==this.lastGeneration){
      if(this.lastFrameAt){this.frameTimes.push(now-this.lastFrameAt);if(this.frameTimes.length>90)this.frameTimes.shift();}
      this.lastFrameAt=now;this.lastGeneration=generation;
      this.emit('framePresented',{generation:Number(generation)||0,hash:canvas?.dataset?.render360Hash||'',at:now});
    }
    const avg=this.frameTimes.length?this.frameTimes.reduce((a,b)=>a+b,0)/this.frameTimes.length:0,fps=avg?1000/avg:0;
    const gpu=state?.gpuTraffic||{},cpu=state?.persistentCpu||{},shaders=state?.shaderRuntime||{};
    this.emit('telemetry',{
      fps,frameMs:avg||0,cpuMs:null,gpuMs:null,scale:1,workerHz:Number(this.workerStats.hz||0),
      ramBytes:state?.bootstrap?.exports?.memory?.buffer?.byteLength||0,
      pm4Packets:Number(gpu.packets||0),draws:Number(gpu.draws||0),swaps:Number(gpu.swaps||0),shaderLoads:Number(gpu.shaderLoads||0),
      threadSlices:Number(cpu.totalSlices||cpu.firstPumpSlices||0),shaderStatus:shaders?.bothExecuted?'executed':shaders?.bothSpirvTranslated?'translated':shaders?.available?'captured':'waiting',
      blocker:state?.schedulerBlocker||state?.result?.reachedKernelBlocker||(!gpu.submitted&&gpu.ready?gpu:null),
      realFrame:state?.frontbufferFrame?.realTitleFrameReady===true||gpu.realTitleFrameReady===true,state,
    });
  }
}

function stripExtension(name='Xbox 360 Game'){return String(name).replace(/\.(zip|iso|xex|live|pirs|con)$/i,'').replace(/[._-]+/g,' ').trim()||'Xbox 360 Game';}
export {fmtHex,stripExtension};
