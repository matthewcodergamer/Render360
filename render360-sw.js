const VERSION='44.23';
const SHELL_CACHE=`render360-shell-v${VERSION}`;
const SHELL_ASSETS=[
  './index.html',
  './manifest.webmanifest',
  './render360-app-icon.svg',
  './rendr360-apple-touch-icon.png',
];

self.addEventListener('install',event=>{
  event.waitUntil((async()=>{
    const cache=await caches.open(SHELL_CACHE);
    await Promise.allSettled(SHELL_ASSETS.map(url=>cache.add(new Request(url,{cache:'reload'}))));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate',event=>{
  event.waitUntil((async()=>{
    const names=await caches.keys();
    await Promise.all(names.filter(name=>name.startsWith('render360-shell-v')&&name!==SHELL_CACHE).map(name=>caches.delete(name)));
    if(self.registration.navigationPreload)await self.registration.navigationPreload.enable().catch(()=>{});
    await self.clients.claim();
  })());
});

function sameOrigin(request){
  try{return new URL(request.url).origin===self.location.origin;}catch{return false;}
}
function isMutableRuntime(request){
  const pathname=new URL(request.url).pathname.toLowerCase();
  return /\.(?:m?js|wasm)$/.test(pathname);
}
function isShellAsset(request){
  const pathname=new URL(request.url).pathname.toLowerCase();
  return /\.(?:css|svg|webmanifest|png|jpg|jpeg|webp)$/.test(pathname);
}
async function networkFirstNoStore(request){
  return fetch(new Request(request,{cache:'no-store'}));
}
async function shellAsset(request){
  const cache=await caches.open(SHELL_CACHE);
  try{
    const response=await fetch(new Request(request,{cache:'no-store'}));
    if(response?.ok)cache.put(request,response.clone()).catch(()=>{});
    return response;
  }catch{
    return await cache.match(request)||Response.error();
  }
}
async function navigation(event){
  const cache=await caches.open(SHELL_CACHE);
  const preload=await event.preloadResponse;
  if(preload){
    if(preload.ok)cache.put('./index.html',preload.clone()).catch(()=>{});
    return preload;
  }
  try{
    const response=await fetch(new Request(event.request,{cache:'no-store'}));
    if(response.ok)cache.put('./index.html',response.clone()).catch(()=>{});
    return response;
  }catch{
    return await cache.match('./index.html')||await cache.match('./')||Response.error();
  }
}

self.addEventListener('fetch',event=>{
  const request=event.request;
  if(request.method!=='GET'||!sameOrigin(request))return;
  if(request.mode==='navigate'){event.respondWith(navigation(event));return;}
  // Emulator JavaScript and WebAssembly are deliberately network-first and
  // never stored in the shell cache. This prevents an old service worker from
  // resurrecting stale PPC/Xenos binaries after a Rendr360 deployment.
  if(isMutableRuntime(request)){event.respondWith(networkFirstNoStore(request));return;}
  // UI assets are network-first too. This prevents an older cached stylesheet
  // from briefly restoring an obsolete header/order after a new deployment.
  if(isShellAsset(request))event.respondWith(shellAsset(request));
});
