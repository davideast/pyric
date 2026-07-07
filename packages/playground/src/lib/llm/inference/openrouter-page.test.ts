/**
 * Tests for the in-repo page-direct OpenRouter provider — bounded
 * reasoning budget, Anthropic `reasoning_details` round-trip, and
 * reasoning-token telemetry (sonnet-food session, 2026-06-10). SSE
 * payloads mirror the probe capture against claude-haiku-4.5.
 * Mocks global fetch; no network.
 */
import { describe, test, expect, afterEach, beforeEach } from 'bun:test';
import {
  buildBody,
  buildProviderPrefs,
  mergeReasoningDelta,
  mergedDetails,
  openrouterPageProvider,
  toOaiMessages,
  _resetReasoningDetails,
  DEFAULT_MAX_TOKENS,
  type PageNormalizedRequest,
  type ReasoningDetail,
} from './openrouter-page';
import type { NormalizedRequest } from '@inbrowser/relay';
import { pruneToolHistory } from '~/lib/agent/prune-history';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});
beforeEach(() => {
  _resetReasoningDetails();
});

function req(partial: Partial<NormalizedRequest> = {}): NormalizedRequest {
  return {
    provider: 'openrouter',
    model: 'anthropic/claude-sonnet-4.6',
    messages: [{ role: 'user', text: 'hi' }],
    tools: [],
    toolUseEnabled: false,
    apiKey: 'k',
    ...partial,
  };
}

function sse(events: unknown[]): string {
  return events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('') + 'data: [DONE]\n\n';
}

async function drain(r: NormalizedRequest) {
  const out: any[] = [];
  for await (const e of openrouterPageProvider(r)) out.push(e);
  return out;
}

describe('openrouter-page — request body (reasoning budget)', () => {
  test('effort low/medium/high → unified reasoning param + explicit max_tokens', () => {
    const body = buildBody(req({ reasoningEffort: 'medium' }));
    expect(body.reasoning).toEqual({ effort: 'medium', summary: 'auto' });
    expect(body.include_reasoning).toBe(true);
    // Load-bearing: Anthropic budget = effort-ratio × max_tokens. Without
    // an explicit cap, OpenRouter uses the model-default max and `medium`
    // still authorizes a ~60k-token thinking free-run.
    expect(body.max_tokens).toBe(DEFAULT_MAX_TOKENS);
    expect(body.usage).toEqual({ include: true });
  });

  test("effort 'off' (and absent) → explicit reasoning disable", () => {
    expect(buildBody(req({ reasoningEffort: 'off' })).reasoning).toEqual({ enabled: false });
    expect(buildBody(req()).reasoning).toEqual({ enabled: false });
  });
});

describe('openrouter-page — prompt caching (system-prefix breakpoint)', () => {
  const SYS = 'You are a Firebase agent in a playground.';
  const cached = () =>
    buildBody(
      req({
        messages: [
          { role: 'system', text: SYS },
          { role: 'user', text: 'build it' },
          { role: 'assistant', text: 'on it' },
        ],
      }),
    );

  test('static system prefix becomes a cache_control-marked content part', () => {
    const msgs = cached().messages as { role: string; content: unknown }[];
    expect(msgs[0]!.content).toEqual([
      { type: 'text', text: SYS, cache_control: { type: 'ephemeral' } },
    ]);
  });

  test('string→parts conversion happens ONLY on the marked message', () => {
    // Providers that expect plain-string content must keep getting it
    // everywhere except the marked prefix (same posture as the
    // experiment client's opt-in cache path).
    const msgs = cached().messages as { role: string; content: unknown }[];
    expect(typeof msgs[1]!.content).toBe('string');
    expect(typeof msgs[2]!.content).toBe('string');
  });

  test('exactly ONE breakpoint — mirrors the experiment client (no history-boundary marker)', () => {
    const msgs = cached().messages as { content: unknown }[];
    const marked = msgs.filter((m) => Array.isArray(m.content));
    expect(marked).toHaveLength(1);
  });

  test('no system prefix → no conversion anywhere', () => {
    const msgs = buildBody(req()).messages as { content: unknown }[];
    for (const m of msgs) expect(typeof m.content).toBe('string');
  });
});

