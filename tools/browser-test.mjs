// Runs a browser-side test module in headless Chromium with WebGPU
// (SwiftShader) and returns what it reports.
//
//   import {runBrowserTest} from './tools/browser-test.mjs';
//   const result = await runBrowserTest('tests/browser/foo.mjs');
//
// The repository root is served on localhost (WebGPU needs a secure
// context). The module's default export is awaited in the page; its return
// value comes back as JSON. Uses the globally installed Playwright.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {execSync} from 'node:child_process';
import {createRequire} from 'node:module';

const ROOT=path.resolve(path.dirname(new URL(import.meta.url).pathname),'..');
const TYPES={'.mjs':'text/javascript','.js':'text/javascript','.html':'text/html','.wasm':'application/wasm','.json':'application/json'};

function loadPlaywright(){
  const globalRoot=execSync('npm root -g').toString().trim();
  return createRequire(path.join(globalRoot,'noop.js'))(path.join(globalRoot,'playwright'));
}

function serve(){
  const server=http.createServer((req,res)=>{
    const url=new URL(req.url,'http://localhost');
    if(url.pathname==='/__test__.html'){
      res.writeHead(200,{'content-type':'text/html'});
      res.end('<!doctype html><meta charset="utf-8"><body></body>');
      return;
    }
    const file=path.join(ROOT,decodeURIComponent(url.pathname));
    if(!file.startsWith(ROOT)||!fs.existsSync(file)||fs.statSync(file).isDirectory()){res.writeHead(404);res.end();return;}
    res.writeHead(200,{'content-type':TYPES[path.extname(file)]||'application/octet-stream'});
    fs.createReadStream(file).pipe(res);
  });
  return new Promise(resolve=>server.listen(0,'127.0.0.1',()=>resolve(server)));
}

export async function runBrowserTest(modulePath,{args=[],timeoutMs=300000,onConsole=null}={}){
  const {chromium}=loadPlaywright();
  const server=await serve();
  const port=server.address().port;
  const browser=await chromium.launch({args:['--enable-unsafe-webgpu','--enable-features=Vulkan',
    '--use-vulkan=swiftshader','--use-webgpu-adapter=swiftshader','--disable-vulkan-surface']});
  try{
    const page=await browser.newPage();
    page.on('console',m=>onConsole?.(m.text()));
    page.on('pageerror',e=>onConsole?.(`pageerror: ${e.message}`));
    await page.goto(`http://127.0.0.1:${port}/__test__.html`);
    page.setDefaultTimeout(timeoutMs);
    return await page.evaluate(async([m,a])=>{
      const mod=await import(m);
      return JSON.stringify(await mod.default(...a));
    },[`/${modulePath}`,args]).then(JSON.parse);
  }finally{
    await browser.close();
    server.close();
  }
}
