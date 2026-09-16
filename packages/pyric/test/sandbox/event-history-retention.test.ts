import { expect, test } from 'bun:test';
import { EventHistory } from '../../src/sandbox/internal/event-history.js';
import type { RequestEvent } from '../../src/sandbox/types/events.js';

function request(index: number): RequestEvent {
  return {
    kind: 'request', id: String(index), at: index, evalMs: 0,
    method: 'get', path: `notes/${index}`, auth: null, result: 'deny',
    reasons: [], origin: 'user',
    rulesEvidence: { version: 'rules-v1', decision: 'DENY', scope: 'request', truncated: false, rules: [], paths: [] },
  };
}

test('evidence expiry survives earlier history eviction and preserves inspected snapshots', () => {
  const history = new EventHistory({ maxEvents: 70, maxBytes: 100_000 });
  for (let index = 0; index < 70; index++) history.append(request(index));
  const inspected = history.snapshot().find(event => event.id === '69');
  for (let index = 70; index < 160; index++) history.append(request(index));
  const retained = history.snapshot();
  expect(retained[0]).toMatchObject({ kind: 'observation_gap', omittedCount: 90 });
  const requests = retained.filter(event => event.kind === 'request');
  expect(requests.filter(event => event.rulesEvidence !== undefined)).toHaveLength(64);
  expect(requests[0]).toMatchObject({ id: '90', rulesEvidenceExpired: true });
  expect(inspected).toHaveProperty('rulesEvidence');
  history.clear();
  history.append(request(200));
  expect(history.snapshot()).toEqual([request(200)]);
});

test('expired evidence releases its accounted bytes in browser and Node runtimes', () => {
  const buffer = Object.getOwnPropertyDescriptor(globalThis, 'Buffer');
  function fill(): string {
    const history = new EventHistory({ maxEvents: 100, maxBytes: 23_000 });
    for (let index = 0; index < 100; index++) history.append(request(index));
    const events = history.snapshot();
    expect(new TextEncoder().encode(JSON.stringify(events)).length).toBeLessThanOrEqual(23_000);
    expect(events.some(event => event.kind === 'request' && event.rulesEvidenceExpired)).toBe(true);
    return JSON.stringify(events);
  }
  const node = fill();
  try {
    Reflect.deleteProperty(globalThis, 'Buffer');
    expect(fill()).toBe(node);
  } finally {
    if (buffer !== undefined) Object.defineProperty(globalThis, 'Buffer', buffer);
  }
});

test('active requests survive eviction, settle once, and ignore replayed starts', () => {
  const history = new EventHistory({ maxEvents: 2, maxBytes: 100_000 });
  const pending = { kind: 'operation', id: 'start', at: Date.now(), service: 'ai', method: 'generateContent',
    path: 'synthetic', auth: null, origin: 'user', result: 'not-applicable',
    observation: { id: 'request', startedAt: Date.now(), status: 'pending' } } as const;
  history.append(pending);
  for (let index = 0; index < 5; index++) history.append(request(index));
  expect(history.snapshot().some(event => event.id === 'start')).toBe(true);
  const completed = { ...pending, id: 'end', observation: { ...pending.observation, status: 'completed' as const } };
  history.append(completed);
  history.append(pending);
  history.append(completed);
  const ai = history.snapshot().filter(event => event.kind === 'operation');
  expect(ai).toEqual([completed]);
});

test('expiry is visible and active listener registrations remain available', () => {
  const history = new EventHistory({ maxEvents: 2, maxBytes: 100_000, maxAgeMs: 1000 });
  const attach = { kind: 'listener_attach', id: 'attach', at: 0, listenerId: 'listener',
    target: { kind: 'doc', path: 'notes/a' }, auth: null } as const;
  history.append(attach);
  history.append(request(1));
  const events = history.snapshot();
  expect(events[0]).toMatchObject({ kind: 'observation_gap', omittedCount: 2 });
  expect(events).toContainEqual(attach);
  history.append({ ...attach, kind: 'listener_detach', id: 'detach', at: Date.now() });
  expect(history.snapshot()).not.toContainEqual(attach);
});

test('retention uses observation time when the sandbox clock is in the past', () => {
  const history = new EventHistory({ maxEvents: 10, maxBytes: 100_000, maxAgeMs: 1000 });
  const event = { ...request(1), observedAt: Date.now() };
  history.append(event);
  expect(history.snapshot()).toEqual([event]);
});

test('the unified stream stamps wall-clock observation time without changing simulated event time', async () => {
  const { initializeSandbox } = await import('../../src/sandbox/index.js');
  const { emitSandboxEvent, getClock } = await import('../../src/sandbox/internal/index.js');
  const sandbox = initializeSandbox();
  getClock(sandbox).set(0);
  const before = Date.now();
  emitSandboxEvent(sandbox, request(0));
  const event = sandbox.history().find(event => event.id === '0');
  expect(event?.at).toBe(0);
  expect(event?.observedAt).toBeGreaterThanOrEqual(before);
  expect(event?.observedAt).toBeLessThanOrEqual(Date.now());
});
