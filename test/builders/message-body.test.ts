import { describe, expect, test } from 'bun:test';
import { checkMessageBody, COUNT_TOKENS_PATH, MEDIA_ALLOWANCE_TOKENS } from './message-body.ts';
import { worstCaseUsd } from './model-prices.ts';

const MESSAGES = '/v1/messages';
const body = (value: unknown) => Buffer.from(JSON.stringify(value));

describe('checkMessageBody', () => {
  test('allows client tools and reserves the worst case from the body’s size and max_tokens', () => {
    const request = body({ model: 'claude-sonnet-5-5', max_tokens: 32_000, tools: [{ name: 'Bash', description: 'run', input_schema: { type: 'object' } }], messages: [] });
    expect(checkMessageBody(MESSAGES, request)).toEqual({
      kind: 'allowed', model: 'claude-sonnet-5-5', modifiers: { speed: undefined, usOnly: false },
      reservedUsd: worstCaseUsd(request.length, 'claude-sonnet-5-5', 32_000),
    });
  });

  test('reserves fast mode and US-only inference at their higher rates, and adds an allowance per image or document', () => {
    const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA==' } };
    const request = body({ model: 'claude-opus-5-5', max_tokens: 10, speed: 'fast', inference_geo: 'us', messages: [{ role: 'user', content: [image, { type: 'tool_result', content: [image] }] }] });
    const check = checkMessageBody(MESSAGES, request);
    const extra = 2 * (MEDIA_ALLOWANCE_TOKENS.image ?? 0);
    expect(check).toMatchObject({ kind: 'allowed', reservedUsd: worstCaseUsd(request.length + extra, 'claude-opus-5-5', 10, { speed: 'fast', usOnly: true }) });
  });

  test('reserves nothing for a token count, which needs no max_tokens', () => {
    expect(checkMessageBody(COUNT_TOKENS_PATH, body({ model: 'claude-haiku-5-5', messages: [] }))).toMatchObject({ kind: 'allowed', reservedUsd: 0 });
  });

  const refusals: Array<[string, Buffer, string, number, string[]]> = [
    ['a body that is not JSON', Buffer.from('not json'), 'body-not-json', 400, []],
    ['a JSON array', body([]), 'body-not-json', 400, []],
    ['no max_tokens', body({ model: 'claude-haiku-5-5', messages: [] }), 'max-tokens', 400, []],
    ['a max_tokens that is a string', body({ max_tokens: '100', messages: [] }), 'max-tokens', 400, []],
    ['a max_tokens of zero', body({ max_tokens: 0, messages: [] }), 'max-tokens', 400, []],
    ['MCP servers', body({ max_tokens: 1, mcp_servers: [{ type: 'url', url: 'https://example.com/mcp', name: 'x' }] }), 'mcp-servers', 403, []],
    ['web search and code execution', body({ max_tokens: 1, tools: [{ type: 'web_search_20260209', name: 'web_search' }, { name: 'Bash', input_schema: {} }, { type: 'code_execution_20250825', name: 'code_execution' }] }), 'server-tool', 400, ['web_search_20260209', 'code_execution_20250825']],
    ['the advisor tool', body({ max_tokens: 1, tools: [{ type: 'advisor_20260301', name: 'advisor' }] }), 'server-tool', 400, ['advisor_20260301']],
    ['a server tool in a token count', body({ tools: [{ type: 'web_fetch_20260209', name: 'web_fetch' }] }), 'server-tool', 400, ['web_fetch_20260209']],
  ];

  for (const [what, request, reason, status, toolTypes] of refusals) {
    test(`refuses ${what}`, () => {
      const path = what.includes('token count') ? COUNT_TOKENS_PATH : MESSAGES;
      expect(checkMessageBody(path, request)).toMatchObject({ kind: 'refused', reason, status, toolTypes });
    });
  }

  test('names each server tool after Input tag, the wording claude retries on without its advisor', () => {
    const check = checkMessageBody(MESSAGES, body({ max_tokens: 1, tools: [{ type: 'advisor_20260301', name: 'advisor' }] }));
    expect(check.kind === 'refused' && check.message).toContain("Input tag 'advisor_20260301'");
  });
});
