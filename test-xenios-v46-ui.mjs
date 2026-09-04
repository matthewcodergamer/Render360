import fs from 'node:fs';
const read=p=>fs.readFileSync(new URL(p,import.meta.url),'utf8');
const behavior=read('./ui-behavior.js');
const consoleJs=read('./developer-console.js');
const css=read('./styles/mobile-safari-fixes.css');
const failures=[];
const must=(v,m)=>{if(!v)failures.push(m)};
must(behavior.includes("import './developer-console-fab.js';"),'drag/dock module must load');
must(consoleJs.includes("const host=document.body||document.documentElement"),'console launcher must live outside hidden runtime view');
must(!consoleJs.includes("stage.appendChild(b)"),'console launcher must not be owned by runtime-stage');
must(css.includes('Render360 v46 XeniOS library + console visibility'),'v46 CSS marker missing');
must(css.includes('#libraryView .library-content{width:100%!important;max-width:none!important'),'library must stretch full width');
must(css.includes('grid-template-columns:repeat(2,minmax(0,1fr))'),'portrait two-column XeniOS cover sizing missing');
must(css.includes('#r360DevConsole .r360-dev-panel'),'visible console safe-area rule missing');
if(failures.length){console.error('XENIOS_V46_UI FAIL');for(const f of failures)console.error(' - '+f);process.exit(1)}
console.log('XENIOS_V46_UI PASS');
