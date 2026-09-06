import assert from 'node:assert/strict';
import {browserPerformanceDefaults,createAdaptivePerformancePolicy,performancePolicyContract} from './render360-performance-policy.mjs';

const defaults=browserPerformanceDefaults({navigatorImpl:{hardwareConcurrency:4,deviceMemory:4}});
assert.equal(defaults.targetFps,30);
assert.equal(defaults.initialScale,0.9);
assert.equal(defaults.schedulerQuantum,1);

const policy=createAdaptivePerformancePolicy({initialScale:1,cooldownMs:100,recoverySamples:3});
let now=0;
for(let i=0;i<5;i++)policy.observe({fps:20,now:now+=120});
let state=policy.snapshot();
assert.ok(state.resolutionScale<1,'sustained sub-30 FPS must lower host resolution cost');
assert.ok(state.resolutionScale>=2/3,'policy must preserve the configured quality floor');
assert.equal(state.reason,'frame-budget');

const lowScale=state.resolutionScale;
for(let i=0;i<8;i++)policy.observe({fps:30,now:now+=120});
state=policy.snapshot();
assert.ok(state.resolutionScale>=lowScale,'stable recovery must never reduce resolution further');

policy.setScale(1);
policy.observe({fps:30,memoryBytes:950,memoryBudgetBytes:1000,now:now+=200});
state=policy.snapshot();
assert.ok(state.resolutionScale<=0.8,'critical memory pressure must drop at least two quality steps');
assert.equal(state.pressure,'critical');
assert.equal(state.reason,'memory-critical');

const contract=performancePolicyContract();
assert.equal(contract.guestSemanticsChanged,false);
assert.equal(contract.adaptiveResolution,true);
assert.equal(contract.targetFrameRate,30);
console.log('R360_V74_ADAPTIVE_PERFORMANCE_POLICY=PASS');
