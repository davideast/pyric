import { describe, expect, it } from 'bun:test';
import { useUpdateHighlights } from '../../src/primitives/index.js';
import { act, renderHook } from '../helpers/render-hook.js';

describe('useUpdateHighlights', () => {
  it('treats the first ready entries as a silent baseline', () => {
    const { result, unmount } = renderHook(
      (props: { entries: ReadonlyMap<string, unknown> }) =>
        useUpdateHighlights({ scope: 'users', entries: props.entries }),
      { entries: new Map([['users/alice', 1]]) },
    );

    expect(result.current.size).toBe(0);
    unmount();
  });

  it('marks added and modified entries without marking unchanged entries', () => {
    const { result, rerender, unmount } = renderHook(
      (props: { entries: ReadonlyMap<string, number> }) =>
        useUpdateHighlights({ scope: 'users', entries: props.entries }),
      { entries: new Map([['users/alice', 1], ['users/bob', 2]]) },
    );

    rerender({
      entries: new Map([['users/alice', 3], ['users/bob', 2], ['users/carol', 4]]),
    });

    expect(result.current.get('users/alice')?.kind).toBe('modified');
    expect(result.current.has('users/bob')).toBe(false);
    expect(result.current.get('users/carol')?.kind).toBe('added');
    unmount();
  });

  it('changes cycle when the same entry updates again before expiry', () => {
    const { result, rerender, unmount } = renderHook(
      (props: { entries: ReadonlyMap<string, number> }) =>
        useUpdateHighlights({ scope: 'users', entries: props.entries, durationMs: 100 }),
      { entries: new Map([['users/alice', 1]]) },
    );

    rerender({ entries: new Map([['users/alice', 2]]) });
    const firstCycle = result.current.get('users/alice')?.cycle;
    rerender({ entries: new Map([['users/alice', 3]]) });

    expect(result.current.get('users/alice')?.cycle).toBe(firstCycle === 0 ? 1 : 0);
    unmount();
  });

  it('preserves highlight state across equivalent snapshot objects', () => {
    const { result, rerender, unmount } = renderHook(
      (props: { entries: ReadonlyMap<string, number> }) =>
        useUpdateHighlights({ scope: 'users', entries: props.entries }),
      { entries: new Map([['users/alice', 1]]) },
    );

    rerender({ entries: new Map([['users/alice', 2]]) });
    const activeHighlights = result.current;
    rerender({ entries: new Map([['users/alice', 2]]) });

    expect(result.current).toBe(activeHighlights);
    unmount();
  });

  it('expires highlights and resets silently when scope changes', async () => {
    const { result, rerender, unmount } = renderHook(
      (props: { scope: string; entries: ReadonlyMap<string, number> }) =>
        useUpdateHighlights({ ...props, durationMs: 20 }),
      { scope: 'users', entries: new Map([['users/alice', 1]]) },
    );

    rerender({ scope: 'users', entries: new Map([['users/alice', 2]]) });
    expect(result.current.has('users/alice')).toBe(true);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(result.current.size).toBe(0);

    rerender({ scope: 'posts', entries: new Map([['posts/one', 1]]) });
    expect(result.current.size).toBe(0);
    unmount();
  });
});
