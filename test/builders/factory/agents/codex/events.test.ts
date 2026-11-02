// What the agent's output says about how a session ended, from event
// streams in the agent's shape: the success recorded in the factory's
// experiment, and the rate-limit and retry failures in the messages the
// agent prints.
import { describe, expect, test } from 'bun:test';
import { codexAgent } from './adapter.ts';
import { parseEvents, reportsUsageLimit } from './events.ts';

/** The stream the experiment's real call printed. */
const SUCCESS = [
  '{"type":"thread.started","thread_id":"01a19a0f-d5a8-7263-bc17-1eeaf535196f"}',
  '{"type":"turn.started"}',
  '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"pong"}}',
  '{"type":"turn.completed","usage":{"input_tokens":10849,"cached_input_tokens":9088,"cache_write_input_tokens":0,"output_tokens":5,"reasoning_output_tokens":0}}',
].join('\n');

const LIMIT_MESSAGE = 'You\'ve hit your usage limit. Try again at Nov 4th, 2026 3:11 AM.';

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

describe('parseEvents', () => {
  test('reads each event line and leaves out what is not one', () => {
    const events = parseEvents(`${SUCCESS}\nnot json\n{"no":"type"}\n`);
    expect(events.map((event) => event.type)).toEqual(['thread.started', 'turn.started', 'item.completed', 'turn.completed']);
  });
});

describe('reportsUsageLimit', () => {
  test('sees the rate-limit message and a 429 the agent gave up on, not a success or a network wait', () => {
    expect(reportsUsageLimit(parseEvents(USAGE_LIMIT))).toBe(true);
    expect(reportsUsageLimit(parseEvents(RETRIES_EXHAUSTED))).toBe(true);
    expect(reportsUsageLimit(parseEvents(SUCCESS))).toBe(false);
    expect(reportsUsageLimit(parseEvents(NETWORK_DOWN))).toBe(false);
  });
});

describe('the adapter', () => {
  test('reads a rate limit from the agent’s output as it was saved', () => {
    expect(codexAgent.reportsRateLimit(`${USAGE_LIMIT}\n`)).toBe(true);
    expect(codexAgent.reportsRateLimit(NETWORK_DOWN)).toBe(false);
  });
});
