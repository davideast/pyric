/**
 * Tests for the Claude lane handler — OpenAI shape ↔ `@inbrowser/model`
 * `ModelEvent` mapping with a stubbed Agent-SDK client. No subprocess,
 * no SDK, no network.
 */
import { describe, test, expect } from 'bun:test';
import type { ModelClient, ModelEvent, ModelRequest } from '@inbrowser/model';
import {
  CLAUDE_LANE_MODELS,
  handleClaudeLaneRequest,
  toModelMessages,
  type ClaudeLaneClientFactory,
} from './claude-lane';

function makeRequest(body: unknown): Request {
  return new Request('http://localhost/api/claude-lane/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** A fake `ModelClient` that replays a fixed `ModelEvent` script and
 *  (optionally) captures the `ModelRequest` + the model id it was built
 *  for — the `claudeCodeModelClient` seam, without spawning the SDK. */
function stubClient(
  events: ModelEvent[],
  capture?: { req?: ModelRequest; model?: string },
  model = 'claude-haiku-4-5-20251001',
): ModelClient {
  return {
    id: `claude-code:${model}`,
    supportsTools: false,
    async *chat(req) {
      if (capture) capture.req = req;
      for (const e of events) yield e;
    },
  };
}

const stubFactory =
  (events: ModelEvent[], capture?: { req?: ModelRequest; model?: string }): ClaudeLaneClientFactory =>
  (model) => {
    if (capture) capture.model = model;
    return stubClient(events, capture, model);
  };

const okOpts = (events: ModelEvent[], capture?: { req?: ModelRequest; model?: string }) => ({
  enabled: true,
  createClient: stubFactory(events, capture),
});

const HAPPY_BODY = {
  model: 'claude-haiku-4-5-20251001',
  stream: true,
  messages: [{ role: 'user', content: 'hi' }],
};

/** Parse an SSE body into its `data:` payload strings. */
async function readSse(res: Response): Promise<string[]> {
  const text = await res.text();
  return text
    .split('\n\n')
    .map((block) => block.trim())
    .filter((block) => block.startsWith('data: '))
    .map((block) => block.slice('data: '.length));
}

describe('handleClaudeLaneRequest — guards', () => {
  test('404s when disabled (non-dev build)', async () => {
    const res = await handleClaudeLaneRequest(makeRequest(HAPPY_BODY), {
      enabled: false,
      createClient: stubFactory([]),
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe('lane_disabled');
  });

  test('rejects tool-bearing requests — the Agent-SDK provider has no tool surface', async () => {
    const res = await handleClaudeLaneRequest(
      makeRequest({
        ...HAPPY_BODY,
        tools: [{ type: 'function', function: { name: 'writeRules', parameters: {} } }],
      }),
      okOpts([]),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.type).toBe('invalid_request_error');
    expect(body.error.code).toBe('tools_unsupported');
    expect(body.error.message).toContain('bare-model');
    expect(body.error.message).toContain('Draft → Validate');
  });

  test('legacy `functions` also triggers the tools rejection', async () => {
    const res = await handleClaudeLaneRequest(
      makeRequest({ ...HAPPY_BODY, functions: [{ name: 'f' }] }),
      okOpts([]),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('tools_unsupported');
  });

  test('rejects models outside the four-model allowlist', async () => {
    const res = await handleClaudeLaneRequest(
      makeRequest({ ...HAPPY_BODY, model: 'claude-2.1' }),
      okOpts([]),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('model_not_supported');
    for (const id of CLAUDE_LANE_MODELS) {
      expect(body.error.message).toContain(id);
    }
  });

  test('requires stream: true', async () => {
    const res = await handleClaudeLaneRequest(
      makeRequest({ ...HAPPY_BODY, stream: false }),
      okOpts([]),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('stream_required');
  });

  test('requires at least one user message', async () => {
    const res = await handleClaudeLaneRequest(
      makeRequest({ ...HAPPY_BODY, messages: [{ role: 'system', content: 'be terse' }] }),
      okOpts([]),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('no_user_message');
  });
});

describe('handleClaudeLaneRequest — streaming', () => {
  test('happy path: text + thinking deltas, terminal usage (no cost — subscription)', async () => {
    const capture: { req?: ModelRequest; model?: string } = {};
    const res = await handleClaudeLaneRequest(
      makeRequest({ ...HAPPY_BODY, reasoning_effort: 'medium' }),
      okOpts(
        [
          { kind: 'thinking', text: 'pondering…' },
          { kind: 'text', text: 'Hello' },
          { kind: 'text', text: ' world' },
          {
            kind: 'usage',
            usage: { promptTokens: 11, outputTokens: 7, cachedTokens: 4 },
          },
        ],
        capture,
      ),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/event-stream');

    const payloads = await readSse(res);
    expect(payloads.at(-1)).toBe('[DONE]');
    const chunks = payloads.slice(0, -1).map((p) => JSON.parse(p));

    expect(chunks[0].object).toBe('chat.completion.chunk');
    expect(chunks[0].choices[0].delta.reasoning_content).toBe('pondering…');
    expect(chunks[1].choices[0].delta.content).toBe('Hello');
    expect(chunks[2].choices[0].delta.content).toBe(' world');

    const final = chunks.at(-1);
    expect(final.choices[0].finish_reason).toBe('stop');
    // prompt_tokens = input + cache reads (the Anthropic SDK reports them
    // disjoint; the OpenAI/OpenRouter shape wants the whole prompt). No
    // `cost` — the Agent-SDK provider draws from the subscription.
    expect(final.usage).toEqual({
      prompt_tokens: 15,
      completion_tokens: 7,
      total_tokens: 22,
      prompt_tokens_details: { cached_tokens: 4 },
    });

    // ModelRequest mapping: tools-free, effort, model passed to factory.
    expect(capture.model).toBe('claude-haiku-4-5-20251001');
    expect(capture.req?.tools).toEqual([]);
    expect(capture.req?.toolUseEnabled).toBe(false);
    expect(capture.req?.reasoningEffort).toBe('medium');
    expect(capture.req?.messages).toEqual([{ role: 'user', text: 'hi' }]);
  });

  test('cache-aware usage: a fully-cached prompt does NOT report tokensIn≈0', async () => {
    // The user-found failure shape (trace t-mq9msa9m-xcgt): a ~12k
    // prompt landed in Anthropic's cache, the SDK reported
    // input_tokens=2. With cache reads folded in, prompt_tokens reflects
    // the whole prompt.
    const res = await handleClaudeLaneRequest(
      makeRequest(HAPPY_BODY),
      okOpts([
        { kind: 'text', text: 'ok' },
        { kind: 'usage', usage: { promptTokens: 2, outputTokens: 50, cachedTokens: 11900 } },
      ]),
    );
    const payloads = await readSse(res);
    const final = JSON.parse(payloads.at(-2)!);
    expect(final.usage.prompt_tokens).toBe(11902);
    expect(final.usage.prompt_tokens_details.cached_tokens).toBe(11900);
    expect(final.usage.total_tokens).toBe(11952);
  });

  test('usage without cachedTokens passes through unchanged (no detail field)', async () => {
    const res = await handleClaudeLaneRequest(
      makeRequest(HAPPY_BODY),
      okOpts([
        { kind: 'text', text: 'ok' },
        { kind: 'usage', usage: { promptTokens: 9, outputTokens: 3 } },
      ]),
    );
    const payloads = await readSse(res);
    const final = JSON.parse(payloads.at(-2)!);
    expect(final.usage).toEqual({ prompt_tokens: 9, completion_tokens: 3, total_tokens: 12 });
  });

  test('a costUsd, when a provider reports one, passes through as `cost`', async () => {
    const res = await handleClaudeLaneRequest(
      makeRequest(HAPPY_BODY),
      okOpts([
        { kind: 'text', text: 'ok' },
        { kind: 'usage', usage: { promptTokens: 9, outputTokens: 3, costUsd: 0.002 } },
      ]),
    );
    const payloads = await readSse(res);
    const final = JSON.parse(payloads.at(-2)!);
    expect(final.usage.cost).toBe(0.002);
  });

  test('provider error event arrives as an in-band SSE error line', async () => {
    const res = await handleClaudeLaneRequest(
      makeRequest(HAPPY_BODY),
      okOpts([
        { kind: 'text', text: 'partial' },
        { kind: 'error', message: 'claude-code: failed to load @anthropic-ai/claude-agent-sdk' },
      ]),
    );
    const payloads = await readSse(res);
    expect(payloads.at(-1)).toBe('[DONE]');
    const chunks = payloads.slice(0, -1).map((p) => JSON.parse(p));
    expect(chunks[0].choices[0].delta.content).toBe('partial');
    expect(chunks.at(-1).error.message).toContain('failed to load');
    expect(chunks.at(-1).error.code).toBe('provider_error');
  });

  test('provider ending without usage still closes with finish_reason stop', async () => {
    const res = await handleClaudeLaneRequest(
      makeRequest(HAPPY_BODY),
      okOpts([{ kind: 'text', text: 'ok' }]),
    );
    const payloads = await readSse(res);
    const chunks = payloads.slice(0, -1).map((p) => JSON.parse(p));
    expect(chunks.at(-1).choices[0].finish_reason).toBe('stop');
    expect(payloads.at(-1)).toBe('[DONE]');
  });

  test('a thrown client error is caught and surfaced in-band', async () => {
    const res = await handleClaudeLaneRequest(makeRequest(HAPPY_BODY), {
      enabled: true,
      createClient: () => ({
        id: 'claude-code:claude-haiku-4-5-20251001',
        supportsTools: false,
        // eslint-disable-next-line require-yield
        async *chat(): AsyncIterable<ModelEvent> {
          throw new Error('SDK exploded');
        },
      }),
    });
    const payloads = await readSse(res);
    const chunks = payloads.slice(0, -1).map((p) => JSON.parse(p));
    expect(chunks.at(-1).error.message).toContain('SDK exploded');
    expect(payloads.at(-1)).toBe('[DONE]');
  });

  test('an `error` event from the client (SDK/login unavailable) is surfaced, not swallowed', async () => {
    const res = await handleClaudeLaneRequest(
      makeRequest(HAPPY_BODY),
      okOpts([
        {
          kind: 'error',
          message: 'claude-code SDK reported error: not logged in to Claude Code',
        },
      ]),
    );
    const payloads = await readSse(res);
    const chunks = payloads.slice(0, -1).map((p) => JSON.parse(p));
    expect(chunks.at(-1).error.message).toContain('not logged in');
    expect(chunks.at(-1).error.code).toBe('provider_error');
    expect(payloads.at(-1)).toBe('[DONE]');
  });
});

describe('toModelMessages', () => {
  test('maps multi-turn history including assistant tool calls and tool results', () => {
    const out = toModelMessages([
      { role: 'system', content: 'be terse' },
      { role: 'user', content: [{ type: 'text', text: 'part a. ' }, { type: 'text', text: 'part b' }] },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'c1', function: { name: 'runOnce', arguments: '{"x":1}' } }],
      },
      { role: 'tool', tool_call_id: 'c1', name: 'runOnce', content: '{"ok":true}' },
      { role: 'user', content: 'and now?' },
    ]);
    expect(out).toEqual([
      { role: 'system', text: 'be terse' },
      { role: 'user', text: 'part a. part b' },
      { role: 'assistant', text: '', toolCalls: [{ id: 'c1', name: 'runOnce', args: { x: 1 } }] },
      { role: 'tool', toolCallId: 'c1', name: 'runOnce', resultJson: '{"ok":true}' },
      { role: 'user', text: 'and now?' },
    ]);
  });

  test('tolerates malformed tool-call argument JSON', () => {
    const out = toModelMessages([
      {
        role: 'assistant',
        content: 'x',
        tool_calls: [{ id: 'c2', function: { name: 'f', arguments: '{nope' } }],
      },
    ]);
    expect(out[0]).toEqual({
      role: 'assistant',
      text: 'x',
      toolCalls: [{ id: 'c2', name: 'f', args: { _raw: '{nope' } }],
    });
  });
});
