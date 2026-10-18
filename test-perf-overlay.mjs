// Unit test for the FPS / frame-time overlay statistics (render360-perf-overlay.mjs).
import {PerfStats, formatPerf} from './render360-perf-overlay.mjs';

const expect = (cond, message) => { if (!cond) throw new Error(message); };
const near = (a, b, tol) => Math.abs(a - b) <= tol;

const stats = new PerfStats();
let t = 0, submitted = 0;
stats.submitted(t, submitted);
// 10 s at 30 FPS presented, 60 frames/s submitted; one 200 ms hitch at 5 s.
for (let frame = 0; frame < 300; ++frame) {
  t += frame === 150 ? 200 : 1000 / 30;
  submitted += 2;
  stats.submitted(t, submitted);
  stats.framePresented(t);
  // Each 33 ms frame: 20 ms inside the emulator, 5 of them in the GPU
  // renderer, plus 3 ms presenting -> CPU 15 ms, GPU 8 ms.
  stats.slice(t, 20, 5, 3);
}
const s = stats.snapshot(t);
expect(near(s.fps, 30, 1), `current FPS ${s.fps}`);
expect(near(s.averageFps, 30, 2), `average FPS ${s.averageFps}`);
expect(near(s.frameMs, 1000 / 30, 1), `frame time ${s.frameMs}`);
// Slowest 1% of 299 intervals = 3 frames: the 200 ms hitch and two 33 ms ones.
expect(near(s.low1Fps, 3000 / (200 + 2000 / 30), 0.2), `1% low should reveal the 200 ms hitch, got ${s.low1Fps}`);
expect(near(s.cpuMsPerSecond, 15 * 30, 20) && near(s.gpuMsPerSecond, 8 * 30, 20),
       `CPU/GPU split ${s.cpuMsPerSecond}/${s.gpuMsPerSecond}`);
expect(s.bottleneck === 'CPU emulation', `bottleneck ${s.bottleneck}`);
expect(near(s.submittedPerSecond, 60, 2) && near(s.presentedPerSecond, 30, 1),
       `submitted/presented ${s.submittedPerSecond}/${s.presentedPerSecond}`);
expect(s.totalSubmitted === 600 && s.totalPresented === 300, 'totals');
const text = formatPerf(s);
for (const label of ['FPS', 'avg', '1% low', 'Frame time', 'CPU emulation', 'GPU rendering', 'submitted', 'presented']) {
  expect(text.includes(label), `overlay text missing ${label}`);
}

// Window: older than 60 s drops out of the average.
const w = new PerfStats({windowMs: 60000});
for (let i = 0; i <= 600; ++i) w.framePresented(i * 100);     // 10 FPS for 60 s
for (let i = 1; i <= 600; ++i) w.framePresented(60000 + i * 50); // then 20 FPS for 30 s
expect(near(w.snapshot(90000).averageFps, 15, 1.5), `windowed average ${w.snapshot(90000).averageFps}`);

console.log(text);
// 30 FPS bar on guest frames. 60 s at 30 guest FPS with 20% idle, 2% of
// instructions interpreted: passes. One 80 ms hitch per 10 s: fails stutter.
{
  const run = (hitchEvery) => {
    const b = new PerfStats();
    let t = 0, swaps = 0, instr = 0, interp = 0, idle = 0;
    b.submitted(t, swaps);
    b.counters(t, instr, interp, idle);
    for (let frame = 1; frame <= 1800; ++frame) {
      t += hitchEvery && frame % hitchEvery === 0 ? 80 : 1000 / 30;
      b.submitted(t, ++swaps);
      instr += 20e6; interp += 0.4e6; idle += (1000 / 30) * 0.2;
      b.counters(t, instr, interp, idle);
      b.slice(t, 20, 4, 1);
      b.gpuFrame(t, 6);
      b.record(t);
    }
    return b;
  };
  const good = run(0), gs = good.snapshot(1800 * 1000 / 30);
  expect(near(gs.gameFps, 30, 1) && near(gs.gameAverageFps, 30, 0.5), `game FPS ${gs.gameFps}/${gs.gameAverageFps}`);
  expect(near(gs.interpretedPercent, 2, 0.01), `interpreted ${gs.interpretedPercent}`);
  expect(near(gs.idlePercent, 20, 0.5) && near(gs.emulationSpeedPercent, 125, 1), `speed ${gs.emulationSpeedPercent} idle ${gs.idlePercent}`);
  expect(near(gs.mips, 600, 5), `MIPS ${gs.mips}`);
  expect(near(gs.gpuMsPerFrame, 6, 0.01) && near(gs.cpuMsPerGuestFrame, 16, 1), `ms/frame ${gs.cpuMsPerGuestFrame}/${gs.gpuMsPerFrame}`);
  expect(gs.bar.pass && gs.stuttersPerMinute === 0, `bar should pass: ${JSON.stringify(gs.bar)}`);
  expect(good.log.length >= 59 && good.exportLog({cores: 8}).records.length === good.log.length, 'log records');
  expect(formatPerf(gs).includes('30 FPS bar: PASS'), 'overlay verdict');
  const hitchy = run(300).snapshot(1800 * 1000 / 30);
  expect(!hitchy.bar.pass && !hitchy.bar.stutter && near(hitchy.stuttersPerMinute, 6, 0.6), `stutters ${hitchy.stuttersPerMinute}`);
  // No idle time and 20 guest FPS: speed is 20/30, bar not met.
  const slow = new PerfStats();
  let t = 0;
  slow.submitted(0, 0); slow.counters(0, 0, 0, 0);
  for (let f = 1; f <= 600; ++f) { t += 50; slow.submitted(t, f); slow.counters(t, f * 1e7, 0, 0); }
  const ss = slow.snapshot(t);
  expect(near(ss.emulationSpeedPercent, 66.7, 1) && !ss.bar.pass && !ss.bar.average, `slow ${ss.emulationSpeedPercent}`);
}
console.log('PERF_OVERLAY_STATS=PASS');
