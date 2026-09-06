import assert from 'node:assert/strict';
import {computePcGraphicsProfile} from './runtime/pc-webgpu-presenter.js';

const iphoneLandscape=computePcGraphicsProfile({cssWidth:896,cssHeight:414,dpr:2,deviceMemory:4,mobile:true});
assert.equal(iphoneLandscape.targetFps,30);
assert.ok(iphoneLandscape.sourceWidth*iphoneLandscape.sourceHeight<=960*540+960);
assert.ok(iphoneLandscape.presentWidth*iphoneLandscape.presentHeight<=1280*720+1280);
assert.ok(iphoneLandscape.presentWidth>=iphoneLandscape.sourceWidth);
assert.ok(iphoneLandscape.presentHeight>=iphoneLandscape.sourceHeight);

const desktop=computePcGraphicsProfile({cssWidth:1280,cssHeight:720,dpr:1,deviceMemory:8,mobile:false});
assert.equal(desktop.targetFps,60);
assert.equal(desktop.sourceWidth,1280);
assert.equal(desktop.sourceHeight,720);
assert.equal(desktop.presentWidth,1280);
assert.equal(desktop.presentHeight,720);

const tiny=computePcGraphicsProfile({cssWidth:320,cssHeight:180,dpr:3,deviceMemory:2,mobile:true});
assert.ok(tiny.sourceWidth>=320);
assert.ok(tiny.sourceHeight>=180);
assert.ok(tiny.presentWidth>=tiny.sourceWidth);

console.log('PC WebGPU profile tests passed', {iphoneLandscape,desktop,tiny});
