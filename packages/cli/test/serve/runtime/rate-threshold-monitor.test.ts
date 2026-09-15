import { expect, test } from 'bun:test';
import type { SdkRateSnapshot } from 'pyric/sandbox/internal';
import { createRateThresholdMonitor } from '../../../src/serve/runtime/rate-threshold-monitor.js';
import { createRateHistory } from '../../../src/serve/runtime/rate-history.js';
function snapshot(second: number, values: number[], service: 'firestore' | 'rtdb' = 'rtdb'): SdkRateSnapshot {
  return { monotonicAt: second * 1000, windowSeconds: 5, services: [{ service, coverage: 'partial', observed: true, untrackedMethods: [],
    methods: [{ method: 'set', category: 'write', callsPerSecond: 999, deliveriesPerSecond: 0, activeListeners: 0, observed: true, buckets: values.map((calls, second) => ({ second, calls, deliveries: 0 })) }],
    usageBuckets: values.map((documentReads, second) => ({ second, documentReads, documentWrites: 0, documentDeletes: 0, payloadBytes: 0, unmeasured: 0 })),
  }] };
}
test('five completed consecutive seconds above the limit create one incident, independent of live average', () => {
  const monitor = createRateThresholdMonitor();
  const values = [6, 6, 8, 6, 7, 9];
  for (let second = 0; second < 5; second++) monitor.sample(snapshot(second, values), {});
  expect(monitor.incidents()).toHaveLength(0);
  monitor.sample(snapshot(5, values), {});
  expect(monitor.incidents()).toHaveLength(1);
  expect(monitor.incidents()[0]).toMatchObject({ from: 0, to: 4, limit: 5, peak: 8, recovered: false });
  monitor.sample(snapshot(5, values), {});
  monitor.sample(snapshot(6, values), {});
  expect(monitor.incidents()).toHaveLength(1);
  expect(monitor.incidents()[0]!.peak).toBe(9);
});
test('equal limits and short bursts do not warn; zero seconds reset the consecutive window', () => {
  const monitor = createRateThresholdMonitor();
  const values = [5, 9, 9, 0, 9, 9, 9, 9, 0];
  for (let second = 0; second <= 10; second++) monitor.sample(snapshot(second, values), {});
  expect(monitor.incidents()).toHaveLength(0);
});
test('recovered alerts retain evidence beyond history expiry; review clears amber and a new episode rearms it', () => {
  const monitor = createRateThresholdMonitor();
  const config = { sustainedSeconds: 2 };
  for (let second = 0; second <= 7; second++) monitor.sample(snapshot(second, [7, 8]), config);
  const incident = monitor.incidents()[0]!;
  expect(incident.recovered).toBe(true);
  expect(monitor.pending()).toBe(true);
  const history = createRateHistory('rtdb');
  history.inspect(incident.evidence, incident.from, incident.to);
  expect(history.view(snapshot(500, []))!.totals.writes).toBe(15);
  monitor.review(incident.id);
  expect(monitor.pending()).toBe(false);
  monitor.sample(snapshot(8, [7, 8, 0, 0, 0, 0, 0, 9, 9]), config);
  monitor.sample(snapshot(9, [7, 8, 0, 0, 0, 0, 0, 9, 9]), config);
  expect(monitor.incidents()).toHaveLength(2);
  expect(monitor.pending()).toBe(true);
});
test('Firestore thresholds use document evidence, not SDK call counts', () => {
  const monitor = createRateThresholdMonitor();
  for (let second = 0; second <= 5; second++) monitor.sample(snapshot(second, [21, 22, 23, 21, 21], 'firestore'), {});
  expect(monitor.incidents()).toHaveLength(1);
  expect(monitor.incidents()[0]).toMatchObject({ operation: 'documentReads', peak: 23 });
});
test('disabled limits and changed settings do not reinterpret past activity', () => {
  const monitor = createRateThresholdMonitor();
  for (let second = 0; second <= 6; second++) monitor.sample(snapshot(second, [9, 9, 9, 9, 9, 9]), { rtdb: { writes: null } });
  monitor.sample(snapshot(7, [9, 9, 9, 9, 9, 9]), {});
  expect(monitor.incidents()).toHaveLength(0);
});
test('long gaps cannot join two incomplete bursts', () => {
  const monitor = createRateThresholdMonitor();
  for (let second = 0; second <= 4; second++) monitor.sample(snapshot(second, [9, 9, 9, 9]), {});
  const later = snapshot(100, []);
  monitor.sample(later, {});
  expect(monitor.incidents()).toHaveLength(0);
});

for (const service of ['rtdb', 'firestore'] as const) {
  test(`${service}: brief dips join bursts; five quiet seconds close the incident`, () => {
    const monitor = createRateThresholdMonitor();
    const quiet = service === 'firestore' ? 20 : 5;
    const values = [30, 30, 30, 30, 30, quiet, quiet, 30, 30, quiet, quiet, quiet, quiet, quiet, 30, 30, 30, 30, 30];
    for (let second = 0; second <= 9; second++) monitor.sample(snapshot(second, values, service), {});
    expect(monitor.incidents()).toHaveLength(1);
    expect(monitor.incidents()[0]).toMatchObject({ from: 0, to: 8, aboveSeconds: 7, recovered: false, aboveRanges: [{ from: 0, to: 4 }, { from: 7, to: 8 }] });
    for (let second = 10; second <= 13; second++) monitor.sample(snapshot(second, values, service), {});
    expect(monitor.incidents()[0]!.recovered).toBe(false);
    monitor.sample(snapshot(14, values, service), {});
    expect(monitor.incidents()[0]!.recovered).toBe(true);
    for (let second = 15; second <= 19; second++) monitor.sample(snapshot(second, values, service), {});
    expect(monitor.incidents()).toHaveLength(2);
    expect(monitor.incidents()[0]).toMatchObject({ from: 14, to: 18, aboveSeconds: 5 });
  });
}
