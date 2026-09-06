#!/usr/bin/env python3
from pathlib import Path


def replace_once(path: Path, old: str, new: str) -> bool:
    text = path.read_text()
    if new in text:
        return False
    if old not in text:
        raise SystemExit(f"expected patch anchor missing in {path}: {old[:100]!r}")
    text = text.replace(old, new, 1)
    path.write_text(text)
    return True


changed = []

app = Path('app.js')
old = "function coverMarkup(game,url){return url?`<img src=\"${url}\" alt=\"${escapeHtml(game.name)} cover\">`:`<div class=\"cover-placeholder\"><div><b>${escapeHtml(game.name)}</b><span>XBOX 360</span></div></div>`;}"
new = "function coverMarkup(game,url){const platform=game?.platform==='pc'?'PC WASM':'XBOX 360';return url?`<img src=\"${url}\" alt=\"${escapeHtml(game.name)} cover\">`:`<div class=\"cover-placeholder\"><div><b>${escapeHtml(game.name)}</b><span>${platform}</span></div></div>`;}"
if replace_once(app, old, new): changed.append(str(app))

old = "function startRelink(){if(!currentGame)return;relinkTarget=currentGame;const input=$('relinkInput');input.value='';input.click();}"
new = "function startRelink(){if(!currentGame)return;if(currentGame.platform==='pc'){globalThis.dispatchEvent(new CustomEvent('render360:openPcImport',{detail:{gameId:currentGame.id}}));return;}relinkTarget=currentGame;const input=$('relinkInput');input.value='';input.click();}"
if replace_once(app, old, new): changed.append(str(app))

old = "async function playCurrent(){if(!currentGame)return;const source=runtime.getSource(currentGame.id);if(!source){startRelink();return;}closeSheets();setState('BOOTING_GAME');$('bootOverlay').classList.remove('frame-live');setText('bootTitle',currentGame.name);setText('bootMessage','Preparing Xbox 360 runtime…');setText('bootStage',String(currentGame.sourceType||'game').toUpperCase());const profile=resolveTitleProfile(currentGame,loadTitleProfile(currentGame),appSettings);runtime.configure(profile);try{await markPlayed(currentGame.id);const result=await runtime.play(currentGame,source,profile);if(appState==='BOOTING_GAME')setState('RUNNING');setText('bootMessage','Guest execution is running. Waiting for real title pixels…');return result;}catch(error){setState('GAME_DETAILS');await renderDetail();showAlert('Game Stopped',error.message,[{label:'Done'}]);}}"
new = "async function playCurrent(){if(!currentGame)return;const source=runtime.getSource(currentGame.id);if(!source){startRelink();return;}closeSheets();setState('BOOTING_GAME');$('bootOverlay').classList.remove('frame-live');setText('bootTitle',currentGame.name);const pc=currentGame.platform==='pc';setText('bootMessage',pc?'Preparing PC WebAssembly runtime…':'Preparing Xbox 360 runtime…');setText('bootStage',String(currentGame.sourceType||'game').toUpperCase());const profile=resolveTitleProfile(currentGame,loadTitleProfile(currentGame),appSettings);runtime.configure(profile);try{await markPlayed(currentGame.id);const result=await runtime.play(currentGame,source,profile);if(appState==='BOOTING_GAME')setState('RUNNING');setText('bootMessage',pc?'PC WebAssembly runtime is running.':'Guest execution is running. Waiting for real title pixels…');return result;}catch(error){setState('GAME_DETAILS');await renderDetail();showAlert('Game Stopped',error.message,[{label:'Done'}]);}}"
if replace_once(app, old, new): changed.append(str(app))

old = "}\nboot();"
new = "}\n\nglobalThis.render360AppBridge={runtime,refreshLibrary,openGame,playCurrent,getCurrentGame:()=>currentGame};\nboot();"
if replace_once(app, old, new): changed.append(str(app))

ui_behavior = Path('ui-behavior.js')
old = "import './ui.js';\n"
new = "import './ui.js';\nimport './settings/execution-engine.js';\n"
if replace_once(ui_behavior, old, new): changed.append(str(ui_behavior))

execution = Path('settings/execution-engine.js')
old = "import {loadTitleProfile,saveTitleProfile} from '../profiles/title-profile-store.js';\n"
new = "import {loadTitleProfile,saveTitleProfile} from '../profiles/title-profile-store.js';\nimport {installPcRecompiledRouter} from '../runtime/pc-recompiled-runtime.js';\nimport '../runtime/pc-recompiled-ui.js';\n"
if replace_once(execution, old, new): changed.append(str(execution))

old = "installRuntimeRouter();\nif(document.readyState==='loading')"
new = "installRuntimeRouter();\ninstallPcRecompiledRouter(Render360Runtime);\nif(document.readyState==='loading')"
if replace_once(execution, old, new): changed.append(str(execution))

print('PC_PORTAL_PATCHED=' + (','.join(sorted(set(changed))) if changed else 'already-applied'))
