// Render360 native iOS app bridge. The app (ios/Render360) shows this same web
// UI - library, details, settings, touch controller, HUD - over its native
// Metal game view, so the app and the website look and behave the same. Only
// the emulator differs: inside the app the native C++ core runs the title
// (no browser memory limit) and game files live in the app's storage.
//
// On the website `nativeHost` is null and nothing here runs.
const handler = globalThis.webkit?.messageHandlers?.render360 || null;

export const nativeHost = handler ? createNativeHost(handler) : null;

function createNativeHost(handler) {
  const pending = new Map();
  let nextId = 1;
  const listeners = new Map();
  // Native -> web: replies to requests and pushed events.
  globalThis.render360NativeReply = (id, ok, value) => {
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    if (ok) p.resolve(value);
    else p.reject(new Error(String(value || 'Native request failed')));
  };
  globalThis.render360NativeEvent = (type, detail) => {
    for (const fn of listeners.get(type) || []) {
      try { fn(detail); } catch (error) { console.error(error); }
    }
  };
  document.documentElement.classList.add('r360-native-host');
  const style = document.createElement('style');
  // The native game view is behind the page: the runtime view is see-through
  // once the title draws (the boot card stays until the first frame).
  style.textContent = `html.r360-native-host:not(.r360-native-playing),html.r360-native-host:not(.r360-native-playing) body{background:#000}
html.r360-native-host.r360-native-playing,html.r360-native-host.r360-native-playing body,html.r360-native-host.r360-native-playing #app{background:transparent!important}
html.r360-native-host #runtimeView,html.r360-native-host #runtimeView .runtime-stage{background:transparent!important}
html.r360-native-host #runtimeView #gpuCanvas,html.r360-native-host #runtimeView #titleFrameCanvas,html.r360-native-host #runtimeView #titleFrameWebGPUCanvas{display:none!important}`;
  document.head.appendChild(style);
  return {
    post(message) { handler.postMessage(message); },
    request(type, payload = {}) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, {resolve, reject});
        handler.postMessage({type, id, ...payload});
      });
    },
    on(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    setPlaying(on) { document.documentElement.classList.toggle('r360-native-playing', !!on); },
  };
}
