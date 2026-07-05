import { describe, it, expect } from 'bun:test';
import { useTrafficMonitor } from '../../../src/traffic/hooks/useTrafficMonitor.js';
import { renderHook, act, waitFor } from '../../helpers/render-hook.js';
import { makeFakeSource, evt } from '../helpers/fake-source.js';

describe('useTrafficMonitor', () => {
  it('starts with an empty buffer', async () => {
    const fake = makeFakeSource();
    const { result } = renderHook(() =>
      useTrafficMonitor({ source: fake.source }),
    );
    await waitFor(() => expect(result.current.events).toEqual([]));
    expect(result.current.counts).toEqual({ total: 0, denied: 0, listener: 0 });
    expect(result.current.isPaused).toBe(false);
  });

  it('buffers emitted events oldest-first', async () => {
    const fake = makeFakeSource();
    const { result } = renderHook(() =>
      useTrafficMonitor({ source: fake.source }),
    );
    await waitFor(() => expect(fake.attached).toBe(true));

    act(() => fake.emit(evt({ id: 'a' })));
    act(() => fake.emit(evt({ id: 'b' })));

    expect(result.current.events.map((e) => e.id)).toEqual(['a', 'b']);
  });

  it('caps the buffer at bufferSize, dropping oldest', async () => {
    const fake = makeFakeSource();
    const { result } = renderHook(() =>
      useTrafficMonitor({ source: fake.source, bufferSize: 3 }),
    );
    await waitFor(() => expect(fake.attached).toBe(true));

    for (const id of ['a', 'b', 'c', 'd', 'e']) {
      act(() => fake.emit(evt({ id })));
    }

    expect(result.current.events.map((e) => e.id)).toEqual(['c', 'd', 'e']);
  });

  it('drops incoming events while paused, resumes on resume()', async () => {
    const fake = makeFakeSource();
    const { result } = renderHook(() =>
      useTrafficMonitor({ source: fake.source }),
    );
    await waitFor(() => expect(fake.attached).toBe(true));

    act(() => fake.emit(evt({ id: 'a' })));
    act(() => result.current.pause());
    expect(result.current.isPaused).toBe(true);

    act(() => fake.emit(evt({ id: 'dropped' })));
    expect(result.current.events.map((e) => e.id)).toEqual(['a']);

    act(() => result.current.resume());
    act(() => fake.emit(evt({ id: 'b' })));
    expect(result.current.events.map((e) => e.id)).toEqual(['a', 'b']);
  });

  it('starts paused when paused: true', async () => {
    const fake = makeFakeSource();
    const { result } = renderHook(() =>
      useTrafficMonitor({ source: fake.source, paused: true }),
    );
    await waitFor(() => expect(fake.attached).toBe(true));

    act(() => fake.emit(evt({ id: 'dropped' })));
    expect(result.current.events).toEqual([]);
  });

  it('clear() empties the buffer', async () => {
    const fake = makeFakeSource();
    const { result } = renderHook(() =>
      useTrafficMonitor({ source: fake.source }),
    );
    await waitFor(() => expect(fake.attached).toBe(true));

    act(() => fake.emit(evt({ id: 'a' })));
    act(() => fake.emit(evt({ id: 'b' })));
    act(() => result.current.clear());

    expect(result.current.events).toEqual([]);
  });

  it('derives counts for total, denied, and listener', async () => {
    const fake = makeFakeSource();
    const { result } = renderHook(() =>
      useTrafficMonitor({ source: fake.source }),
    );
    await waitFor(() => expect(fake.attached).toBe(true));

    act(() => fake.emit(evt({ result: 'allow', origin: 'user' })));
    act(() => fake.emit(evt({ result: 'deny', origin: 'user' })));
    act(() => fake.emit(evt({ result: 'allow', origin: 'listener' })));

    expect(result.current.counts).toEqual({
      total: 3,
      denied: 1,
      listener: 1,
    });
  });

  it('applies transform before buffering', async () => {
    const fake = makeFakeSource();
    const { result } = renderHook(() =>
      useTrafficMonitor({
        source: fake.source,
        transform: (e) => ({ ...e, path: `shrunk:${e.path}` }),
      }),
    );
    await waitFor(() => expect(fake.attached).toBe(true));

    act(() => fake.emit(evt({ path: 'users/alice' })));

    expect(result.current.events[0].path).toBe('shrunk:users/alice');
  });

  it('unsubscribes on unmount', async () => {
    const fake = makeFakeSource();
    const { unmount } = renderHook(() =>
      useTrafficMonitor({ source: fake.source }),
    );
    await waitFor(() => expect(fake.attached).toBe(true));

    unmount();
    expect(fake.unsubscribed).toBe(true);
  });
});
