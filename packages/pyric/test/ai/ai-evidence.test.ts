import { describe, expect, test } from 'bun:test';
import { aiUsageEvidence } from '../../src/sandbox/internal/ai-evidence.js';

describe('aiUsageEvidence', () => {
  test('maps prompt to input, candidates to output, and the total', () => {
    const usage = { promptTokenCount: 9, candidatesTokenCount: 2, totalTokenCount: 11 };
    expect(aiUsageEvidence(usage, 'gemini-2.5-flash-lite')).toEqual({
      reportedModel: 'gemini-2.5-flash-lite', inputTokens: 9, outputTokens: 2, totalTokens: 11,
    });
  });

  test('leaves thinking tokens out of the output count', () => {
    const usage = { promptTokenCount: 9, candidatesTokenCount: 2, thoughtsTokenCount: 40, totalTokenCount: 51 };
    expect(aiUsageEvidence(usage)).toMatchObject({ inputTokens: 9, outputTokens: 2, totalTokens: 51 });
  });

  test('a zero count is kept', () => {
    expect(aiUsageEvidence({ promptTokenCount: 0, candidatesTokenCount: 0, totalTokenCount: 0 }))
      .toMatchObject({ inputTokens: 0, outputTokens: 0, totalTokens: 0 });
  });

  test('a missing count maps to undefined', () => {
    const evidence = aiUsageEvidence({ promptTokenCount: 4 });
    expect(evidence.inputTokens).toBe(4);
    expect(evidence.outputTokens).toBeUndefined();
    expect(evidence.totalTokens).toBeUndefined();
  });

  test('missing usage maps every count and the model to undefined', () => {
    const evidence = aiUsageEvidence(undefined);
    expect(evidence).toEqual({});
    expect(Object.keys(evidence).sort()).toEqual(['inputTokens', 'outputTokens', 'reportedModel', 'totalTokens']);
  });

  test('a negative, non-finite or non-number count maps to undefined', () => {
    const evidence = aiUsageEvidence({ promptTokenCount: -1, candidatesTokenCount: Number.NaN, totalTokenCount: '11' });
    expect(evidence.inputTokens).toBeUndefined();
    expect(evidence.outputTokens).toBeUndefined();
    expect(evidence.totalTokens).toBeUndefined();
    expect(aiUsageEvidence({ totalTokenCount: Number.POSITIVE_INFINITY }).totalTokens).toBeUndefined();
  });
});
