/**
 * Delegate-mode routing tests — the contract that fixes the
 * agent-inside-agent mismatch (trace t-mq9msa9m-xcgt): on the Claude
 * (local CLI) lane the playground NEVER runs a react loop. One LLM
 * call per user turn, zero playground-side tool dispatch, loud failure
 * on contract drift.
 */
import { describe, test, expect } from 'bun:test';
import type {
  ModelEvent,
  ModelRequest,
  StrategyEvent,
  StrategyRunInput,
} from '@inbrowser/agent';
import { createClaudeDelegateStrategy, isDelegatedProvider } from './claude-delegate';

interface FakeLlmRecord {
  requests: ModelRequest[];
}

function fakeLlm(events: ModelEvent[], record: FakeLlmRecord) {
  return {
    id: 'claude',
    supportsTools: true,
    chat(req: ModelRequest, _signal?: AbortSignal): AsyncIterable<ModelEvent> {
      record.requests.push(req);
      return (async function* () {
        for (const e of events) yield e;
      })();
    },
  };
}

function makeInput(
  events: ModelEvent[],
  record: FakeLlmRecord,
  overrides: Partial<StrategyRunInput> = {},
): { input: StrategyRunInput; dispatched: string[] } {
  const dispatched: string[] = [];
  const input = {
    prompt: 'lock down the tasks collection',
    history: [],
    workspace: {} as never,
    runtime: {} as never,
    llm: fakeLlm(events, record),
    // Spy dispatch — the delegate strategy must NEVER call it.
    tools: {
      dispatch: async (name: string) => {
        dispatched.push(name);
        return { ok: true, summary: 'spy' };
      },
    } as never,
    toolList: [
      { name: 'write_file', description: 'w', parameters: { type: 'object' }, execute: async () => ({ ok: true, summary: '' }) },
      { name: 'read_file', description: 'r', parameters: { type: 'object' }, execute: async () => ({ ok: true, summary: '' }) },
    ] as never,
    toolContext: () => ({}) as never,
    systemPrompt: 'LANE PROMPT',
    ...overrides,
  } as StrategyRunInput;
  return { input, dispatched };
}

async function collect(
  events: ModelEvent[],
  overrides: Partial<StrategyRunInput> = {},
  signal = new AbortController().signal,
): Promise<{ out: StrategyEvent[]; record: FakeLlmRecord; dispatched: string[] }> {
  const record: FakeLlmRecord = { requests: [] };
  const { input, dispatched } = makeInput(events, record, overrides);
  const out: StrategyEvent[] = [];
  for await (const ev of createClaudeDelegateStrategy().run(input, signal)) {
    out.push(ev);
  }
  return { out, record, dispatched };
}

// ModelEvent has no `turn_complete` — the turn ends with a `usage` event
// (ModelUsage; outputTokens, not completionTokens; no `details` on the
// stream). The strategy synthesizes the StrategyEvent turn_complete details
// from `llm.id` (the fake's id is 'claude').
const TURN_COMPLETE: ModelEvent = {
  kind: 'usage',
  usage: { promptTokens: 12000, outputTokens: 80, cachedTokens: 11900, costUsd: 0.051 },
};

describe('isDelegatedProvider', () => {
  test('claude is delegated; every other lane keeps the strategy router', () => {
    expect(isDelegatedProvider('claude')).toBe(true);
    for (const id of ['gemini', 'openrouter', 'ollama']) {
      expect(isDelegatedProvider(id)).toBe(false);
    }
  });
});

