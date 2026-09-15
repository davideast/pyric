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
