import assert from 'node:assert/strict';
import {PC_RECOMPILED_TITLE_SCHEMA,probePcRecompiledTitle,installPcRecompiledRouter,pcRecompiledRuntimeContract} from './runtime/pc-recompiled-runtime.js';

const manifest={schema:PC_RECOMPILED_TITLE_SCHEMA,gameId:'portal-1-pc',name:'Portal',adapter:'./adapter.mjs'};
const probe=await probePcRecompiledTitle({pcGameId:'portal-1-pc'},{fetchImpl:async()=>({ok:true,status:200,json:async()=>manifest})});
assert.equal(probe.available,true);
assert.equal(probe.gameId,'portal-1-pc');

const bad=await probePcRecompiledTitle({pcGameId:'portal-1-pc'},{fetchImpl:async()=>({ok:true,status:200,json:async()=>({...manifest,gameId:'wrong-game'})})});
assert.equal(bad.available,false);
assert.equal(bad.reason,'pc-manifest-game-id-mismatch');

class FakeRuntime{
  constructor(){this.calls=[];this.ready=true;this.core={};this.sources=new Map();this.inputHost={setSession(){}};}
  contract(){return {xbox360:true};}
  bindSource(id,source){this.sources.set(id,source);}
  getSource(id){return this.sources.get(id);}
  resetTelemetry(){}
  emit(){}
  async play(game,source,config){this.calls.push({game,source,config});return {kind:'xbox-unchanged'};}
}
const originalPlay=FakeRuntime.prototype.play;
assert.equal(installPcRecompiledRouter(FakeRuntime),true);
const fake=new FakeRuntime();
const xboxResult=await fake.play({id:'x',sourceType:'xex',platform:'xbox360'},{name:'default.xex'},{executionMode:'emulator'});
assert.deepEqual(xboxResult,{kind:'xbox-unchanged'});
assert.equal(fake.calls.length,1);
assert.notEqual(FakeRuntime.prototype.play,originalPlay);
assert.equal(fake.contract().pcRecompiledWasm.xboxRuntimeUnchanged,true);

const contract=pcRecompiledRuntimeContract();
assert.deepEqual(contract.registeredTitles,['portal-1-pc']);
assert.equal(contract.automaticWindowsExeTranslation,false);
assert.equal(contract.xbox360PathModified,false);

console.log('PC_RECOMPILED_MANIFEST_PROBE=PASS');
console.log('PC_ROUTER_XBOX_DELEGATION=PASS');
console.log('PC_PORTAL_REGISTERED=PASS');
