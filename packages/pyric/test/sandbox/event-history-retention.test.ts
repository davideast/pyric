import { expect, test } from 'bun:test';
import { EventHistory } from '../../src/sandbox/internal/event-history.js';
import type { RequestEvent, SandboxListenerEvent } from '../../src/sandbox/types/events.js';

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

test('age retains observations and only capacity eviction creates a gap', () => {
  const history = new EventHistory({ maxEvents: 2, maxBytes: 100_000 });
  const attach = { kind: 'listener_attach', id: 'attach', at: 0, listenerId: 'listener',
    target: { kind: 'doc', path: 'notes/a' }, auth: null } as const;
  history.append(attach);
  history.append(request(1));
  const events = history.snapshot();
  expect(events).toEqual([attach, request(1)]);
  const detach = { ...attach, kind: 'listener_detach', id: 'detach', at: Date.now() } as const;
  history.append(detach);
  const retained = history.snapshot();
  expect(retained[0]).toMatchObject({ kind: 'observation_gap', omittedCount: 1 });
  expect(retained.slice(1)).toEqual([request(1), detach]);
});

test('old observations survive snapshots without another append', () => {
  const history = new EventHistory({ maxEvents: 10, maxBytes: 100_000 });
  const event = { ...request(1), observedAt: Date.now() - 60_000 };
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


test('live listener registrations share the history count budget without disappearing', () => {
  const history = new EventHistory({ maxEvents: 3, maxBytes: 100_000 });
  const attach = { kind: 'listener_attach', id: 'attach', at: 0, listenerId: 'listener',
    target: { kind: 'doc', path: 'notes/a' }, auth: null } as const;
  history.append(attach);
  for (let index = 1; index <= 5; index++) history.append(request(index));
  const events = history.snapshot();
  expect(events).toHaveLength(4);
  expect(events[0]).toMatchObject({ kind: 'observation_gap', omittedCount: 3 });
  expect(events.slice(1)).toEqual([request(4), request(5), attach]);
  history.append({ ...attach, kind: 'listener_detach', id: 'detach', at: 6 });
  expect(history.snapshot().map(event => event.id)).toEqual(['history-gap', '4', '5', 'detach']);
  expect(history.snapshot()[0]).toMatchObject({ kind: 'observation_gap', omittedCount: 4 });
});


test('a new pending request reserves history capacity until it settles', () => {
  const history = new EventHistory({ maxEvents: 3, maxBytes: 100_000 });
  for (let index = 1; index <= 3; index++) history.append(request(index));
  const pending = { kind: 'operation', id: 'start', at: 4, service: 'ai', method: 'generateContent',
    path: 'synthetic', auth: null, origin: 'user', result: 'not-applicable',
    observation: { id: 'request', startedAt: 4, status: 'pending' } } as const;
  history.append(pending);
  history.append(pending);
  expect(history.snapshot()).toHaveLength(4);
  expect(history.snapshot()[0]).toMatchObject({ kind: 'observation_gap', omittedCount: 1 });
  expect(history.snapshot().slice(1)).toEqual([request(2), request(3), pending]);
  const completed = { ...pending, id: 'end', observation: { ...pending.observation, status: 'completed' as const } };
  history.append(completed);
  expect(history.snapshot().slice(1)).toEqual([request(2), request(3), completed]);
});


test('live state shares the encoded byte budget in browser and Node runtimes', () => {
  const buffer = Object.getOwnPropertyDescriptor(globalThis, 'Buffer');
  function fill(): string {
    const history = new EventHistory({ maxEvents: 100, maxBytes: 1_200 });
    const attach = { kind: 'listener_attach', id: 'attach', at: 0, listenerId: 'listener',
      target: { kind: 'doc', path: `notes/${'é'.repeat(250)}` }, auth: null } as const;
    history.append(attach);
    for (let index = 1; index <= 8; index++) history.append(request(index));
    const events = history.snapshot();
    expect(new TextEncoder().encode(JSON.stringify(events)).length).toBeLessThanOrEqual(1_200);
    expect(events).toContainEqual(attach);
    expect(events).toContainEqual(request(8));
    expect(events[0]).toMatchObject({ kind: 'observation_gap', omittedCount: 7 });
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


test('pending bytes reserve at most half the budget in browser and Node runtimes', () => {
  const buffer = Object.getOwnPropertyDescriptor(globalThis, 'Buffer');
  function fill(): string {
    const history = new EventHistory({ maxEvents: 100, maxBytes: 2_000 });
    history.append(request(1));
    history.append(request(2));
    const pending = { kind: 'operation', id: 'start', at: 3, service: 'ai', method: 'generateContent',
      path: 'large'.repeat(1_000), auth: null, origin: 'user', result: 'not-applicable',
      observation: { id: 'large-request', startedAt: 3, status: 'pending' } } as const;
    history.append(pending);
    expect(history.snapshot()).toEqual([request(1), request(2), pending]);
    history.append(request(3));
    expect(history.snapshot()).toContainEqual(request(3));
    return JSON.stringify(history.snapshot());
  }
  const node = fill();
  try {
    Reflect.deleteProperty(globalThis, 'Buffer');
    expect(fill()).toBe(node);
  } finally {
    if (buffer !== undefined) Object.defineProperty(globalThis, 'Buffer', buffer);
  }
});

test('replacing and closing a live-only listener counts each missing attach once', () => {
  const history = new EventHistory({ maxEvents: 3, maxBytes: 100_000 });
  const attach = { kind: 'listener', phase: 'attach', service: 'database', id: 'attach', at: 0,
    listenerId: 'listener', target: { kind: 'value', path: '/presence' }, auth: null } as const satisfies SandboxListenerEvent;
  history.append(attach);
  for (let index = 1; index <= 3; index++) history.append(request(index));
  expect(history.snapshot()[0]).toMatchObject({ kind: 'observation_gap', omittedCount: 1 });
  history.append({ ...attach, id: 'replacement', at: 4 });
  expect(history.snapshot().some(event => event.id === 'attach')).toBe(false);
  expect(history.snapshot()[0]).toMatchObject({ kind: 'observation_gap', omittedCount: 2 });
  for (let index = 5; index <= 7; index++) history.append(request(index));
  expect(history.snapshot()[0]).toMatchObject({ kind: 'observation_gap', omittedCount: 5 });
  const errored = { ...attach, phase: 'errored', id: 'errored', at: 8 } as const;
  history.append(errored);
  history.append(errored);
  expect(history.snapshot().slice(1)).toEqual([request(6), request(7), errored]);
  expect(history.snapshot()[0]).toMatchObject({ kind: 'observation_gap', omittedCount: 6 });
  history.clear();
  history.append(request(9));
  expect(history.snapshot()).toEqual([request(9)]);
});
