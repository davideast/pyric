/** Tests for the local OpenAI-compatible client — caching + usage plumbing
 *  (#511), reasoning budget gating + Anthropic thinking round-trip
 *  (sonnet-food session, 2026-06-10). Mocks global fetch; no network. */
import { describe, test, expect, afterEach } from 'bun:test';
import { localOpenAiLlm } from './local-openai-llm';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function mockFetch(captured: { body?: any }) {
  globalThis.fetch = (async (_url: unknown, init: { body: string }) => {
    captured.body = JSON.parse(init.body);
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: 'ok' } }],
        usage: { prompt_tokens: 10, completion_tokens: 2, cost: 0.001, prompt_tokens_details: { cached_tokens: 8 } },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as unknown as typeof fetch;
}

async function drain(llm: ReturnType<typeof localOpenAiLlm>) {
  const out: { kind: string; usage?: { cachedTokens?: number; costUsd?: number; reasoningTokens?: number } }[] = [];
  for await (const e of llm.chat(
    { messages: [{ role: 'system', text: 'SYS' }, { role: 'user', text: 'hi' }], tools: [] } as never,
    new AbortController().signal,
  )) {
    out.push(e as never);
  }
  return out;
}

describe('local OpenAI client — caching (#511)', () => {
  test('cache + apiKey → system message carries a cache_control breakpoint', async () => {
    const cap: { body?: any } = {};
    mockFetch(cap);
    await drain(localOpenAiLlm({ baseUrl: 'https://openrouter.ai/api/v1', model: 'm', apiKey: 'k', cache: true }));
    const sys = cap.body.messages[0];
    expect(Array.isArray(sys.content)).toBe(true);
    expect(sys.content[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(cap.body.usage).toEqual({ include: true }); // also requests real cost
  });

  test('cache off → system message stays a plain string', async () => {
    const cap: { body?: any } = {};
    mockFetch(cap);
    await drain(localOpenAiLlm({ baseUrl: 'https://openrouter.ai/api/v1', model: 'm', apiKey: 'k' }));
    expect(typeof cap.body.messages[0].content).toBe('string');
  });

  test('no apiKey (local) → no cache_control, no usage.include', async () => {
    const cap: { body?: any } = {};
    mockFetch(cap);
    await drain(localOpenAiLlm({ baseUrl: 'http://localhost:11434/v1', model: 'm', cache: true }));
    expect(typeof cap.body.messages[0].content).toBe('string');
    expect(cap.body.usage).toBeUndefined();
  });

  test('cached tokens + cost flow through to usage event', async () => {
    const cap: { body?: any } = {};
    mockFetch(cap);
    const evs = await drain(localOpenAiLlm({ baseUrl: 'https://openrouter.ai/api/v1', model: 'm', apiKey: 'k', cache: true }));
    const usage = evs.find((e) => e.kind === 'usage')!;
    expect(usage.usage!.cachedTokens).toBe(8);
    expect(usage.usage!.costUsd).toBe(0.001);
  });
});

describe('local OpenAI client — reasoning budget (OpenRouter gating)', () => {
  test('openrouter baseUrl → reasoning effort sent, default medium', async () => {
    const cap: { body?: any } = {};
    mockFetch(cap);
    await drain(localOpenAiLlm({ baseUrl: 'https://openrouter.ai/api/v1', model: 'm', apiKey: 'k' }));
    expect(cap.body.reasoning).toEqual({ effort: 'medium' });
  });

  test('explicit effort overrides the default', async () => {
    const cap: { body?: any } = {};
    mockFetch(cap);
    await drain(localOpenAiLlm({ baseUrl: 'https://openrouter.ai/api/v1', model: 'm', apiKey: 'k', reasoningEffort: 'high' }));
    expect(cap.body.reasoning).toEqual({ effort: 'high' });
  });

  test("effort 'off' → explicit disable (omitting ≠ disabling on Anthropic)", async () => {
    const cap: { body?: any } = {};
    mockFetch(cap);
    await drain(localOpenAiLlm({ baseUrl: 'https://openrouter.ai/api/v1', model: 'm', apiKey: 'k', reasoningEffort: 'off' }));
    expect(cap.body.reasoning).toEqual({ enabled: false });
  });

  test('non-openrouter baseUrl → no reasoning field, even when requested', async () => {
    const cap: { body?: any } = {};
    mockFetch(cap);
    await drain(localOpenAiLlm({ baseUrl: 'http://localhost:11434/v1', model: 'm', reasoningEffort: 'high' }));
    expect(cap.body.reasoning).toBeUndefined();
  });

  test('host that 400s on `reasoning` → one retry without the field', async () => {
    const bodies: any[] = [];
    globalThis.fetch = (async (_url: unknown, init: { body: string }) => {
      const body = JSON.parse(init.body);
      bodies.push(body);
      if ('reasoning' in body) {
        return new Response(JSON.stringify({ error: { message: 'Unknown parameter: reasoning' } }), { status: 400 });
      }
      return new Response(
        JSON.stringify({ choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;
    const evs = await drain(localOpenAiLlm({ baseUrl: 'https://openrouter.ai/api/v1', model: 'm', apiKey: 'k' }));
    expect(bodies.length).toBe(2);
    expect('reasoning' in bodies[1]).toBe(false);
    expect(evs.some((e) => e.kind === 'error')).toBe(false);
    expect(evs.some((e) => e.kind === 'text')).toBe(true);
  });

  test('reasoning tokens flow through to usage event', async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: 'ok' } }],
          usage: { prompt_tokens: 10, completion_tokens: 70, completion_tokens_details: { reasoning_tokens: 64 } },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )) as unknown as typeof fetch;
    const evs = await drain(localOpenAiLlm({ baseUrl: 'https://openrouter.ai/api/v1', model: 'm', apiKey: 'k' }));
    const usage = evs.find((e) => e.kind === 'usage')!;
    expect(usage.usage!.reasoningTokens).toBe(64);
  });
});

describe('local OpenAI client — Anthropic thinking round-trip', () => {
  /** Probe-verified shape (claude-haiku-4.5 via OpenRouter, 2026-06-10):
   *  message-level `reasoning_details` with a signed reasoning.text block. */
  const DETAILS = [
    { type: 'reasoning.text', text: 'I should check the price first.', signature: 'sig-abc', format: 'anthropic-claude-v1' },
  ];

  function mockToolCallThenEcho(bodies: any[]) {
    let call = 0;
    globalThis.fetch = (async (_url: unknown, init: { body: string }) => {
      bodies.push(JSON.parse(init.body));
      call += 1;
      if (call === 1) {
        return new Response(
          JSON.stringify({
            choices: [{
              message: {
                content: '',
                reasoning: 'I should check the price first.',
                reasoning_details: DETAILS,
                tool_calls: [{ id: 'toolu_1', function: { name: 'get_price', arguments: '{"itemId":"x"}' } }],
              },
            }],
            usage: { prompt_tokens: 10, completion_tokens: 20 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(
        JSON.stringify({ choices: [{ message: { content: 'done' } }], usage: { prompt_tokens: 12, completion_tokens: 2 } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;
  }

  test('reasoning_details captured per callId and re-attached when the call is echoed', async () => {
    const bodies: any[] = [];
    mockToolCallThenEcho(bodies);
    const llm = localOpenAiLlm({ baseUrl: 'https://openrouter.ai/api/v1', model: 'anthropic/claude-haiku-4.5', apiKey: 'k' });

    // Iteration 0 — model thinks, emits a signed tool call.
    const evs: any[] = [];
    for await (const e of llm.chat(
      { messages: [{ role: 'user', text: 'hi' }], tools: [{ name: 'get_price', description: 'd', parameters: {} }] } as never,
      new AbortController().signal,
    )) evs.push(e);
    expect(evs.some((e) => e.kind === 'thinking')).toBe(true);
    expect(evs.find((e) => e.kind === 'tool_call')!.id).toBe('toolu_1');

    // Iteration 1 — the ReAct loop echoes the assistant turn + tool result.
    for await (const _ of llm.chat(
      {
        messages: [
          { role: 'user', text: 'hi' },
          { role: 'assistant', text: '', toolCalls: [{ callId: 'toolu_1', name: 'get_price', args: { itemId: 'x' } }] },
          { role: 'tool', callId: 'toolu_1', name: 'get_price', resultJson: '{"price":5}' },
        ],
        tools: [],
      } as never,
      new AbortController().signal,
    )) { /* drain */ }

    const echoed = bodies[1].messages.find((m: any) => m.role === 'assistant');
    expect(echoed.reasoning_details).toEqual(DETAILS);
    expect(echoed.tool_calls[0].id).toBe('toolu_1');
  });

  test('assistant turns with no captured thinking get no reasoning_details', async () => {
    const bodies: any[] = [];
    mockToolCallThenEcho(bodies);
    const llm = localOpenAiLlm({ baseUrl: 'https://openrouter.ai/api/v1', model: 'm', apiKey: 'k' });
    for await (const _ of llm.chat(
      {
        messages: [
          { role: 'user', text: 'hi' },
          { role: 'assistant', text: '', toolCalls: [{ callId: 'unknown_call', name: 'f', args: {} }] },
          { role: 'tool', callId: 'unknown_call', name: 'f', resultJson: '{}' },
        ],
        tools: [],
      } as never,
      new AbortController().signal,
    )) { /* drain */ }
    const echoed = bodies[0].messages.find((m: any) => m.role === 'assistant');
    expect(echoed.reasoning_details).toBeUndefined();
  });
});

describe('local OpenAI client — provider routing (sort + price ceilings)', () => {
  test('OpenRouter default → provider:{sort:"throughput"}, no max_price', async () => {
    const cap: { body?: any } = {};
    mockFetch(cap);
    await drain(localOpenAiLlm({ baseUrl: 'https://openrouter.ai/api/v1', model: 'm', apiKey: 'k' }));
    expect(cap.body.provider).toEqual({ sort: 'throughput' });
  });

  test('explicit providerSort modes land on the wire', async () => {
    for (const sort of ['price', 'latency'] as const) {
      const cap: { body?: any } = {};
      mockFetch(cap);
      await drain(
        localOpenAiLlm({ baseUrl: 'https://openrouter.ai/api/v1', model: 'm', apiKey: 'k', providerSort: sort }),
      );
      expect(cap.body.provider).toEqual({ sort });
    }
  });

  test("providerSort 'default' + no caps → provider field omitted entirely", async () => {
    const cap: { body?: any } = {};
    mockFetch(cap);
    await drain(
      localOpenAiLlm({ baseUrl: 'https://openrouter.ai/api/v1', model: 'm', apiKey: 'k', providerSort: 'default' }),
    );
    expect('provider' in cap.body).toBe(false);
  });

  test('price ceilings pass through as max_price ($/M tokens); partial caps keep one key', async () => {
    // Unit per https://openrouter.ai/docs/guides/routing/provider-selection:
    // {"prompt": 1, "completion": 2} ⇒ providers ≤ $1/M prompt, ≤ $2/M completion.
    const cap: { body?: any } = {};
    mockFetch(cap);
    await drain(
      localOpenAiLlm({
        baseUrl: 'https://openrouter.ai/api/v1',
        model: 'm',
        apiKey: 'k',
        maxPromptPrice: 1,
        maxCompletionPrice: 2,
      }),
    );
    expect(cap.body.provider).toEqual({ sort: 'throughput', max_price: { prompt: 1, completion: 2 } });

    const partial: { body?: any } = {};
    mockFetch(partial);
    await drain(
      localOpenAiLlm({
        baseUrl: 'https://openrouter.ai/api/v1',
        model: 'm',
        apiKey: 'k',
        providerSort: 'default',
        maxCompletionPrice: 0.5,
      }),
    );
    expect(partial.body.provider).toEqual({ max_price: { completion: 0.5 } });
  });

  test('non-OpenRouter endpoints get NO provider field (400-on-unknown-fields gating)', async () => {
    const cap: { body?: any } = {};
    mockFetch(cap);
    await drain(
      localOpenAiLlm({
        baseUrl: 'http://localhost:11434/v1',
        model: 'm',
        providerSort: 'price',
        maxPromptPrice: 1,
      }),
    );
    expect('provider' in cap.body).toBe(false);
  });
});
