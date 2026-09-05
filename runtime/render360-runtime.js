import {RuntimeHost} from '../runtime-host.js';
import {pauseActiveTitle,resumeActiveTitle} from './title-controls.js';

const ext=name=>String(name||'').toLowerCase().split('.').pop()||'';
const fmtHex=value=>`0x${(Number(value)>>>0).toString(16).toUpperCase().padStart(8,'0')}`;
const RENDER360_RELEASE=58;
const REQUIRED_CORE_BUILD=30;
const REQUIRED_ABI=0x00030002;
const CONTENT_BRIDGE={release:58,inputs:['xex','live','pirs','con'],stfsStreamingMount:true,wholePackageCopy:false,defaultXexBounded:true,translationSideEffects:false,generatedWasmExecution:true,nativeGuestThreadRegistry:true,cooperativeThreadScheduler:true,xenosTrafficInspection:true,realFrontbufferCapture:true,pauseResume:true,nativeHirCompatibilityFallback:true};
const containerName=kind=>({1:'XEX1',2:'XEX2',10:'STFS LIVE',11:'STFS PIRS',12:'STFS CON',20:'PowerPC ELF'})[kind]||'Unknown';

let coreModulePromise=null;
let isoBridgePromise=null;
let contentBridgePromise=null;
let xdvdfsPromise=null;
const coreModule=()=>coreModulePromise??=(import('../wasm-core.js'));
const isoBridge=()=>isoBridgePromise??=(import('../render360-browser-modern-iso-bridge.mjs'));
const contentBridge=()=>contentBridgePromise??=(import('../render360-browser-modern-content-bridge.mjs'));
const xdvdfs=()=>xdvdfsPromise??=(import('../render360-xdvdfs.mjs'));

