import { describe, it, expect } from 'bun:test';
import { useState } from 'react';
import {
  usePathState,
  normalizeStoragePath,
  type UsePathStateOptions,
} from '../../../src/storage/hooks/usePathState.js';
import { renderHook, act } from '../../helpers/render-hook.js';

const runHook = (p: UsePathStateOptions) => usePathState(p);

describe('normalizeStoragePath', () => {
  it('strips leading/trailing slashes and collapses repeats', () => {
    expect(normalizeStoragePath('/a/b/')).toBe('a/b');
    expect(normalizeStoragePath('a//b///c')).toBe('a/b/c');
    expect(normalizeStoragePath('')).toBe('');
    expect(normalizeStoragePath('/')).toBe('');
  });
});

describe('usePathState (uncontrolled)', () => {
  it('starts at the root by default', () => {
    const { result } = renderHook(runHook, {});
    expect(result.current.path).toBe('');
    expect(result.current.segments).toEqual([]);
  });

  it('starts at a normalized defaultPath', () => {
    const { result } = renderHook(runHook, { defaultPath: '/docs/sub/' });
    expect(result.current.path).toBe('docs/sub');
    expect(result.current.segments).toEqual(['docs', 'sub']);
  });

  it('setPath jumps to an absolute (normalized) path', () => {
    const { result } = renderHook(runHook, {});
    act(() => result.current.setPath('/a/b/'));
    expect(result.current.path).toBe('a/b');
  });

  it('enter descends by bare name and by absolute prefix path', () => {
    const { result } = renderHook(runHook, {});
    act(() => result.current.enter('docs'));
    expect(result.current.path).toBe('docs');
    // Bare child name appends.
    act(() => result.current.enter('sub'));
    expect(result.current.path).toBe('docs/sub');
    // An absolute descendant path (a prefix ref's fullPath) is used as-is.
    act(() => result.current.enter('docs/sub/deep'));
    expect(result.current.path).toBe('docs/sub/deep');
  });

  it('up ascends one level and no-ops at root', () => {
    const { result } = renderHook(runHook, { defaultPath: 'a/b/c' });
    act(() => result.current.up());
    expect(result.current.path).toBe('a/b');
    act(() => result.current.up());
    act(() => result.current.up());
    expect(result.current.path).toBe('');
    act(() => result.current.up());
    expect(result.current.path).toBe('');
  });

  it('navigateToIndex jumps to an ancestor; negative is root', () => {
    const { result } = renderHook(runHook, { defaultPath: 'a/b/c' });
    act(() => result.current.navigateToIndex(1));
    expect(result.current.path).toBe('a/b');
    act(() => result.current.navigateToIndex(-1));
    expect(result.current.path).toBe('');
  });

  it('fires onPathChange with the normalized next path', () => {
    const seen: string[] = [];
    const { result } = renderHook(runHook, {
      onPathChange: (p) => seen.push(p),
    });
    act(() => result.current.setPath('/x//y/'));
    expect(seen).toEqual(['x/y']);
  });
});

describe('usePathState (controlled)', () => {
  it('mirrors the controlled value and does not self-update', () => {
    const seen: string[] = [];
    const { result, rerender } = renderHook(runHook, {
      path: 'docs',
      onPathChange: (p) => seen.push(p),
    });
    expect(result.current.path).toBe('docs');

    // Navigation only notifies — the value stays until the owner
    // re-renders with the new path.
    act(() => result.current.enter('sub'));
    expect(seen).toEqual(['docs/sub']);
    expect(result.current.path).toBe('docs');

    rerender({ path: 'docs/sub', onPathChange: (p) => seen.push(p) });
    expect(result.current.path).toBe('docs/sub');
    expect(result.current.segments).toEqual(['docs', 'sub']);
  });

  it('round-trips through an owner component', () => {
    // The canonical wiring: owner state feeds `path`, `onPathChange`
    // writes it back.
    const { result } = renderHook(() => {
      const [path, setPath] = useState('a/b');
      return usePathState({ path, onPathChange: setPath });
    });
    act(() => result.current.up());
    expect(result.current.path).toBe('a');
    act(() => result.current.enter('z'));
    expect(result.current.path).toBe('a/z');
    act(() => result.current.navigateToIndex(-1));
    expect(result.current.path).toBe('');
  });

  it('normalizes a sloppy controlled value', () => {
    const { result } = renderHook(runHook, { path: '/docs//sub/' });
    expect(result.current.path).toBe('docs/sub');
    expect(result.current.segments).toEqual(['docs', 'sub']);
  });
});
