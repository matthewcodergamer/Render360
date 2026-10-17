// Render360 FPS / frame-time overlay.
//
// PerfStats is pure (testable in Node); createPerfOverlay draws it on the page.
// The player feeds it once per guest slice (see browserGuestRunOptions):
//   - presented frames: frames actually drawn to the page canvas;
//   - submitted frames: the guest's VdSwap count (frames the game handed to
//     the GPU);
//   - host time spent inside the emulator, the part of it spent in the GPU
//     renderer, and the time spent presenting frames on the page.
//
// Shown: current FPS (last second), average FPS (last 60 s), frame time, 1%
// low FPS, CPU emulation vs GPU rendering time, submitted vs presented.

const WINDOW_MS = 60000;

export class PerfStats {
  constructor({windowMs = WINDOW_MS} = {}) {
    this.windowMs = windowMs;
    this.presentTimes = [];   // performance.now() of each presented frame
    this.submitEvents = [];   // [time, count] of guest submissions
    this.slices = [];         // [time, emulationMs, gpuMs, presentMs]
    this.lastSubmitted = null;
    this.totalPresented = 0;
    this.totalSubmitted = 0;
  }

  // One presented frame at time t (ms).
  framePresented(t) {
    this.presentTimes.push(t);
    ++this.totalPresented;
    this.trim(t);
  }

  // Guest swap counter (cumulative) seen at time t.
  submitted(t, cumulative) {
    if (this.lastSubmitted !== null && cumulative > this.lastSubmitted) {
      const n = cumulative - this.lastSubmitted;
      this.submitEvents.push([t, n]);
      this.totalSubmitted += n;
    }
    this.lastSubmitted = cumulative;
    this.trim(t);
  }

  // Host time of one slice: total time inside the emulator, the part of it
  // spent in the GPU renderer, and the page-side present time (all ms).
  slice(t, emulationMs, gpuMs, presentMs) {
    this.slices.push([t, Math.max(0, emulationMs - gpuMs), gpuMs + presentMs]);
    this.trim(t);
  }

  trim(t) {
    const old = t - this.windowMs;
    while (this.presentTimes.length && this.presentTimes[0] < old) this.presentTimes.shift();
    while (this.submitEvents.length && this.submitEvents[0][0] < old) this.submitEvents.shift();
    while (this.slices.length && this.slices[0][0] < old) this.slices.shift();
  }

  snapshot(t) {
    const inLast = (times, ms) => times.filter(x => x >= t - ms).length;
    const current = inLast(this.presentTimes, 1000);
    const span = this.presentTimes.length > 1
      ? Math.max(1, t - this.presentTimes[0]) : 0;
    const average = span ? (this.presentTimes.length - 1) * 1000 / span : current;
    const deltas = [];
    for (let i = 1; i < this.presentTimes.length; ++i) {
      deltas.push(this.presentTimes[i] - this.presentTimes[i - 1]);
    }
    const frameMs = deltas.length ? deltas.slice(-Math.max(1, current)).reduce((a, b) => a + b, 0) / Math.min(deltas.length, Math.max(1, current)) : 0;
    // 1% low: the FPS of the slowest 1% of frames in the window.
    let low1 = 0;
    if (deltas.length) {
      const sorted = [...deltas].sort((a, b) => b - a);
      const worst = sorted.slice(0, Math.max(1, Math.ceil(sorted.length / 100)));
      low1 = 1000 / (worst.reduce((a, b) => a + b, 0) / worst.length);
    }
    const submittedLastSecond = this.submitEvents
      .filter(([time]) => time >= t - 1000).reduce((a, [, n]) => a + n, 0);
    const recent = this.slices.filter(([time]) => time >= t - 1000);
    const cpuMs = recent.reduce((a, s) => a + s[1], 0);
    const gpuMs = recent.reduce((a, s) => a + s[2], 0);
    return {
      fps: current,
      averageFps: average,
      frameMs,
      low1Fps: low1,
      cpuMsPerSecond: cpuMs,
      gpuMsPerSecond: gpuMs,
      bottleneck: cpuMs === 0 && gpuMs === 0 ? '—' : cpuMs >= gpuMs ? 'CPU emulation' : 'GPU rendering',
      submittedPerSecond: submittedLastSecond,
      presentedPerSecond: current,
      totalSubmitted: this.totalSubmitted,
      totalPresented: this.totalPresented,
    };
  }
}

export function formatPerf(s) {
  const f = (x, d = 1) => Number.isFinite(x) ? x.toFixed(d) : '—';
  return [
    `FPS ${f(s.fps, 0)}   avg ${f(s.averageFps)}   1% low ${f(s.low1Fps)}`,
    `Frame time ${f(s.frameMs)} ms`,
    `CPU emulation ${f(s.cpuMsPerSecond, 0)} ms/s   GPU rendering ${f(s.gpuMsPerSecond, 0)} ms/s`,
    `Bottleneck: ${s.bottleneck}`,
    `Frames submitted ${f(s.submittedPerSecond, 0)}/s   presented ${f(s.presentedPerSecond, 0)}/s`,
  ].join('\n');
}

// Overlay element, toggled with the ` key (or globalThis.render360PerfOverlay.toggle()).
export function createPerfOverlay(doc = globalThis.document) {
  if (!doc) return null;
  const el = doc.createElement('pre');
  el.setAttribute('aria-live', 'off');
  el.style.cssText = 'position:fixed;top:8px;left:8px;z-index:9998;margin:0;padding:8px 10px;' +
    'background:rgba(0,0,0,.66);color:#e8f5e9;font:12px/1.4 ui-monospace,Menlo,Consolas,monospace;' +
    'border-radius:6px;pointer-events:none;white-space:pre;max-width:calc(100vw - 16px);overflow:hidden';
  el.textContent = 'FPS —';
  doc.body.append(el);
  let visible = true;
  const toggle = () => { visible = !visible; el.style.display = visible ? '' : 'none'; };
  const onKey = e => { if (e.key === '`') toggle(); };
  doc.addEventListener('keydown', onKey);
  const overlay = {
    element: el,
    toggle,
    update(snapshot) { if (visible) el.textContent = formatPerf(snapshot); },
    remove() { doc.removeEventListener('keydown', onKey); el.remove(); },
  };
  globalThis.render360PerfOverlay = overlay;
  return overlay;
}
