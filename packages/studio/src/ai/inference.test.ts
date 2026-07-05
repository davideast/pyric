import { describe, expect, it } from 'bun:test';
import type { ModelRequest, ModelEvent } from '@inbrowser/agent';
import {
  relayProviderAsLlmClient,
  type InferenceProvider,
  type InferenceEvent,
  type NormalizedRequest,
} from './inference.js';

/** A mock page-direct provider that yields a scripted event list + captures the request. */
function mockProvider(
  events: InferenceEvent[],
  capture?: { req?: NormalizedRequest },
): InferenceProvider {
  return async function* (req) {
    if (capture) capture.req = req;
    for (const e of events) yield e;
  };
}

const REQ: ModelRequest = {
  messages: [
    { role: 'system', text: 'be helpful' },
    { role: 'user', text: 'hi' },
  ],
  tools: [
    {
      type: 'function',
      function: { name: 'doThing', description: 'does a thing', parameters: { type: 'object' } },
    },
  ],
  toolUseEnabled: true,
};

async function collect(it: AsyncIterable<ModelEvent>): Promise<ModelEvent[]> {
  const out: ModelEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

describe('relayProviderAsLlmClient', () => {
  it('maps text, tool_call, and usage into ModelEvents', async () => {
    const provider = mockProvider([
      { kind: 'text', chunk: 'hel' },
      { kind: 'text', chunk: 'lo' },
      { kind: 'tool_call', callId: 'c1', name: 'doThing', args: { x: 1 }, signature: 'sig' },
      { kind: 'usage', promptTokens: 10, outputTokens: 5, cachedTokens: 2, costUsd: 0.001 },
    ]);
    const client = relayProviderAsLlmClient(provider, {
      providerKey: 'anthropic',
      model: 'claude-opus-4-8',
      apiKey: 'sk-x',
    });
    expect(client.supportsTools).toBe(true);
    expect(client.id).toBe('anthropic:claude-opus-4-8');

    const events = await collect(client.chat(REQ, new AbortController().signal));
    expect(events.map((e) => e.kind)).toEqual(['text', 'text', 'tool_call', 'usage']);

    const toolCall = events.find((e) => e.kind === 'tool_call');
    expect(toolCall).toMatchObject({ id: 'c1', name: 'doThing', args: { x: 1 }, signature: 'sig' });

    const done = events.at(-1);
    expect(done).toMatchObject({
      kind: 'usage',
      usage: { promptTokens: 10, outputTokens: 5, cachedTokens: 2, costUsd: 0.001 },
    });
  });

  it('builds the NormalizedRequest from the ModelRequest + config', async () => {
    const cap: { req?: NormalizedRequest } = {};
    const client = relayProviderAsLlmClient(mockProvider([{ kind: 'usage', promptTokens: 1, outputTokens: 1 }], cap), {
      providerKey: 'openrouter',
      model: 'anthropic/claude-opus-4.8',
      apiKey: 'or-key',
      effort: 'high',
    });
    await collect(client.chat(REQ, new AbortController().signal));
    expect(cap.req).toMatchObject({
      provider: 'openrouter',
      model: 'anthropic/claude-opus-4.8',
      apiKey: 'or-key',
      reasoningEffort: 'high',
    });
    expect(cap.req!.messages.map((m) => m.role)).toEqual(['system', 'user']);
    expect(cap.req!.tools.map((t) => t.name)).toEqual(['doThing']);
  });

  it('omits tools when toolUseEnabled is false', async () => {
    const cap: { req?: NormalizedRequest } = {};
    const client = relayProviderAsLlmClient(mockProvider([{ kind: 'usage', promptTokens: 1, outputTokens: 1 }], cap), {
      providerKey: 'anthropic',
      model: 'm',
      apiKey: 'k',
    });
    await collect(client.chat({ ...REQ, toolUseEnabled: false }, new AbortController().signal));
    expect(cap.req!.tools).toEqual([]);
  });

  it('yields error and stops (no usage after)', async () => {
    const provider = mockProvider([
      { kind: 'text', chunk: 'partial' },
      { kind: 'error', message: 'boom' },
      { kind: 'usage', promptTokens: 1, outputTokens: 1 }, // should never be reached
    ]);
    const client = relayProviderAsLlmClient(provider, { providerKey: 'anthropic', model: 'm', apiKey: 'k' });
    const events = await collect(client.chat(REQ, new AbortController().signal));
    expect(events.map((e) => e.kind)).toEqual(['text', 'error']);
  });

  it('synthesizes a usage event when the stream ends without one', async () => {
    const provider = mockProvider([{ kind: 'text', chunk: 'done' }]);
    const client = relayProviderAsLlmClient(provider, { providerKey: 'anthropic', model: 'm', apiKey: 'k' });
    const events = await collect(client.chat(REQ, new AbortController().signal));
    expect(events.map((e) => e.kind)).toEqual(['text', 'usage']);
    expect(events.at(-1)).toMatchObject({ usage: { promptTokens: 0, outputTokens: 0 } });
  });

  it('stops immediately when the signal is already aborted', async () => {
    const provider = mockProvider([{ kind: 'text', chunk: 'x' }, { kind: 'usage', promptTokens: 1, outputTokens: 1 }]);
    const client = relayProviderAsLlmClient(provider, { providerKey: 'anthropic', model: 'm', apiKey: 'k' });
    const ctrl = new AbortController();
    ctrl.abort();
    const events = await collect(client.chat(REQ, ctrl.signal));
    expect(events).toEqual([]);
  });
});
