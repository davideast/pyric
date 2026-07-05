import { describe, it, expect } from 'bun:test';
import { useTrafficStats } from '../../../src/traffic/hooks/useTrafficStats.js';
import { renderHook, waitFor } from '../../helpers/render-hook.js';
import { evt } from '../helpers/fake-source.js';

describe('useTrafficStats', () => {
  it('returns zeroed stats for an empty buffer', async () => {
    const { result } = renderHook(() => useTrafficStats({ events: [] }));
    await waitFor(() => expect(result.current.total).toBe(0));
    expect(result.current.denyRate).toBe(0);
    expect(result.current.byMethod).toEqual([]);
  });

  it('counts totals and deny rate', async () => {
    const events = [
      evt({ result: 'allow' }),
      evt({ result: 'allow' }),
      evt({ result: 'deny' }),
      evt({ result: 'unsupported' }),
    ];
    const { result } = renderHook(() => useTrafficStats({ events }));
    await waitFor(() => expect(result.current.total).toBe(4));
    expect(result.current.allows).toBe(2);
    expect(result.current.denies).toBe(1);
    expect(result.current.unsupported).toBe(1);
    expect(result.current.denyRate).toBe(0.25);
  });

  it('buckets by method, sorted by count descending', async () => {
    const events = [
      evt({ method: 'get' }),
      evt({ method: 'get' }),
      evt({ method: 'get' }),
      evt({ method: 'update' }),
    ];
    const { result } = renderHook(() => useTrafficStats({ events }));
    await waitFor(() => expect(result.current.byMethod.length).toBe(2));
    expect(result.current.byMethod[0]).toEqual({ key: 'get', count: 3 });
    expect(result.current.byMethod[1]).toEqual({ key: 'update', count: 1 });
  });

  it('buckets by origin', async () => {
    const events = [
      evt({ origin: 'user' }),
      evt({ origin: 'listener' }),
      evt({ origin: 'listener' }),
    ];
    const { result } = renderHook(() => useTrafficStats({ events }));
    await waitFor(() => expect(result.current.byOrigin[0].key).toBe('listener'));
    expect(result.current.byOrigin[0].count).toBe(2);
  });

  it('caps byPath at topPaths', async () => {
    const events = ['a', 'b', 'c', 'd'].map((p) => evt({ path: p }));
    const { result } = renderHook(() =>
      useTrafficStats({ events, topPaths: 2 }),
    );
    await waitFor(() => expect(result.current.byPath.length).toBe(2));
  });
});
