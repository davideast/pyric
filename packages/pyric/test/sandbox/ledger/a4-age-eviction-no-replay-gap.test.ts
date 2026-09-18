/**
 * Ledger A4: an age bound on observation history must not turn a long
 * session into an unreplayable one. Events older than the window may leave
 * retained history, but their absence must not be reported as a
 * `history-limit` gap that makes replay and verify refuse the history.
 */
import { describe, expect, it } from 'bun:test';
import { EventHistory } from '../../../src/sandbox/internal/event-history.js';
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

describe('ledger A4: age eviction does not produce a replay-refusing gap', () => {
  it('history older than the age window still replays', () => {
    const history = new EventHistory({ maxEvents: 1_000, maxBytes: 1_000_000, maxAgeMs: 1_000 });
    const stale = Date.now() - 60_000;
    for (let index = 0; index < 20; index++) history.append(request(index, stale + index));
    history.append(request(99, Date.now()));
    const events = history.snapshot();
    const gaps = events.filter((event) => event.kind === 'observation_gap' && event.reason === 'history-limit');
    expect(gaps).toHaveLength(0);
    expect(() => replay(events, OPEN_RULES)).not.toThrow('Cannot replay or verify incomplete observation history');
  });
});
