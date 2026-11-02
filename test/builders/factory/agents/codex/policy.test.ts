// What the forwarder passes on for this adapter, and the limits it reads from a
// response.
import { describe, expect, test } from 'bun:test';
import { checkBody, isForwardedHeader, lineRefusal } from './policy.ts';
import { rateLimitOf } from './rate-limit.ts';

/** The headers the agent sent in the factory's experiment, with made-up values. */
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

describe('lineRefusal', () => {
  test('passes a turn and a compaction, posted with no query', () => {
    expect(lineRefusal('POST', '/backend-api/codex/responses')).toBeUndefined();
    expect(lineRefusal('POST', '/backend-api/codex/responses/compact')).toBeUndefined();
  });

  test('refuses another method, another path, and any query', () => {
    expect(lineRefusal('GET', '/backend-api/codex/responses')).toBe('method');
    expect(lineRefusal('POST', '/backend-api/codex/models')).toBe('path');
    expect(lineRefusal('POST', '/backend-api/wham/usage')).toBe('path');
    expect(lineRefusal('POST', 'https://upstream.example/backend-api/codex/responses')).toBe('path');
    expect(lineRefusal('POST', '/backend-api/codex/responses?x=1')).toBe('query');
  });
});

describe('isForwardedHeader', () => {
  test('passes every header the agent sent, and no credential or cookie', () => {
    const own = new Set(['content-length', 'host']);
    expect(Object.keys(CODEX_HEADERS).filter((name) => !own.has(name)).every(isForwardedHeader)).toBe(true);
    for (const name of ['authorization', 'chatgpt-account-id', 'cookie', 'proxy-authorization']) expect(isForwardedHeader(name)).toBe(false);
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

  /** The agent's tools, as it sent them to a stand-in upstream: namespaces of function and custom tools in an `input` item. */
  const additionalTools = (tools: unknown[]) => ({
    type: 'additional_tools',
    role: 'developer',
    tools: [{ type: 'namespace', name: 'functions', tools: [{ type: 'custom', name: 'exec' }, { type: 'function', name: 'wait' }] }, ...tools],
  });

  test('passes the tools the agent sends, and refuses any other type, at the top or nested in input, including ones it has never seen', () => {
    expect(checkBody(body({ model: 'gpt-6.1-sol', tools: [], input: [additionalTools([{ type: 'local_shell' }])] }), 'gpt-6.1-sol')).toEqual({ ok: true, model: 'gpt-6.1-sol' });
    const nested = { type: 'namespace', name: 'x', tools: [{ type: 'mcp', server_url: 'https://elsewhere.example' }] };
    expect(checkBody(body({ model: 'gpt-6.1-sol', input: [additionalTools([nested, { type: 'hosted_tool_from_next_year' }])] }), 'gpt-6.1-sol')).toEqual({ ok: false, reason: 'server-tool', names: ['mcp', 'hosted_tool_from_next_year'] });
    expect(checkBody(body({ model: 'gpt-6.1-sol', tools: [{ type: 'file_search' }, 'not a tool'] }), 'gpt-6.1-sol')).toEqual({ ok: false, reason: 'server-tool', names: ['file_search', '(not a tool)'] });
  });

  test('passes inline data in input, and refuses a URL the upstream would fetch or a file ID', () => {
    const message = (content: unknown[]) => ({ model: 'gpt-6.1-sol', input: [{ type: 'message', role: 'user', content }] });
    const inline = message([{ type: 'input_text', text: 'see https://example.com' }, { type: 'input_image', image_url: 'data:image/png;base64,AAAA' }, { type: 'input_file', file_url: 'data:text/plain;base64,AAAA' }]);
    expect(checkBody(body(inline), 'gpt-6.1-sol')).toEqual({ ok: true, model: 'gpt-6.1-sol' });
    expect(checkBody(body(message([{ type: 'input_image', image_url: 'https://attacker.example/?d=secret' }])), 'gpt-6.1-sol')).toEqual({ ok: false, reason: 'remote-input', names: ['image_url'] });
    expect(checkBody(body(message([{ type: 'input_file', file_url: 'https://attacker.example/f' }, { type: 'input_file', file_id: 'file-1' }])), 'gpt-6.1-sol')).toEqual({ ok: false, reason: 'remote-input', names: ['file_url', 'file_id'] });
    expect(checkBody(body(message([{ type: 'input_image', image_url: { url: 'https://attacker.example' } }])), 'gpt-6.1-sol')).toMatchObject({ ok: false, reason: 'remote-input' });
  });
});

describe('rateLimitOf', () => {
  const NOW = new Date('2026-11-02T00:00:00Z');
  const WINDOWS = { 'x-codex-primary-used-percent': '98', 'x-codex-primary-reset-at': '1793790664', 'x-codex-secondary-used-percent': '0' };

  test('reads the windows from every response, and no limit from a 200', () => {
    expect(rateLimitOf(200, WINDOWS, '', NOW)).toEqual({ limitReached: false, resetAt: null, usedPercent: { primary: 98, secondary: 0 } });
  });

  test('takes the reset a 429’s usage_limit_reached names', () => {
    const error = JSON.stringify({ error: { type: 'usage_limit_reached', message: 'Rate limit reached', resets_at: 1793790664 } });
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
