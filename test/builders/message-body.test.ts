import { describe, expect, test } from 'bun:test';
import { checkMessageBody, COUNT_TOKENS_PATH, MEDIA_ALLOWANCE_TOKENS } from './message-body.ts';
import { worstCaseUsd } from './model-prices.ts';
import { MAX_DEPTH, nestsDeeperThan, parseStrictJson } from './strict-json.ts';

const MESSAGES = '/v1/messages';
const body = (value: unknown) => Buffer.from(JSON.stringify(value));
const request = (fields: Record<string, unknown> = {}) => ({ model: 'claude-haiku-5-5', max_tokens: 1000, messages: [{ role: 'user', content: 'hi' }], ...fields });
const check = (fields: Record<string, unknown>) => checkMessageBody(MESSAGES, body(request(fields)));
const raw = (text: string) => checkMessageBody(MESSAGES, Buffer.from(text));

describe('parseStrictJson', () => {
  test('refuses a key repeated at any depth, compared decoded, and keeps keys of sibling objects apart', () => {
    expect(parseStrictJson('{"a":1,"a":2}')).toEqual({ kind: 'duplicate-key', key: 'a' });
    expect(parseStrictJson('{"x":[{"b":{"c":1,"c":2}}]}')).toEqual({ kind: 'duplicate-key', key: 'c' });
    expect(parseStrictJson('{"max":1,"m\\u0061x":2}')).toEqual({ kind: 'duplicate-key', key: 'max' });
    expect(parseStrictJson('{"a":{"k":1},"b":{"k":1},"s":"a\\"a:","t":["a","a"]}')).toMatchObject({ kind: 'value' });
    expect(parseStrictJson('{"a":')).toEqual({ kind: 'malformed' });
  });

  test('refuses nesting past 64 levels before parsing, and doesn’t count brackets inside strings', () => {
    const nested = (depth: number) => `${'['.repeat(depth)}${']'.repeat(depth)}`;
    expect(parseStrictJson(nested(MAX_DEPTH))).toMatchObject({ kind: 'value' });
    expect(parseStrictJson(nested(MAX_DEPTH + 1))).toEqual({ kind: 'too-deep' });
    expect(parseStrictJson(nested(100_000))).toEqual({ kind: 'too-deep' });
    expect(nestsDeeperThan(`["${'['.repeat(100)}\\"${'{'.repeat(100)}"]`, 2)).toBe(false);
  });
});

describe('checkMessageBody allows', () => {
  test('the fields Claude Code sends, client tools and client blocks, and reserves the worst case from the body’s size and max_tokens', () => {
    const fields = {
      system: [{ type: 'text', text: 'you build apps', cache_control: { type: 'ephemeral', ttl: '1h' } }],
      tools: [{ name: 'Bash', description: 'run', input_schema: { type: 'object' } }],
      tool_choice: { type: 'auto' }, thinking: { type: 'adaptive' }, output_config: { effort: 'high' }, metadata: { user_id: 'u' },
      stream: true, temperature: 1, stop_sequences: ['x'], service_tier: 'standard_only',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'hi' }] },
        { role: 'assistant', content: [{ type: 'thinking', thinking: 't', signature: 's' }, { type: 'tool_use', id: 't1', name: 'Bash', input: { type: 'anything' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'ok' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA==' } }] }] },
        { role: 'user', content: [{ type: 'document', source: { type: 'text', media_type: 'text/plain', data: 'notes' } }] },
      ],
    };
    const sent = body(request(fields));
    const extra = (MEDIA_ALLOWANCE_TOKENS.image ?? 0) + (MEDIA_ALLOWANCE_TOKENS.document ?? 0);
    expect(checkMessageBody(MESSAGES, sent)).toEqual({
      kind: 'allowed', model: 'claude-haiku-5-5', modifiers: { speed: undefined, usOnly: false },
      reservedUsd: worstCaseUsd(sent.length + extra, 'claude-haiku-5-5', 1000),
    });
  });

  test('fast mode and US-only inference at their higher rates', () => {
    const sent = body(request({ model: 'claude-opus-5-5', max_tokens: 10, speed: 'fast', inference_geo: 'us' }));
    expect(checkMessageBody(MESSAGES, sent)).toMatchObject({ kind: 'allowed', reservedUsd: worstCaseUsd(sent.length, 'claude-opus-5-5', 10, { speed: 'fast', usOnly: true }) });
  });

  test('a token count with no max_tokens, reserving nothing', () => {
    expect(checkMessageBody(COUNT_TOKENS_PATH, body({ model: 'claude-haiku-5-5', messages: [] }))).toMatchObject({ kind: 'allowed', reservedUsd: 0 });
  });

  test('long text counted a token per byte, never under a token per character', () => {
    const long = '漢'.repeat(100_000);
    const checked = check({ system: [{ type: 'text', text: long }], messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: long }] }] });
    expect(checked.kind === 'allowed' && checked.reservedUsd).toBeGreaterThan(worstCaseUsd(200_000, 'claude-haiku-5-5', 1000));
  });
});

