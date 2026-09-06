import assert from 'node:assert/strict';
import {portalControllerContract} from './runtime/pc-controller-input.js';

const contract=portalControllerContract();
assert.equal(contract.schema,'render360-pc-controller-v1');
assert.equal(contract.gameId,'portal-1-pc');
assert.equal(contract.layout,'xbox360-overlay');
assert.equal(contract.buttons.A.code,'Space');
assert.equal(contract.buttons.X.code,'KeyE');
assert.equal(contract.buttons.RT.kind,'mouse');
assert.equal(contract.buttons.RT.button,0);
assert.equal(contract.buttons.LT.button,2);
assert.equal(contract.leftStick,'WASD');
assert.equal(contract.rightStick,'relative-mouse-look');
assert.equal(contract.touchAndPhysicalGamepad,true);

console.log('PORTAL_PC_XBOX_OVERLAY=PASS');
console.log('PORTAL_PC_PHYSICAL_GAMEPAD=PASS');
console.log('PORTAL_PC_MOVE_LOOK_MAPPING=PASS');
