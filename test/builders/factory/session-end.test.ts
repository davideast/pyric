// How a session ended, from the harness's stop, the exit, what the agent's
// output says, and this session's lines of the forwarder's record.
import { describe, expect, test } from 'bun:test';
import { latestReset, sessionEnd, type SessionFacts } from './session-end.ts';
import type { UpstreamEvent } from './upstream-forwarder.ts';

function line(fields: Partial<UpstreamEvent>): UpstreamEvent {
  return {
    time: '2026-11-02T00:00:00.000Z', layer: 'agent-upstream', kind: 'request', via: 'forwarder', method: 'POST', path: '/v1/responses',
    action: 'forwarded', reason: null, status: 200, model: 'm', rateLimit: null, refusedNames: [], droppedHeaders: [], ...fields,
  };
}

const LIMITED = line({ status: 429, rateLimit: { limitReached: true, resetAt: '2026-11-04T11:11:04.000Z', usedPercent: { primary: 100 } } });
const OK = line({ rateLimit: { limitReached: false, resetAt: null, usedPercent: { primary: 98 } } });

function facts(overrides: Partial<SessionFacts>): SessionFacts {
  return { stoppedBy: null, code: 0, signal: null, reportsRateLimit: false, channel: [], ...overrides };
}

describe('sessionEnd', () => {
  test('a session that exits is ended by its exit, whatever its code', () => {
    expect(sessionEnd(facts({ channel: [OK] }))).toEqual({ endedBy: 'exit' });
    expect(sessionEnd(facts({ code: 1 }))).toEqual({ endedBy: 'exit' });
  });

  test('out of usage, it ends by the rate limit, with the reset the forwarder recorded', () => {
    expect(sessionEnd(facts({ code: 1, reportsRateLimit: true, channel: [OK, LIMITED] }))).toEqual({ endedBy: 'rate-limit', resetAt: '2026-11-04T11:11:04.000Z' });
  });

  test('a rate limit with no recorded reset has no resetAt', () => {
    expect(sessionEnd(facts({ code: 1, reportsRateLimit: true }))).toEqual({ endedBy: 'rate-limit' });
  });

  test('a successful session is never rate-limited, whatever its output says', () => {
    expect(sessionEnd(facts({ code: 0, reportsRateLimit: true, channel: [LIMITED] }))).toEqual({ endedBy: 'exit' });
  });

  test('a failed session whose last request came back 429 is rate-limited even when the agent said nothing', () => {
    expect(sessionEnd(facts({ code: 1, channel: [LIMITED] }))).toEqual({ endedBy: 'rate-limit', resetAt: '2026-11-04T11:11:04.000Z' });
    expect(sessionEnd(facts({ code: 1, channel: [LIMITED, OK] }))).toEqual({ endedBy: 'exit' });
  });

  test('the harness’s own stop wins, and a signal no one sent is a kill', () => {
    expect(sessionEnd(facts({ stoppedBy: 'deadline', code: null, signal: 'SIGTERM', reportsRateLimit: true, channel: [LIMITED] }))).toEqual({ endedBy: 'deadline' });
    expect(sessionEnd(facts({ stoppedBy: 'killed', code: 143 }))).toEqual({ endedBy: 'killed' });
    expect(sessionEnd(facts({ code: null, signal: 'SIGKILL' }))).toEqual({ endedBy: 'killed' });
  });

  test('latestReset takes the last 429’s reset', () => {
    const earlier = line({ status: 429, rateLimit: { limitReached: true, resetAt: '2026-11-03T00:00:00.000Z', usedPercent: {} } });
    expect(latestReset([earlier, OK, LIMITED])).toBe('2026-11-04T11:11:04.000Z');
    expect(latestReset([OK])).toBeUndefined();
  });
});
