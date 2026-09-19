/**
 * Ledger A4: elapsed time must not turn a long session into an unreplayable
 * one. The shared observation policy that served sandboxes use bounds history
 * by count and bytes only. Events far older than any former age window stay
 * retained under that policy, no `history-limit` gap is reported for them,
 * and replay accepts the history.
 */
import { describe, expect, it } from 'bun:test';
import { EventHistory } from '../../../src/sandbox/internal/event-history.js';
import { OBSERVATION_HISTORY_LIMITS } from '../../../src/sandbox/internal/observation-history.js';
import { replay } from '../../../src/sandbox/index.js';
import type { RequestEvent } from '../../../src/sandbox/types/events.js';

const OPEN_RULES = 'service cloud.firestore { match /{path=**} { allow read, write: if true; } }';

function request(index: number, at: number): RequestEvent {
  return {
    kind: 'request', id: `old-${index}`, at, evalMs: 0,
    method: 'get', path: `notes/${index}`, auth: null, result: 'allow',
    reasons: [], origin: 'user',
  };
}

describe('ledger A4: the shared observation policy has no age bound', () => {
  it('the policy bounds by count and bytes only', () => {
    expect(Object.keys(OBSERVATION_HISTORY_LIMITS).sort()).toEqual(['maxBytes', 'maxEvents']);
  });

  it('history far older than any age window still replays under the shared policy', () => {
    const history = new EventHistory(OBSERVATION_HISTORY_LIMITS);
    const stale = Date.now() - 2 * 60 * 60_000;
    for (let index = 0; index < 20; index++) history.append(request(index, stale + index));
    history.append(request(99, Date.now()));
    const events = history.snapshot();
    const gaps = events.filter((event) => event.kind === 'observation_gap' && event.reason === 'history-limit');
    expect(gaps).toHaveLength(0);
    expect(events.filter((event) => event.kind === 'request')).toHaveLength(21);
    expect(() => replay(events, OPEN_RULES)).not.toThrow('Cannot replay or verify incomplete observation history');
  });
});
