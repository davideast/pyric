/**
 * Pins for the session host's per-turn accounting (sonnet-food session,
 * 2026-06-10):
 *
 *   - multi-iteration metrics SUM (not last-iteration-wins);
 *   - the user prompt appears at most TWICE on the wire (the two known
 *     upstream @inbrowser/agent copies), never three times.
 */
import { describe, test, expect } from 'bun:test';
import type { TurnMetrics } from '@inbrowser/agent';
import {
  createAgentSession,
  createMetricsCollector,
  createReactLoopStrategy,
  type ModelClient,
  type SessionEvent,
} from '@inbrowser/agent';
import { createTurnMetricsAccumulator, snapshotHistoryForTurn } from './turn-accounting';
import type { ChatMessage } from '~/lib/store/chat';

function m(p: Partial<TurnMetrics>): TurnMetrics {
  return { tokensIn: 0, tokensOut: 0, tokensCached: 0, tokensReasoning: 0, costUsd: 0, ...p };
}

describe('createTurnMetricsAccumulator — defect 3 (last-iteration-wins)', () => {
  test('sums usage across all iterations of a turn', () => {
    const acc = createTurnMetricsAccumulator();
    // The real numbers from the sonnet-food session: iteration 0 burned
    // 60,583 output tokens; iteration 1 another 183. The UI reported 183.
    acc.add(m({ tokensIn: 11274, tokensOut: 60583, tokensReasoning: 55000, costUsd: 0.95 }));
    const agg = acc.add(m({ tokensIn: 12546, tokensOut: 183, costUsd: 0.040383 }));
    expect(agg.tokensOut).toBe(60583 + 183);
    expect(agg.tokensIn).toBe(11274 + 12546);
    expect(agg.tokensReasoning).toBe(55000);
    expect(agg.costUsd).toBeCloseTo(0.990383, 6);
    expect(agg.costEstimated).toBe(false);
    expect(agg.iterations).toBe(2);
  });

  test('any estimated iteration marks the aggregate estimated', () => {
    const acc = createTurnMetricsAccumulator();
    acc.add(m({ tokensOut: 10, costUsd: 0.1 }));
    const agg = acc.add(m({ tokensOut: 5, costUsd: 0.05, costEstimated: true }));
    expect(agg.costEstimated).toBe(true);
  });

  test('cached tokens sum; isByok carries through; reset() zeroes', () => {
    const acc = createTurnMetricsAccumulator();
    acc.add(m({ tokensCached: 100, isByok: true }));
    const agg = acc.add(m({ tokensCached: 50 }));
    expect(agg.tokensCached).toBe(150);
    expect(agg.isByok).toBe(true);
    acc.reset();
    expect(acc.totals().tokensCached).toBe(0);
    expect(acc.totals().iterations).toBe(0);
  });
});

describe('snapshotHistoryForTurn — defect 4 (prompt triplication)', () => {
  const PROMPT = 'Create an app where signed-in users can order food.';
  function uiMessages(): ChatMessage[] {
    return [
      { id: 'u-old', role: 'user', text: 'earlier prompt', createdAt: 1 },
      { id: 'a-old', role: 'assistant', text: 'earlier reply', createdAt: 2 },
      { id: 'u-now', role: 'user', text: PROMPT, createdAt: 3 },
      { id: 'a-now', role: 'assistant', text: '', createdAt: 4, streaming: true },
    ];
  }

  test('drops the placeholder AND the in-flight user message; keeps earlier turns', () => {
    const history = snapshotHistoryForTurn(uiMessages(), 'u-now');
    expect(history.map((x) => x.id)).toEqual(['u-old', 'a-old']);
  });

  test('PIN: through the real agent session + react strategy, the prompt reaches the wire at most twice', async () => {
    // The two remaining copies are the KNOWN upstream pair:
    //   1. @inbrowser/agent session.js pre-appends the user msg to history
    //      before strategy.run(), AND
    //   2. strategy.js buildMessages() appends input.prompt again.
    // The in-repo third copy (chat-store history snapshot) is gone.
    const history = snapshotHistoryForTurn(uiMessages(), 'u-now');
    const seen: string[][] = [];
    const stubLlm: ModelClient = {
      id: 'stub',
      supportsTools: true,
      async *chat(req: { messages: { role: string; text?: string }[] }) {
        seen.push(req.messages.filter((x) => x.role === 'user' && x.text === PROMPT).map((x) => x.text!));
        yield { kind: 'text', text: 'done' } as never;
        // ModelEvent ends with a `usage` event (no `turn_complete`/`details`
        // on the stream; ModelUsage uses outputTokens, not completionTokens).
        yield { kind: 'usage', usage: { promptTokens: 1, outputTokens: 1 } } as never;
      },
    } as unknown as ModelClient;

    const session = createAgentSession({
      strategy: createReactLoopStrategy({ maxTurns: 2 }),
      llm: stubLlm,
      tools: { execute: async () => ({ ok: true, summary: '' }) } as never,
      toolList: [],
      toolContext: () => ({}) as never,
      systemPromptBuilder: () => 'SYS',
      metrics: createMetricsCollector(),
      history: history.map((x) => ({ id: x.id, role: x.role, text: x.text, timestamp: x.createdAt })),
    });
    for await (const _ev of session.submit(PROMPT, new AbortController().signal) as AsyncIterable<SessionEvent>) {
      // drain
    }
    expect(seen.length).toBeGreaterThan(0);
    for (const copies of seen) {
      expect(copies.length).toBeGreaterThan(0);
      expect(copies.length).toBeLessThanOrEqual(2); // never the old local third copy
    }
  });
});