describe('openrouter-page — provider routing (sort + price ceilings)', () => {
  const routed = (providerRouting: PageNormalizedRequest['providerRouting']) =>
    buildBody({ ...req(), providerRouting });

  test('no providerRouting (legacy caller) → throughput sort preserved', () => {
    expect(buildBody(req()).provider).toEqual({ sort: 'throughput' });
  });

  test('each explicit sort mode lands on the wire', () => {
    expect(routed({ sort: 'throughput' }).provider).toEqual({ sort: 'throughput' });
    expect(routed({ sort: 'price' }).provider).toEqual({ sort: 'price' });
    expect(routed({ sort: 'latency' }).provider).toEqual({ sort: 'latency' });
  });

  test("sort 'default' + no caps → provider field omitted entirely", () => {
    const body = routed({ sort: 'default' });
    expect('provider' in body).toBe(false);
  });

  test('price ceilings pass through as max_price in $/M tokens', () => {
    // Unit per https://openrouter.ai/docs/guides/routing/provider-selection:
    // {"prompt": 1, "completion": 2} ⇒ providers ≤ $1/M prompt, ≤ $2/M completion.
    expect(routed({ sort: 'throughput', maxPromptPrice: 1, maxCompletionPrice: 2 }).provider).toEqual({
      sort: 'throughput',
      max_price: { prompt: 1, completion: 2 },
    });
  });

  test('partial caps → only the configured key; caps survive sort default', () => {
    expect(routed({ sort: 'throughput', maxCompletionPrice: 9 }).provider).toEqual({
      sort: 'throughput',
      max_price: { completion: 9 },
    });
    expect(routed({ sort: 'default', maxPromptPrice: 0.5 }).provider).toEqual({
      max_price: { prompt: 0.5 },
    });
  });

  test('buildProviderPrefs: non-positive caps are ignored, not sent', () => {
    expect(buildProviderPrefs({ sort: 'default', maxPromptPrice: 0, maxCompletionPrice: -1 })).toBeUndefined();
  });
});

describe('openrouter-page — reasoning_details delta merge', () => {
  test('text concatenates per index; signature lands on the merged block', () => {
    const acc = new Map<number, ReasoningDetail>();
    // Probe-verified delta sequence: N text deltas then a text-less
    // signature delta, all index 0, format anthropic-claude-v1.
    mergeReasoningDelta(acc, { type: 'reasoning.text', text: 'The user wants', format: 'anthropic-claude-v1', index: 0 });
    mergeReasoningDelta(acc, { type: 'reasoning.text', text: ' me to check.', format: 'anthropic-claude-v1', index: 0 });
    mergeReasoningDelta(acc, { type: 'reasoning.text', signature: 'EpoDCkgI…', format: 'anthropic-claude-v1', index: 0 });
    const merged = mergedDetails(acc);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({
      type: 'reasoning.text',
      text: 'The user wants me to check.',
      signature: 'EpoDCkgI…',
      format: 'anthropic-claude-v1',
    });
  });

  test('encrypted blocks accumulate data and keep their own index', () => {
    const acc = new Map<number, ReasoningDetail>();
    mergeReasoningDelta(acc, { type: 'reasoning.text', text: 'a', index: 0 });
    mergeReasoningDelta(acc, { type: 'reasoning.encrypted', data: 'AAA', index: 1 });
    mergeReasoningDelta(acc, { type: 'reasoning.encrypted', data: 'BBB', index: 1 });
    const merged = mergedDetails(acc);
    expect(merged).toHaveLength(2);
    expect(merged[1]).toMatchObject({ type: 'reasoning.encrypted', data: 'AAABBB' });
  });
});