describe('checkMessageBody refuses', () => {
  // The re-review's probes of 927347aab, each now expecting refusal.
  const refusals: Array<[string, Buffer, string, number, string[]]> = [
    ['a body that is not JSON', Buffer.from('not json'), 'body-not-json', 400, []],
    ['a JSON array', body([]), 'body-not-json', 400, []],
    ['max_tokens given twice', Buffer.from('{"model":"claude-haiku-5-5","max_tokens":128000,"max_tokens":1,"messages":[]}'), 'duplicate-key', 400, ['max_tokens']],
    ['tools given twice', Buffer.from('{"model":"claude-haiku-5-5","max_tokens":1,"tools":[{"type":"web_fetch_20260209","name":"web_fetch"}],"tools":[],"messages":[]}'), 'duplicate-key', 400, ['tools']],
    ['model given twice', Buffer.from('{"model":"claude-fable-5-1","model":"claude-haiku-5-5","max_tokens":1000,"messages":[]}'), 'duplicate-key', 400, ['model']],
    ['a key repeated inside a block', Buffer.from('{"model":"m","max_tokens":1,"messages":[{"role":"user","content":[{"type":"text","type":"image","text":"x"}]}]}'), 'duplicate-key', 400, ['type']],
    ['MCP servers', body(request({ mcp_servers: [{ type: 'url', url: 'https://example.com/mcp', name: 'x' }] })), 'field', 400, ['mcp_servers']],
    ['MCP servers in another case', body(request({ MCP_Servers: [] })), 'field', 400, ['MCP_Servers']],
    ['fallbacks to a dearer model', body(request({ model: 'claude-sonnet-5-5', fallbacks: [{ model: 'claude-fable-5-1' }] })), 'field', 400, ['fallbacks']],
    ['server-side compaction', body(request({ context_management: { edits: [{ type: 'compact_20260112' }] } })), 'field', 400, ['context_management']],
    ['a container', body(request({ container: { skills: [{ type: 'anthropic', skill_id: 'pdf' }] } })), 'field', 400, ['container']],
    ['diagnostics', body(request({ diagnostics: null })), 'field', 400, ['diagnostics']],
    ['service_tier auto, which may run at priority prices', body(request({ service_tier: 'auto' })), 'service-tier', 403, ['service_tier=auto']],
    ['an image from a URL', body(request({ messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'url', url: 'https://firebasestorage.googleapis.com/x.png' } }] }] })), 'source', 403, ['messages[0].content[0].source.type=url']],
    ['a document from a URL', body(request({ messages: [{ role: 'user', content: [{ type: 'text', text: 'a' }, { type: 'document', source: { type: 'url', url: 'https://firestore.googleapis.com/big.pdf' } }] }] })), 'source', 403, ['messages[0].content[1].source.type=url']],
    ['a document from a file', body(request({ messages: [{ role: 'user', content: [{ type: 'document', source: { type: 'file', file_id: 'file_011' } }] }] })), 'source', 403, ['messages[0].content[0].source.type=file']],
    ['a document with nested content', body(request({ messages: [{ role: 'user', content: [{ type: 'document', source: { type: 'content', content: [] } }] }] })), 'source', 403, ['messages[0].content[0].source.type=content']],
    ['an image from a file inside a tool result', body(request({ messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: [{ type: 'image', source: { type: 'file', file_id: 'f' } }] }] }] })), 'source', 403, ['messages[0].content[0].content[0].source.type=file']],
    ['an image with no source', body(request({ messages: [{ role: 'user', content: [{ type: 'image' }] }] })), 'source', 403, ['messages[0].content[0].source.type=undefined']],
    ['a body nested 100,000 deep', Buffer.from(`{"max_tokens":1,"messages":${'['.repeat(100_000)}${']'.repeat(100_000)}}`), 'too-deep', 400, []],
    ['an image inside a search result', body(request({ messages: [{ role: 'user', content: [{ type: 'search_result', source: 's', title: 't', content: [{ type: 'text', text: 'a' }, { type: 'image', source: { type: 'url', url: 'https://x' } }] }] }] })), 'block', 403, ['messages[0].content[0].content[1].type=image']],
    ['a search result inside a tool result with a non-text block', body(request({ messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: [{ type: 'search_result', source: 's', title: 't', content: [{ type: 'document', source: { type: 'base64' } }] }] }] }] })), 'block', 403, ['messages[0].content[0].content[0].content[0].type=document']],
    ['a container upload', body(request({ messages: [{ role: 'user', content: [{ type: 'container_upload', file_id: 'f' }] }] })), 'block', 403, ['messages[0].content[0].type=container_upload']],
    ['a server tool result', body(request({ messages: [{ role: 'assistant', content: [{ type: 'web_fetch_tool_result', tool_use_id: 't', content: {} }] }] })), 'block', 403, ['messages[0].content[0].type=web_fetch_tool_result']],
    ['an unknown block in the system prompt', body(request({ system: [{ type: 'document', source: { type: 'url', url: 'https://x' } }] })), 'block', 403, ['system[0].type=document']],
    ['no max_tokens', body({ model: 'claude-haiku-5-5', messages: [] }), 'max-tokens', 400, []],
    ['a max_tokens that is a string', body(request({ max_tokens: '1000' })), 'max-tokens', 400, []],
    ['a max_tokens that is a fraction', body(request({ max_tokens: 1.5 })), 'max-tokens', 400, []],
    ['a max_tokens of zero', body(request({ max_tokens: 0 })), 'max-tokens', 400, []],
    ['web search and code execution', body(request({ tools: [{ type: 'web_search_20260209', name: 'web_search' }, { name: 'Bash', input_schema: {} }, { type: 'code_execution_20250825', name: 'code_execution' }] })), 'server-tool', 400, ['web_search_20260209', 'code_execution_20250825']],
    ['the advisor tool', body(request({ tools: [{ type: 'advisor_20260301', name: 'advisor' }] })), 'server-tool', 400, ['advisor_20260301']],
  ];

  for (const [what, sent, reason, status, names] of refusals) {
    test(what, () => {
      expect(checkMessageBody(MESSAGES, sent)).toMatchObject({ kind: 'refused', reason, status, names });
    });
  }

  test('a server tool in a token count', () => {
    expect(checkMessageBody(COUNT_TOKENS_PATH, body({ tools: [{ type: 'web_fetch_20260209', name: 'web_fetch' }] }))).toMatchObject({ kind: 'refused', reason: 'server-tool' });
  });

  test('a field with the API’s wording, which claude retries on without context_management', () => {
    const refused = check({ context_management: {} });
    expect(refused.kind === 'refused' && refused.message).toBe('context_management: Extra inputs are not permitted');
  });

  test('a server tool named after Input tag, the wording claude retries on without its advisor', () => {
    const refused = check({ tools: [{ type: 'advisor_20260301', name: 'advisor' }] });
    expect(refused.kind === 'refused' && refused.message).toContain("Input tag 'advisor_20260301'");
  });

});

describe('checkMessageBody leaves to the meter', () => {
  test('a max_tokens of 1.0, read as 1, and one of 1e300, reserved too high for any cap', () => {
    expect(raw('{"model":"claude-haiku-5-5","max_tokens":1.0,"messages":[]}').kind).toBe('allowed');
    const huge = check({ max_tokens: 1e300 });
    expect(huge.kind === 'allowed' && huge.reservedUsd).toBeGreaterThan(1e290);
  });
});
