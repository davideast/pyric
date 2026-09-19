/**
 * Ledger I1 and I13: live state (pending observations and attached listeners)
 * reserves capacity but must never consume the entire history budget. Once
 * live state alone reaches the limits, retained events must not be evicted
 * on every append, and `omittedCount` must count only events that are
 * actually missing from the snapshot.
 */
import { describe, expect, it } from 'bun:test';
import { EventHistory } from '../../../src/sandbox/internal/event-history.js';
import type { ListenerLifecycleEvent, RequestEvent, SandboxEvent } from '../../../src/sandbox/types/events.js';

function request(index: number): RequestEvent {
  return {
    kind: 'request', id: `request-${index}`, at: 1_000 + index, evalMs: 0,
    method: 'get', path: `notes/${index}`, auth: null, result: 'allow',
    reasons: [], origin: 'user',
  };
}

function pending(index: number): SandboxEvent {
  return {
    kind: 'operation', id: `pending-${index}`, at: 2_000 + index, service: 'ai', method: 'generateContent',
    path: 'synthetic', auth: null, origin: 'user', result: 'not-applicable',
    observation: { id: `observation-${index}`, startedAt: 2_000 + index, status: 'pending' },
  } as SandboxEvent;
}

function attach(index: number): ListenerLifecycleEvent {
  return {
    kind: 'listener_attach', id: `attach-${index}`, at: 3_000 + index, listenerId: `listener-${index}`,
    target: { kind: 'doc', path: `notes/${index}` }, auth: null,
  };
}

function idsOf(events: SandboxEvent[]): Set<string> {
  return new Set(events.filter((event) => event.kind !== 'observation_gap').map((event) => event.id));
}

describe('ledger I1: live state cannot evict retained history', () => {
  it('pending observations beyond the reserve do not evict retained requests', () => {
    const history = new EventHistory({ maxEvents: 10, maxBytes: 1_000_000 });
    for (let index = 0; index < 5; index++) history.append(request(index));
    for (let index = 0; index < 12; index++) history.append(pending(index));
    const retained = idsOf(history.snapshot());
    for (let index = 0; index < 5; index++) expect(retained.has(`request-${index}`)).toBe(true);
  });

  it('a request appended after many live listeners is retained', () => {
    const history = new EventHistory({ maxEvents: 10, maxBytes: 1_000_000 });
    for (let index = 0; index < 12; index++) history.append(attach(index));
    history.append(request(0));
    expect(idsOf(history.snapshot()).has('request-0')).toBe(true);
  });

  it('omittedCount counts only events missing from the snapshot', () => {
    const history = new EventHistory({ maxEvents: 10, maxBytes: 1_000_000 });
    const appended: string[] = [];
    for (let index = 0; index < 12; index++) { history.append(attach(index)); appended.push(`attach-${index}`); }
    history.append(request(0)); appended.push('request-0');
    const events = history.snapshot();
    const present = idsOf(events);
    const missing = appended.filter((id) => !present.has(id));
    const gap = events.find((event) => event.kind === 'observation_gap');
    const omitted = gap && gap.kind === 'observation_gap' ? gap.omittedCount : 0;
    expect(omitted).toBe(missing.length);
  });
});
