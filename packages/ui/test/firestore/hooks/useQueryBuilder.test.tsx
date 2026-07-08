import { describe, it, expect } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import {
  collection as collFn,
  getFirestore,
  type Query,
} from 'pyric/firestore';
import { useQueryBuilder } from '../../../src/firestore/hooks/useQueryBuilder.js';
import { renderHook, act, waitFor } from '../../helpers/render-hook.js';

// Shared sandbox + Firestore handle. `buildQuery` calls `query()`
// and `where()` against the input — both refuse refs not produced
// by pyric/firestore factories.
const sandbox = initializeSandbox();
const firestore = getFirestore(sandbox.withAuth({ uid: 'tester' }));
const baseColl = collFn(firestore, 'users');

describe('useQueryBuilder', () => {
  it('starts empty', async () => {
    const { result } = renderHook(() => useQueryBuilder());
    await waitFor(() => expect(result.current.conditions).toEqual([]));
    expect(result.current.orderBy).toBeUndefined();
    expect(result.current.limit).toBeUndefined();
  });

  it('addCondition appends a new condition with defaults', async () => {
    const { result } = renderHook(() => useQueryBuilder());
    await waitFor(() => expect(result.current.conditions).toEqual([]));
    act(() => {
      result.current.addCondition();
    });
    expect(result.current.conditions.length).toBe(1);
    expect(result.current.conditions[0].field).toBe('');
    expect(result.current.conditions[0].op).toBe('==');
    expect(typeof result.current.conditions[0].id).toBe('string');
  });

  it('updateCondition patches a single field', async () => {
    const { result } = renderHook(() => useQueryBuilder());
    act(() => {
      result.current.addCondition({ field: 'name', op: '==', value: 'Alice' });
    });
    const id = result.current.conditions[0].id;
    act(() => {
      result.current.updateCondition(id, { value: 'Bob' });
    });
    expect(result.current.conditions[0].field).toBe('name');
    expect(result.current.conditions[0].value).toBe('Bob');
  });

  it('removeCondition drops by id', async () => {
    const { result } = renderHook(() => useQueryBuilder());
    act(() => {
      result.current.addCondition({ field: 'a' });
      result.current.addCondition({ field: 'b' });
    });
    expect(result.current.conditions.length).toBe(2);
    const firstId = result.current.conditions[0].id;
    act(() => {
      result.current.removeCondition(firstId);
    });
    expect(result.current.conditions.length).toBe(1);
    expect(result.current.conditions[0].field).toBe('b');
  });

  it('setOrderBy + setLimit + reset', async () => {
    const { result } = renderHook(() => useQueryBuilder());
    act(() => {
      result.current.setOrderBy({ field: 'score', direction: 'desc' });
      result.current.setLimit(50);
      result.current.addCondition({ field: 'active', op: '==', value: true });
    });
    expect(result.current.orderBy).toEqual({ field: 'score', direction: 'desc' });
    expect(result.current.limit).toBe(50);
    expect(result.current.conditions.length).toBe(1);
    act(() => {
      result.current.reset();
    });
    expect(result.current.conditions).toEqual([]);
    expect(result.current.orderBy).toBeUndefined();
    expect(result.current.limit).toBeUndefined();
  });

  it('buildQuery returns the base collection when state is empty', async () => {
    const { result } = renderHook(() => useQueryBuilder());
    await waitFor(() => expect(result.current.conditions).toEqual([]));
    const q = result.current.buildQuery(baseColl);
    // No constraints → returns the base directly (cast to Query is
    // safe because CollectionReference extends Query).
    expect(q).toBe(baseColl as unknown as Query);
  });

  it('buildQuery composes where/orderBy/limit constraints', async () => {
    const { result } = renderHook(() => useQueryBuilder());
    act(() => {
      result.current.addCondition({ field: 'active', op: '==', value: true });
      result.current.setOrderBy({ field: 'score', direction: 'desc' });
      result.current.setLimit(10);
    });
    // The composed Query is a fresh object distinct from the base.
    const q = result.current.buildQuery(baseColl);
    expect(q).not.toBe(baseColl);
  });

  it('buildQuery skips conditions with empty field', async () => {
    const { result } = renderHook(() => useQueryBuilder());
    act(() => {
      result.current.addCondition({ field: '' });
      result.current.addCondition({ field: 'active', op: '==', value: true });
    });
    // With one valid condition we should get a non-base query;
    // the empty-field condition is dropped silently.
    const q = result.current.buildQuery(baseColl);
    expect(q).not.toBe(baseColl);
  });

  it('initial state populates conditions', async () => {
    const { result } = renderHook(() =>
      useQueryBuilder({
        initial: {
          conditions: [
            { id: 'c1', field: 'active', op: '==', value: true },
          ],
          orderBy: { field: 'score', direction: 'desc' },
          limit: 25,
        },
      }),
    );
    await waitFor(() => expect(result.current.conditions.length).toBe(1));
    expect(result.current.conditions[0]).toMatchObject({
      id: 'c1',
      field: 'active',
      op: '==',
    });
    expect(result.current.orderBy?.direction).toBe('desc');
    expect(result.current.limit).toBe(25);
  });
});
