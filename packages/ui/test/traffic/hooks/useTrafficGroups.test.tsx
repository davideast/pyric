import { describe, it, expect } from 'bun:test';
import { useTrafficGroups } from '../../../src/traffic/hooks/useTrafficGroups.js';
import { renderHook, waitFor } from '../../helpers/render-hook.js';
import { evt } from '../helpers/fake-source.js';

describe('useTrafficGroups', () => {
  it('leaves ungrouped events as singles', async () => {
    const events = [evt({ id: 'a' }), evt({ id: 'b' })];
    const { result } = renderHook(() => useTrafficGroups({ events }));
    await waitFor(() => expect(result.current.items.length).toBe(2));
    expect(result.current.items.every((i) => i.type === 'single')).toBe(true);
  });

  it('collapses consecutive events sharing a groupId into a batch', async () => {
    const events = [
      evt({ id: 'a', groupId: 'g1', origin: 'batch' }),
      evt({ id: 'b', groupId: 'g1', origin: 'batch' }),
      evt({ id: 'c' }),
    ];
    const { result } = renderHook(() => useTrafficGroups({ events }));
    await waitFor(() => expect(result.current.items.length).toBe(2));
    const group = result.current.items[0];
    expect(group.type).toBe('group');
    if (group.type === 'group') {
      expect(group.kind).toBe('batch');
      expect(group.count).toBe(2);
      expect(group.key).toBe('g1');
    }
  });

  it('labels a transaction-origin group as transaction', async () => {
    const events = [
      evt({ groupId: 'tx1', origin: 'transaction' }),
      evt({ groupId: 'tx1', origin: 'transaction' }),
    ];
    const { result } = renderHook(() => useTrafficGroups({ events }));
    await waitFor(() => expect(result.current.items.length).toBe(1));
    const group = result.current.items[0];
    if (group.type === 'group') expect(group.kind).toBe('transaction');
  });

  it('collapses a run of listener re-evals from the same trigger', async () => {
    const trigger = { method: 'create', path: 'events/e1' };
    const events = [
      evt({ origin: 'user' }),
      evt({ origin: 'listener', triggeredBy: trigger }),
      evt({ origin: 'listener', triggeredBy: trigger }),
      evt({ origin: 'listener', triggeredBy: trigger }),
    ];
    const { result } = renderHook(() => useTrafficGroups({ events }));
    await waitFor(() => expect(result.current.items.length).toBe(2));
    const group = result.current.items[1];
    expect(group.type).toBe('group');
    if (group.type === 'group') {
      expect(group.kind).toBe('listener-run');
      expect(group.count).toBe(3);
    }
  });

  it('does not collapse a single listener event', async () => {
    const events = [
      evt({ origin: 'listener', triggeredBy: { method: 'set', path: 'a/b' } }),
      evt({ origin: 'user' }),
    ];
    const { result } = renderHook(() => useTrafficGroups({ events }));
    await waitFor(() => expect(result.current.items.length).toBe(2));
    expect(result.current.items[0].type).toBe('single');
  });

  it('splits listener runs with different triggers', async () => {
    const events = [
      evt({ origin: 'listener', triggeredBy: { method: 'create', path: 'a' } }),
      evt({ origin: 'listener', triggeredBy: { method: 'create', path: 'a' } }),
      evt({ origin: 'listener', triggeredBy: { method: 'create', path: 'b' } }),
      evt({ origin: 'listener', triggeredBy: { method: 'create', path: 'b' } }),
    ];
    const { result } = renderHook(() => useTrafficGroups({ events }));
    await waitFor(() => expect(result.current.items.length).toBe(2));
    expect(result.current.items.every((i) => i.type === 'group')).toBe(true);
  });

  it('rolls up denies on a group', async () => {
    const events = [
      evt({ groupId: 'g', origin: 'batch', result: 'allow' }),
      evt({ groupId: 'g', origin: 'batch', result: 'deny' }),
    ];
    const { result } = renderHook(() => useTrafficGroups({ events }));
    await waitFor(() => expect(result.current.items.length).toBe(1));
    const group = result.current.items[0];
    if (group.type === 'group') expect(group.denies).toBe(1);
  });

  it('honors groupBatches: false / groupListenerRuns: false', async () => {
    const events = [
      evt({ groupId: 'g', origin: 'batch' }),
      evt({ groupId: 'g', origin: 'batch' }),
    ];
    const { result } = renderHook(() =>
      useTrafficGroups({ events, groupBatches: false }),
    );
    await waitFor(() => expect(result.current.items.length).toBe(2));
    expect(result.current.items.every((i) => i.type === 'single')).toBe(true);
  });
});
