import { describe, it, expect } from 'bun:test';
import { useActivityStream } from '../../../src/events/hooks/useActivityStream.js';
import { renderHook, act, waitFor } from '../../helpers/render-hook.js';
import { makeFakeSource, writeEvent } from '../helpers/fake-events.js';

describe('useActivityStream', () => {
  it('starts empty and attaches the subscription', async () => {
    const fake = makeFakeSource();
    const { result } = renderHook(() =>
      useActivityStream({ source: fake.source }),
    );
    await waitFor(() => expect(fake.attached).toBe(true));
    expect(result.current.events).toEqual([]);
  });

  it('seeds the buffer from `initial` (e.g. history())', async () => {
    const fake = makeFakeSource();
    const seed = [writeEvent({ id: 's1' }), writeEvent({ id: 's2' })];
    const { result } = renderHook(() =>
      useActivityStream({ source: fake.source, initial: seed }),
    );
    await waitFor(() => expect(fake.attached).toBe(true));
    expect(result.current.events.map((e) => (e as { id: string }).id)).toEqual([
      's1',
      's2',
    ]);
  });

  it('buffers emitted events after the seed, oldest-first', async () => {
    const fake = makeFakeSource();
    const { result } = renderHook(() =>
      useActivityStream({ source: fake.source, initial: [writeEvent({ id: 's' })] }),
    );
    await waitFor(() => expect(fake.attached).toBe(true));

    act(() => fake.emit(writeEvent({ id: 'a' })));
    act(() => fake.emit(writeEvent({ id: 'b' })));

    expect(result.current.events.map((e) => (e as { id: string }).id)).toEqual([
      's',
      'a',
      'b',
    ]);
  });

  it('caps the buffer, dropping oldest', async () => {
    const fake = makeFakeSource();
    const { result } = renderHook(() =>
      useActivityStream({ source: fake.source, bufferSize: 2 }),
    );
    await waitFor(() => expect(fake.attached).toBe(true));

    for (const id of ['a', 'b', 'c']) act(() => fake.emit(writeEvent({ id })));

    expect(result.current.events.map((e) => (e as { id: string }).id)).toEqual([
      'b',
      'c',
    ]);
  });

  it('drops events while paused and resumes', async () => {
    const fake = makeFakeSource();
    const { result } = renderHook(() =>
      useActivityStream({ source: fake.source }),
    );
    await waitFor(() => expect(fake.attached).toBe(true));

    act(() => fake.emit(writeEvent({ id: 'a' })));
    act(() => result.current.pause());
    act(() => fake.emit(writeEvent({ id: 'dropped' })));
    expect(result.current.events.map((e) => (e as { id: string }).id)).toEqual([
      'a',
    ]);

    act(() => result.current.resume());
    act(() => fake.emit(writeEvent({ id: 'b' })));
    expect(result.current.events.map((e) => (e as { id: string }).id)).toEqual([
      'a',
      'b',
    ]);
  });

  it('clear() empties the buffer', async () => {
    const fake = makeFakeSource();
    const { result } = renderHook(() =>
      useActivityStream({ source: fake.source }),
    );
    await waitFor(() => expect(fake.attached).toBe(true));
    act(() => fake.emit(writeEvent({ id: 'a' })));
    act(() => result.current.clear());
    expect(result.current.events).toEqual([]);
  });

  it('unsubscribes on unmount', async () => {
    const fake = makeFakeSource();
    const { unmount } = renderHook(() =>
      useActivityStream({ source: fake.source }),
    );
    await waitFor(() => expect(fake.attached).toBe(true));
    unmount();
    expect(fake.unsubscribed).toBe(true);
  });
});