export class Render360Runtime extends EventTarget{
  constructor(){
    super();this.core=null;this.ready=false;this.sources=new Map();this.currentGame=null;this.launchConfig={};
    this.telemetryTimer=0;this.frameTimes=[];this.lastGeneration=null;this.lastFrameAt=0;this.backend='WASM';
    this.workerStats={hz:0,ticks:0,work:0};
    this.inputHost=new RuntimeHost((level,message)=>this.emit('log',{level,message}),stats=>{this.workerStats=stats;this.emit('workerTelemetry',stats);});
  }
  emit(type,detail={}){this.dispatchEvent(new CustomEvent(type,{detail}));try{globalThis.dispatchEvent(new CustomEvent(`render360:${type}`,{detail}));}catch{}}
  async init(){
    this.emit('bootStage',{stage:'core',message:'Loading emulator core…'});
    const inputPromise=this.inputHost.init().catch(error=>{this.emit('log',{level:'warn',message:`Input worker unavailable: ${error.message}`});return null;});
    const {Render360Core}=await coreModule();
    this.core=new Render360Core();
    await this.core.init();
    if(this.core.buildVersion<REQUIRED_CORE_BUILD)throw new Error(`Runtime contract requires Core V${REQUIRED_CORE_BUILD}+; loaded V${this.core.buildVersion}`);
    if(this.core.abiVersion<REQUIRED_ABI)throw new Error(`Runtime contract requires ABI ${fmtHex(REQUIRED_ABI)}+; loaded ${fmtHex(this.core.abiVersion)}`);
    await Promise.allSettled([inputPromise]);this.ready=true;
    this.emit('log',{level:'ok',message:`Core source ${this.core.source} · STFS extraction ${this.core.stfsExtractionMode}`});
    if(this.core.source==='embedded'&&this.core.networkError)this.emit('log',{level:'warn',message:`Network core unavailable; using embedded fallback: ${this.core.networkError.message}`});
    this.emit('ready',{buildVersion:this.core.buildVersion,abiVersion:this.core.abiVersion,featureBits:this.core.featureBits,contract:this.contract()});
    this.startTelemetry();return this;
  }
  contract(){return {release:RENDER360_RELEASE,minCoreBuild:REQUIRED_CORE_BUILD,minAbi:REQUIRED_ABI,loadedCoreBuild:this.core?.exports?this.core.buildVersion:null,loadedAbi:this.core?.exports?this.core.abiVersion:null,coreSource:this.core?.source||'loading',stfsExtraction:this.core?.exports?this.core.stfsExtractionMode:'loading',nativeStfsExtraction:Boolean(this.core?.nativeStfsExtraction),inputs:['iso','xex','live','pirs','con'],contentBridge:{...CONTENT_BRIDGE}};}
  configure(config={}){this.launchConfig={...this.launchConfig,...config};return this.launchConfig;}
  bindSource(gameId,file){if(gameId&&file)this.sources.set(gameId,file);}
  getSource(gameId){return this.sources.get(gameId)||null;}
  unbindSource(gameId){this.sources.delete(gameId);}
  setKey(key,pressed){this.inputHost.setKey(key,pressed);}
  setAnalog(lx=0,ly=0,rx=0,ry=0){this.inputHost.setAnalog(lx,ly,rx,ry);}
  pause(){const titlePaused=pauseActiveTitle();this.inputHost.pause();this.emit('paused',{titlePaused});return titlePaused;}
  resume(){const titleResumed=resumeActiveTitle();this.inputHost.resume();this.emit('resumed',{titleResumed});return titleResumed;}
  resetInput(){this.inputHost.reset();this.setAnalog(0,0,0,0);}
  resetTelemetry(){this.frameTimes.length=0;this.lastGeneration=null;this.lastFrameAt=0;}
  async inspectFile(file){
    if(!this.ready||!this.core)throw new Error('Render360 core is still loading');
    const lower=String(file.name||'').toLowerCase();
    if(lower.endsWith('.iso')){
      try{
        const {mountXdvdfs}=await xdvdfs();
        this.emit('importProgress',{phase:'inspect',done:0,total:file.size,name:'Mounting XDVDFS'});
        const volume=await mountXdvdfs(file),node=await volume.stat('/default.xex');
        if(node.isDirectory||node.size<0x18)throw new Error('Disc default.xex is invalid');
        if(node.size>256*1024*1024)throw new Error('Disc default.xex exceeds browser metadata limit');
        const bytes=await volume.readDefaultXex({maxBytes:256*1024*1024}),xexFile=new File([bytes],'default.xex',{type:'application/octet-stream'}),probe=await this.core.probeFile(xexFile);
        this.emit('importProgress',{phase:'inspect',done:file.size,total:file.size,name:'default.xex metadata'});
        return {sourceType:'iso',displayType:'Xbox 360 Disc / XDVDFS',name:stripExtension(file.name),titleId:probe.xex?.titleId||0,mediaId:probe.xex?.mediaId||0,probe,discLayout:volume.layout,defaultXexBytes:node.size};
      }catch(error){return {sourceType:'iso',displayType:'Xbox 360 Disc / XDVDFS',name:stripExtension(file.name),titleId:0,mediaId:0,probe:null,inspectionWarning:error.message};}
    }
    const probe=await this.core.probeFile(file);let titleId=probe.xex?.titleId||probe.stfs?.titleId||0,mediaId=probe.xex?.mediaId||probe.stfs?.mediaId||0,name=stripExtension(file.name),displayType=containerName(probe.kind);
    if(probe.kind>=10&&probe.kind<=12){
      try{const mount=await this.core.mountStfs(file,{onExtractProgress:s=>this.emit('importProgress',{phase:'inspect',done:s.bytesDone||0,total:s.bytesTotal||0,name:'default.xex'})});name=mount?.stfs?.displayName||probe.stfs?.displayName||name;titleId=mount?.stfs?.titleId||mount?.defaultXexInspection?.titleId||titleId;mediaId=mount?.stfs?.mediaId||mount?.defaultXexInspection?.mediaId||mediaId;return {sourceType:lower.endsWith('.live')?'live':lower.endsWith('.pirs')?'pirs':'con',displayType,name,titleId,mediaId,probe,mount};}catch(error){return {sourceType:ext(file.name),displayType,name,titleId,mediaId,probe,inspectionWarning:error.message};}
    }
    return {sourceType:lower.endsWith('.xex')?'xex':ext(file.name),displayType,name,titleId,mediaId,probe};
  }
  async play(game,file=this.getSource(game.id),config={}){
    if(!file)throw new Error('The original game file is not linked. Choose it again or enable persistent Game Storage.');
    if(!this.ready||!this.core)throw new Error('Render360 core is still loading');
    this.currentGame=game;this.bindSource(game.id,file);this.resetTelemetry();
    const type=String(game.sourceType||ext(file.name)).toLowerCase(),launchConfig={...this.launchConfig,...config};
    this.inputHost.setSession({kind:type==='iso'?1:type==='xex'?2:3,stage:5,titleId:game.titleId||0});
    this.emit('bootStage',{stage:'launch',message:`Starting ${game.name}…`,type,fileName:file.name||'',fileSize:file.size||0,titleId:game.titleId||0,mediaId:game.mediaId||0});
    try{
      let result;
      if(type==='iso'){const {runModernXboxIso}=await isoBridge();result=await runModernXboxIso(file);}
      else if(['xex','live','pirs','con'].includes(type)){const {runModernXboxContent}=await contentBridge();result=await runModernXboxContent({core:this.core,file,type,config:launchConfig,onStage:event=>{this.emit('bootStage',event);if(event.stage==='blocked')this.emit('runtimeBlocker',event);}});}
      else throw new Error(`${type.toUpperCase()} is not a runnable Render360 source type`);
      this.emit('titleStarted',{game,result,type,config:launchConfig});return result;
    }catch(error){this.emit('fatalError',{message:error?.message||String(error),error,type,lastStage:globalThis.render360ModernTitle?.result?.runtimeBoundary||null});throw error;}
  }
  startTelemetry(){clearInterval(this.telemetryTimer);this.telemetryTimer=setInterval(()=>this.sampleTelemetry(),250);}
  sampleTelemetry(){
    const state=globalThis.render360ModernTitle||null,canvas=document.getElementById('titleFrameCanvas'),generation=canvas?.dataset?.render360Generation??null,now=performance.now();
    if(generation!==null&&generation!==this.lastGeneration){if(this.lastFrameAt){this.frameTimes.push(now-this.lastFrameAt);if(this.frameTimes.length>90)this.frameTimes.shift();}this.lastFrameAt=now;this.lastGeneration=generation;this.emit('framePresented',{generation:Number(generation)||0,hash:canvas?.dataset?.render360Hash||'',at:now});}
    const avg=this.frameTimes.length?this.frameTimes.reduce((a,b)=>a+b,0)/this.frameTimes.length:0,fps=avg?1000/avg:0,gpu=state?.gpuTraffic||{},cpu=state?.persistentCpu||{},shaders=state?.shaderRuntime||{};
    this.emit('telemetry',{fps,frameMs:avg||0,cpuMs:null,gpuMs:null,scale:Number(state?.config?.resolutionScale||1),workerHz:Number(this.workerStats.hz||0),ramBytes:state?.bootstrap?.exports?.memory?.buffer?.byteLength||0,pm4Packets:Number(gpu.packets||0),draws:Number(gpu.draws||0),swaps:Number(gpu.swaps||0),shaderLoads:Number(gpu.shaderLoads||0),threadSlices:Number(cpu.totalSlices||cpu.firstPumpSlices||0),shaderStatus:shaders?.bothExecuted?'executed':shaders?.bothSpirvTranslated?'translated':shaders?.available?'captured':'waiting',blocker:state?.schedulerBlocker||state?.result?.reachedKernelBlocker||(!gpu.submitted&&gpu.ready?gpu:null),realFrame:state?.frontbufferFrame?.realTitleFrameReady===true||gpu.realTitleFrameReady===true,state});
  }
}
function stripExtension(name='Xbox 360 Game'){return String(name).replace(/\.(zip|iso|xex|live|pirs|con)$/i,'').replace(/[._-]+/g,' ').trim()||'Xbox 360 Game';}
export {fmtHex,stripExtension,RENDER360_RELEASE,REQUIRED_CORE_BUILD,REQUIRED_ABI};
