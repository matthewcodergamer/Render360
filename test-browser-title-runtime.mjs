import assert from 'node:assert/strict';
import {R360Buffer,installRender360Buffer} from './render360-byte-buffer.mjs';
import {validateBrowserBootstrap,browserTitleRuntimeContract} from './render360-browser-title-runtime.mjs';
import {extractXex2EncryptedImageKey} from './render360-iso-title-controller.mjs';

const b=R360Buffer.from('XEX2','ascii');assert.equal(b.toString('ascii'),'XEX2');
const n=R360Buffer.alloc(8);n.writeUInt16BE(0x1234,0);assert.equal(n.readUInt16BE(0),0x1234);n.set([0x89,0xab,0xcd,0xef],4);assert.equal(n.readUInt32BE(4),0x89abcdef);
assert.equal(installRender360Buffer(),globalThis.Buffer);

const names=browserTitleRuntimeContract().requiredExports;
const memory=new WebAssembly.Memory({initial:1});const exports={memory};for(const name of names)if(name!=='memory')exports[name]=()=>1;
const check=validateBrowserBootstrap({exports});assert.equal(check.ok,true);assert.equal(check.memoryBytes,65536);
const broken={exports:{memory,...Object.fromEntries(names.filter(n=>n!=='memory'&&n!=='r360_xenos_submit').map(n=>[n,()=>1]))}};
assert.throws(()=>validateBrowserBootstrap(broken),/r360_xenos_submit/);
const stalePe={exports:{memory,...Object.fromEntries(names.filter(n=>n!=='memory'&&n!=='r360_xex_guest_mapper_reserve_input').map(n=>[n,()=>1]))}};
assert.throws(()=>validateBrowserBootstrap(stalePe),/r360_xex_guest_mapper_reserve_input/);
const contract=browserTitleRuntimeContract();assert.equal(contract.bootstrapUrl,'./xenia_ppc_bootstrap.wasm');assert.equal(contract.wholeIsoCopy,false);assert.match(contract.input,/File\/Blob/);assert.equal(contract.growablePreparedPeStaging,true);assert.equal(contract.maxPreparedPeStagingBytes,256*1024*1024);

const xex=R360Buffer.alloc(0x200);xex.set(R360Buffer.from('XEX2','ascii'),0);xex.set([0,0,2,0],8);xex.set([0,0,0,0x20],0x10);const key=Uint8Array.from({length:16},(_,i)=>(0x80+i)&255);xex.set(key,0x20+0x150);assert.deepEqual([...extractXex2EncryptedImageKey(xex)],[...key]);
const short=xex.slice(0,0x17f);assert.throws(()=>extractXex2EncryptedImageKey(short),/header size out of bounds|security info/);

console.log('BROWSER_TITLE_RUNTIME=PASS');
console.log('BROWSER_BUFFER_COMPAT=PASS');
console.log('BROWSER_BOOTSTRAP_EXPORT_CONTRACT=PASS');
console.log('BROWSER_GROWABLE_PE_STAGING_CONTRACT=PASS');
console.log('BROWSER_ISO_NO_WHOLE_COPY=PASS');
console.log('BROWSER_XEX2_SECURITY_KEY=PASS');