describe('openrouter-page — streaming round-trip', () => {
  const STREAM = sse([
    { choices: [{ delta: { role: 'assistant', reasoning: 'thinking…', reasoning_details: [{ type: 'reasoning.text', text: 'thinking…', format: 'anthropic-claude-v1', index: 0 }] } }] },
    { choices: [{ delta: { reasoning_details: [{ type: 'reasoning.text', signature: 'sig-1', format: 'anthropic-claude-v1', index: 0 }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'toolu_1', function: { name: 'get_price', arguments: '{"itemId"' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ':"x"}' } }] } }] },
    {
      choices: [{ delta: {} }],
      usage: {
        prompt_tokens: 615,
        completion_tokens: 132,
        cost: 0.001275,
        prompt_tokens_details: { cached_tokens: 7 },
        completion_tokens_details: { reasoning_tokens: 64 },
      },
    },
  ]);

  test('thinking + tool call + extended usage stream through', async () => {
    globalThis.fetch = (async () => new Response(STREAM, { status: 200 })) as unknown as typeof fetch;
    const evs = await drain(req({ reasoningEffort: 'low', tools: [{ type: 'function', function: { name: 'get_price', description: 'd', parameters: {} } }] }));
    expect(evs.find((e) => e.kind === 'thinking')!.chunk).toBe('thinking…');
    const call = evs.find((e) => e.kind === 'tool_call')!;
    expect(call.callId).toBe('toolu_1');
    expect(call.args).toEqual({ itemId: 'x' });
    const usage = evs.find((e) => e.kind === 'usage')!;
    expect(usage).toMatchObject({ promptTokens: 615, outputTokens: 132, cachedTokens: 7, reasoningTokens: 64, costUsd: 0.001275 });
  });

  test('next request re-attaches the merged signed thinking on the echoed assistant turn', async () => {
    globalThis.fetch = (async () => new Response(STREAM, { status: 200 })) as unknown as typeof fetch;
    await drain(req({ reasoningEffort: 'low', tools: [{ type: 'function', function: { name: 'get_price', description: 'd', parameters: {} } }] }));

    // The ReAct loop echoes the assistant turn (by tool-call id) + tool result.
    const echoed = toOaiMessages([
      { role: 'user', text: 'hi' },
      { role: 'assistant', text: '', toolCalls: [{ id: 'toolu_1', name: 'get_price', args: { itemId: 'x' } }] },
      { role: 'tool', toolCallId: 'toolu_1', name: 'get_price', resultJson: '{"price":5}' },
    ]);
    const asst = echoed.find((m) => m.role === 'assistant')!;
    expect(asst.reasoning_details).toEqual([
      { type: 'reasoning.text', text: 'thinking…', signature: 'sig-1', format: 'anthropic-claude-v1' },
    ]);
    // Unknown calls stay clean.
    const other = toOaiMessages([
      { role: 'assistant', text: '', toolCalls: [{ id: 'toolu_other', name: 'f', args: {} }] },
    ]);
    expect(other[0]!.reasoning_details).toBeUndefined();
  });

  test('pruned history round-trips: every tool message still pairs with an emitted tool_call id', () => {
    // Live-seam pruning (#515 port) only compacts `resultJson` on
    // role:'tool' messages — callIds are untouched, so the wire format
    // never carries an orphaned tool id (Anthropic/OpenAI both reject
    // those). Mirrors the harness policy: keepLastResults 3.
    const history: Parameters<typeof toOaiMessages>[0] = [
      { role: 'system', text: 'SYS' },
      { role: 'user', text: 'build' },
    ];
    for (let i = 1; i <= 6; i++) {
      history.push({
        role: 'assistant',
        text: '',
        toolCalls: [{ id: `c${i}`, name: 'write_file', args: { path: `/f${i}` } }],
      });
      history.push({
        role: 'tool',
        toolCallId: `c${i}`,
        name: 'write_file',
        resultJson: JSON.stringify({
          ok: true,
          summary: `wrote /f${i}`,
          data: { bytes: 1000, echo: 'x'.repeat(500) },
        }),
      });
    }
    const wire = toOaiMessages(pruneToolHistory(history, { keepLastResults: 3 }));
    const emittedIds = new Set(
      wire.flatMap((m) => (m.tool_calls ?? []).map((c) => c.id)),
    );
    const toolMsgs = wire.filter((m) => m.role === 'tool');
    expect(toolMsgs).toHaveLength(6);
    for (const t of toolMsgs) expect(emittedIds.has(t.tool_call_id!)).toBe(true);
    // Old results collapsed to the one-line stub; recent results intact.
    const first = JSON.parse(toolMsgs[0]!.content as string);
    expect(first).toMatchObject({ _pruned: true, tool: 'write_file', ok: true, summary: 'wrote /f1' });
    expect(first.data).toBeUndefined();
    const last = JSON.parse(toolMsgs[5]!.content as string);
    expect(last.data.echo).toHaveLength(500);
  });

  test('model that rejects `reasoning` → one retry without it', async () => {
    const bodies: any[] = [];
    let call = 0;
    globalThis.fetch = (async (_url: unknown, init: { body: string }) => {
      bodies.push(JSON.parse(init.body));
      call += 1;
      if (call === 1) {
        return new Response(JSON.stringify({ error: { message: 'reasoning is not supported for this model' } }), { status: 404 });
      }
      return new Response(sse([{ choices: [{ delta: { content: 'ok' } }] }]), { status: 200 });
    }) as unknown as typeof fetch;
    const evs = await drain(req({ reasoningEffort: 'medium' }));
    expect(bodies).toHaveLength(2);
    expect('reasoning' in bodies[1]).toBe(false);
    expect('include_reasoning' in bodies[1]).toBe(false);
    expect(evs.some((e) => e.kind === 'error')).toBe(false);
    expect(evs.find((e) => e.kind === 'text')!.chunk).toBe('ok');
  });
});
