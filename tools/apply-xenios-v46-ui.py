from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def read(path):
    return (ROOT / path).read_text(encoding='utf-8')


def write(path, text):
    (ROOT / path).write_text(text, encoding='utf-8')


# 1) Keep the existing developer console design, but make its launcher global
# instead of a child of the hidden runtime view. Also enable the drag/dock module.
ui_path = 'ui-behavior.js'
ui = read(ui_path)
if "import './developer-console-fab.js';" not in ui:
    ui = ui.replace("import './developer-console.js';\n", "import './developer-console.js';\nimport './developer-console-fab.js';\n", 1)
write(ui_path, ui)

console_path = 'developer-console.js'
console = read(console_path)
old = "  const stage=document.querySelector('.runtime-stage');if(stage&&!$('r360RuntimeConsole')){const b=document.createElement('button');b.id='r360RuntimeConsole';b.type='button';b.className='r360-console-fab';b.textContent='>_';b.onclick=openConsole;stage.appendChild(b);}\n"
new = "  const host=document.body||document.documentElement;if(host&&!$('r360RuntimeConsole')){const b=document.createElement('button');b.id='r360RuntimeConsole';b.type='button';b.className='r360-console-fab';b.textContent='>_';b.onclick=openConsole;host.appendChild(b);}\n"
if old not in console:
    raise SystemExit('developer-console launcher anchor not found')
console = console.replace(old, new, 1)
write(console_path, console)

