import { describe, expect, test } from 'bun:test';
import type { SandboxEvent } from 'pyric/sandbox';
import { createSdkRates, observedCallEvent, type SdkRateSnapshot, type SdkServiceRate } from 'pyric/sandbox/internal';
import type { ObservedCall } from 'pyric/sandbox/internal';
import { liveRates } from '../../../src/serve/runtime/live-rates.js';
import { workerAiRates } from '../../../src/serve/runtime/worker-ai-rates.js';
import { chipRequestFromEvent, hostAiRequests, sandboxAiRequests, type ChipRequest } from '../../../src/serve/runtime/chip-traffic.js';
import { createRateHistory } from '../../../src/serve/runtime/rate-history.js';
import { createRateThresholdMonitor } from '../../../src/serve/runtime/rate-threshold-monitor.js';

/** Wall clock and monotonic clock one fixed offset apart, as in a page. */
function clockAt(wall: number) {
  const offset = 1_000_000;
  const clock = { at: wall, now: () => clock.at, monotonicNow: () => clock.at - offset };
  return clock;
}

function observed(call: Partial<ObservedCall> & Pick<ObservedCall, 'service' | 'method' | 'at'>): SandboxEvent {
  return observedCallEvent({ outcome: { status: 'ok' }, ...call } as ObservedCall);
}

function service(snapshot: SdkRateSnapshot, name: string): SdkServiceRate {
  const found = snapshot.services.find(entry => entry.service === name);
  if (!found) throw new Error(`no ${name} service`);
  return found;
}

function calls(rate: SdkServiceRate, method: string): number {
  return rate.methods.find(entry => entry.method === method)?.buckets.reduce((sum, bucket) => sum + bucket.calls, 0) ?? 0;
}

function deliveries(rate: SdkServiceRate, method: string): number {
  return rate.methods.find(entry => entry.method === method)?.buckets.reduce((sum, bucket) => sum + bucket.deliveries, 0) ?? 0;
}

function usageTotal(rate: SdkServiceRate, key: 'documentReads' | 'documentWrites' | 'payloadBytes' | 'uploadedBytes' | 'downloadedBytes' | 'unmeasured'): number {
  return (rate.usageBuckets ?? []).reduce((sum, bucket) => sum + (bucket[key] ?? 0), 0);
}

const base = 1_700_000_000_000;
const pageSnapshot = (clock: ReturnType<typeof clockAt>) => createSdkRates({ monotonicNow: clock.monotonicNow }).snapshot();

