import { expect, test } from 'bun:test';
import { buildRateCapture, readRateCapture, readSessionFixture } from '../../../src/serve/runtime/rate-capture.js';
import type { HistoryFrame } from '../../../src/serve/runtime/rate-history.js';
const counts = { reads: 0, writes: 4, deletes: 0, deliveries: 0 };
const frame: HistoryFrame = { service: { service: 'rtdb', coverage: 'partial', observed: true, untrackedMethods: [], methods: [] }, points: [{ second: 10, ...counts }], from: 10, to: 10, duration: 1, clockOffset: 1000, paused: true, totals: counts, peaks: counts };
test('capture round trip preserves measurements and labels current state separately from replay', () => {
  const capture = buildRateCapture(frame, { rtdb: { writes: 2 } }, [], { schema: 'pyric.verify.fixture.v1' });
  expect(capture.replay.available).toBe(false);
  expect(capture.sessionFixture?.scope).toContain('not the starting state');
  const imported = readRateCapture(JSON.stringify(capture));
  expect(imported.frame.totals.writes).toBe(4);
  expect(imported.thresholds.rtdb?.writes).toBe(2);
});
test('invalid ranges and non-capture JSON cannot enter the chart', () => {
  const capture = buildRateCapture(frame, {}, []);
  expect(() => readRateCapture('{}')).toThrow();
  expect(() => readRateCapture(JSON.stringify({ ...capture, frame: { ...frame, to: 9 } }))).toThrow();
  expect(() => readRateCapture(JSON.stringify({ ...capture, frame: { ...frame, points: [] } }))).toThrow();
});
test('capture endpoint uses the existing session token and missing capture stays explicit', async () => {
  const requests: RequestInit[] = [];
  const fetcher = (async (_url: unknown, init?: RequestInit) => {
    requests.push(init ?? {});
    return requests.length === 1 ? Response.json({ sessionToken: 'test-token' }) : new Response('', { status: 404 });
  }) as typeof fetch;
  expect(await readSessionFixture(fetcher)).toBeNull();
  expect(requests[1]!.headers).toEqual({ 'x-pyric-session-token': 'test-token' });
});

test('portable captures carry the same service measurement definitions used by the UI', () => {
  const rtdb = buildRateCapture(frame, {}, []);
  expect(rtdb.measurement.scope).toBe('This page');
  expect(rtdb.measurement.bucketSeconds).toBe(1);
  expect(rtdb.measurement.average).toContain('idle seconds');
  expect(rtdb.measurement.notes.find(note => note.label === 'Operations')?.text).toContain('including failed attempts');
  expect(rtdb.measurement.notes.find(note => note.label === 'Billing limit')?.text).toContain('not billed download size');
  const firestore = buildRateCapture({ ...frame, service: { ...frame.service, service: 'firestore' } }, {}, []);
  expect(firestore.measurement.notes.find(note => note.label === 'Includes')?.text).toContain('successful writes');
  expect(firestore.measurement.notes.find(note => note.label === 'Not measured')?.text).toContain('Index scans');
});
