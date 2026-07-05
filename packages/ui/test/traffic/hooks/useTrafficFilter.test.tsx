import { describe, it, expect } from 'bun:test';
import { useTrafficFilter } from '../../../src/traffic/hooks/useTrafficFilter.js';
import { renderHook, act, waitFor } from '../../helpers/render-hook.js';
import { evt } from '../helpers/fake-source.js';

const EVENTS = [
  evt({ id: 'u-allow', origin: 'user', result: 'allow', path: 'users/alice' }),
  evt({ id: 'u-deny', origin: 'user', result: 'deny', path: 'events/e1' }),
  evt({ id: 'l-allow', origin: 'listener', result: 'allow', path: 'events/e1' }),
  evt({ id: 'tx', origin: 'transaction', result: 'allow', path: 'rsvps/r1' }),
];

describe('useTrafficFilter', () => {
  it('defaults to user origin — hides listener traffic', async () => {
    const { result } = renderHook(() =>
      useTrafficFilter({ events: EVENTS }),
    );
    await waitFor(() =>
      expect(result.current.filter.origin).toBe('user'),
    );
    // user default keeps everything that isn't a listener re-eval.
    expect(result.current.filtered.map((e) => e.id)).toEqual([
      'u-allow',
      'u-deny',
      'tx',
    ]);
  });

  it('defaults to result "all" — keeps allow and deny', async () => {
    const { result } = renderHook(() =>
      useTrafficFilter({ events: EVENTS }),
    );
    await waitFor(() => expect(result.current.filter.result).toBe('all'));
    const results = result.current.filtered.map((e) => e.result);
    expect(results).toContain('allow');
    expect(results).toContain('deny');
  });

  it('origin "listener" shows only listener re-evals', async () => {
    const { result } = renderHook(() =>
      useTrafficFilter({ events: EVENTS }),
    );
    act(() => result.current.setOrigin('listener'));
    expect(result.current.filtered.map((e) => e.id)).toEqual(['l-allow']);
  });

  it('origin "all" shows everything', async () => {
    const { result } = renderHook(() =>
      useTrafficFilter({ events: EVENTS }),
    );
    act(() => result.current.setOrigin('all'));
    expect(result.current.filtered.length).toBe(4);
  });

  it('result "deny" shows only denials', async () => {
    const { result } = renderHook(() =>
      useTrafficFilter({ events: EVENTS, initialOrigin: 'all' }),
    );
    act(() => result.current.setResult('deny'));
    expect(result.current.filtered.map((e) => e.id)).toEqual(['u-deny']);
  });

  it('path query filters case-insensitively by substring', async () => {
    const { result } = renderHook(() =>
      useTrafficFilter({ events: EVENTS, initialOrigin: 'all' }),
    );
    act(() => result.current.setPathQuery('EVENTS/'));
    expect(result.current.filtered.map((e) => e.id)).toEqual([
      'u-deny',
      'l-allow',
    ]);
  });

  it('combines origin, result, and path filters', async () => {
    const { result } = renderHook(() =>
      useTrafficFilter({ events: EVENTS }),
    );
    act(() => {
      result.current.setOrigin('all');
      result.current.setResult('allow');
      result.current.setPathQuery('events');
    });
    expect(result.current.filtered.map((e) => e.id)).toEqual(['l-allow']);
  });

  it('honors initial filter overrides', async () => {
    const { result } = renderHook(() =>
      useTrafficFilter({
        events: EVENTS,
        initialOrigin: 'all',
        initialResult: 'deny',
      }),
    );
    await waitFor(() =>
      expect(result.current.filtered.map((e) => e.id)).toEqual(['u-deny']),
    );
  });
});
