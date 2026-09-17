import { register } from 'node:module';
import { Session } from 'node:inspector';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { writeFileSync } from 'node:fs';

register('./capacity-loader.mjs', import.meta.url);
const timings = new Map();
const counts = {};
const owners = [];
let phase = 'startup';
const inspector = new Session();
inspector.connect();
const call = (method, params = {}) => new Promise((resolve, reject) => {
  inspector.post(method, params, (error, result) => error ? reject(error) : resolve(result));
});
await call('Profiler.enable');
await call('Profiler.start');
const eventLoop = monitorEventLoopDelay({ resolution: 1 });
eventLoop.enable();
globalThis.__capacity = {
  pending: 0, owners,
  time(name, started) {
    const values = timings.get(name) ?? [];
    if (values.length < 50_000) values.push(performance.now() - started);
    timings.set(name, values);
  },
  count(name, value) { counts[name] = (counts[name] ?? 0) + value; },
};
function summarize(values) {
  values.sort((a, b) => a - b);
  return { count: values.length, totalMs: values.reduce((sum, value) => sum + value, 0), p95Ms: values[Math.ceil(values.length * .95) - 1], maxMs: values.at(-1) };
}
function sample() {
  const retained = owners.flatMap(({ kind, ref }) => {
    const owner = ref.deref();
    if (!owner) return [];
    if (kind === 'undo') return [{ kind, entries: owner.events.length, redo: owner.undoneEvents.length }];
    return [{ kind, entries: owner.entries.length, encodedBytes: owner.bytes, activeRequests: owner.activeRequests.size, activeListeners: owner.activeListeners.size }];
  });
  const result = { at: Date.now(), phase, memory: process.memoryUsage(), pending: globalThis.__capacity.pending,
    retained, timings: Object.fromEntries([...timings].map(([name, values]) => [name, summarize(values)])), counts: { ...counts },
    eventLoopP95Ms: eventLoop.percentile(95) / 1e6, eventLoopMaxMs: eventLoop.max / 1e6 };
  timings.clear();
  for (const name of Object.keys(counts)) delete counts[name];
  eventLoop.reset();
  process.send?.({ type: 'sample', ...result });
}
const timer = setInterval(sample, 1000);
timer.unref();
process.on('message', async message => {
  try {
    if (message.command === 'phase') { sample(); phase = message.phase; sample(); }
    if (message.command === 'clear-owner') {
      for (const owner of owners) {
        if (owner.kind === message.kind) owner.ref.deref()?.clear();
      }
    }
    if (message.command === 'gc') { globalThis.gc(); phase = message.phase; sample(); }
    if (message.command === 'profile') {
      const { profile } = await call('Profiler.stop');
      writeFileSync(message.path, JSON.stringify(profile));
    }
    process.send?.({ type: 'reply', id: message.id });
  } catch (error) { process.send?.({ type: 'reply', id: message.id, error: String(error) }); }
});