describe('createClaudeDelegateStrategy', () => {
  test('one LLM call per turn: [system,…,user] messages, tools as MCP-mode flag, no dispatch', async () => {
    const { out, record, dispatched } = await collect([
      { kind: 'thinking', text: 'hm' },
      { kind: 'text', text: 'done' },
      TURN_COMPLETE,
    ]);

    expect(record.requests).toHaveLength(1);
    const req = record.requests[0]!;
    expect(req.messages[0]).toEqual({ role: 'system', text: 'LANE PROMPT' });
    expect(req.messages.at(-1)).toEqual({ role: 'user', text: 'lock down the tasks collection' });
    expect(req.toolUseEnabled).toBe(true);
    expect(req.tools.map((t) => t.function.name)).toEqual(['write_file', 'read_file']);

    expect(dispatched).toEqual([]); // the lane owns the tool loop
    expect(out[0]).toMatchObject({ kind: 'custom', name: 'strategy_routed' });
    expect(out.filter((e) => e.kind === 'text')).toEqual([{ kind: 'text', chunk: 'done' }]);
    expect(out.filter((e) => e.kind === 'thinking')).toEqual([{ kind: 'thinking', chunk: 'hm' }]);
    const complete = out.at(-1);
    expect(complete?.kind).toBe('turn_complete');
    if (complete?.kind === 'turn_complete') {
      expect(complete.usage.promptTokens).toBe(12000);
      expect(complete.usage.cachedTokens).toBe(11900);
      expect(complete.usage.costUsd).toBe(0.051);
    }
  });

  test('history replays with the same composition the react loop uses', async () => {
    const { record } = await collect([{ kind: 'text', text: 'x' }, TURN_COMPLETE], {
      history: [
        { id: 'u1', role: 'user', text: 'earlier ask', timestamp: 1 },
        { id: 'a1', role: 'assistant', text: 'earlier answer', timestamp: 2 },
      ],
    });
    const roles = record.requests[0]!.messages.map((m) => m.role);
    expect(roles).toEqual(['system', 'user', 'assistant', 'user']);
  });

  test('an unexpected tool_call from the provider fails LOUD, never dispatches', async () => {
    const { out, dispatched } = await collect([
      { kind: 'tool_call', id: 'c1', name: 'write_file', args: {} },
      { kind: 'text', text: 'should not arrive' },
    ]);
    const err = out.find((e) => e.kind === 'error');
    expect(err && err.kind === 'error' ? err.message : '').toContain('tool_call');
    expect(dispatched).toEqual([]);
    expect(out.some((e) => e.kind === 'text')).toBe(false);
  });

  test('empty toolList degrades to a plain text turn (toolUseEnabled false)', async () => {
    const { record } = await collect([{ kind: 'text', text: 'hi' }, TURN_COMPLETE], {
      toolList: [] as never,
    });
    expect(record.requests[0]!.toolUseEnabled).toBe(false);
    expect(record.requests[0]!.tools).toEqual([]);
  });

  test('pre-aborted signal short-circuits without an LLM call', async () => {
    const ctl = new AbortController();
    ctl.abort();
    const { out, record } = await collect([{ kind: 'text', text: 'x' }], {}, ctl.signal);
    expect(record.requests).toHaveLength(0);
    expect(out.some((e) => e.kind === 'error')).toBe(true);
  });

  test('provider error events pass through and end the turn', async () => {
    const { out } = await collect([
      { kind: 'error', message: 'claude -p exited with code 1' },
      TURN_COMPLETE,
    ]);
    expect(out.at(-1)).toEqual({ kind: 'error', message: 'claude -p exited with code 1' });
  });

  test('strips CLI transcript markup and emits delegated activity rows', async () => {
    const markup =
      "I'll start.\n<function_calls><invoke name=\"mcp__playground__read_file\">" +
      '<parameter name="path">/workspace/firestore.rules</parameter></invoke></function_calls>' +
      '<function_result>rules source</function_result>\nDone.';
    const { out } = await collect([{ kind: 'text', text: markup }, TURN_COMPLETE]);

    const text = out.filter((e) => e.kind === 'text').map((e) => (e.kind === 'text' ? e.chunk : '')).join('');
    expect(text).toBe("I'll start.\nDone.");
    expect(out.some((e) => e.kind === 'custom' && e.name === 'delegated_activity')).toBe(true);
    expect(out.some((e) => e.kind === 'custom' && e.name === 'delegated_transcript')).toBe(true);
    const activity = out.find(
      (e): e is Extract<StrategyEvent, { kind: 'custom' }> =>
        e.kind === 'custom' && e.name === 'delegated_activity',
    );
    expect(activity?.data).toMatchObject({ name: 'read_file', summary: 'read /workspace/firestore.rules' });
  });
});
