// How a session ended, from event streams in Codex 0.164's shape: the
// success recorded in the factory's experiment, and the usage-limit and
// retry failures in the messages Codex prints for them.
import { describe, expect, test } from 'bun:test';
import { latestReset, parseEvents, reportsUsageLimit, sessionEnd, type SessionFacts } from './codex-events.ts';
import type { CodexChannelEvent } from './codex-forwarder.ts';

/** The stream the experiment's real call printed. */
const SUCCESS = [
  '{"type":"thread.started","thread_id":"01a19a0f-d5a8-7263-bc17-1eeaf535196f"}',
  '{"type":"turn.started"}',
  '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"pong"}}',
  '{"type":"turn.completed","usage":{"input_tokens":10849,"cached_input_tokens":9088,"cache_write_input_tokens":0,"output_tokens":5,"reasoning_output_tokens":0}}',
].join('\n');

const LIMIT_MESSAGE = 'You\'ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/settings/usage to purchase more credits or try again at Nov 4th, 2026 3:11 AM.';

const USAGE_LIMIT = [
  '{"type":"thread.started","thread_id":"t"}',
  '{"type":"turn.started"}',
  JSON.stringify({ type: 'error', message: LIMIT_MESSAGE }),
  JSON.stringify({ type: 'turn.failed', error: { message: LIMIT_MESSAGE } }),
].join('\n');

const RETRIES_EXHAUSTED = [
  '{"type":"turn.started"}',
  JSON.stringify({ type: 'turn.failed', error: { message: 'exceeded retry limit, last status: 429 Too Many Requests' } }),
].join('\n');

const NETWORK_DOWN = [
  '{"type":"turn.started"}',
  '{"type":"error","message":"Reconnecting... waiting for network (Connection failed: error sending request)"}',
].join('\n');

function line(fields: Partial<CodexChannelEvent>): CodexChannelEvent {
  return {
    time: '2026-11-02T00:00:00.000Z', layer: 'codex-channel', kind: 'request', via: 'forwarder', method: 'POST', path: '/backend-api/codex/responses',
    action: 'forwarded', reason: null, status: 200, model: 'gpt-6.1-sol', rateLimit: null, refusedNames: [], droppedHeaders: [], ...fields,
  };
}

const LIMITED = line({ status: 429, rateLimit: { limitReached: true, resetAt: '2026-11-04T11:11:04.000Z', primaryUsedPercent: 100, secondaryUsedPercent: 0 } });
const OK = line({ rateLimit: { limitReached: false, resetAt: null, primaryUsedPercent: 98, secondaryUsedPercent: 0 } });

function facts(overrides: Partial<SessionFacts>): SessionFacts {
  return { stoppedBy: null, code: 0, signal: null, events: [], channel: [], ...overrides };
}

describe('parseEvents', () => {
  test('reads each event line and leaves out what is not one', () => {
    const events = parseEvents(`${SUCCESS}\nnot json\n{"no":"type"}\n`);
    expect(events.map((event) => event.type)).toEqual(['thread.started', 'turn.started', 'item.completed', 'turn.completed']);
  });
});

describe('reportsUsageLimit', () => {
  test('sees the usage-limit message and a 429 Codex gave up on, not a success or a network wait', () => {
    expect(reportsUsageLimit(parseEvents(USAGE_LIMIT))).toBe(true);
    expect(reportsUsageLimit(parseEvents(RETRIES_EXHAUSTED))).toBe(true);
    expect(reportsUsageLimit(parseEvents(SUCCESS))).toBe(false);
    expect(reportsUsageLimit(parseEvents(NETWORK_DOWN))).toBe(false);
  });
});

describe('sessionEnd', () => {
  test('a session that exits is ended by its exit, whatever its code', () => {
    expect(sessionEnd(facts({ events: parseEvents(SUCCESS), channel: [OK] }))).toEqual({ endedBy: 'exit' });
    expect(sessionEnd(facts({ code: 1, events: parseEvents(NETWORK_DOWN) }))).toEqual({ endedBy: 'exit' });
  });

  test('out of usage, it ends by the rate limit, with the reset the forwarder recorded', () => {
    expect(sessionEnd(facts({ code: 1, events: parseEvents(USAGE_LIMIT), channel: [OK, LIMITED] }))).toEqual({ endedBy: 'rate-limit', resetAt: '2026-11-04T11:11:04.000Z' });
  });

  test('a rate limit with no recorded reset has no resetAt', () => {
    expect(sessionEnd(facts({ code: 1, events: parseEvents(RETRIES_EXHAUSTED), channel: [line({ status: 429, rateLimit: { limitReached: true, resetAt: null, primaryUsedPercent: null, secondaryUsedPercent: null } })] }))).toEqual({ endedBy: 'rate-limit' });
  });

  test('a failed session whose last request came back 429 is rate-limited even when Codex said nothing', () => {
    expect(sessionEnd(facts({ code: 1, channel: [LIMITED] }))).toEqual({ endedBy: 'rate-limit', resetAt: '2026-11-04T11:11:04.000Z' });
    expect(sessionEnd(facts({ code: 1, channel: [LIMITED, OK] }))).toEqual({ endedBy: 'exit' });
  });

  test('the harness’s own stop wins, and a signal no one sent is a kill', () => {
    expect(sessionEnd(facts({ stoppedBy: 'deadline', code: null, signal: 'SIGTERM', events: parseEvents(USAGE_LIMIT), channel: [LIMITED] }))).toEqual({ endedBy: 'deadline' });
    expect(sessionEnd(facts({ stoppedBy: 'killed', code: 143 }))).toEqual({ endedBy: 'killed' });
    expect(sessionEnd(facts({ code: null, signal: 'SIGKILL' }))).toEqual({ endedBy: 'killed' });
  });

  test('latestReset takes the last 429’s reset', () => {
    const earlier = line({ status: 429, rateLimit: { limitReached: true, resetAt: '2026-11-03T00:00:00.000Z', primaryUsedPercent: 100, secondaryUsedPercent: 0 } });
    expect(latestReset([earlier, OK, LIMITED])).toBe('2026-11-04T11:11:04.000Z');
    expect(latestReset([OK])).toBeUndefined();
  });
});
