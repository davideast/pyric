/** Token strip + per-tool attribution — pure-function coverage. */
import { describe, test, expect } from 'bun:test';
import {
  attributeToolTokens,
  buildMetricsStripParts,
  formatTokenCount,
} from './token-attribution';
import type { ChatMessage, ToolCall } from '~/lib/store/chat';

function msg(overrides: Partial<ChatMessage>): ChatMessage {
  return { id: 'm', role: 'assistant', text: '', createdAt: 0, ...overrides };
}

function call(id: string, name: string, argsLen: number, resultLen?: number): ToolCall {
  return {
    id,
    name,
    argsJson: 'x'.repeat(argsLen),
    ...(resultLen !== undefined ? { resultJson: 'y'.repeat(resultLen) } : {}),
  };
}

describe('formatTokenCount', () => {
  test('compact vocabulary', () => {
    expect(formatTokenCount(0)).toBe('0');
    expect(formatTokenCount(950)).toBe('950');
    expect(formatTokenCount(8842)).toBe('8.8k');
    expect(formatTokenCount(12_000)).toBe('12k');
    expect(formatTokenCount(123_456)).toBe('123k');
  });
});

describe('buildMetricsStripParts', () => {
  test('token split renders in/out/cached', () => {
    const parts = buildMetricsStripParts({
      tokensIn: 8842,
      tokensOut: 1205,
      cachedTokens: 6400,
    });
    expect(parts).toEqual(['in 8.8k', 'out 1.2k', 'cached 6.4k']);
  });

  test('zero cached is omitted (no "cached 0" noise)', () => {
    const parts = buildMetricsStripParts({ tokensIn: 100, tokensOut: 50, cachedTokens: 0 });
    expect(parts).toEqual(['in 100', 'out 50']);
  });

  test('legacy messages fall back to the total', () => {
    expect(buildMetricsStripParts({ tokensTotal: 2374 })).toEqual(['2,374 tok']);
  });

  test('absent metrics → empty', () => {
    expect(buildMetricsStripParts(undefined)).toEqual([]);
  });
});

describe('attributeToolTokens', () => {
  test('no tool calls → empty attribution', () => {
    const a = attributeToolTokens(msg({}));
    expect(a.rows).toEqual([]);
    expect(a.toolTrafficTok).toBe(0);
  });

  test('shares sum to ~1 and follow payload sizes', () => {
    const m = msg({
      toolCalls: [call('a', 'write_file', 4000, 400), call('b', 'read_file', 100, 300)],
    });
    const { rows, toolTrafficTok } = attributeToolTokens(m);
    expect(toolTrafficTok).toBe(rows[0]!.totalTok + rows[1]!.totalTok);
    expect(rows[0]!.share).toBeGreaterThan(rows[1]!.share);
    expect(rows[0]!.share + rows[1]!.share).toBeCloseTo(1, 5);
    // ~4 chars/token: 4400 chars ≈ 1100 tok.
    expect(rows[0]!.totalTok).toBe(1100);
  });

  test('in-flight call (no result yet) counts args only', () => {
    const m = msg({ toolCalls: [call('a', 'write_file', 400)] });
    const { rows } = attributeToolTokens(m);
    expect(rows[0]!.argsTok).toBe(100);
    expect(rows[0]!.resultTok).toBe(0);
  });

  test('cost attribution uses the REAL turn total as denominator', () => {
    const m = msg({
      toolCalls: [call('a', 'x', 4000, 0), call('b', 'y', 4000, 0)],
      metrics: { tokensTotal: 10_000, costUsd: 0.01, costEstimated: true },
    });
    const { rows } = attributeToolTokens(m);
    // each call ≈1000 tok of a 10k turn → ≈$0.001
    expect(rows[0]!.estCostUsd).toBeCloseTo(0.001, 6);
  });

  test('no turn cost → no per-call cost estimates', () => {
    const m = msg({ toolCalls: [call('a', 'x', 400, 0)] });
    expect(attributeToolTokens(m).rows[0]!.estCostUsd).toBeUndefined();
  });
});
