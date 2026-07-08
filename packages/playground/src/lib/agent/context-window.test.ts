import { describe, expect, test } from 'bun:test';
import type { ToolHandler } from '@inbrowser/agent';
import type { ChatMessage } from '~/lib/store/chat';
import type { TurnTrace } from '~/lib/store/trace';
import { buildContextWindowSnapshot } from './context-window';

function msg(partial: Partial<ChatMessage>): ChatMessage {
  return {
    id: partial.id ?? `m-${Math.random().toString(36).slice(2)}`,
    role: partial.role ?? 'user',
    text: partial.text ?? '',
    createdAt: partial.createdAt ?? 0,
    ...partial,
  };
}

const tool = {
  name: 'read_file',
  description: 'Read a bounded file range.',
  parameters: {
    type: 'object',
    properties: { path: { type: 'string' } },
    required: ['path'],
  },
} as unknown as ToolHandler;

describe('context-window snapshot', () => {
  test('known model limit calculates percent and status', () => {
    const snapshot = buildContextWindowSnapshot({
      messages: [msg({ text: 'hello '.repeat(100) })],
      currentPrompt: 'build the app',
      systemPrompt: 'system '.repeat(100),
      tools: [tool],
      limitTokens: 1_000,
    });

    expect(snapshot.basis).toBe('estimated-next-send');
    expect(snapshot.percentFull).toBe(snapshot.usedTokens / 1_000);
    expect(['low', 'medium', 'high', 'critical']).toContain(snapshot.status);
  });

  test('unknown model limit stays neutral instead of inventing a percentage', () => {
    const snapshot = buildContextWindowSnapshot({
      messages: [msg({ text: 'hello' })],
      currentPrompt: '',
      systemPrompt: 'system',
      tools: [],
    });

    expect(snapshot.limitTokens).toBeUndefined();
    expect(snapshot.percentFull).toBeUndefined();
    expect(snapshot.status).toBe('unknown');
  });

  test('current draft prompt contributes to next-send estimate', () => {
    const withoutDraft = buildContextWindowSnapshot({
      messages: [],
      currentPrompt: '',
      systemPrompt: 'system',
      tools: [],
      limitTokens: 10_000,
    });
    const withDraft = buildContextWindowSnapshot({
      messages: [],
      currentPrompt: 'x'.repeat(400),
      systemPrompt: 'system',
      tools: [],
      limitTokens: 10_000,
    });

    expect(withDraft.usedTokens).toBeGreaterThan(withoutDraft.usedTokens);
    expect(withDraft.breakdown.some((row) => row.id === 'draft')).toBe(true);
  });

  test('stale tool results are cleared from the next-send estimate (lever 1)', () => {
    // Five user turns: the first turn's fat tool result is older than the
    // 4-recent-turns keep window, so the estimate clears it.
    const fatResult = JSON.stringify({ ok: true, data: 'x'.repeat(40_000) });
    const messages = [
      msg({ id: 'u1', role: 'user', text: 'turn 1' }),
      msg({
        id: 'a1',
        role: 'assistant',
        text: 'done',
        toolCalls: [
          { id: 'call-1', name: 'read_file', argsJson: '{"path":"/a"}', resultJson: fatResult, ok: true },
        ],
      } as Partial<ChatMessage>),
      msg({ id: 'u2', role: 'user', text: 'turn 2' }),
      msg({ id: 'a2', role: 'assistant', text: 'done' }),
      msg({ id: 'u3', role: 'user', text: 'turn 3' }),
      msg({ id: 'a3', role: 'assistant', text: 'done' }),
      msg({ id: 'u4', role: 'user', text: 'turn 4' }),
      msg({ id: 'a4', role: 'assistant', text: 'done' }),
      msg({ id: 'u5', role: 'user', text: 'turn 5' }),
    ];
    const snapshot = buildContextWindowSnapshot({
      messages,
      currentPrompt: 'next',
      systemPrompt: 'system',
      tools: [],
      limitTokens: 200_000,
    });

    expect(snapshot.compaction.compacted).toBe(true);
    expect(snapshot.compaction.bytesSaved).toBeGreaterThan(30_000);
    expect(snapshot.compactionPreview.rawTokens).toBeGreaterThan(
      snapshot.compactionPreview.currentTokens,
    );
  });

  test('a persisted compaction marker defines the model-bound boundary', () => {
    const old = 'older discussion '.repeat(2_000);
    const messages = [
      msg({ id: 'u1', role: 'user', text: old }),
      msg({ id: 'a1', role: 'assistant', text: 'done' }),
      msg({ id: 'u2', role: 'user', text: 'recent' }),
    ];
    const withoutMarker = buildContextWindowSnapshot({
      messages,
      currentPrompt: 'next',
      systemPrompt: 'system',
      tools: [],
      limitTokens: 200_000,
    });
    const withMarker = buildContextWindowSnapshot({
      messages,
      currentPrompt: 'next',
      systemPrompt: 'system',
      tools: [],
      limitTokens: 200_000,
      compactionMarkers: [
        {
          atMessageId: 'a1',
          summaryText: 'Summary: discussed the older topic; decision recorded.',
          beforeTokens: 9_000,
          afterTokens: 300,
          ts: 100,
          source: 'model',
        },
      ],
    });

    expect(withMarker.usedTokens).toBeLessThan(withoutMarker.usedTokens);
    expect(withMarker.compaction.compacted).toBe(true);
    expect(withMarker.compaction.bytesSaved).toBeGreaterThan(0);
  });

  test('compaction reports nothing to do for a short, result-light history', () => {
    const snapshot = buildContextWindowSnapshot({
      messages: [
        msg({ id: 'u1', role: 'user', text: 'recent 1' }),
        msg({ id: 'a1', role: 'assistant', text: 'done' }),
        msg({ id: 'u2', role: 'user', text: 'recent 2' }),
      ],
      currentPrompt: 'next',
      systemPrompt: 'system',
      tools: [],
      limitTokens: 10_000,
    });

    expect(snapshot.compactionPreview.savedTokens).toBe(0);
    expect(snapshot.compactionPreview.stats.compacted).toBe(false);
  });

  test('session usage is carried separately from next-request context', () => {
    const snapshot = buildContextWindowSnapshot({
      messages: [msg({ text: 'hello' })],
      currentPrompt: 'next',
      systemPrompt: 'system',
      tools: [],
      limitTokens: 1_000_000,
      sessionTurns: 1,
      sessionRequests: 16,
      sessionTokensTotal: 3_004_949,
      sessionInputTokens: 2_100_000,
      sessionOutputTokens: 904_949,
      sessionCachedInputTokens: 400_000,
      sessionReasoningTokens: 300_000,
    });

    expect(snapshot.usedTokens).toBeLessThan(snapshot.sessionUsage!.tokensTotal);
    expect(snapshot.sessionUsage).toMatchObject({
      turns: 1,
      requests: 16,
      tokensTotal: 3_004_949,
      inputTokens: 2_100_000,
      outputTokens: 904_949,
      cachedInputTokens: 400_000,
      reasoningTokens: 300_000,
      turnRows: [],
    });
    expect(snapshot.sessionUsage!.workMultiplier).toBeCloseTo(
      3_004_949 / snapshot.usedTokens,
    );
    expect(snapshot.sessionUsage!.averageRequestTokens).toBeCloseTo(3_004_949 / 16);
  });

  test('session turn rows derive request counts and non-overlapping buckets', () => {
    const snapshot = buildContextWindowSnapshot({
      messages: [
        msg({
          id: 'a1',
          role: 'assistant',
          text: 'done',
          turnId: 't1',
          metrics: {
            tokensIn: 1_000,
            tokensOut: 300,
            tokensTotal: 1_300,
            cachedTokens: 400,
            reasoningTokens: 100,
          },
        }),
        msg({
          id: 'a2',
          role: 'assistant',
          text: 'done again',
          turnId: 'missing-trace',
          metrics: {
            tokensIn: 500,
            tokensOut: 200,
            tokensTotal: 700,
          },
        }),
      ],
      currentPrompt: 'next',
      systemPrompt: 'system',
      tools: [],
      limitTokens: 100_000,
      tracesByTurn: {
        t1: {
          turnId: 't1',
          requests: [{}, {}, {}],
          responses: [],
          hostCtx: {
            providerId: 'gemini',
            providerLabel: 'Gemini',
            modelLabel: 'Flash',
            diagnosticsEnabled: false,
            resumableServerMode: false,
          },
        } as unknown as TurnTrace,
      },
    });

    expect(snapshot.sessionUsage).toMatchObject({
      turns: 2,
      requests: null,
      tokensTotal: 2_000,
      inputTokens: 1_500,
      outputTokens: 500,
      cachedInputTokens: 400,
      reasoningTokens: 100,
    });
    expect(snapshot.sessionUsage!.turnRows[0]).toMatchObject({
      id: 'a1',
      label: 'Turn 1',
      requestCount: 3,
      freshInputTokens: 600,
      cachedInputTokens: 400,
      visibleOutputTokens: 200,
      reasoningTokens: 100,
      tokensTotal: 1_300,
    });
    expect(snapshot.sessionUsage!.turnRows[1]).toMatchObject({
      id: 'a2',
      label: 'Turn 2',
      requestCount: null,
      freshInputTokens: 500,
      visibleOutputTokens: 200,
      tokensTotal: 700,
    });
    expect(snapshot.sessionUsage!.workMultiplier).toBeCloseTo(
      snapshot.sessionUsage!.tokensTotal / snapshot.usedTokens,
    );
  });

  test('session request rows use provider usage with estimated input composition', () => {
    const snapshot = buildContextWindowSnapshot({
      messages: [
        msg({
          id: 'assistant-1',
          role: 'assistant',
          text: 'done',
          turnId: 't1',
          toolCalls: [
            {
              id: 'call-read',
              name: 'read_file',
              argsJson: '{"path":"/workspace/src/App.tsx"}',
              resultJson: '{"ok":true}',
              ok: true,
            },
            {
              id: 'call-write',
              name: 'write_file',
              argsJson: '{"path":"/workspace/src/App.tsx"}',
              ok: true,
            },
          ],
          metrics: {
            tokensIn: 1_000,
            tokensOut: 250,
            tokensTotal: 1_250,
            cachedTokens: 300,
            reasoningTokens: 50,
          },
        }),
      ],
      currentPrompt: 'next',
      systemPrompt: 'system',
      tools: [],
      limitTokens: 100_000,
      tracesByTurn: {
        t1: {
          turnId: 't1',
          requests: [
            {
              requestId: 't1#0',
              turnId: 't1',
              iteration: 0,
              ts: 10,
              messages: [
                { role: 'system', text: 'system instructions '.repeat(20) },
                { role: 'user', text: 'old prompt '.repeat(20) },
                {
                  role: 'assistant',
                  text: 'calling tool',
                  toolCalls: [{ callId: 'call-read', name: 'read_file' }],
                },
                {
                  role: 'tool',
                  callId: 'call-read',
                  name: 'read_file',
                  resultJson: JSON.stringify({ file: 'content '.repeat(30) }),
                },
                { role: 'user', text: 'current prompt '.repeat(20) },
              ],
              tools: [{ name: 'read_file', description: 'read', parameters: {} }],
            },
          ],
          responses: [
            {
              requestId: 't1#0',
              text: 'visible output '.repeat(20),
              thinking: 'hidden reasoning '.repeat(10),
              usage: {
                promptTokens: 1_000,
                outputTokens: 250,
                cachedTokens: 300,
                reasoningTokens: 50,
              },
              toolCalls: [
                {
                  id: 'call-write',
                  name: 'write_file',
                  args: { path: '/workspace/src/App.tsx' },
                },
              ],
            },
          ],
          hostCtx: {
            providerId: 'gemini',
            providerLabel: 'Gemini',
            modelLabel: 'Flash',
            diagnosticsEnabled: false,
            resumableServerMode: false,
          },
        } as unknown as TurnTrace,
      },
    });

    const request = snapshot.sessionUsage!.requestRows[0]!;
    expect(request).toMatchObject({
      requestId: 't1#0',
      turnId: 't1',
      iteration: 0,
      providerLabel: 'Gemini',
      modelLabel: 'Flash',
      usageSource: 'provider',
      inputTokens: 1_000,
      cachedInputTokens: 300,
      freshInputTokens: 700,
      outputTokens: 250,
      reasoningTokens: 50,
      visibleOutputTokens: 200,
      tokensTotal: 1_250,
    });
    expect(request.composition.system).toBeGreaterThan(0);
    expect(request.composition.history).toBeGreaterThan(0);
    expect(request.composition.resentToolResults).toBeGreaterThan(0);
    expect(request.composition.currentPrompt).toBeGreaterThan(0);
    expect(request.composition.toolSchemas).toBeGreaterThan(0);
    expect(request.toolNames).toContain('read_file');
    expect(request.toolSchemaNames).toEqual(['read_file']);
    expect(request.resentToolResults).toEqual([
      expect.objectContaining({
        name: 'read_file',
        callId: 'call-read',
        messageId: 'assistant-1',
      }),
    ]);
    expect(request.emittedToolCalls).toEqual([
      expect.objectContaining({
        name: 'write_file',
        callId: 'call-write',
        messageId: 'assistant-1',
      }),
    ]);

    const fresh = snapshot.sessionUsage!.categoryDetails['fresh-input']!;
    expect(fresh.source).toBe('mixed');
    expect(fresh.rows.some((row) => row.label === 'System prompt' && row.estimated)).toBe(true);
    const freshRowTotal = fresh.rows.reduce((sum, row) => sum + row.tokens, 0);
    expect(Math.abs(freshRowTotal - 700)).toBeLessThanOrEqual(fresh.rows.length);

    const cached = snapshot.sessionUsage!.categoryDetails['cached-input']!;
    expect(cached.rows).toEqual([
      expect.objectContaining({
        label: 'Cache-read input',
        tokens: 300,
        estimated: false,
        source: 'provider-reported',
      }),
    ]);
    const visible = snapshot.sessionUsage!.categoryDetails['visible-output']!;
    expect(visible.rows[0]).toMatchObject({
      label: 'Assistant-visible output',
      tokens: 200,
      estimated: false,
    });
  });

  test('session request rows derive cache-hit teaching without claiming exact cached messages', () => {
    const snapshot = buildContextWindowSnapshot({
      messages: [],
      currentPrompt: 'next',
      systemPrompt: 'system',
      tools: [],
      limitTokens: 100_000,
      tracesByTurn: {
        t1: {
          turnId: 't1',
          requests: [
            {
              requestId: 't1#0',
              turnId: 't1',
              iteration: 0,
              ts: 10,
              messages: [
                { role: 'system', text: 'stable system '.repeat(200) },
                { role: 'user', text: 'first prompt '.repeat(200) },
              ],
              tools: [{ name: 'read_file', description: 'read', parameters: {} }],
            },
            {
              requestId: 't1#1',
              turnId: 't1',
              iteration: 1,
              ts: 20,
              messages: [
                { role: 'system', text: 'stable system '.repeat(200) },
                { role: 'user', text: 'first prompt '.repeat(200) },
                {
                  role: 'tool',
                  callId: 'call-read',
                  name: 'read_file',
                  resultJson: JSON.stringify({ file: 'stable result '.repeat(200) }),
                },
                { role: 'user', text: 'second prompt '.repeat(200) },
              ],
              tools: [{ name: 'read_file', description: 'read', parameters: {} }],
            },
          ],
          responses: [
            {
              requestId: 't1#0',
              text: 'first output',
              usage: {
                promptTokens: 3_000,
                outputTokens: 100,
                cachedTokens: 0,
              },
            },
            {
              requestId: 't1#1',
              text: 'second output',
              usage: {
                promptTokens: 5_000,
                outputTokens: 100,
                cachedTokens: 2_000,
              },
            },
          ],
          hostCtx: {
            providerId: 'gemini',
            providerLabel: 'Gemini',
            modelLabel: 'Gemini 3.5 Flash',
            diagnosticsEnabled: false,
            resumableServerMode: false,
          },
        } as unknown as TurnTrace,
      },
    });

    const first = snapshot.sessionUsage!.requestRows[0]!.cacheInsight!;
    expect(first).toMatchObject({
      cachedTokens: 0,
      freshTokens: 3_000,
      knownMinimumTokens: 4_096,
      meetsKnownMinimum: false,
      likelyStablePrefixTokens: 0,
      providerMode: 'Gemini implicit caching',
    });
    expect(first.hitRate).toBe(0);
    expect(first.explanation).toContain('first request');

    const second = snapshot.sessionUsage!.requestRows[1]!.cacheInsight!;
    expect(second).toMatchObject({
      cachedTokens: 2_000,
      freshTokens: 3_000,
      knownMinimumTokens: 4_096,
      meetsKnownMinimum: true,
      providerMode: 'Gemini implicit caching',
    });
    expect(second.hitRate).toBeCloseTo(0.4);
    expect(second.likelyStablePrefixTokens).toBeGreaterThan(0);
    expect(second.explanation).toContain('Partial cache hit');
    expect(second.explanation).not.toContain('exact');
  });

  test('session request rows fall back to estimated usage when response usage is missing', () => {
    const snapshot = buildContextWindowSnapshot({
      messages: [],
      currentPrompt: 'next',
      systemPrompt: 'system',
      tools: [],
      limitTokens: 100_000,
      tracesByTurn: {
        t1: {
          turnId: 't1',
          requests: [
            {
              requestId: 't1#0',
              turnId: 't1',
              iteration: 0,
              ts: 10,
              messages: [
                { role: 'system', text: 'system instructions' },
                { role: 'user', text: 'current prompt '.repeat(10) },
              ],
              toolDeclarations: [],
            },
          ],
          responses: [
            {
              requestId: 't1#0',
              text: 'visible output '.repeat(8),
              thinking: 'hidden reasoning '.repeat(4),
            },
          ],
          hostCtx: {
            providerId: 'gemini',
            providerLabel: 'Gemini',
            modelLabel: 'Flash',
            diagnosticsEnabled: false,
            resumableServerMode: false,
          },
        } as unknown as TurnTrace,
      },
    });

    const request = snapshot.sessionUsage!.requestRows[0]!;
    const compositionTotal = Object.values(request.composition).reduce((sum, tokens) => sum + tokens, 0);
    expect(request.usageSource).toBe('estimate');
    expect(request.inputTokens).toBe(compositionTotal);
    expect(request.cachedInputTokens).toBe(0);
    expect(request.outputTokens).toBeGreaterThan(request.reasoningTokens);
    expect(request.visibleOutputTokens).toBe(request.outputTokens - request.reasoningTokens);
  });

  test('legacy metrics without traces expose high-level totals but no request detail', () => {
    const snapshot = buildContextWindowSnapshot({
      messages: [
        msg({
          id: 'a1',
          role: 'assistant',
          text: 'done',
          metrics: {
            tokensIn: 1_000,
            tokensOut: 300,
            tokensTotal: 1_300,
            cachedTokens: 200,
          },
        }),
      ],
      currentPrompt: 'next',
      systemPrompt: 'system',
      tools: [],
      limitTokens: 100_000,
    });

    expect(snapshot.sessionUsage!.requestRows).toEqual([]);
    expect(snapshot.sessionUsage!.categoryDetails['fresh-input']).toMatchObject({
      source: 'unavailable',
      rows: [],
    });
    expect(snapshot.sessionUsage!.categoryDetails['cached-input']!.rows[0]).toMatchObject({
      label: 'Cache-read input',
      tokens: 200,
      source: 'provider-reported',
    });
  });

  test('Gemini prompt cost estimate uses input context tokens only', () => {
    const snapshot = buildContextWindowSnapshot({
      messages: [msg({ text: 'hello '.repeat(100) })],
      currentPrompt: 'build the app',
      systemPrompt: 'system '.repeat(100),
      tools: [tool],
      limitTokens: 1_000_000,
      providerId: 'gemini',
      modelId: 'gemini-3.5-flash',
    });

    expect(snapshot.pricing.current?.source).toBe('gemini-pricing-table');
    expect(snapshot.pricing.current?.inputPricePerMillion).toBe(1.5);
    expect(snapshot.pricing.current?.costUsd).toBeCloseTo(snapshot.usedTokens * 1.5 / 1_000_000);
  });

  test('OpenRouter prompt pricing can come from models API metadata', () => {
    const snapshot = buildContextWindowSnapshot({
      messages: [msg({ text: 'hello '.repeat(100) })],
      currentPrompt: 'build the app',
      systemPrompt: 'system '.repeat(100),
      tools: [tool],
      limitTokens: 200_000,
      providerId: 'openrouter',
      modelId: 'openai/gpt-5.5',
      promptPricing: {
        source: 'openrouter-models-api',
        inputPricePerMillion: 3,
      },
    });

    expect(snapshot.pricing.current?.source).toBe('openrouter-models-api');
    expect(snapshot.pricing.current?.costUsd).toBeCloseTo(snapshot.usedTokens * 3 / 1_000_000);
  });

  test('unknown-priced provider returns no cost estimate', () => {
    const snapshot = buildContextWindowSnapshot({
      messages: [msg({ text: 'hello' })],
      currentPrompt: 'build the app',
      systemPrompt: 'system',
      tools: [],
      providerId: 'ollama',
      modelId: 'llama3.1:8b',
    });

    expect(snapshot.pricing.current).toBeNull();
    expect(snapshot.pricing.compacted).toBeNull();
    expect(snapshot.pricing.savedCostUsd).toBeNull();
  });

  test('empty composer still reports next-request estimate when trace data exists', () => {
    const trace = {
      t1: {
        turnId: 't1',
        requests: [
          {
            requestId: 't1#0',
            turnId: 't1',
            iteration: 0,
            ts: 100,
            systemPrompt: 'old',
            messages: [{ role: 'user', text: 'old prompt' }],
            tools: [],
          },
        ],
        responses: [],
        hostCtx: {
          providerId: 'gemini',
          providerLabel: 'Gemini',
          modelLabel: 'Flash',
          diagnosticsEnabled: false,
          resumableServerMode: false,
        },
      },
      t2: {
        turnId: 't2',
        requests: [
          {
            requestId: 't2#0',
            turnId: 't2',
            iteration: 0,
            ts: 200,
            systemPrompt: 'new',
            messages: [{ role: 'user', text: 'new prompt' }],
            toolDeclarations: [{ name: 'read_file', description: 'read', parameters: {} }],
          },
        ],
        responses: [],
        hostCtx: {
          providerId: 'gemini',
          providerLabel: 'Gemini',
          modelLabel: 'Flash',
          diagnosticsEnabled: false,
          resumableServerMode: false,
        },
      },
    } as unknown as Record<string, TurnTrace>;

    const snapshot = buildContextWindowSnapshot({
      messages: [],
      currentPrompt: '',
      systemPrompt: 'system',
      tools: [],
      limitTokens: 10_000,
      tracesByTurn: trace,
    });

    expect(snapshot.basis).toBe('estimated-next-send');
    expect(snapshot.toolCount).toBe(0);
    expect(snapshot.breakdown.some((row) => row.label === 'System prompt')).toBe(true);
  });
});
