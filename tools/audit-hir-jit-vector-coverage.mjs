#!/usr/bin/env node
// Compare the vector operations recognized by the HIR executor with the
// native WebAssembly SIMD cases in Emitter::EmitVector. Missing cases use
// Emitter::EmitGeneric (kHExec) unless the instruction is rejected earlier.
import fs from 'node:fs';

const [executorPath='src/xenia_web_bootstrap/hir_correctness_executor.cpp',
       jitPath='src/xenia_web_bootstrap/hir_wasm_jit.cpp'] = process.argv.slice(2);
const executor=fs.readFileSync(executorPath,'utf8');
const jit=fs.readFileSync(jitPath,'utf8');

function casesInSwitch(source, marker, endMarker) {
  const start=source.indexOf(marker);
  if(start<0)throw new Error(`Cannot find switch marker: ${marker}`);
  const end=source.indexOf(endMarker,start);
  if(end<0)throw new Error(`Cannot find switch end marker: ${endMarker}`);
  return new Set([...source.slice(start,end).matchAll(/\\bcase\\s+(OPCODE_[A-Z0-9_]+)\\s*:/g)].map(m=>m[1]));
}

const interpreter=casesInSwitch(
  executor,
  'bool ExecuteVectorOperation(',
  '    default:',
);
const native=casesInSwitch(
  jit,
  'bool Emitter::EmitVector(',
  '    default:',
);
const fallback=[...interpreter].filter(op=>!native.has(op)).sort();
console.log(`HIR vector operations recognized by interpreter: ${interpreter.size}`);
console.log(`Native EmitVector lowerings: ${[...interpreter].filter(op=>native.has(op)).length}`);
console.log(`Generic kHExec fallback candidates: ${fallback.length}`);
for(const opcode of fallback)console.log(`  ${opcode}`);
if(fallback.length)process.exitCode=1;
