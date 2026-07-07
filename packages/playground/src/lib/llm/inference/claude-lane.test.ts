/**
 * Tests for the Claude lane page-direct transport — OpenAI SSE →
 * `InferenceEvent` mapping. Mocks global fetch; no network.
 */
import { describe, test, expect, afterEach } from 'bun:test';
import { claudeLaneProvider, CLAUDE_LANE_PATH } from './claude-lane';
import type { NormalizedRequest } from '@inbrowser/relay';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function sseResponse(payloads: string[]): Response {
  const body = payloads.map((p) => `data: ${p}\n\n`).join('');
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

function baseReq(overrides: Partial<NormalizedRequest> = {}): NormalizedRequest {
  return {
    provider: 'claude',
    model: 'claude-fable-5',
    messages: [{ role: 'user', text: 'hi' }],
    tools: [],
    toolUseEnabled: false,
    apiKey: '',
    ...overrides,
  };
}

async function collect(req: NormalizedRequest) {
  const events = [];
  for await (const evt of claudeLaneProvider(req)) events.push(evt);
  return events;
}

describe('claudeLaneProvider', () => {
  test('maps deltas, reasoning_content, and usage (incl. cost) to events', async () => {
    const captured: { url?: string; body?: any } = {};
    globalThis.fetch = (async (url: unknown, init: { body: string }) => {
      captured.url = String(url);
      captured.body = JSON.parse(init.body);
      return sseResponse([
        JSON.stringify({ choices: [{ delta: { reasoning_content: 'mull' }, finish_reason: null }] }),
        JSON.stringify({ choices: [{ delta: { content: 'Hey' }, finish_reason: null }] }),
        JSON.stringify({
          choices: [{ delta: {}, finish_reason: 'stop' }],
          usage: {
            prompt_tokens: 9,
            completion_tokens: 3,
            total_tokens: 12,
            prompt_tokens_details: { cached_tokens: 2 },
            cost: 0.004,
          },
        }),
        '[DONE]',
      ]);
    }) as typeof fetch;

    const events = await collect(baseReq({ reasoningEffort: 'high' }));
    expect(captured.url).toBe(CLAUDE_LANE_PATH);
    expect(captured.body.model).toBe('claude-fable-5');
    expect(captured.body.stream).toBe(true);
    expect(captured.body.reasoning_effort).toBe('high');
    expect(captured.body.tools).toBeUndefined();

    expect(events).toEqual([
      { kind: 'thinking', chunk: 'mull' },
      { kind: 'text', chunk: 'Hey' },
      { kind: 'usage', promptTokens: 9, outputTokens: 3, cachedTokens: 2, costUsd: 0.004 },
    ]);
  });

  test("effort 'off' omits reasoning_effort", async () => {
    const captured: { body?: any } = {};
    globalThis.fetch = (async (_url: unknown, init: { body: string }) => {
      captured.body = JSON.parse(init.body);
      return sseResponse(['[DONE]']);
    }) as typeof fetch;
    await collect(baseReq({ reasoningEffort: 'off' }));
    expect(captured.body.reasoning_effort).toBeUndefined();
  });

  test('forwards tools (never drops them) so the route can reject', async () => {
    const captured: { body?: any } = {};
    globalThis.fetch = (async (_url: unknown, init: { body: string }) => {
      captured.body = JSON.parse(init.body);
      return new Response(
        JSON.stringify({
          error: {
            message: 'The Claude (local CLI) lane is text-only…',
            type: 'invalid_request_error',
            code: 'tools_unsupported',
          },
        }),
        { status: 400, headers: { 'Content-Type': 'application/json' } },
      );
    }) as typeof fetch;

    const events = await collect(
      baseReq({
        tools: [
          { type: 'function', function: { name: 'writeRules', description: 'd', parameters: { type: 'object' } } },
        ],
      }),
    );
    expect(captured.body.tools).toHaveLength(1);
    expect(events).toEqual([
      { kind: 'error', message: 'The Claude (local CLI) lane is text-only…' },
    ]);
  });

  test('in-band SSE error line becomes a terminal error event', async () => {
    globalThis.fetch = (async () =>
      sseResponse([
        JSON.stringify({ choices: [{ delta: { content: 'part' }, finish_reason: null }] }),
        JSON.stringify({ error: { message: 'claude -p timed out', code: 'provider_error' } }),
        '[DONE]',
      ])) as unknown as typeof fetch;

    const events = await collect(baseReq());
    expect(events).toEqual([
      { kind: 'text', chunk: 'part' },
      { kind: 'error', message: 'claude -p timed out' },
    ]);
  });
});
