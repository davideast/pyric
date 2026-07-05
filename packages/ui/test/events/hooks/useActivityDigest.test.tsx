import { describe, it, expect } from 'bun:test';
import { useActivityDigest } from '../../../src/events/hooks/useActivityDigest.js';
import { renderHook, waitFor } from '../../helpers/render-hook.js';
import { reqEvent, writeEvent } from '../helpers/fake-events.js';

const NOW = 1_700_000_100_000;

describe('useActivityDigest', () => {
  it('folds events into the banded digest', async () => {
    const events = [
      writeEvent({ method: 'create' }),
      reqEvent({ result: 'deny', reasons: ['Rule #0 (update) → DENY'] }),
    ];
    const { result } = renderHook(() =>
      useActivityDigest(events, { now: NOW }),
    );
    await waitFor(() => expect(result.current.total).toBe(2));
    expect(result.current.bands[0].key).toBe('denied');
    expect(result.current.deniedCount).toBe(1);
  });

  it('memoizes — same events + options yields a stable digest reference', async () => {
    const events = [writeEvent({ method: 'create' })];
    let last: unknown;
    let sameAcrossRerender = false;
    const { result, rerender } = renderHook(
      ({ ev }) => useActivityDigest(ev, { now: NOW }),
      { ev: events },
    );
    await waitFor(() => expect(result.current.total).toBe(1));
    last = result.current;
    rerender({ ev: events });
    sameAcrossRerender = result.current === last;
    expect(sameAcrossRerender).toBe(true);
  });

  it('recomputes when groupBy changes', async () => {
    const events = [
      writeEvent({ method: 'create', actor: { kind: 'app' } }),
      writeEvent({ method: 'create', actor: { kind: 'agent', name: 'atlas' } }),
    ];
    const { result, rerender } = renderHook(
      ({ gb }) => useActivityDigest(events, { now: NOW, groupBy: gb }),
      { gb: 'none' as const },
    );
    await waitFor(() => expect(result.current.bands.length).toBe(1));
    expect(result.current.bands[0].subgroups).toBeUndefined();

    rerender({ gb: 'actor' as const });
    expect(result.current.bands[0].subgroups).toBeDefined();
  });
});