# 2) Extend the last-loaded UI stylesheet. This preserves the existing visual
# language while making the library match the supplied XeniOS references more
# closely: safe-area spacing, full landscape width, larger covers, native-feel
# controls, and a console that can never open outside the visible viewport.
css_path = 'styles/mobile-safari-fixes.css'
css = read(css_path)
marker = '/* Render360 v46 XeniOS library + console visibility */'
if marker not in css:
    css += r'''

/* Render360 v46 XeniOS library + console visibility */
:root{
  --r360-library-left:max(18px,calc(var(--safe-left) + 14px));
  --r360-library-right:max(18px,calc(var(--safe-right) + 14px));
  --r360-top-air:14px;
  --r360-ease:cubic-bezier(.22,.78,.22,1);
}

/* Give Render360 deliberate space below the iOS status area instead of
   pinning the brand against the top edge. The navbar owns the safe area so it
   remains correct while scrolling and after rotation. */
#libraryView{
  padding-top:0!important;
  padding-left:var(--r360-library-left)!important;
  padding-right:var(--r360-library-right)!important;
}
#libraryView .navbar{
  top:0!important;
  margin-top:0!important;
  margin-left:calc(-1 * var(--r360-library-left))!important;
  margin-right:calc(-1 * var(--r360-library-right))!important;
  padding-top:calc(var(--safe-top) + var(--r360-top-air))!important;
  padding-left:var(--r360-library-left)!important;
  padding-right:var(--r360-library-right)!important;
  padding-bottom:12px!important;
  width:auto!important;
}
#libraryView .nav-row{min-height:48px!important}
#libraryView .r360-brand>.nav-title{font-size:20px!important;line-height:1.08!important}
#libraryView .r360-brand .runtime-sync{margin-top:3px!important;font-size:11.5px!important;line-height:1.2!important}
#libraryView .r360-library-title-row{margin:13px 0 14px!important;min-height:54px!important}
#libraryView .r360-library-title-row>.nav-title.large{font-size:36px!important;letter-spacing:-1.25px!important}
#libraryView .search-wrap{margin:1px 0 18px!important}
#libraryView .search-input{height:42px!important;border-radius:12px!important;font-size:16px!important;padding-left:39px!important}
#libraryView .search-wrap svg{left:13px!important;width:18px!important;height:18px!important}

/* XeniOS reference proportions: covers are intentionally larger and the
   library no longer stops at the old 920px desktop cap. */
#libraryView .library-content{width:100%!important;max-width:none!important;margin:0!important}
#libraryView .game-grid{
  width:100%!important;
  grid-template-columns:repeat(auto-fill,minmax(158px,178px))!important;
  justify-content:start!important;
  gap:28px 20px!important;
  padding-top:7px!important;
}
#libraryView .cover-shell{border-radius:10px!important;box-shadow:0 7px 22px rgba(0,0,0,.24)!important}
#libraryView .game-tile-title{font-size:16px!important;line-height:1.2!important;margin-top:9px!important}
#libraryView .game-tile-meta{font-size:11.5px!important;margin-top:5px!important}

/* iOS-feeling tap targets and motion without changing the existing icons. */
.ios-icon-button{
  width:42px!important;height:42px!important;border-radius:13px!important;
  transition:transform .16s var(--r360-ease),background-color .16s ease,opacity .16s ease!important;
}
.ios-icon-button svg{width:26px!important;height:26px!important}
.ios-icon-button:active{transform:scale(.90)!important;background:color-mix(in srgb,var(--surface3) 38%,transparent)!important}
#importButton{width:46px!important;height:46px!important}
#importButton svg{width:30px!important;height:30px!important;stroke-width:1.45!important}
.row-button,.play-button,.text-button,.cover-action{
  transition:transform .16s var(--r360-ease),filter .16s ease,opacity .16s ease,background-color .16s ease!important;
}
.row-button:active{background:color-mix(in srgb,var(--surface2) 72%,var(--surface))!important}
.play-button:active{transform:scale(.985)!important;filter:brightness(.93)!important}
.settings-select{
  min-height:34px!important;
  padding:0 25px 0 10px!important;
  border-radius:10px!important;
  background-color:color-mix(in srgb,var(--surface3) 34%,transparent)!important;
  background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='8' viewBox='0 0 12 8'%3E%3Cpath d='m1 1 5 5 5-5' fill='none' stroke='%238e8e93' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E")!important;
  background-repeat:no-repeat!important;background-position:right 8px center!important;
  transition:background-color .16s ease,transform .16s var(--r360-ease)!important;
}
.settings-select:active{transform:scale(.97)!important;background-color:color-mix(in srgb,var(--surface3) 52%,transparent)!important}
.switch span,.switch span:after{transition:background-color .22s ease,transform .24s var(--r360-ease),box-shadow .22s ease!important}
.switch:active span:after{transform:scale(.91)!important}
.switch:has(input:checked):active span:after{transform:translateX(20px) scale(.91)!important}
.settings-range{appearance:none!important;-webkit-appearance:none!important;height:28px!important;background:transparent!important}
.settings-range::-webkit-slider-runnable-track{height:4px;border-radius:999px;background:var(--surface3)}
.settings-range::-webkit-slider-thumb{-webkit-appearance:none;width:28px;height:28px;border-radius:50%;background:#fff;margin-top:-12px;box-shadow:0 1px 5px rgba(0,0,0,.34)}

/* The launcher is a global overlay now, so it is visible on Library, Settings,
   boot, and gameplay. Keep the previous console panel design unchanged. */
.r360-console-fab.r360-fab-v45{
  display:grid!important;place-items:center!important;
  visibility:visible!important;opacity:1!important;
  min-width:30px!important;
  top:max(88px,calc(var(--safe-top) + 66px));
  max-width:64px!important;
}
#r360DevConsole{
  position:fixed!important;
  inset:0!important;
  box-sizing:border-box!important;
  padding:calc(var(--safe-top) + 8px) max(8px,var(--safe-right)) calc(var(--safe-bottom) + 8px) max(8px,var(--safe-left))!important;
  align-items:flex-end!important;
  justify-content:center!important;
  overflow:hidden!important;
}
#r360DevConsole .r360-dev-panel{
  width:min(100%,920px)!important;
  height:min(82dvh,760px)!important;
  max-height:calc(100dvh - var(--safe-top) - var(--safe-bottom) - 24px)!important;
  flex:0 1 auto!important;
}
#r360DevConsole .r360-dev-head{padding-top:14px!important;flex-wrap:wrap!important}
#r360DevConsole .r360-dev-body{min-height:0!important;flex:1 1 auto!important}

@media (orientation:portrait) and (max-width:430px){
  :root{--r360-library-left:max(14px,calc(var(--safe-left) + 10px));--r360-library-right:max(14px,calc(var(--safe-right) + 10px));--r360-top-air:12px}
  #libraryView .game-grid{grid-template-columns:repeat(2,minmax(0,1fr))!important;gap:25px 26px!important}
  #libraryView .r360-library-title-row>.nav-title.large{font-size:35px!important}
}

@media (orientation:landscape){
  :root{--r360-library-left:max(28px,calc(var(--safe-left) + 18px));--r360-library-right:max(28px,calc(var(--safe-right) + 18px));--r360-top-air:10px}
  #libraryView{padding-bottom:max(22px,var(--safe-bottom))!important}
  #libraryView .navbar{padding-bottom:10px!important}
  #libraryView .nav-row{min-height:44px!important}
  #libraryView .r360-library-title-row{margin:7px 0 10px!important;min-height:46px!important}
  #libraryView .r360-library-title-row>.nav-title.large{font-size:31px!important}
  #libraryView .search-wrap{margin-bottom:18px!important}
  #libraryView .game-grid{grid-template-columns:repeat(auto-fill,minmax(166px,186px))!important;gap:26px 24px!important}
  #r360DevConsole .r360-dev-panel{height:min(88dvh,620px)!important;width:min(94vw,980px)!important;border-radius:22px!important}
}

@media (min-width:900px){
  :root{--r360-library-left:max(42px,calc(var(--safe-left) + 28px));--r360-library-right:max(42px,calc(var(--safe-right) + 28px))}
  #libraryView .game-grid{grid-template-columns:repeat(auto-fill,minmax(174px,194px))!important;gap:30px 28px!important}
}

@media (prefers-reduced-motion:reduce){
  .ios-icon-button,.row-button,.play-button,.text-button,.cover-action,.settings-select,.switch span,.switch span:after{transition:none!important}
}
'''
write(css_path, css)

# 3) Add a small regression contract so future patches do not silently move the
# developer console back into the hidden runtime view or reintroduce the 920px
# library cap.
test = r'''import fs from 'node:fs';
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
'''
write('test-xenios-v46-ui.mjs', test)

print('Applied Render360 XeniOS v46 UI patch')
