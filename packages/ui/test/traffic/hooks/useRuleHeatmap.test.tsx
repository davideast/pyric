import { describe, it, expect } from 'bun:test';
import { useRuleHeatmap } from '../../../src/traffic/hooks/useRuleHeatmap.js';
import { renderHook, waitFor } from '../../helpers/render-hook.js';
import { evt } from '../helpers/fake-source.js';

describe('useRuleHeatmap', () => {
  it('returns empty entries for an empty buffer', async () => {
    const { result } = renderHook(() => useRuleHeatmap({ events: [] }));
    await waitFor(() => expect(result.current.entries).toEqual([]));
    expect(result.current.unmatchedCount).toBe(0);
  });

  it('rolls events up by ruleIndex with allow/deny splits', async () => {
    const events = [
      evt({ result: 'allow', matchedRule: { ruleIndex: 0, operations: ['read'] } }),
      evt({ result: 'allow', matchedRule: { ruleIndex: 0, operations: ['read'] } }),
      evt({ result: 'deny', matchedRule: { ruleIndex: 2, operations: ['update'] } }),
    ];
    const { result } = renderHook(() => useRuleHeatmap({ events }));
    await waitFor(() => expect(result.current.entries.length).toBe(2));

    const rule0 = result.current.entries.find((e) => e.ruleIndex === 0)!;
    expect(rule0.total).toBe(2);
    expect(rule0.allows).toBe(2);
    expect(rule0.denies).toBe(0);
    expect(rule0.denyRatio).toBe(0);

    const rule2 = result.current.entries.find((e) => e.ruleIndex === 2)!;
    expect(rule2.total).toBe(1);
    expect(rule2.denies).toBe(1);
    expect(rule2.denyRatio).toBe(1);
  });

  it('sorts entries by total descending, ties by ruleIndex', async () => {
    const events = [
      evt({ matchedRule: { ruleIndex: 5, operations: ['read'] } }),
      evt({ matchedRule: { ruleIndex: 1, operations: ['read'] } }),
      evt({ matchedRule: { ruleIndex: 1, operations: ['read'] } }),
      evt({ matchedRule: { ruleIndex: 3, operations: ['read'] } }),
    ];
    const { result } = renderHook(() => useRuleHeatmap({ events }));
    await waitFor(() => expect(result.current.entries.length).toBe(3));
    expect(result.current.entries.map((e) => e.ruleIndex)).toEqual([1, 3, 5]);
  });

  it('unions operations seen for the same rule', async () => {
    const events = [
      evt({ matchedRule: { ruleIndex: 0, operations: ['create'] } }),
      evt({ matchedRule: { ruleIndex: 0, operations: ['update'] } }),
    ];
    const { result } = renderHook(() => useRuleHeatmap({ events }));
    await waitFor(() => expect(result.current.entries.length).toBe(1));
    expect(result.current.entries[0].operations.sort()).toEqual([
      'create',
      'update',
    ]);
  });

  it('counts events with no matched rule as unmatched', async () => {
    const events = [
      evt({ matchedRule: undefined }),
      evt({ matchedRule: { ruleIndex: 0, operations: ['read'] } }),
    ];
    const { result } = renderHook(() => useRuleHeatmap({ events }));
    await waitFor(() => expect(result.current.unmatchedCount).toBe(1));
    expect(result.current.entries.length).toBe(1);
  });
});
