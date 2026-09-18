import { register } from 'node:module';
import { Session } from 'node:inspector/promises';
import { writeFileSync } from 'node:fs';
import { monitorEventLoopDelay } from 'node:perf_hooks';

const loop = monitorEventLoopDelay({ resolution: 10 });
loop.enable();
const detailed = process.env.PYRIC_MULTICLIENT_PROFILE === '1';
const profiler = detailed ? new Session() : null;
if (profiler) profiler.connect();
let timings = {};
let lastCpu = process.cpuUsage();
let lastSample = performance.now();
const activeBudgets = new Map();
let capturePendingSince = null;
let captureWrites = 0;
let captureBytes = 0;
let maxCaptureDelayMs = 0;
let maxPendingCount = 0;
let maxPendingBytes = 0;
let phase = 'startup';
const probe = globalThis.__multiClient = {
  measure(name, value) {
    const metric = timings[name] ??= { count: 0, sum: 0, max: 0 };
    metric.count++; metric.sum += value; metric.max = Math.max(metric.max, value);
  },
  histories: [], nextBudget: 0, socketBytes: 0,
  budget(id, count, bytes) {
    maxPendingCount = Math.max(maxPendingCount, count);
    maxPendingBytes = Math.max(maxPendingBytes, bytes);
    if (count === 0) activeBudgets.delete(id);
    else activeBudgets.set(id, { count, bytes });
  },
  observerRefused(socket) {
    process.send?.({ type: 'observer-refused', remotePort: socket._socket.remotePort, backlogBytes: socket.bufferedAmount });
  },
  captureDirty() { capturePendingSince ??= Date.now(); },
  captureWritten(bytes) {
    if (capturePendingSince !== null) maxCaptureDelayMs = Math.max(maxCaptureDelayMs, Date.now() - capturePendingSince);
    capturePendingSince = null;
    captureWrites++;
    captureBytes = Math.max(captureBytes, bytes);
  },
};
register('./multiclient-loader.mjs', import.meta.url);

function sample() {
  const histories = probe.histories.flatMap(ref => {
    const owner = ref.deref();
    if (!owner) return [];
    return [{ entries: owner.entries.length, bytes: owner.bytes + owner.liveBytes, liveCount: owner.liveCount, limits: owner.limits,
      requests: owner.activeRequests.size, listeners: owner.activeListeners.size,
      retainedIds: owner.retainedIds.size, completedRequests: owner.completedRequests.size,
      gap: owner.gap ? { omittedCount: owner.gap.omittedCount, reason: owner.gap.reason } : null }];
  });
  const pendingAgeMs = capturePendingSince === null ? 0 : Date.now() - capturePendingSince;
  const context = probe.context?.deref();
  const subs = context ? [...context.subs.values()].reduce((count, values) => count + values.size, 0) : null;
  const handles = process.getActiveResourcesInfo().reduce((counts, name) => {
    counts[name] = (counts[name] ?? 0) + 1;
    return counts;
  }, {});
  const now = performance.now();
  const cpu = process.cpuUsage();
  const cpuMs = (cpu.user - lastCpu.user + cpu.system - lastCpu.system) / 1000;
  const intervalMs = now - lastSample;
  lastCpu = cpu; lastSample = now;
  process.send?.({ type: 'sample', at: Date.now(), phase, cpuMs, intervalMs, timings, memory: process.memoryUsage(), handles,
    histories, subscriptions: subs, operationBudgets: [...activeBudgets.values()], maxPendingCount, maxPendingBytes,
    socketBytes: probe.socketBytes, history: probe.history?.deref()?.status(),
    capture: { writes: captureWrites, maxBytes: captureBytes, pendingAgeMs, maxDelayMs: Math.max(maxCaptureDelayMs, pendingAgeMs) },
    loopP95Ms: loop.percentile(95) / 1e6, loopMaxMs: loop.max / 1e6 });
  loop.reset();
}
const interval = setInterval(sample, 1000);
interval.unref();
process.on('message', async message => {
  if (message.type !== 'phase') return;
  try {
    const leavingMeasurement = phase === 'measurement';
    if (leavingMeasurement && profiler) {
      const { profile } = await profiler.post('Profiler.stop');
      writeFileSync(process.env.PYRIC_MULTICLIENT_PROFILE_OUTPUT, JSON.stringify(profile));
      profiler.disconnect();
    }
    const enteringMeasurement = message.phase === 'measurement';
    if (enteringMeasurement) {
      timings = {};
      if (profiler) {
        await profiler.post('Profiler.enable');
        await profiler.post('Profiler.setSamplingInterval', { interval: 1000 });
        await profiler.post('Profiler.start');
      }
    }
    phase = message.phase;
    sample();
    process.send?.({ type: 'phase-ready' });
  } catch (error) { process.send?.({ type: 'phase-ready', error: String(error) }); }
});
