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
//
// The 30 FPS bar (PROGRESS.md "30 FPS bar"), judged on guest frames (VdSwap
// presents per second, "game FPS"): average >= 30 and 1% low >= 25 over the
// last 60 s, emulation speed >= 100%, at most one frame over 50 ms per minute.
// Emulation speed is 100% plus the headroom when the guest had idle time
// (nothing runnable: the emulator is ahead of real time); without idle time
// it is game FPS / 30. Counters (counters()) come from the core: guest and
// interpreted instructions, guest idle ms.

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
    this.guestFrameTimes = [];  // time of each guest frame (VdSwap)
    this.counterSamples = [];   // [time, instructions, interpreted, idleMs]
    this.gpuFrames = [];        // [time, gpuMs] per presented frame (WebGPU path)
    this.log = [];              // one record per second (exportLog)
    this.lastLogAt = 0;
  }

  // Core counters at time t (cumulative): guest instructions, interpreted
  // instructions, guest idle milliseconds.
  counters(t, instructions, interpreted, idleMs) {
    this.counterSamples.push([t, instructions, interpreted, idleMs]);
    this.trim(t);
  }

  // GPU time of one frame on the WebGPU path (submit to completion, ms).
  gpuFrame(t, ms) {
    this.gpuFrames.push([t, ms]);
    this.trim(t);
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
      for (let i = 0; i < n; ++i) this.guestFrameTimes.push(t);
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
    while (this.guestFrameTimes.length && this.guestFrameTimes[0] < old) this.guestFrameTimes.shift();
    while (this.counterSamples.length > 2 && this.counterSamples[1][0] < old) this.counterSamples.shift();
    while (this.gpuFrames.length && this.gpuFrames[0][0] < old) this.gpuFrames.shift();
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
    // Game FPS from guest frames: last second, 60 s average, 1% low,
    // frames over 50 ms in the last minute.
    const g = this.guestFrameTimes;
    const gameFps = g.filter(x => x > t - 1000).length;
    const gSpan = g.length > 1 ? Math.max(1, t - g[0]) : 0;
    const gameAverageFps = gSpan ? (g.length - 1) * 1000 / gSpan : gameFps;
    const gDeltas = [];
    for (let i = 1; i < g.length; ++i) if (g[i] > g[i - 1]) gDeltas.push(g[i] - g[i - 1]);
    let gameLow1Fps = 0;
    if (gDeltas.length) {
      const sorted = [...gDeltas].sort((a, b) => b - a);
      const worst = sorted.slice(0, Math.max(1, Math.ceil(sorted.length / 100)));
      gameLow1Fps = 1000 / (worst.reduce((a, b) => a + b, 0) / worst.length);
    }
    const stutters = gDeltas.filter(d => d > 50).length;
    const minutes = Math.max(1 / 60, Math.min(this.windowMs, gSpan || 1000) / 60000);
    // Counter rates over the last second (or the oldest sample in it).
    const cs = this.counterSamples;
    let mips = 0, interpretedPercent = 0, idlePercent = 0;
    if (cs.length > 1) {
      const last = cs[cs.length - 1];
      let first = cs[0];
      for (const c of cs) { if (c[0] >= t - 1000) { first = c; break; } }
      if (first === last) first = cs[cs.length - 2];
      const dt = Math.max(1, last[0] - first[0]);
      const di = last[1] - first[1];
      mips = di / dt / 1000;
      interpretedPercent = di > 0 ? 100 * (last[2] - first[2]) / di : 0;
      idlePercent = Math.min(100, 100 * (last[3] - first[3]) / dt);
    }
    const emulationSpeedPercent = idlePercent > 0 ? 100 / Math.max(0.01, 1 - idlePercent / 100)
                                                  : Math.min(100, 100 * gameFps / 30);
    const gpuRecent = this.gpuFrames.filter(([time]) => time >= t - 1000);
    const gpuMsPerFrame = gpuRecent.length ? gpuRecent.reduce((a, [, ms]) => a + ms, 0) / gpuRecent.length : null;
    const cpuMsPerGuestFrame = gameFps ? cpuMs / gameFps : null;
    const stuttersPerMinute = stutters / minutes;
    const bar = {
      average: gameAverageFps >= 30, low1: gameLow1Fps >= 25, speed: emulationSpeedPercent >= 100,
      stutter: stuttersPerMinute <= 1,
    };
    bar.pass = bar.average && bar.low1 && bar.speed && bar.stutter && gSpan >= 10000;
    return {
      gameFps, gameAverageFps, gameLow1Fps, stuttersPerMinute, emulationSpeedPercent, idlePercent,
      mips, interpretedPercent, cpuMsPerGuestFrame, gpuMsPerFrame, bar,
      frameTimes: gDeltas.slice(-120),
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

  // Appends a once-a-second record to the log (exportLog).
  record(t, extra = {}) {
    if (t - this.lastLogAt < 1000) return;
    this.lastLogAt = t;
    const s = this.snapshot(t);
    const {frameTimes, ...rest} = s;
    this.log.push({t: Math.round(t), ...rest, ...extra});
    if (this.log.length > 7200) this.log.shift();
  }

  // The run log with device details, as one JSON-serializable object.
  exportLog(device = {}) {
    return {format: 'render360-perf-log-1', device, bar: '30 FPS: avg >= 30, 1% low >= 25, speed >= 100%, <= 1 stutter (>50 ms) per minute',
      records: this.log};
  }
}

export function formatPerf(s) {
  const f = (x, d = 1) => Number.isFinite(x) ? x.toFixed(d) : '—';
  const mark = ok => ok ? '✓' : '✗';
  const game = s.gameFps === undefined ? [] : [
    `Game FPS ${f(s.gameFps, 0)}   avg ${f(s.gameAverageFps)}   1% low ${f(s.gameLow1Fps)}   stutters ${f(s.stuttersPerMinute, 1)}/min`,
    `Emulation speed ${f(s.emulationSpeedPercent, 0)}%   idle ${f(s.idlePercent, 0)}%   ${f(s.mips, 0)} MIPS   interpreted ${f(s.interpretedPercent, 2)}%`,
    `CPU ${f(s.cpuMsPerGuestFrame)} ms/frame   GPU ${s.gpuMsPerFrame === null ? '—' : f(s.gpuMsPerFrame) + ' ms/frame'}`,
    `30 FPS bar: ${s.bar.pass ? 'PASS' : 'not met'}  avg${mark(s.bar.average)} low${mark(s.bar.low1)} speed${mark(s.bar.speed)} stutter${mark(s.bar.stutter)}`,
  ];
  return [
    ...game,
    `FPS ${f(s.fps, 0)}   avg ${f(s.averageFps)}   1% low ${f(s.low1Fps)}`,
    `Frame time ${f(s.frameMs)} ms`,
    `CPU emulation ${f(s.cpuMsPerSecond, 0)} ms/s   GPU rendering ${f(s.gpuMsPerSecond, 0)} ms/s`,
    `Bottleneck: ${s.bottleneck}`,
    `Frames submitted ${f(s.submittedPerSecond, 0)}/s   presented ${f(s.presentedPerSecond, 0)}/s`,
    'Audio: not implemented (no XMA yet)',
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
  // Frame-time graph: guest frame times, 33.3 ms (30 FPS) and 50 ms lines.
  const graph = doc.createElement('canvas');
  graph.width = 240; graph.height = 60;
  graph.style.cssText = 'display:block;margin-top:6px;width:240px;height:60px';
  el.after(graph);
  const box = doc.createElement('div');
  box.style.cssText = 'position:fixed;top:8px;left:8px;z-index:9998;pointer-events:none';
  el.style.position = 'static';
  el.replaceWith(box);
  box.append(el, graph);
  const drawGraph = times => {
    const ctx = graph.getContext?.('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, 240, 60);
    ctx.fillStyle = 'rgba(0,0,0,.66)'; ctx.fillRect(0, 0, 240, 60);
    const y = ms => 60 - Math.min(60, ms * 60 / 100);
    ctx.strokeStyle = 'rgba(120,255,120,.5)'; ctx.beginPath(); ctx.moveTo(0, y(1000 / 30)); ctx.lineTo(240, y(1000 / 30)); ctx.stroke();
    ctx.strokeStyle = 'rgba(255,120,120,.5)'; ctx.beginPath(); ctx.moveTo(0, y(50)); ctx.lineTo(240, y(50)); ctx.stroke();
    ctx.fillStyle = '#e8f5e9';
    times.forEach((ms, i) => { const h = 60 - y(ms); ctx.fillRect(i * 2, 60 - h, 2, h); });
  };
  let visible = true;
  const toggle = () => { visible = !visible; box.style.display = visible ? '' : 'none'; };
  // L downloads the run log (globalThis.render360Perf.exportLog).
  const download = () => {
    const perf = globalThis.render360Perf;
    if (!perf?.exportLog) return;
    const nav = globalThis.navigator || {};
    const device = {userAgent: nav.userAgent, cores: nav.hardwareConcurrency, memoryGiB: nav.deviceMemory,
      gpu: globalThis.render360GpuAdapterInfo || null, screen: globalThis.screen ? `${screen.width}x${screen.height}@${globalThis.devicePixelRatio}` : null};
    const blob = new Blob([JSON.stringify(perf.exportLog(device), null, 1)], {type: 'application/json'});
    const a = doc.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `render360-perf-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  };
  const onKey = e => { if (e.key === '`') toggle(); else if (e.key === 'L' || e.key === 'l') download(); };
  doc.addEventListener('keydown', onKey);
  const overlay = {
    element: el,
    toggle,
    update(snapshot) { if (visible) { el.textContent = formatPerf(snapshot) + '\n[`] hide   [L] download log'; drawGraph(snapshot.frameTimes || []); } },
    download,
    remove() { doc.removeEventListener('keydown', onKey); box.remove(); },
  };
  globalThis.render360PerfOverlay = overlay;
  return overlay;
}
