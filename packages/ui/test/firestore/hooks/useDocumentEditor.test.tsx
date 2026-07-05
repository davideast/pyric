import { describe, it, expect } from 'bun:test';
import { useDocumentEditor } from '../../../src/firestore/hooks/useDocumentEditor.js';
import { renderHook, act } from '../../helpers/render-hook.js';

describe('useDocumentEditor', () => {
  it('starts with isDirty=false and isValid=true for a clean document', () => {
    const { result } = renderHook(() =>
      useDocumentEditor({ initial: { name: 'Alice' } }),
    );
    expect(result.current.isDirty).toBe(false);
    expect(result.current.isValid).toBe(true);
    expect(result.current.errorCount).toBe(0);
  });

  it('flips isDirty after the first action', () => {
    const { result } = renderHook(() =>
      useDocumentEditor({ initial: { name: 'Alice' } }),
    );
    const nameId = (result.current.tree.childIds[result.current.tree.rootId] ?? [])[0];
    act(() => {
      result.current.setValue(nameId, 'Bob');
    });
    expect(result.current.isDirty).toBe(true);
    expect(result.current.toData()).toEqual({ name: 'Bob' });
  });

  it('reset clears isDirty and restores the initial tree', () => {
    const { result } = renderHook(() =>
      useDocumentEditor({ initial: { name: 'Alice' } }),
    );
    const nameId = (result.current.tree.childIds[result.current.tree.rootId] ?? [])[0];
    act(() => {
      result.current.setValue(nameId, 'Bob');
    });
    expect(result.current.isDirty).toBe(true);
    act(() => {
      result.current.reset();
    });
    expect(result.current.isDirty).toBe(false);
    expect(result.current.toData()).toEqual({ name: 'Alice' });
  });

  it('isValid flips false when a duplicate key is set', () => {
    const { result } = renderHook(() =>
      useDocumentEditor({ initial: { a: 1, b: 2 } }),
    );
    const tree = result.current.tree;
    const bId = (tree.childIds[tree.rootId] ?? []).find(
      (id) => tree.nodes[id].key === 'b',
    )!;
    act(() => {
      result.current.setKey(bId, 'a');
    });
    expect(result.current.isValid).toBe(false);
    expect(result.current.errorCount).toBeGreaterThanOrEqual(2);
  });

  it('exposes raw dispatch for actions not covered by named helpers', () => {
    const { result } = renderHook(() =>
      useDocumentEditor({ initial: { a: 1 } }),
    );
    act(() => {
      result.current.dispatch({
        type: 'addMapEntry',
        parentId: result.current.tree.rootId,
        key: 'b',
        childType: 'string',
      });
    });
    expect(result.current.toData()).toEqual({ a: 1, b: '' });
  });
});
