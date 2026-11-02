// What the Codex forwarder passes on, and the limits it reads from a
// response.
import { describe, expect, test } from 'bun:test';
import { checkBody, droppedHeaderNames, forwardedHeaders, lineRefusal } from './codex-policy.ts';
import { rateLimitOf } from './codex-rate-limit.ts';

/** The headers Codex 0.164 sent in the factory's experiment, with made-up values. */
const CODEX_HEADERS = {
  accept: 'text/event-stream',
  'content-type': 'application/json',
  'content-length': '10',
  host: '127.0.0.1:4321',
  originator: 'codex_exec',
  'session-id': 's',
  'thread-id': 't',
  'user-agent': 'codex_exec/0.164.0',
  'x-client-request-id': 'r',
  'x-codex-beta-features': 'b',
  'x-codex-turn-metadata': 'm',
  'x-codex-window-id': 'w',
  'x-openai-internal-codex-responses-lite': '1',
};

const LOGIN = { accessToken: 'made-up-access', accountId: 'made-up-account' };

describe('lineRefusal', () => {
  test('passes a turn and a compaction, posted with no query', () => {
    expect(lineRefusal('POST', '/backend-api/codex/responses')).toBeUndefined();
    expect(lineRefusal('POST', '/backend-api/codex/responses/compact')).toBeUndefined();
  });

  test('refuses another method, another path, and any query', () => {
    expect(lineRefusal('GET', '/backend-api/codex/responses')).toBe('method');
    expect(lineRefusal('POST', '/backend-api/codex/models')).toBe('path');
    expect(lineRefusal('POST', '/backend-api/wham/usage')).toBe('path');
    expect(lineRefusal('POST', 'https://chatgpt.com/backend-api/codex/responses')).toBe('path');
    expect(lineRefusal('POST', '/backend-api/codex/responses?x=1')).toBe('query');
  });
});

describe('headers', () => {
  test('sends on every header Codex sent, then the login, which nothing Codex sent replaces', () => {
    const headers = forwardedHeaders({ ...CODEX_HEADERS, authorization: 'Bearer from-the-sandbox', 'chatgpt-account-id': 'from-the-sandbox', cookie: 'c' }, LOGIN, 99);
    expect(headers.authorization).toBe('Bearer made-up-access');
    expect(headers['chatgpt-account-id']).toBe('made-up-account');
    expect(headers.host).toBe('chatgpt.com');
    expect(headers['content-length']).toBe('99');
    expect(headers.originator).toBe('codex_exec');
    expect(headers['x-openai-internal-codex-responses-lite']).toBe('1');
    expect(headers.cookie).toBeUndefined();
  });

  test('names what it drops, never a value', () => {
    expect(droppedHeaderNames(CODEX_HEADERS)).toEqual([]);
    expect(droppedHeaderNames({ ...CODEX_HEADERS, authorization: 'Bearer made-up', cookie: 'c' })).toEqual(['authorization', 'cookie']);
  });
});

describe('checkBody', () => {
  const body = (value: unknown) => Buffer.from(JSON.stringify(value));

  test('passes a request for the session’s model with function tools', () => {
    expect(checkBody(body({ model: 'gpt-6.1-sol', tools: [{ type: 'function', name: 'shell' }] }), 'gpt-6.1-sol')).toEqual({ ok: true, model: 'gpt-6.1-sol' });
  });

  test('refuses another model, a server-side tool, and a body that is not a request', () => {
    expect(checkBody(body({ model: 'gpt-6-astra' }), 'gpt-6.1-sol')).toEqual({ ok: false, reason: 'other-model', names: ['gpt-6-astra'] });
    expect(checkBody(body({ model: 'gpt-6.1-sol', tools: [{ type: 'web_search_preview' }, { type: 'image_generation' }] }), 'gpt-6.1-sol')).toEqual({ ok: false, reason: 'server-tool', names: ['web_search_preview', 'image_generation'] });
    expect(checkBody(Buffer.from('{ not json'), 'gpt-6.1-sol')).toMatchObject({ ok: false, reason: 'body-not-json' });
    expect(checkBody(body([1]), 'gpt-6.1-sol')).toMatchObject({ ok: false, reason: 'body-not-json' });
  });
});

describe('rateLimitOf', () => {
  const NOW = new Date('2026-11-02T00:00:00Z');
  const WINDOWS = { 'x-codex-primary-used-percent': '98', 'x-codex-primary-reset-at': '1793790664', 'x-codex-secondary-used-percent': '0' };

  test('reads the windows from every response, and no limit from a 200', () => {
    expect(rateLimitOf(200, WINDOWS, '', NOW)).toEqual({ limitReached: false, resetAt: null, primaryUsedPercent: 98, secondaryUsedPercent: 0 });
  });

  test('takes the reset a 429’s usage_limit_reached names', () => {
    const error = JSON.stringify({ error: { type: 'usage_limit_reached', message: 'The usage limit has been reached', plan_type: 'pro', resets_at: 1793790664 } });
    expect(rateLimitOf(429, WINDOWS, error, NOW)).toMatchObject({ limitReached: true, resetAt: '2026-11-04T11:11:04.000Z' });
  });

  test('counts resets_in_seconds from now when there is no resets_at', () => {
    const error = JSON.stringify({ error: { type: 'usage_limit_reached', resets_in_seconds: 3600 } });
    expect(rateLimitOf(429, {}, error, NOW).resetAt).toBe('2026-11-02T01:00:00.000Z');
  });

  test('falls back to the latest reset of a full window, and to no reset when none is full', () => {
    const full = { 'x-codex-primary-used-percent': '100', 'x-codex-primary-reset-at': '1793790664', 'x-codex-secondary-used-percent': '100', 'x-codex-secondary-reset-at': '1793800000' };
    expect(rateLimitOf(429, full, 'not json', NOW).resetAt).toBe(new Date(1793800000 * 1000).toISOString());
    expect(rateLimitOf(429, WINDOWS, '', NOW)).toMatchObject({ limitReached: true, resetAt: null });
  });
});