describe('live Rates read observed calls from the host', () => {
  test('each service counts its calls, documents and bytes from production.usage', () => {
    const clock = clockAt(base + 2000);
    const events = [
      observed({ service: 'firestore', method: 'getDocs', path: 'rooms', at: base, durationMs: 20, usage: { documentReads: 3, payloadBytes: 120 } }),
      observed({ service: 'firestore', method: 'getDoc', path: 'rooms/a', at: base + 100, usage: { documentReads: 1 } }),
      observed({ service: 'firestore', method: 'setDoc', path: 'rooms/b', at: base + 200, usage: { documentWrites: 1 } }),
      observed({ service: 'rtdb', method: 'get', path: '/items', instance: 'p-default-rtdb', at: base + 300, usage: { payloadBytes: 40 } }),
      observed({ service: 'storage', method: 'uploadBytes', path: 'u/a.txt', bucket: 'p.firebasestorage.app', at: base + 400, usage: { uploadedBytes: 500 } }),
      observed({ service: 'storage', method: 'getBytes', path: 'u/a.txt', bucket: 'p.firebasestorage.app', at: base + 500, usage: { downloadedBytes: 500 } }),
    ];
    const snapshot = liveRates(events, clock)(pageSnapshot(clock));

    const firestore = service(snapshot, 'firestore');
    expect(calls(firestore, 'getDocs')).toBe(1);
    expect(calls(firestore, 'getDoc')).toBe(1);
    expect(calls(firestore, 'setDoc')).toBe(1);
    expect(deliveries(firestore, 'getDocs')).toBe(1);
    expect(usageTotal(firestore, 'documentReads')).toBe(4);
    expect(usageTotal(firestore, 'documentWrites')).toBe(1);
    expect(usageTotal(firestore, 'payloadBytes')).toBe(120);
    expect(firestore.usage?.documentReads).toBeCloseTo(4 / snapshot.windowSeconds);

    const rtdb = service(snapshot, 'rtdb');
    expect(calls(rtdb, 'get')).toBe(1);
    expect(usageTotal(rtdb, 'payloadBytes')).toBe(40);

    const storage = service(snapshot, 'storage');
    expect(calls(storage, 'uploadBytes')).toBe(1);
    expect(calls(storage, 'getBytes')).toBe(1);
    expect(usageTotal(storage, 'uploadedBytes')).toBe(500);
    expect(usageTotal(storage, 'downloadedBytes')).toBe(500);
  });

  test("a live writeBatch call counts as the batch commit's writes", () => {
    const clock = clockAt(base + 2000);
    const events = [
      observed({ service: 'firestore', method: 'writeBatch', at: base, durationMs: 15, usage: { documentWrites: 2, documentDeletes: 1 } }),
    ];
    const firestore = service(liveRates(events, clock)(pageSnapshot(clock)), 'firestore');
    expect(calls(firestore, 'writeBatch.commit')).toBe(1);
    expect(usageTotal(firestore, 'documentWrites')).toBe(2);
    expect((firestore.usageBuckets ?? []).reduce((sum, bucket) => sum + bucket.documentDeletes, 0)).toBe(1);
  });

  test('an observed one-shot replaces the page journal for Firestore, RTDB and Storage', () => {
    const clock = clockAt(base + 1000);
    const page = createSdkRates({ monotonicNow: clock.monotonicNow });
    page.record({ sequence: 1, id: 'p/start', activityId: 'p', appId: 'a', sourceId: 's', service: 'firestore', method: 'getDoc',
      kind: 'operation', phase: 'start', status: 'pending', at: base, monotonicAt: clock.monotonicNow() - 500, deliveryNumber: 0 });
    const snapshot = liveRates([observed({ service: 'firestore', method: 'getDocs', path: 'rooms', at: base, usage: { documentReads: 2 } })], clock)(page.snapshot());
    const firestore = service(snapshot, 'firestore');
    expect(calls(firestore, 'getDoc')).toBe(0);
    expect(calls(firestore, 'getDocs')).toBe(1);
  });

  test('usage {} reads as missing: a billed call with no sizes counts as unmeasured', () => {
    const clock = clockAt(base + 1000);
    const snapshot = liveRates([
      observed({ service: 'firestore', method: 'getDocs', path: 'rooms', at: base, usage: {} }),
      observed({ service: 'firestore', method: 'getDoc', path: 'rooms/a', at: base + 10 }),
    ], clock)(pageSnapshot(clock));
    const firestore = service(snapshot, 'firestore');
    expect(usageTotal(firestore, 'documentReads')).toBe(0);
    expect(usageTotal(firestore, 'unmeasured')).toBe(2);
  });

  test('a listener delivery counts its billed documents, and a metadata-only one counts none', () => {
    const clock = clockAt(base + 1000);
    const snapshot = liveRates([
      observed({ service: 'firestore', method: 'onSnapshot', path: 'rooms', at: base, billedDocuments: 2 }),
      observed({ service: 'firestore', method: 'onSnapshot', path: 'rooms', at: base + 50, billedDocuments: 0 }),
      observed({ service: 'rtdb', method: 'onValue', path: '/items', instance: 'p-default-rtdb', at: base + 60, usage: { payloadBytes: 9 } }),
    ], clock)(pageSnapshot(clock));
    const firestore = service(snapshot, 'firestore');
    expect(deliveries(firestore, 'onSnapshot')).toBe(2);
    expect(usageTotal(firestore, 'documentReads')).toBe(2);
    const rtdb = service(snapshot, 'rtdb');
    expect(deliveries(rtdb, 'onValue')).toBe(1);
    expect(usageTotal(rtdb, 'payloadBytes')).toBe(9);
  });

  test('a failed call counts as a call with no usage; sandbox events and repeats are left out', () => {
    const clock = clockAt(base + 1000);
    const failed = observed({ service: 'firestore', method: 'getDoc', path: 'rooms/a', at: base, outcome: { status: 'error', code: 'permission-denied' } });
    const sandbox = { ...observed({ service: 'firestore', method: 'getDocs', path: 'rooms', at: base, usage: { documentReads: 5 } }), production: undefined, rulesDisposition: { kind: 'evaluated', verdict: 'allow' } } as unknown as SandboxEvent;
    const snapshot = liveRates([failed, failed, sandbox], clock)(pageSnapshot(clock));
    const firestore = service(snapshot, 'firestore');
    expect(calls(firestore, 'getDoc')).toBe(1);
    expect(calls(firestore, 'getDocs')).toBe(0);
    expect(usageTotal(firestore, 'documentReads')).toBe(0);
    expect(usageTotal(firestore, 'unmeasured')).toBe(0);
  });

  test("an AI call counts once, through its tokens, never through production.usage", () => {
    const clock = clockAt(base + 2000);
    const event = observed({ service: 'ai', method: 'generateContent', at: base, durationMs: 300,
      ai: { model: 'models/gemini-test', usage: { promptTokenCount: 12, candidatesTokenCount: 30, totalTokenCount: 42 } } });
    const withUsage = { ...event, production: { ...(event as { production: object }).production, usage: { documentReads: 7 } } } as unknown as SandboxEvent;
    const rows = [chipRequestFromEvent(withUsage)].filter((row): row is ChipRequest => row !== null);
    expect(sandboxAiRequests(rows)).toHaveLength(0);
    const ai = hostAiRequests(rows);
    expect(ai).toHaveLength(1);
    const snapshot = workerAiRates(ai)(liveRates([withUsage], clock)(pageSnapshot(clock)));
    const rate = service(snapshot, 'ai');
    expect(rate.aiRequests).toHaveLength(1);
    expect(rate.history?.methods.find(method => method.method === 'generateContent')?.buckets.reduce((sum, bucket) => sum + bucket.calls, 0)).toBe(1);
    expect(rate.history?.usageBuckets?.reduce((sum, bucket) => sum + (bucket.aiInputTokens ?? 0), 0)).toBe(12);
    for (const name of ['firestore', 'rtdb', 'storage']) expect(usageTotal(service(snapshot, name), 'documentReads')).toBe(0);
  });

  test('rate history reads the overlay: a frame totals production document reads', () => {
    const clock = clockAt(base + 3000);
    const events = [0, 1, 2].map(second => observed({ service: 'firestore', method: 'getDocs', path: 'rooms', at: base + second * 1000, usage: { documentReads: 3 } }));
    const history = createRateHistory('firestore');
    const snapshot = liveRates(events, clock)(pageSnapshot(clock));
    history.open(snapshot);
    history.pause(snapshot);
    const frame = history.view(snapshot);
    expect(frame?.totals.reads).toBe(9);
  });

  test('a Firestore read rate above a configured limit raises a threshold incident', () => {
    const monitor = createRateThresholdMonitor();
    const config = { sustainedSeconds: 2, firestore: { documentReads: 10 } };
    const events: SandboxEvent[] = [];
    for (let second = 0; second < 5; second++) {
      events.push(observed({ service: 'firestore', method: 'getDocs', path: 'rooms', at: base + second * 1000 + 100, usage: { documentReads: 25 } }));
      const clock = clockAt(base + second * 1000 + 500);
      monitor.sample(liveRates(events, clock)(pageSnapshot(clock)), config);
    }
    const incidents = monitor.incidents();
    expect(incidents).toHaveLength(1);
    expect(incidents[0]).toMatchObject({ service: 'firestore', operation: 'documentReads', limit: 10, peak: 25 });
  });
});
